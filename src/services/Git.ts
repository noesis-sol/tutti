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
import { formatDuration } from "../project/configFile.ts"
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

/** What git said of its failure, in a few words. */
export const gitWhy = (error: GitError): string =>
  error._tag === "GitFailed"
    ? (error.stderr.trim().split("\n")[0] ?? "") || `exit code ${error.exitCode}`
    : `git took longer than ${formatDuration(error.timeLimit)}`

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
  readonly head?: Sha
  /** The branch checked out, without `refs/heads/`; absent on a detached HEAD. */
  readonly branch?: string
  /** Its folder is gone, and `git worktree prune` would forget it. */
  readonly prunable: boolean
}

export interface Commit {
  /** The full hash. */
  readonly hash: Sha
  readonly subject: string
  /** The whole message, subject included. */
  readonly message: string
}

/**
 * Whether `text` is a commit hash, abbreviated or whole, and so a revision git can't take for an
 * option or a range.
 */
export const isHash = (text: string): boolean => /^[0-9a-f]{7,64}$/.test(text)

declare const shaBrand: unique symbol

/**
 * A commit's hash, as git gave it (revParse, mergeBase, log) or Sha.parse read it: a type of its
 * own, so a hash can't be passed for a ticket, a branch or another string beside it. Where git
 * couldn't say what the commit is, there is none (undefined), not an empty one.
 */
export type Sha = string & { readonly [shaBrand]: true }

export const Sha = {
  /** `text` as a commit hash, abbreviated or whole; undefined when it isn't one. */
  parse: (text: unknown): Sha | undefined =>
    typeof text === "string" && isHash(text) ? (text as Sha) : undefined,
  /** The hash git printed for a commit, trimmed: what git says is a hash. */
  of: (said: string): Sha => said.trim() as Sha,
} as const

/** A commit's hash as a line names it: its first 7 characters, as git abbreviates it. */
export const shortHash = (hash: string): string => hash.slice(0, 7)

/**
 * A commit's hash as a note or a prompt hands it on for git to be given (git show, git reset): its
 * first 10 characters, which stay unambiguous in a repository where 7 may not.
 */
export const givenHash = (hash: string): string => hash.slice(0, 10)

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

/**
 * Reads `git check-attr -z linguist-vendored`'s output: the paths whose attribute is set or true,
 * which linguist counts as vendored.
 */
export const parseVendored = (output: string): ReadonlyArray<string> => {
  const fields = output.split("\0")
  const vendored: Array<string> = []
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === "set" || fields[i + 2] === "true") vendored.push(fields[i] ?? "")
  }
  return vendored
}

/** Reads `git worktree list --porcelain -z`: attribute lines ended by NULs, a worktree's last by two. */
export const parseWorktrees = (output: string): ReadonlyArray<Worktree> => {
  const worktrees: Array<Worktree> = []
  let current: { path: string; head?: Sha; branch?: string; prunable: boolean } | undefined
  for (const line of output.split("\0")) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) worktrees.push(current)
      current = { path: line.slice("worktree ".length), prunable: false }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith("HEAD ")) {
      current.head = Sha.of(line.slice("HEAD ".length))
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

/** A merge commit on a branch beyond the base it is rebased onto, as `branchMerges` reads it. */
export interface BranchMerge {
  readonly hash: Sha
  readonly tree: Sha
  /** Its first parent first. */
  readonly parents: ReadonlyArray<Sha>
}

/** Reads `git log --merges --format='%H %T %P'`: a merge's hash, tree and parents a line. */
export const parseMerges = (output: string): ReadonlyArray<BranchMerge> =>
  output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 4)
    .map(([hash, tree, ...parents]) => ({
      hash: Sha.of(hash ?? ""),
      tree: Sha.of(tree ?? ""),
      parents: parents.map(Sha.of),
    }))

/**
 * How a rebase replays the branch: `linear`, its commits in a line, as git rebases by default;
 * `merges`, its merges recreated by git (--rebase-merges); `replaying`, its merges recreated, those
 * whose other parents share no history with the base (a `git subtree add`'s squashed commit) by
 * replaying what each changed on its first parent (`rebaseMergesScript`), the rest by git.
 */
export type RebaseHow = "linear" | "merges" | "replaying"

/** What a rebase that finished did: whether it recreated merges, the branch having some. */
export interface Rebased {
  readonly merges: boolean
}

