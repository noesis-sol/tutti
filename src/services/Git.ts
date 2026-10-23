// The Git service and GitWriter (§ 3.3): every git command a run makes, each through exec with
// orchestra's limits (30 s for a read, 2 min for a write). Every write takes GitWriter, so one git
// write at a time changes the main repository, whose refs, objects and worktree list each ticket's
// worktree shares. A rebase interrupted or timed out is aborted, putting the branch back (§ 3.4); one
// stopped on conflicts is left stopped, for its worker to resolve, and fails with RebaseConflict.
// Output that names files or holds commit messages is read with -z, so no path or message a worker
// wrote can be taken for a separator.
import {
  Context,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import {
  type Command,
  defaultMaxOutputBytes,
  exec,
  type Output,
  outputCut,
  showCommand,
  TimeLimit,
} from "./exec.ts"

/**
 * git exited with a code other than 0, couldn't be started (127), or wrote more than a read can
 * keep (`maxOutputBytes`), with its exit code.
 */
export class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  /** What was asked of git: `rebase`, `worktree add`, `merge --ff-only`, … */
  op: Schema.String,
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {}

/** git ran past its time limit, and its process group was killed. */
export class GitTimedOut extends Schema.TaggedError<GitTimedOut>()("GitTimedOut", {
  op: Schema.String,
  command: Schema.String,
  timeLimit: Schema.Duration,
}) {}

/** The rebase stopped on conflicts in these files, and is left in progress for them to be resolved. */
export class RebaseConflict extends Schema.TaggedError<RebaseConflict>()("RebaseConflict", {
  files: Schema.Array(Schema.String),
}) {}

export type GitError = GitFailed | GitTimedOut

/**
 * The oldest git tutti runs on: `git merge-tree --write-tree` (`holds`) came in git 2.38, after
 * `worktree list -z` (2.36) and `rev-parse --path-format=absolute` (2.31).
 */
export const minimumGitVersion: readonly [number, number] = [2, 38]

/**
 * Reads `git --version`: `git version 2.34.1`, `git version 2.39.3 (Apple Git-146)`,
 * `git version 2.45.1.windows.1`. Its major, minor and patch numbers, or null for other output.
 */
export const parseGitVersion = (output: string): readonly [number, number, number] | null => {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")]
}

/**
 * What a run says when git's `git --version` output is older than `minimumGitVersion`, or null:
 * output tutti can't read says nothing, and the git commands that follow say what they find.
 */
export const gitTooOld = (output: string): string | null => {
  const version = parseGitVersion(output)
  if (version === null) return null
  const [major, minor, patch] = version
  const [needMajor, needMinor] = minimumGitVersion
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null
  return `git ${major}.${minor}.${patch} is too old: tutti needs git ${needMajor}.${needMinor} or later. Update git, then run tutti again.`
}

/** A worktree, as `git worktree list` gives it. */
export interface Worktree {
  readonly path: string
  /** The commit checked out; absent in a bare repository. */
  readonly head?: string
  /** The branch checked out, without `refs/heads/`; absent on a detached HEAD. */
  readonly branch?: string
  /** Its folder is gone, and `git worktree prune` would forget it. */
  readonly prunable: boolean
}

export interface Commit {
  /** The full hash. */
  readonly hash: string
  readonly subject: string
  /** The whole message, subject included. */
  readonly message: string
}

/** A file `git status --porcelain` lists. */
export interface StatusEntry {
  /** The two-letter code: `M `, ` M`, `??`, `R `, `UU`, … */
  readonly code: string
  readonly path: string
  /** The path a renamed or copied file had. */
  readonly from?: string
}

/** The fields of the output of a git command run with -z, which leaves paths unquoted. */
export const splitNul = (output: string): ReadonlyArray<string> =>
  output.split("\0").filter((field) => field !== "")

/** Reads `git check-attr -z merge`: a path, the attribute and its value for each; those `union`. */
export const parseUnion = (output: string): ReadonlyArray<string> => {
  const fields = output.split("\0")
  const union: Array<string> = []
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === "union") union.push(fields[i] ?? "")
  }
  return union
}