/**
 * The script a `replaying` rebase runs, from the worktree's git folder, as `sh <script> edit <todo>`
 * (its sequence editor) and `sh <script> merge …` (an exec line of its todo). git rebase
 * --rebase-merges recreates a merge by merging its parents again, which loses what the merge itself
 * changed: the subtree `git subtree add` reads in under its prefix (its squashed commit's files land
 * at the root, conflicting with the repository's own). So the editor rewrites each
 * `merge -C <merge> <label>…` line of the merges TUTTI_REBASE_REPLAY names, a space between them,
 * those whose other parents the rebase leaves as they are, sharing no history with the base, into a
 * pick of a commit holding the merge's tree on its first parent, which replays its change as any
 * pick does, stopping on conflicts its worker resolves with git add and git rebase --continue; then
 * an exec that makes HEAD the merge again, its tree with the merge's message, author and other
 * parents. Where the pick was dropped, its change on the base already, the merge goes on HEAD.
 * Written down for each rebase, as the exec runs again when a worker continues one stopped there.
 */
export const rebaseMergesScript = `# tutti's rebase of a branch's merges (src/services/Git.ts, rebaseMergesScript).
set -euf
case $1 in
edit)
  todo=$2
  : > "$todo.tutti"
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
    "merge -C "*)
      set -- $line
      merge=$(git rev-parse --verify "$3^{commit}")
      case " $TUTTI_REBASE_REPLAY " in
      *" $merge "*)
        shift 3
        labels=""
        for label; do
          [ "$label" = "#" ] && break
          labels="$labels $label"
        done
        pick=$(git log -1 --format=%B "$merge" | git commit-tree "$merge^{tree}" -p "$merge^1")
        printf 'label tutti-%s\\npick %s\\nexec %s merge %s tutti-%s%s\\n' "$merge" "$pick" "$TUTTI_REBASE_SCRIPT" "$merge" "$merge" "$labels" >> "$todo.tutti"
        continue
        ;;
      esac
      ;;
    esac
    printf '%s\\n' "$line" >> "$todo.tutti"
  done < "$todo"
  mv "$todo.tutti" "$todo"
  ;;
merge)
  merge=$2
  before=$(git rev-parse --verify "refs/rewritten/$3")
  shift 3
  head=$(git rev-parse --verify HEAD)
  first=$head
  [ "$head" = "$before" ] || first=$(git rev-parse --verify HEAD^)
  parents="-p $first"
  for label; do
    parent=$(git rev-parse --quiet --verify "refs/rewritten/$label^{commit}" || git rev-parse --verify "$label^{commit}")
    parents="$parents -p $parent"
  done
  GIT_AUTHOR_NAME=$(git log -1 --format=%an "$merge")
  GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae "$merge")
  GIT_AUTHOR_DATE=$(git log -1 --format=%ad --date=raw "$merge")
  export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE
  commit=$(git log -1 --format=%B "$merge" | git commit-tree "HEAD^{tree}" $parents)
  git update-ref -m "rebase (merge): $(git log -1 --format=%s "$merge")" HEAD "$commit"
  ;;
esac
`

/** Where a `replaying` rebase keeps `rebaseMergesScript`, in the worktree's git folder. */
export const rebaseMergesFile = "tutti-rebase-merges.sh"

/** A word the shell reads as `text`, whatever it holds. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

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
 * Every git command the Git service runs, by the operation that runs it: the name GitFailed and
 * GitTimedOut give it (`op`), whether it is a write, which takes GitWriter and a write's time limit,
 * or a read, and its arguments. The live layer gives them to git, and the test layer records,
 * faults and shows them as the live layer would.
 */
export const gitOps = {
  addWorktree: {
    op: "worktree add",
    kind: "write",
    args: (path: string, worktree: WorktreeOptions): ReadonlyArray<string> =>
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
  },
  addDetachedWorktree: {
    op: "worktree add",
    kind: "write",
    args: (path: string, commit: string): ReadonlyArray<string> => [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      path,
      ...revisions([commit]),
    ],
  },
  removeWorktree: {
    op: "worktree remove",
    kind: "write",
    args: (path: string, force = false): ReadonlyArray<string> => [
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      path,
    ],
  },
  worktrees: {
    op: "worktree list",
    kind: "read",
    args: (): ReadonlyArray<string> => ["worktree", "list", "--porcelain", "-z"],
  },
  pruneWorktrees: {
    op: "worktree prune",
    kind: "write",
    args: (): ReadonlyArray<string> => ["worktree", "prune"],
  },
  createBranch: {
    op: "branch",
    kind: "write",
    args: (branch: string, start: string): ReadonlyArray<string> => [
      "branch",
      ...revisions([branch, start]),
    ],
  },
  // Deleting a ref takes packed-refs.lock, which a worker's commit in its worktree takes for a
  // moment too; git gives up after a second, too soon on a loaded machine, so it waits longer.
  deleteBranch: {
    op: "branch -d",
    kind: "write",
    args: (branch: string, force = false): ReadonlyArray<string> => [
      "-c",
      "core.packedRefsTimeout=10000",
      "branch",
      force ? "-D" : "-d",
      ...revisions([branch]),
    ],
  },
  // --no-update-refs: with the user's rebase.updateRefs set, git would move every other branch
  // that points into the rebased range (a backup, orchestra's wt/<id>) along with this one, and
  // putting the branch back resets only this one. `replaying` is interactive, for its editor to
  // rewrite the todo (rebaseMergesScript): the todo's commands spelt out and none of the user's
  // checks on it, its commits squashed by none of their autosquash, one made empty dropped.
  rebase: {
    op: "rebase",
    kind: "write",
    args: (onto: string, how: RebaseHow = "linear"): ReadonlyArray<string> => [
      ...(how === "replaying"
        ? ["-c", "rebase.abbreviateCommands=false", "-c", "rebase.missingCommitsCheck=ignore"]
        : []),
      "rebase",
      ...(how === "linear" ? [] : ["--rebase-merges"]),
      ...(how === "replaying" ? ["--interactive", "--no-autosquash", "--empty=drop"] : []),
      "--no-autostash",
      "--no-update-refs",
      ...revisions([onto]),
    ],
  },
  /** The merges on HEAD beyond `onto`, a line each: hash, tree and parents. */
  branchMerges: {
    op: "log --merges",
    kind: "read",
    args: (onto: string): ReadonlyArray<string> => [
      "log",
      "--merges",
      "--no-show-signature",
      "--format=%H %T %P",
      ...revisions([`${onto}..HEAD`], []),
    ],
  },

  /** The files a stopped rebase left conflicted. */
  conflicted: {
    op: "diff --diff-filter=U",
    kind: "read",
    args: (): ReadonlyArray<string> => ["diff", "--name-only", "-z", "--diff-filter=U"],
  },
  abortRebase: {
    op: "rebase --abort",
    kind: "write",
    args: (): ReadonlyArray<string> => ["rebase", "--abort"],
  },
  /** Where git keeps each of these names, a line each, as `rebaseFolders`. */
  gitPaths: {
    op: "rev-parse --git-path",
    kind: "read",
    args: (names: ReadonlyArray<string>): ReadonlyArray<string> => [
      "rev-parse",
      "--path-format=absolute",
      ...names.flatMap((name) => ["--git-path", name]),
    ],
  },
  // The hash, as resetTo gives it: git reset before 2.44 keeps --end-of-options among its
  // arguments and takes it for a revision.
  reset: {
    op: "reset --hard",
    kind: "write",
    args: (hash: string): ReadonlyArray<string> => ["reset", "--hard", "--quiet", hash, "--"],
  },
  mergeBase: {
    op: "merge-base",
    kind: "read",
    args: (a: string, b: string): ReadonlyArray<string> => ["merge-base", ...revisions([a, b])],
  },
  holds: {
    op: "merge-tree",
    kind: "read",
    args: (base: string, branch: string): ReadonlyArray<string> => [
      "merge-tree",
      "--write-tree",
      ...revisions([base, branch]),
    ],
  },
  fastForward: {
    op: "merge --ff-only",
    kind: "write",
    args: (branch: string): ReadonlyArray<string> => [
      "merge",
      "--ff-only",
      "--quiet",
      ...revisions([branch]),
    ],
  },
  log: {
    op: "log",
    kind: "read",
    args: (base: string, head: string): ReadonlyArray<string> => [
      "log",
      "-z",
      "--no-show-signature",
      logFormat,
      ...revisions([`${base}..${head}`], []),
    ],
  },
  // --only: what the paths hold in the working tree, whatever else is staged; a message given
  // with -F - would need input, so it goes as -m.
  commitPaths: {
    op: "commit",
    kind: "write",
    args: (message: string, paths: ReadonlyArray<string>): ReadonlyArray<string> => [
      "commit",
      "--quiet",
      "-m",
      message,
      "--only",
      "--",
      ...paths,
    ],
  },
  addPaths: {
    op: "add",
    kind: "write",
    args: (paths: ReadonlyArray<string>): ReadonlyArray<string> => ["add", "--", ...paths],
  },
  // --quiet: exit 0 is ignored, 1 is not, saying nothing.
  ignored: {
    op: "check-ignore",
    kind: "read",
    args: (path: string): ReadonlyArray<string> => ["check-ignore", "--quiet", "--", path],
  },
  lastCommit: {
    op: "log",
    kind: "read",
    args: (path: string): ReadonlyArray<string> => [
      "log",
      "-1",
      "-z",
      "--no-show-signature",
      logFormat,
      "--",
      path,
    ],
  },
  diffOf: {
    op: "diff",
    kind: "read",
    args: (from: string, to: string, path: string): ReadonlyArray<string> => [
      "diff",
      "--no-color",
      "--no-ext-diff",
      ...revisions([from, to], [path]),
    ],
  },
  status: {
    op: "status",
    kind: "read",
    args: (paths: ReadonlyArray<string>): ReadonlyArray<string> => [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--",
      ...paths,
    ],
  },
  changedFiles: {
    op: "diff --name-only",
    kind: "read",
    args: (base: string, head: string): ReadonlyArray<string> => [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      ...revisions([`${base}...${head}`], []),
    ],
  },
  filesBetween: {
    op: "diff --name-only",
    kind: "read",
    args: (from: string, to: string): ReadonlyArray<string> => [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      ...revisions([from, to], []),
    ],
  },
  fileAt: {
    op: "show",
    kind: "read",
    args: (commit: string, path: string): ReadonlyArray<string> => [
      "show",
      ...revisions([`${commit}:${path}`]),
    ],
  },
  trackedFiles: {
    op: "ls-files",
    kind: "read",
    args: (): ReadonlyArray<string> => ["ls-files", "-z"],
  },
  // The paths go in on stdin, NUL-separated, so a repository of any size fits; -z gives back a
  // path, the attribute and its value for each.
  mergedByUnion: {
    op: "check-attr",
    kind: "read",
    args: (): ReadonlyArray<string> => ["check-attr", "-z", "--stdin", "merge"],
  },
  // As mergedByUnion: the paths on stdin, a path, the attribute and its value back for each.
  vendoredFiles: {
    op: "check-attr linguist-vendored",
    kind: "read",
    args: (): ReadonlyArray<string> => ["check-attr", "-z", "--stdin", "linguist-vendored"],
  },
  // --verify: without it, git prints back a rev it can't find as if it named a commit.
  revParse: {
    op: "rev-parse",
    kind: "read",
    args: (rev: string): ReadonlyArray<string> => [
      "rev-parse",
      "--verify",
      "--quiet",
      ...revisions([rev]),
    ],
  },
  branchExists: {
    op: "show-ref",
    kind: "read",
    args: (branch: string): ReadonlyArray<string> => [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ],
  },
  // A pattern ending in / takes every ref under it; the full name can't read as another ref's.
  branches: {
    op: "for-each-ref",
    kind: "read",
    args: (folder: string): ReadonlyArray<string> => [
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${folder}/`,
    ],
  },
  commonDir: {
    op: "rev-parse --git-common-dir",
    kind: "read",
    args: (): ReadonlyArray<string> => ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  },
  topLevel: {
    op: "rev-parse --show-toplevel",
    kind: "read",
    args: (): ReadonlyArray<string> => ["rev-parse", "--show-toplevel"],
  },
  // --quiet: exit 1, saying nothing, is HEAD naming no branch.
  currentBranch: {
    op: "symbolic-ref",
    kind: "read",
    args: (): ReadonlyArray<string> => ["symbolic-ref", "--quiet", "--short", "HEAD"],
  },
  version: {
    op: "--version",
    kind: "read",
    args: (): ReadonlyArray<string> => ["--version"],
  },
} as const satisfies Record<
  string,
  {
    readonly op: string
    readonly kind: "read" | "write"
    readonly args: (...args: never[]) => ReadonlyArray<string>
  }
>

/** An operation's name, as GitFailed gives it and a test faults it: `rebase`, `merge --ff-only`, … */
export type GitOp = (typeof gitOps)[keyof typeof gitOps]["op"]

/** A read, or a write, which takes GitWriter. */
export type GitKind = "read" | "write"

/** One call of an operation: its name, its kind and the arguments git is given. */
export interface GitCall<K extends GitKind = GitKind> {
  readonly op: GitOp
  readonly kind: K
  readonly args: ReadonlyArray<string>
  /** Variables git is given besides the live layer's own, as a `replaying` rebase's editor. */
  readonly env?: Readonly<Record<string, string>>
}

/** The call of an operation of `gitOps` with these arguments. */
export const gitCall = <K extends GitKind, A extends ReadonlyArray<unknown>>(
  operation: {
    readonly op: GitOp
    readonly kind: K
    readonly args: (...args: A) => ReadonlyArray<string>
  },
  ...args: A
): GitCall<K> => ({ op: operation.op, kind: operation.kind, args: operation.args(...args) })

/** The folders a rebase keeps its state in while one is under way, `gitPaths` asks for both. */
export const rebaseFolders: ReadonlyArray<string> = ["rebase-merge", "rebase-apply"]

/**
 * git reset --hard to `to`, as resetBranch does it: rev-parse first, then reset to the hash `to`
 * names, which no option or path can be taken for, as the one writer throughout. The live and test
 * layers each give their own revParse and reset steps.
 */
export const resetTo =
  <E1, E2>(
    writer: GitWriter["Service"],
    revParse: (dir: string, rev: string) => Effect.Effect<Sha, E1>,
    reset: (dir: string, hash: Sha) => Effect.Effect<void, E2>,
  ) =>
  (worktree: string, to: string): Effect.Effect<void, E1 | E2> =>
    writer.withLock(Effect.flatMap(revParse(worktree, to), (hash) => reset(worktree, hash)))

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
    commits.push({ hash: Sha.of(hash), subject: fields[i + 1] ?? "", message: fields[i + 2] ?? "" })
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
     * it is aborted, and the branch is as it was. No other branch moves, whatever rebase.updateRefs
     * says. A branch with merges beyond `onto` keeps them, recreated on it (`RebaseHow`), and the
     * rebase says so; one without is rebased in a line.
     */
    rebase(worktree: string, onto: string): Effect.Effect<Rebased, GitError | RebaseConflict>
    /** git rebase --abort: puts back the branch a stopped rebase was rewriting. */
    abortRebase(worktree: string): Effect.Effect<void, GitError>
    /** Whether a rebase has stopped in worktree and not been finished or aborted. */
    rebaseInProgress(worktree: string): Effect.Effect<boolean, GitError>
    /**
     * Puts back the branch a rebase that didn't finish was rewriting, if one is under way in
     * worktree: git rebase --abort when rebaseInProgress says so. A failure is let go.
     */
    abandonRebase(worktree: string): Effect.Effect<void>
    /**
     * git reset --hard: moves what worktree has checked out to `to`, its index and working tree
     * with it; untracked files stay.
     */
    resetBranch(worktree: string, to: string): Effect.Effect<void, GitError>
    /** git merge-base: the best common ancestor of a and b, as a full hash. */
    mergeBase(repo: string, a: string, b: string): Effect.Effect<Sha, GitError>
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
    /**
     * git commit --only: commits what `paths`, tracked files, hold in repo's working tree onto the
     * branch it has checked out, whatever else is staged.
     */
    commitPaths(
      repo: string,
      message: string,
      paths: ReadonlyArray<string>,
    ): Effect.Effect<void, GitError>
    /** git add: stages what `paths` hold in repo's working tree, untracked files included. */
    addPaths(repo: string, paths: ReadonlyArray<string>): Effect.Effect<void, GitError>
    /** git check-ignore: whether git ignores `path`, relative to dir. */
    ignored(dir: string, path: string): Effect.Effect<boolean, GitError>
    /** git log -1 -- <path>: the last commit that changed `path` on HEAD; none for none. */
    lastCommit(dir: string, path: string): Effect.Effect<Option.Option<Commit>, GitError>
    /** git diff from to -- <path>: how `path` changed between the two commits; "" for not at all. */
    diffOf(dir: string, from: string, to: string, path: string): Effect.Effect<string, GitError>
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
    /**
     * git check-attr linguist-vendored: those of `paths` .gitattributes marks vendored
     * (`linguist-vendored`, or `linguist-vendored=true`), tracked or not, as dir's .gitattributes say.
     */
    vendoredFiles(
      dir: string,
      paths: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, GitError>
    /** git rev-parse --verify: the full hash `rev` names; GitFailed when it names none. */
    revParse(dir: string, rev: string): Effect.Effect<Sha, GitError>
    /**
     * git show-ref --verify --quiet refs/heads/<branch>: whether the branch is there. Its exit 1 is
     * a missing branch, whatever git said; any other failure is git's.
     */
    branchExists(repo: string, branch: string): Effect.Effect<boolean, GitError>
    /**
     * git for-each-ref refs/heads/<folder>/: the branches under the folder, by name (`tutti/a-1`),
     * in one call where branchExists takes one each.
     */
    branches(repo: string, folder: string): Effect.Effect<ReadonlyArray<string>, GitError>
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

        // Runs git in dir, with its kind's time limit, and returns its output whatever its exit
        // code. A read takes no optional lock (the index's, as status refreshes it), so it can't
        // make a worker's own git command fail on a lock held for a moment.
        const git = (call: GitCall, dir: string, stdin?: string) => {
          const { op, args } = call
          const command: Command = {
            command: bin,
            args,
            timeLimit: limits[call.kind],
            cwd: dir,
            maxOutputBytes,
            ...(stdin === undefined ? {} : { stdin }),
            // No prompt for credentials or an editor can hold a command until its time limit.
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_EDITOR: "true",
              ...(call.kind === "read" ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
              ...call.env,
            },
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

        const failed = (call: GitCall, shown: string, output: Output) =>
          new GitFailed({
            op: call.op,
            command: shown,
            exitCode: output.exitCode,
            stderr: output.stderr,
          })

        const succeeded =
          (call: GitCall) =>
          ({ shown, output }: { shown: string; output: Output }) =>
            output.exitCode === 0
              ? Effect.succeed(output.stdout)
              : Effect.fail(failed(call, shown, output))

        // A read's output past exec's cap would have lost its start, a partial first field and the
        // entries before it, so it fails.
        const gitRead = (call: GitCall<"read">, dir: string, stdin?: string) =>
          Effect.flatMap(git(call, dir, stdin), ({ shown, output }) =>
            output.truncated.stdout
              ? Effect.fail(
                  new GitFailed({
                    op: call.op,
                    command: shown,
                    exitCode: output.exitCode,
                    stderr: `${outputCut(maxOutputBytes)}\n${output.stderr}`,
                  }),
                )
              : Effect.succeed({ shown, output }),
          )

        const read = (call: GitCall<"read">, dir: string, stdin?: string) =>
          Effect.flatMap(gitRead(call, dir, stdin), succeeded(call))

        const write = (call: GitCall<"write">, dir: string) =>
          writer.withLock(Effect.flatMap(git(call, dir), succeeded(call)))

        const abortRebase = (worktree: string) =>
          Effect.asVoid(write(gitCall(gitOps.abortRebase), worktree))

        const revParse = (dir: string, rev: string) =>
          Effect.map(read(gitCall(gitOps.revParse, rev), dir), Sha.of)

        const branchExists = (repo: string, branch: string) => {
          const call = gitCall(gitOps.branchExists, branch)
          return Effect.flatMap(gitRead(call, repo), ({ shown, output }) =>
            output.exitCode === 0 || output.exitCode === 1
              ? Effect.succeed(output.exitCode === 0)
              : Effect.fail(failed(call, shown, output)),
          )
        }

        const resetBranch = resetTo(writer, revParse, (worktree, hash) =>
          Effect.asVoid(write(gitCall(gitOps.reset, hash), worktree)),
        )

        // Both folders' paths from one rev-parse, a line each.
        const rebaseInProgress = (worktree: string) =>
          Effect.gen(function* () {
            const paths = yield* read(gitCall(gitOps.gitPaths, rebaseFolders), worktree)
            for (const path of paths.split("\n").filter((line) => line !== "")) {
              // A folder that can't be shown to be gone counts: the rebase can't be shown to be over.
              const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => true))
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

        // Whether none of the merge's other parents shares history with `onto`, as a subtree's
        // squashed commit doesn't: the rebase leaves them as they are, so the merge's change on its
        // first parent, replayed, still holds all they hold. One that does, a merge of the base
        // into the branch, is git's to recreate: the rebase may give it a parent the replayed
        // change knows nothing of, as `onto` for the base merged in, and its tree would lack it.
        const apart = (worktree: string, onto: string, merge: BranchMerge) =>
          Effect.gen(function* () {
            for (const parent of merge.parents.slice(1)) {
              const call = gitCall(gitOps.mergeBase, onto, parent)
              const { shown, output } = yield* gitRead(call, worktree)
              if (output.exitCode === 0) return false
              if (output.exitCode !== 1) return yield* failed(call, shown, output)
            }
            return true
          })

        // How to rebase the branch: in a line without merges; with them, recreated by git, those
        // apart from the base replayed, the script written down for its editor and execs.
        const rebaseCall = (worktree: string, onto: string) =>
          Effect.gen(function* () {
            const merges = parseMerges(yield* read(gitCall(gitOps.branchMerges, onto), worktree))
            if (merges.length === 0) return gitCall(gitOps.rebase, onto, "linear")
            const replayed: Array<Sha> = []
            for (const merge of merges) {
              if (yield* apart(worktree, onto, merge)) replayed.push(merge.hash)
            }
            if (replayed.length === 0) return gitCall(gitOps.rebase, onto, "merges")
            const call = gitCall(gitOps.rebase, onto, "replaying")
            const path = (yield* read(
              gitCall(gitOps.gitPaths, [rebaseMergesFile]),
              worktree,
            )).trim()
            // Not written, the rebase is as if it ran and failed: nothing was begun to abort.
            yield* fs.writeFileString(path, rebaseMergesScript).pipe(
              Effect.mapError(
                (error) =>
                  new GitFailed({
                    op: call.op,
                    command: showCommand({ command: "git", args: call.args }),
                    exitCode: 1,
                    stderr: `tutti could not write ${path}: ${error.message}`,
                  }),
              ),
            )
            const script = `sh ${shellQuote(path)}`
            return {
              ...call,
              env: {
                GIT_SEQUENCE_EDITOR: `${script} edit`,
                TUTTI_REBASE_SCRIPT: script,
                TUTTI_REBASE_REPLAY: replayed.join(" "),
              },
            }
          })

        const rebase = (worktree: string, onto: string) =>
          writer.withLock(
            Effect.gen(function* () {
              const call = yield* rebaseCall(worktree, onto)
              const rebased: Rebased = { merges: call.args.includes("--rebase-merges") }
              const { shown, output } = yield* git(call, worktree).pipe(
                Effect.tapError(() => abandonRebase(worktree)),
              )
              if (output.exitCode === 0) return rebased
              const conflicted = yield* read(gitCall(gitOps.conflicted), worktree).pipe(
                Effect.orElseSucceed(() => ""),
              )
              const files = splitNul(conflicted)
              if (files.length > 0) return yield* new RebaseConflict({ files })
              yield* abandonRebase(worktree)
              return yield* failed(call, shown, output)
            }).pipe(
              // Interrupted anywhere before it reports, up to reading the conflicts, it is put back.
              Effect.onInterrupt(() => abandonRebase(worktree)),
            ),
          )

        return Git.of({
          addWorktree: (repo, path, worktree) =>
            Effect.asVoid(write(gitCall(gitOps.addWorktree, path, worktree), repo)),
          addDetachedWorktree: (repo, path, commit) =>
            Effect.asVoid(write(gitCall(gitOps.addDetachedWorktree, path, commit), repo)),
          removeWorktree: (repo, path, remove = {}) =>
            Effect.asVoid(write(gitCall(gitOps.removeWorktree, path, remove.force), repo)),
          worktrees: (repo) => Effect.map(read(gitCall(gitOps.worktrees), repo), parseWorktrees),
          pruneWorktrees: (repo) => Effect.asVoid(write(gitCall(gitOps.pruneWorktrees), repo)),
          createBranch: (repo, branch, start) =>
            Effect.asVoid(write(gitCall(gitOps.createBranch, branch, start), repo)),
          deleteBranch: (repo, branch, remove = {}) =>
            Effect.asVoid(write(gitCall(gitOps.deleteBranch, branch, remove.force), repo)),
          rebase,
          abortRebase,
          rebaseInProgress,
          abandonRebase,
          resetBranch,
          mergeBase: (repo, a, b) =>
            Effect.map(read(gitCall(gitOps.mergeBase, a, b), repo), Sha.of),
          holds: (repo, base, branch) =>
            Effect.gen(function* () {
              const call = gitCall(gitOps.holds, base, branch)
              const { shown, output } = yield* gitRead(call, repo)
              // The merged tree's hash is its first line; exit 1 is conflicts, a merge that changes base.
              if (output.exitCode === 1) return false
              if (output.exitCode !== 0) return yield* failed(call, shown, output)
              const tree = yield* revParse(repo, `${base}^{tree}`)
              return (output.stdout.split("\n")[0] ?? "").trim() === tree.trim()
            }),
          fastForward: (repo, branch) =>
            Effect.asVoid(write(gitCall(gitOps.fastForward, branch), repo)),
          log: (repo, base, head = "HEAD") =>
            Effect.map(read(gitCall(gitOps.log, base, head), repo), parseLog),
          commitPaths: (repo, message, paths) =>
            Effect.asVoid(write(gitCall(gitOps.commitPaths, message, paths), repo)),
          addPaths: (repo, paths) => Effect.asVoid(write(gitCall(gitOps.addPaths, paths), repo)),
          ignored: (dir, path) => {
            const call = gitCall(gitOps.ignored, path)
            return Effect.flatMap(gitRead(call, dir), ({ shown, output }) =>
              output.exitCode === 0
                ? Effect.succeed(true)
                : output.exitCode === 1
                  ? Effect.succeed(false)
                  : Effect.fail(failed(call, shown, output)),
            )
          },
          lastCommit: (dir, path) =>
            Effect.map(read(gitCall(gitOps.lastCommit, path), dir), (out) =>
              Option.fromNullishOr(parseLog(out)[0]),
            ),
          diffOf: (dir, from, to, path) => read(gitCall(gitOps.diffOf, from, to, path), dir),
          status: (dir, paths = []) =>
            Effect.map(read(gitCall(gitOps.status, paths), dir), parseStatus),
          changedFiles: (dir, base, head = "HEAD") =>
            Effect.map(read(gitCall(gitOps.changedFiles, base, head), dir), splitNul),
          filesBetween: (dir, from, to) =>
            Effect.map(read(gitCall(gitOps.filesBetween, from, to), dir), splitNul),
          fileAt: (dir, commit, path) => read(gitCall(gitOps.fileAt, commit, path), dir),
          trackedFiles: (dir) => Effect.map(read(gitCall(gitOps.trackedFiles), dir), splitNul),
          mergedByUnion: (dir, paths) =>
            paths.length === 0
              ? Effect.succeed([])
              : Effect.map(
                  read(
                    gitCall(gitOps.mergedByUnion),
                    dir,
                    paths.map((path) => `${path}\0`).join(""),
                  ),
                  parseUnion,
                ),
          vendoredFiles: (dir, paths) =>
            paths.length === 0
              ? Effect.succeed([])
              : Effect.map(
                  read(
                    gitCall(gitOps.vendoredFiles),
                    dir,
                    paths.map((path) => `${path}\0`).join(""),
                  ),
                  parseVendored,
                ),
          revParse,
          branchExists,
          branches: (repo, folder) =>
            Effect.map(read(gitCall(gitOps.branches, folder), repo), (out) =>
              out
                .split("\n")
                .filter((ref) => ref.startsWith("refs/heads/"))
                .map((ref) => ref.slice("refs/heads/".length)),
            ),
          commonDir: (dir) => Effect.map(read(gitCall(gitOps.commonDir), dir), (out) => out.trim()),
          topLevel: (dir) => Effect.map(read(gitCall(gitOps.topLevel), dir), (out) => out.trim()),
          currentBranch: (dir) => {
            const call = gitCall(gitOps.currentBranch)
            return Effect.flatMap(gitRead(call, dir), ({ shown, output }) =>
              output.exitCode === 0
                ? Effect.succeed(Option.some(output.stdout.trim()))
                : output.exitCode === 1 && output.stderr.trim() === ""
                  ? Effect.succeed(Option.none())
                  : Effect.fail(failed(call, shown, output)),
            )
          },
          version: (dir) => Effect.map(read(gitCall(gitOps.version), dir), (out) => out.trim()),
        })
      }),
    )
}