/** Reads `git worktree list --porcelain -z`: attribute lines ended by NULs, a worktree's last by two. */
export const parseWorktrees = (output: string): ReadonlyArray<Worktree> => {
  const worktrees: Array<Worktree> = []
  let current: { path: string; head?: string; branch?: string; prunable: boolean } | undefined
  for (const line of output.split("\0")) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) worktrees.push(current)
      current = { path: line.slice("worktree ".length), prunable: false }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length)
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true
    }
  }
  if (current !== undefined) worktrees.push(current)
  return worktrees
}

/**
 * A command's revisions after --end-of-options, so that none is taken for an option, and, for a
 * command that takes pathspecs, those after --, so that no revision is taken for a path: git refuses
 * a name that is both, such as a base `main` beside a top-level main/ folder.
 */
const revisions = (
  revs: ReadonlyArray<string>,
  paths?: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  paths === undefined
    ? ["--end-of-options", ...revs]
    : ["--end-of-options", ...revs, "--", ...paths]

/** The format `log` asks for: the hash, the subject and the message, each ended by -z's NUL. */
export const logFormat = "--format=%H%x00%s%x00%B"

/**
 * Reads `git log -z` in `logFormat`: three fields to a commit. A commit message can't hold a NUL
 * (git refuses one), so the fields are the commits' own.
 */
export const parseLog = (output: string): ReadonlyArray<Commit> => {
  const fields = output.split("\0")
  const commits: Array<Commit> = []
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const hash = (fields[i] ?? "").replace(/^\n+/, "")
    if (hash === "") continue
    commits.push({ hash, subject: fields[i + 1] ?? "", message: fields[i + 2] ?? "" })
  }
  return commits
}

/** Reads `git status --porcelain -z`: a code, a space and the path; a rename's old path follows. */
export const parseStatus = (output: string): ReadonlyArray<StatusEntry> => {
  const fields = output.split("\0")
  const entries: Array<StatusEntry> = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ""
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    // A rename or copy in either column, staged or (after `git add -N`) in the worktree only.
    if (/[RC]/.test(code)) {
      i++
      entries.push({ code, path: field.slice(3), from: fields[i] ?? "" })
    } else {
      entries.push({ code, path: field.slice(3) })
    }
  }
  return entries
}

/** Who holds a GitWriter in this fiber, so that a writer already holding it doesn't wait on itself. */
const Holding = Context.Reference<Semaphore.Semaphore | undefined>(
  "tutti/services/GitWriter/Holding",
  { defaultValue: () => undefined },
)

export class GitWriter extends Context.Service<
  GitWriter,
  {
    /**
     * Runs the effect as the one writer to the main repository, waiting for the writer before it.
     * A fiber already holding the writer, and the fibers it forks, run on without waiting, so a
     * sequence of writes (a merge's rebase, fast-forward and cleanup) can hold it throughout.
     */
    withLock<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
  }
>()("tutti/services/GitWriter") {
  static readonly make = (semaphore: Semaphore.Semaphore) =>
    GitWriter.of({
      withLock: (effect) =>
        Effect.flatMap(Effect.service(Holding), (holding) =>
          holding === semaphore
            ? effect
            : Semaphore.withPermit(semaphore)(Effect.provideService(effect, Holding, semaphore)),
        ),
    })

  static readonly layer = Layer.effect(GitWriter, Effect.map(Semaphore.make(1), GitWriter.make))
}

export interface WorktreeOptions {
  /** The branch the worktree checks out. */
  readonly branch: string
  /** Creates the branch from this commit; without it, the branch must exist. */
  readonly base?: string
}

export class Git extends Context.Service<
  Git,
  {
    /** git worktree add: a new worktree at path, on a branch that exists or one made from `base`. */
    addWorktree(repo: string, path: string, options: WorktreeOptions): Effect.Effect<void, GitError>
    /** git worktree add --detach: a new worktree at path with `commit` checked out, on no branch. */
    addDetachedWorktree(repo: string, path: string, commit: string): Effect.Effect<void, GitError>
    /** git worktree remove: refuses a worktree with changes unless forced. */
    removeWorktree(
      repo: string,
      path: string,
      options?: { readonly force?: boolean },
    ): Effect.Effect<void, GitError>
    /** git worktree list: the main checkout first. */
    worktrees(repo: string): Effect.Effect<ReadonlyArray<Worktree>, GitError>
    /** git worktree prune: forgets the worktrees whose folders are gone. */
    pruneWorktrees(repo: string): Effect.Effect<void, GitError>
    /** git branch: a new branch at `start`. */
    createBranch(repo: string, branch: string, start: string): Effect.Effect<void, GitError>
    /** git branch -d: refuses a branch not merged into HEAD unless forced (-D). */
    deleteBranch(
      repo: string,
      branch: string,
      options?: { readonly force?: boolean },
    ): Effect.Effect<void, GitError>
    /**
     * git rebase: rebases the branch checked out in worktree onto `onto`. Stopped on conflicts, it
     * fails with RebaseConflict and is left in progress; failing otherwise, timing out or interrupted,
     * it is aborted, and the branch is as it was.
     */
    rebase(worktree: string, onto: string): Effect.Effect<void, GitError | RebaseConflict>
    /** git rebase --abort: puts back the branch a stopped rebase was rewriting. */
    abortRebase(worktree: string): Effect.Effect<void, GitError>
    /** Whether a rebase has stopped in worktree and not been finished or aborted. */
    rebaseInProgress(worktree: string): Effect.Effect<boolean, GitError>
    /**
     * git reset --hard: moves what worktree has checked out to `to`, its index and working tree
     * with it; untracked files stay.
     */
    resetBranch(worktree: string, to: string): Effect.Effect<void, GitError>
    /** git merge-base: the best common ancestor of a and b, as a full hash. */
    mergeBase(repo: string, a: string, b: string): Effect.Effect<string, GitError>
    /**
     * Whether base holds branch's changes already: merging branch into it would change nothing, as
     * after the branch was squash-merged or its commits cherry-picked onto base. git merge-tree
     * --write-tree (git 2.38 and later); conflicts are false.
     */
    holds(repo: string, base: string, branch: string): Effect.Effect<boolean, GitError>
    /** git merge --ff-only: moves the branch checked out in repo up to `branch`, if that is a fast-forward. */
    fastForward(repo: string, branch: string): Effect.Effect<void, GitError>
    /** git log base..head: the commits on head (HEAD by default) that aren't on base, newest first. */
    log(repo: string, base: string, head?: string): Effect.Effect<ReadonlyArray<Commit>, GitError>
    /** git status --porcelain: each changed or untracked file, under `paths` (pathspecs) when given. */
    status(
      dir: string,
      paths?: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<StatusEntry>, GitError>
    /**
     * git diff --name-only base...head: the files head (HEAD by default) changed since it left base,
     * a renamed file under both its paths.
     */
    changedFiles(
      dir: string,
      base: string,
      head?: string,
    ): Effect.Effect<ReadonlyArray<string>, GitError>
    /**
     * git diff --name-only from to: the files whose content differs between the two commits,
     * whatever their history, a renamed file under both its paths.
     */
    filesBetween(
      dir: string,
      from: string,
      to: string,
    ): Effect.Effect<ReadonlyArray<string>, GitError>
    /** git show <commit>:<path>: the file at `path` from the repository's top, as `commit` has it. */
    fileAt(dir: string, commit: string, path: string): Effect.Effect<string, GitError>
    /** git ls-files: the files git tracks. */
    trackedFiles(dir: string): Effect.Effect<ReadonlyArray<string>, GitError>
    /**
     * git check-attr merge: those of `paths` git merges by union (`merge=union` in .gitattributes),
     * tracked or not, as dir's .gitattributes say.
     */
    mergedByUnion(
      dir: string,
      paths: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, GitError>
    /** git rev-parse --verify: the full hash `rev` names; GitFailed when it names none. */
    revParse(dir: string, rev: string): Effect.Effect<string, GitError>
    /** git rev-parse --git-common-dir: the absolute path of the git folder every worktree shares. */
    commonDir(dir: string): Effect.Effect<string, GitError>
    /** git rev-parse --show-toplevel: the top of the checkout dir is in, a linked worktree's own. */
    topLevel(dir: string): Effect.Effect<string, GitError>
    /** The branch checked out in dir; none on a detached HEAD. */
    currentBranch(dir: string): Effect.Effect<Option.Option<string>, GitError>
    /** git --version: what git says it is, as `git version 2.47.1`, for `gitTooOld`. */
    version(dir: string): Effect.Effect<string, GitError>
  }
>()("tutti/services/Git") {
  /**
   * git, with every write taking GitWriter. `command`, `timeLimits` and `maxOutputBytes` (exec's
   * cap on the output kept) are there for tests.
   */
  static readonly layer = (
    options: {
      readonly command?: string
      readonly timeLimits?: { readonly read: Duration.Input; readonly write: Duration.Input }
      readonly maxOutputBytes?: number
    } = {},
  ) =>
    Layer.effect(
      Git,
      Effect.gen(function* () {
        const writer = yield* GitWriter
        const fs = yield* FileSystem.FileSystem
        const context = yield* Effect.context<
          ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
        >()
        const bin = options.command ?? "git"
        const limits = options.timeLimits ?? TimeLimit
        const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes

        // Runs git in dir and returns its output whatever its exit code.
        const git = (
          op: string,
          dir: string,
          args: ReadonlyArray<string>,
          timeLimit: Duration.Input,
          env?: Readonly<Record<string, string>>,
          stdin?: string,
        ) => {
          const command: Command = {
            command: bin,
            args,
            timeLimit,
            cwd: dir,
            maxOutputBytes,
            ...(stdin === undefined ? {} : { stdin }),
            // No prompt for credentials or an editor can hold a command until its time limit.
            env: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...env },
          }
          const shown = showCommand({ command: "git", args })
          return exec(command).pipe(
            Effect.catchTags({
              CommandTimedOut: (error) =>
                Effect.fail(new GitTimedOut({ op, command: shown, timeLimit: error.timeLimit })),
              CommandNotRun: (error) =>
                Effect.fail(
                  new GitFailed({ op, command: shown, exitCode: 127, stderr: error.reason }),
                ),
            }),
            Effect.provideContext(context),
            Effect.map((output) => ({ shown, output })),
          )
        }

        const failed = (op: string, shown: string, output: Output) =>
          new GitFailed({ op, command: shown, exitCode: output.exitCode, stderr: output.stderr })

        const succeeded =
          (op: string) =>
          ({ shown, output }: { shown: string; output: Output }) =>
            output.exitCode === 0
              ? Effect.succeed(output.stdout)
              : Effect.fail(failed(op, shown, output))

        // A read takes no optional lock (the index's, as status refreshes it), so it can't make a
        // worker's own git command fail on a lock held for a moment. Its output past exec's cap
        // would have lost its start, a partial first field and the entries before it, so it fails.
        const gitRead = (op: string, dir: string, args: ReadonlyArray<string>, stdin?: string) =>
          Effect.flatMap(
            git(op, dir, args, limits.read, { GIT_OPTIONAL_LOCKS: "0" }, stdin),
            ({ shown, output }) =>
              output.truncated.stdout
                ? Effect.fail(
                    new GitFailed({
                      op,
                      command: shown,
                      exitCode: output.exitCode,
                      stderr: `${outputCut(maxOutputBytes)}\n${output.stderr}`,
                    }),
                  )
                : Effect.succeed({ shown, output }),
          )

        const read = (op: string, dir: string, args: ReadonlyArray<string>, stdin?: string) =>
          Effect.flatMap(gitRead(op, dir, args, stdin), succeeded(op))

        const write = (op: string, dir: string, args: ReadonlyArray<string>) =>
          writer.withLock(Effect.flatMap(git(op, dir, args, limits.write), succeeded(op)))

        const abortRebase = (worktree: string) =>
          Effect.asVoid(write("rebase --abort", worktree, ["rebase", "--abort"]))

        // --verify: without it, git prints back a rev it can't find as if it named a commit.
        const revParse = (dir: string, rev: string) =>
          Effect.map(
            read("rev-parse", dir, ["rev-parse", "--verify", "--quiet", ...revisions([rev])]),
            (out) => out.trim(),
          )

        // git reset before 2.44 keeps --end-of-options among its arguments and takes it for a
        // revision, so it is given the hash `to` names, which no option or path can be taken for.
        const resetBranch = (worktree: string, to: string) =>
          writer.withLock(
            Effect.flatMap(revParse(worktree, to), (hash) =>
              Effect.asVoid(
                write("reset --hard", worktree, ["reset", "--hard", "--quiet", hash, "--"]),
              ),
            ),
          )

        const rebaseInProgress = (worktree: string) =>
          Effect.gen(function* () {
            for (const name of ["rebase-merge", "rebase-apply"]) {
              const path = yield* read("rev-parse --git-path", worktree, [
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                name,
              ])
              // A folder that can't be shown to be gone counts: the rebase can't be shown to be over.
              const exists = yield* fs.exists(path.trim()).pipe(Effect.orElseSucceed(() => true))
              if (exists) return true
            }
            return false
          })

        // Puts the branch back after a rebase that didn't finish, if one is under way. git may have
        // been killed before it began one, which leaves nothing to abort.
        const abandonRebase = (worktree: string) =>
          rebaseInProgress(worktree).pipe(
            Effect.flatMap((inProgress) => (inProgress ? abortRebase(worktree) : Effect.void)),
            Effect.ignore,
          )

        const rebase = (worktree: string, onto: string) =>
          writer.withLock(
            Effect.gen(function* () {
              const { shown, output } = yield* git(
                "rebase",
                worktree,
                ["rebase", "--no-autostash", ...revisions([onto])],
                limits.write,
              ).pipe(Effect.tapError(() => abandonRebase(worktree)))
              if (output.exitCode === 0) return
              const conflicted = yield* read("diff --diff-filter=U", worktree, [
                "diff",
                "--name-only",
                "-z",
                "--diff-filter=U",
              ]).pipe(Effect.orElseSucceed(() => ""))
              const files = splitNul(conflicted)
              if (files.length > 0) return yield* new RebaseConflict({ files })
              yield* abandonRebase(worktree)
              return yield* failed("rebase", shown, output)
            }).pipe(
              // Interrupted anywhere before it reports, up to reading the conflicts, it is put back.
              Effect.onInterrupt(() => abandonRebase(worktree)),
            ),
          )

        return Git.of({
          addWorktree: (repo, path, worktree) =>
            Effect.asVoid(
              write(
                "worktree add",
                repo,
                worktree.base === undefined
                  ? ["worktree", "add", "--quiet", path, ...revisions([worktree.branch])]
                  : [
                      "worktree",
                      "add",
                      "--quiet",
                      "-b",
                      worktree.branch,
                      path,
                      ...revisions([worktree.base]),
                    ],
              ),
            ),
          addDetachedWorktree: (repo, path, commit) =>
            Effect.asVoid(
              write("worktree add", repo, [
                "worktree",
                "add",
                "--quiet",
                "--detach",
                path,
                ...revisions([commit]),
              ]),
            ),
          removeWorktree: (repo, path, remove = {}) =>
            Effect.asVoid(
              write("worktree remove", repo, [
                "worktree",
                "remove",
                ...(remove.force ? ["--force"] : []),
                path,
              ]),
            ),
          worktrees: (repo) =>
            Effect.map(
              read("worktree list", repo, ["worktree", "list", "--porcelain", "-z"]),
              parseWorktrees,
            ),
          pruneWorktrees: (repo) =>
            Effect.asVoid(write("worktree prune", repo, ["worktree", "prune"])),
          createBranch: (repo, branch, start) =>
            Effect.asVoid(write("branch", repo, ["branch", ...revisions([branch, start])])),
          // Deleting a ref takes packed-refs.lock, which a worker's commit in its worktree takes for a
          // moment too; git gives up after a second, too soon on a loaded machine, so it waits longer.
          deleteBranch: (repo, branch, remove = {}) =>
            Effect.asVoid(
              write("branch -d", repo, [
                "-c",
                "core.packedRefsTimeout=10000",
                "branch",
                remove.force ? "-D" : "-d",
                ...revisions([branch]),
              ]),
            ),
          rebase,
          abortRebase,
          rebaseInProgress,
          resetBranch,
          mergeBase: (repo, a, b) =>
            Effect.map(read("merge-base", repo, ["merge-base", ...revisions([a, b])]), (out) =>
              out.trim(),
            ),
          holds: (repo, base, branch) =>
            Effect.gen(function* () {
              const { shown, output } = yield* gitRead("merge-tree", repo, [
                "merge-tree",
                "--write-tree",
                ...revisions([base, branch]),
              ])
              // The merged tree's hash is its first line; exit 1 is conflicts, a merge that changes base.
              if (output.exitCode === 1) return false
              if (output.exitCode !== 0) return yield* failed("merge-tree", shown, output)
              const tree = yield* revParse(repo, `${base}^{tree}`)
              return (output.stdout.split("\n")[0] ?? "").trim() === tree.trim()
            }),
          fastForward: (repo, branch) =>
            Effect.asVoid(
              write("merge --ff-only", repo, [
                "merge",
                "--ff-only",
                "--quiet",
                ...revisions([branch]),
              ]),
            ),
          log: (repo, base, head = "HEAD") =>
            Effect.map(
              read("log", repo, [
                "log",
                "-z",
                "--no-show-signature",
                logFormat,
                ...revisions([`${base}..${head}`], []),
              ]),
              parseLog,
            ),
          status: (dir, paths = []) =>
            Effect.map(
              read("status", dir, [
                "status",
                "--porcelain",
                "-z",
                "--untracked-files=all",
                "--",
                ...paths,
              ]),
              parseStatus,
            ),
          changedFiles: (dir, base, head = "HEAD") =>
            Effect.map(
              read("diff --name-only", dir, [
                "diff",
                "--no-renames",
                "--name-only",
                "-z",
                ...revisions([`${base}...${head}`], []),
              ]),
              splitNul,
            ),
          filesBetween: (dir, from, to) =>
            Effect.map(
              read("diff --name-only", dir, [
                "diff",
                "--no-renames",
                "--name-only",
                "-z",
                ...revisions([from, to], []),
              ]),
              splitNul,
            ),
          fileAt: (dir, commit, path) =>
            read("show", dir, ["show", ...revisions([`${commit}:${path}`])]),
          trackedFiles: (dir) => Effect.map(read("ls-files", dir, ["ls-files", "-z"]), splitNul),
          // The paths go in on stdin, NUL-separated, so a repository of any size fits; -z gives
          // back a path, the attribute and its value for each.
          mergedByUnion: (dir, paths) =>
            paths.length === 0
              ? Effect.succeed([])
              : Effect.map(
                  read(
                    "check-attr",
                    dir,
                    ["check-attr", "-z", "--stdin", "merge"],
                    paths.map((path) => `${path}\0`).join(""),
                  ),
                  parseUnion,
                ),
          revParse,
          commonDir: (dir) =>
            Effect.map(
              read("rev-parse --git-common-dir", dir, [
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
              ]),
              (out) => out.trim(),
            ),
          topLevel: (dir) =>
            Effect.map(
              read("rev-parse --show-toplevel", dir, ["rev-parse", "--show-toplevel"]),
              (out) => out.trim(),
            ),
          currentBranch: (dir) =>
            Effect.flatMap(
              gitRead("symbolic-ref", dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
              ({ shown, output }) =>
                // --quiet: exit 1, saying nothing, is HEAD naming no branch.
                output.exitCode === 0
                  ? Effect.succeed(Option.some(output.stdout.trim()))
                  : output.exitCode === 1 && output.stderr.trim() === ""
                    ? Effect.succeed(Option.none())
                    : Effect.fail(failed("symbolic-ref", shown, output)),
            ),
          version: (dir) => Effect.map(read("--version", dir, ["--version"]), (out) => out.trim()),
        })
      }),
    )
}
