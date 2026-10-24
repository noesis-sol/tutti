// Git's test layer (§ 3.3): an in-memory repository with git's semantics for the operations the Git
// service has, so whole runs can be scripted without real git (§ 13). Commits hold whole trees (a
// path to its content); each worktree has a HEAD (a branch, or detached), an index and a working
// tree, and git status, diff and ls-files are read from those. Writes take the layer's own
// GitWriter, which it provides too.
//
// A rebase replays the branch's commits onto the new base a file at a time: a file both sides
// changed, differently, conflicts (git merges lines; this merges files, so two edits to one file
// always overlap). A test can also force a conflict on a branch's next rebase, or make the next call
// of any operation fail or time out, which is how scenarios reach OFF_BRANCH, DIRTY_WORKTREE,
// REBASE_FAILED, MERGE_CONFLICT and MERGE_FAILED. A folder inside a worktree counts as the worktree,
// but paths, in and out, are always the worktree root's.
import { createHash } from "node:crypto"
import { posix } from "node:path"
import { Context, Effect, Layer, Option, Semaphore } from "effect"
import { showCommand, TimeLimit } from "../services/exec.ts"
import {
  type Commit,
  Git,
  type GitCall,
  GitFailed,
  type GitOp,
  GitTimedOut,
  GitWriter,
  gitCall,
  gitOps,
  RebaseConflict,
  rebaseFolders,
  resetTo,
  Sha,
  type StatusEntry,
  type Worktree,
} from "../services/Git.ts"

/** A tree: each file's path and content. */
export type Tree = ReadonlyMap<string, string>

/** Files to write, by path; null removes the file. */
export type Files = Readonly<Record<string, string | null>>

/** A failure to give the next call of an operation, instead of what it would do. */
export interface Fault {
  /** Only a call in this worktree (or in a folder inside it); any worktree when absent. */
  readonly dir?: string
  /** The call times out (GitTimedOut) instead of failing (GitFailed). */
  readonly timedOut?: boolean
  readonly exitCode?: number
  readonly stderr?: string
  /** How many calls fail; 1 by default. */
  readonly times?: number
}

/** A call made to the Git service: its operation, as GitFailed names it, and its folder. */
export interface Call {
  readonly op: GitOp
  readonly dir: string
}

/** The repository behind the test layer, for a test to look at or change as a worker would. */
export class Repository extends Context.Service<
  Repository,
  {
    /** The main checkout. */
    readonly dir: string
    /** Every call made to the Git service, in order. */
    readonly calls: Effect.Effect<ReadonlyArray<Call>>
    /**
     * Writes the files in dir, stages everything (git add --all) and commits on its HEAD, as a
     * worker's commit would; the commit's hash. A commit may be empty.
     */
    commit(dir: string, message: string, files?: Files): Effect.Effect<Sha>
    /** Writes the files in dir's working tree without staging them. */
    write(dir: string, files: Files): Effect.Effect<void>
    /** git add: stages the paths, or every change, untracked files included. */
    stage(dir: string, paths?: ReadonlyArray<string>): Effect.Effect<void>
    /** git checkout: a branch, or a detached HEAD at any other rev. dir must have no changes. */
    checkout(dir: string, rev: string): Effect.Effect<void>
    /** Deletes a worktree's folder behind git's back: it becomes prunable. */
    removeFolder(path: string): Effect.Effect<void>
    /**
     * git add and git rebase --continue in a worktree whose rebase stopped: writes the resolved
     * files, stages them and every conflicted file, and goes on. The files of the next conflict,
     * or none when the rebase finished.
     */
    continueRebase(dir: string, resolved?: Files): Effect.Effect<ReadonlyArray<string>>
    /** Makes the branch's next rebase that has a commit to replay stop on conflicts in these files. */
    conflict(branch: string, files: ReadonlyArray<string>): Effect.Effect<void>
    /** Makes the next call of op (`rebase`, `merge --ff-only`, `status`, …) fail. */
    fail(op: GitOp, fault?: Fault): Effect.Effect<void>
    /** The full hash rev names, in dir (the main checkout by default). */
    head(rev?: string, dir?: string): Effect.Effect<Sha>
    /** The files of the commit rev names. */
    tree(rev: string, dir?: string): Effect.Effect<Tree>
    /** A file in dir's working tree, if it has one. */
    read(dir: string, path: string): Effect.Effect<string | undefined>
  }
>()("tutti/testing/Git/Repository") {}

/** How the repository starts: one commit, `Start`, holding the files on the branch. */
export interface Seed {
  /** The main checkout; `/repo` by default. */
  readonly dir?: string
  /** `main` by default. */
  readonly branch?: string
  /** `README.md` by default. */
  readonly files?: Readonly<Record<string, string>>
  /** What `git --version` prints; `git version 2.47.1` by default. */
  readonly version?: string
}

interface CommitObject {
  readonly hash: Sha
  readonly parents: ReadonlyArray<Sha>
  readonly message: string
  readonly tree: Tree
  readonly seq: number
}

interface Rebasing {
  /** The branch being rebased; absent when HEAD was detached. */
  readonly branch?: string
  /** Where HEAD was before, which an abort puts back. */
  readonly orig: Sha
  /** The commit it stopped on, and those left to replay after it. */
  readonly stopped: CommitObject
  readonly remaining: ReadonlyArray<CommitObject>
}

interface Checkout {
  readonly path: string
  readonly seq: number
  head: { readonly branch: string } | { readonly detached: Sha }
  index: Map<string, string>
  work: Map<string, string>
  /** Conflicted paths and their status codes: UU, AA, DU or UD. */
  conflicts: Map<string, string>
  rebase?: Rebasing
  /** Its folder is gone. */
  gone: boolean
}

/** What a stopped replay leaves: the conflicted files. */
type Replayed = { readonly conflicts: ReadonlyArray<string> }

const normalize = (path: string) => {
  const normal = posix.normalize(path)
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal
}

/**
 * The merge attribute a root .gitattributes gives a path, as git check-attr reads it: the last line
 * whose pattern matches says, a pattern without a / matching the path's name, one with a / the path
 * from the root; * and ? match within a name. undefined when no line says.
 */
const mergeAttribute = (attributes: string) => {
  const rules = attributes.split("\n").flatMap((line) => {
    const [pattern, ...attrs] = line.trim().split(/\s+/)
    if (pattern === undefined || pattern === "" || pattern.startsWith("#")) return []
    let value: string | undefined
    for (const attr of attrs) {
      if (attr === "merge") value = "set"
      else if (attr === "-merge" || attr === "!merge") value = "unset"
      else if (attr.startsWith("merge=")) value = attr.slice("merge=".length)
    }
    if (value === undefined) return []
    const anchored = pattern.includes("/")
    const source = pattern
      .replace(/^\//, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
    return [{ match: new RegExp(anchored ? `^${source}$` : `(^|/)${source}$`), value }]
  })
  return (path: string): string | undefined =>
    rules.findLast((rule) => rule.match.test(path))?.value
}

/** A message as git commit -m keeps it: trailing spaces and blank lines at either end gone. */
const cleanMessage = (message: string) => {
  const lines = message.split("\n").map((line) => line.trimEnd())
  const kept = lines.filter((line, i) => line !== "" || (i > 0 && lines[i - 1] !== ""))
  while (kept[0] === "") kept.shift()
  while (kept.at(-1) === "") kept.pop()
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`
}

/** %s: the message's first paragraph on one line. */
const subjectOf = (message: string) => {
  const end = message.indexOf("\n\n")
  return (end === -1 ? message : message.slice(0, end)).trim().split("\n").join(" ")
}

const sameTree = (a: Tree, b: Tree) =>
  a.size === b.size && [...a].every(([path, content]) => b.get(path) === content)

/** The paths whose content differs between the trees, sorted. */
const changedPaths = (a: Tree, b: Tree) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort()

const under = (path: string, pathspecs: ReadonlyArray<string>) =>
  pathspecs.length === 0 ||
  pathspecs.some((spec) => {
    const prefix = normalize(spec)
    return prefix === "." || path === prefix || path.startsWith(`${prefix}/`)
  })

const setFile = (tree: Map<string, string>, path: string, content: string | undefined) => {
  if (content === undefined) tree.delete(path)
  else tree.set(path, content)
}

const markers = (ours: string | undefined, theirs: string | undefined) =>
  `<<<<<<< HEAD\n${ours ?? ""}=======\n${theirs ?? ""}>>>>>>> theirs\n`

/** An in-memory Git, its GitWriter and its Repository, starting with one commit. */
export const layer = (seed: Seed = {}): Layer.Layer<Git | GitWriter | Repository> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const writer = GitWriter.make(yield* Semaphore.make(1))
      const main = normalize(seed.dir ?? "/repo")
      const commits = new Map<Sha, CommitObject>()
      const branches = new Map<string, Sha>()
      const checkouts = new Map<string, Checkout>()
      const forced = new Map<string, ReadonlyArray<string>>()
      const faults: Array<{ op: GitOp; fault: Fault; left: number }> = []
      const calls: Array<Call> = []
      let seq = 0

      const newCommit = (parents: ReadonlyArray<Sha>, message: string, tree: Tree): Sha => {
        seq += 1
        const hash = Sha.of(
          createHash("sha1")
            .update(`${seq}\0${parents.join(" ")}\0${message}`)
            .digest("hex"),
        )
        commits.set(hash, { hash, parents, message, tree: new Map(tree), seq })
        return hash
      }

      const commitOf = (hash: Sha): CommitObject => {
        const commit = commits.get(hash)
        if (commit === undefined) throw new Error(`no commit ${hash}`)
        return commit
      }

      const treeOf = (hash: Sha): Tree => commitOf(hash).tree

      const headOf = (checkout: Checkout): Sha =>
        "branch" in checkout.head
          ? (branches.get(checkout.head.branch) as Sha)
          : checkout.head.detached

      const ancestors = (hash: Sha): Set<Sha> => {
        const found = new Set<Sha>()
        const stack = [hash]
        for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
          if (found.has(next)) continue
          found.add(next)
          stack.push(...commitOf(next).parents)
        }
        return found
      }

      const isAncestor = (a: Sha, b: Sha) => ancestors(b).has(a)

      /** The best common ancestor: one no other common ancestor descends from, the newest of those. */
      const mergeBaseOf = (a: Sha, b: Sha): Sha | undefined => {
        const ofB = ancestors(b)
        const common = [...ancestors(a)].filter((hash) => ofB.has(hash))
        const best = common.filter(
          (hash) => !common.some((other) => other !== hash && isAncestor(hash, other)),
        )
        return best.sort((x, y) => commitOf(y).seq - commitOf(x).seq)[0]
      }

      /** The checkout dir is in, the innermost when worktrees nest, unless its folder is gone. */
      const locate = (dir: string): Checkout | undefined => {
        const path = normalize(dir)
        const found = [...checkouts.values()]
          .filter((each) => path === each.path || path.startsWith(`${each.path}/`))
          .sort((a, b) => b.path.length - a.path.length)[0]
        return found?.gone ? undefined : found
      }

      /** The hash rev names: HEAD, a branch, a hash or a unique prefix of one, then ~n and ^n. */
      const resolve = (checkout: Checkout | undefined, rev: string): Sha | undefined => {
        const match = /^(.*?)((?:[~^]\d*)*)$/.exec(rev)
        const name = match?.[1] ?? rev
        const suffix = match?.[2] ?? ""
        let hash: Sha | undefined
        if (name === "HEAD" || name === "@") {
          hash = checkout === undefined ? undefined : headOf(checkout)
        } else if (branches.has(name)) {
          hash = branches.get(name)
        } else if (name.startsWith("refs/heads/") && branches.has(name.slice(11))) {
          hash = branches.get(name.slice(11))
        } else if (/^[0-9a-f]{4,40}$/.test(name)) {
          const matching = [...commits.keys()].filter((each) => each.startsWith(name))
          hash = matching.length === 1 ? matching[0] : undefined
        }
        for (const step of suffix.match(/[~^]\d*/g) ?? []) {
          if (hash === undefined) return undefined
          const n = step.length === 1 ? 1 : Number(step.slice(1))
          if (step.startsWith("~")) {
            for (let i = 0; i < n && hash !== undefined; i++) hash = commitOf(hash).parents[0]
          } else if (n > 0) {
            hash = commitOf(hash).parents[n - 1]
          }
        }
        return hash
      }

      const untracked = (checkout: Checkout) =>
        [...checkout.work.keys()].filter(
          (path) => !checkout.index.has(path) && !checkout.conflicts.has(path),
        )

      /** Tracked files whose working copy differs from the index, and whether the index differs from HEAD. */
      const changes = (checkout: Checkout) => {
        const head = treeOf(headOf(checkout))
        const unstaged = [...checkout.index.keys()].filter(
          (path) => checkout.work.get(path) !== checkout.index.get(path),
        )
        return { unstaged, staged: changedPaths(head, checkout.index) }
      }

      /** Checks out the tree, keeping untracked files. */
      const switchTo = (checkout: Checkout, tree: Tree) => {
        const kept = untracked(checkout).map((path) => [path, checkout.work.get(path) as string])
        checkout.index = new Map(tree)
        checkout.work = new Map([...tree, ...(kept as Array<[string, string]>)])
        checkout.conflicts = new Map()
      }

      const status = (checkout: Checkout, pathspecs: ReadonlyArray<string>) => {
        const head = treeOf(headOf(checkout))
        const { index, work, conflicts } = checkout
        const tracked: Array<StatusEntry> = []
        const others: Array<StatusEntry> = []
        const paths = [...new Set([...head.keys(), ...index.keys(), ...work.keys()])].sort()
        for (const path of paths.filter((each) => under(each, pathspecs))) {
          const conflict = conflicts.get(path)
          if (conflict !== undefined) {
            tracked.push({ code: conflict, path })
            continue
          }
          if (!index.has(path) && work.has(path)) others.push({ code: "??", path })
          if (!index.has(path) && !head.has(path)) continue
          const x = !head.has(path)
            ? "A"
            : !index.has(path)
              ? "D"
              : head.get(path) !== index.get(path)
                ? "M"
                : " "
          const y = !index.has(path)
            ? " "
            : !work.has(path)
              ? "D"
              : work.get(path) !== index.get(path)
                ? "M"
                : " "
          if (x !== " " || y !== " ") tracked.push({ code: x + y, path })
        }
        return [...tracked, ...others]
      }

      /**
       * Replays the commits onto `onto` in the checkout, a file at a time; stops at the first
       * conflict, leaving the rebase in progress, or finishes it.
       */
      const replay = (
        checkout: Checkout,
        rebasing: { readonly branch?: string; readonly orig: Sha },
        onto: Sha,
        todo: ReadonlyArray<CommitObject>,
        force: ReadonlyArray<string> = [],
      ): Replayed => {
        let current = onto
        for (const [i, commit] of todo.entries()) {
          const parent = commit.parents[0] === undefined ? new Map() : treeOf(commit.parents[0])
          const ours = treeOf(current)
          const merged = new Map(ours)
          const conflicts = new Map<string, string>()
          for (const path of changedPaths(parent, commit.tree)) {
            const base = parent.get(path)
            const theirs = commit.tree.get(path)
            const mine = ours.get(path)
            if (mine === base) setFile(merged, path, theirs)
            else if (theirs !== base && theirs !== mine) {
              conflicts.set(
                path,
                base === undefined
                  ? "AA"
                  : mine === undefined
                    ? "DU"
                    : theirs === undefined
                      ? "UD"
                      : "UU",
              )
            }
          }
          if (i === 0) for (const path of force) if (!conflicts.has(path)) conflicts.set(path, "UU")
          if (conflicts.size > 0) {
            checkout.rebase = {
              ...(rebasing.branch === undefined ? {} : { branch: rebasing.branch }),
              orig: rebasing.orig,
              stopped: commit,
              remaining: todo.slice(i + 1),
            }
            const kept = untracked(checkout).map(
              (path) => [path, checkout.work.get(path) ?? ""] as const,
            )
            checkout.head = { detached: current }
            checkout.index = new Map(ours)
            for (const path of changedPaths(parent, commit.tree)) {
              if (!conflicts.has(path)) setFile(checkout.index, path, merged.get(path))
            }
            for (const [path] of conflicts) {
              checkout.index.set(path, ours.get(path) ?? commit.tree.get(path) ?? "")
            }
            checkout.work = new Map([
              ...checkout.index,
              ...kept,
              ...[...conflicts.keys()].map(
                (path) => [path, markers(ours.get(path), commit.tree.get(path))] as const,
              ),
            ])
            checkout.conflicts = conflicts
            return { conflicts: [...conflicts.keys()].sort() }
          }
          // A commit that becomes empty is dropped; one made empty is kept, as git rebase does.
          if (sameTree(merged, ours) && !sameTree(parent, commit.tree)) continue
          current = newCommit([current], commit.message, merged)
        }
        if (rebasing.branch === undefined) {
          checkout.head = { detached: current }
        } else {
          branches.set(rebasing.branch, current)
          checkout.head = { branch: rebasing.branch }
        }
        delete checkout.rebase
        switchTo(checkout, treeOf(current))
        return { conflicts: [] }
      }

      // The service's operations: each recorded, then given its scripted fault if one is due.

      type Refuse = (exitCode: number, stderr: string) => GitFailed

      const takeFault = (op: GitOp, dir: string) => {
        const checkout = locate(dir)
        const found = faults.find(
          (each) =>
            each.op === op &&
            (each.fault.dir === undefined ||
              (checkout !== undefined && locate(each.fault.dir) === checkout) ||
              normalize(each.fault.dir) === normalize(dir)),
        )
        if (found === undefined) return undefined
        found.left -= 1
        if (found.left <= 0) faults.splice(faults.indexOf(found), 1)
        return found.fault
      }

      const operation = <A, E>(
        { op, kind, args }: GitCall,
        dir: string,
        body: (refuse: Refuse) => Effect.Effect<A, E | GitFailed>,
      ): Effect.Effect<A, E | GitFailed | GitTimedOut> => {
        const command = showCommand({ command: "git", args })
        const refuse: Refuse = (exitCode, stderr) =>
          new GitFailed({ op, command, exitCode, stderr })
        const run = Effect.suspend((): Effect.Effect<A, E | GitFailed | GitTimedOut> => {
          calls.push({ op, dir })
          const fault = takeFault(op, dir)
          if (fault?.timedOut) {
            return Effect.fail(new GitTimedOut({ op, command, timeLimit: TimeLimit[kind] }))
          }
          if (fault !== undefined) {
            return Effect.fail(refuse(fault.exitCode ?? 1, fault.stderr ?? `error: ${op} failed`))
          }
          return body(refuse)
        })
        return kind === "write" ? writer.withLock(run) : run
      }

      /** The checkout dir is in, or git's refusal outside any. */
      const inRepo = (refuse: Refuse, dir: string) => {
        const checkout = locate(dir)
        return checkout === undefined
          ? Effect.fail(
              refuse(128, "fatal: not a git repository (or any of the parent directories): .git"),
            )
          : Effect.succeed(checkout)
      }

      const rebase = (worktree: string, onto: string) =>
        operation(gitCall(gitOps.rebase, onto), worktree, (refuse) =>
          Effect.gen(function* () {
            const checkout = yield* inRepo(refuse, worktree)
            if (checkout.rebase !== undefined) {
              return yield* refuse(
                128,
                "fatal: It seems that there is already a rebase-merge directory, and\nI wonder if you are in the middle of another rebase.",
              )
            }
            const target = resolve(checkout, onto)
            if (target === undefined) return yield* refuse(128, `fatal: invalid upstream '${onto}'`)
            const { unstaged, staged } = changes(checkout)
            const please = "error: Please commit or stash them."
            if (unstaged.length > 0) {
              return yield* refuse(1, `error: cannot rebase: You have unstaged changes.\n${please}`)
            }
            if (staged.length > 0) {
              return yield* refuse(
                1,
                `error: cannot rebase: Your index contains uncommitted changes.\n${please}`,
              )
            }
            const head = headOf(checkout)
            const branch = "branch" in checkout.head ? checkout.head.branch : undefined
            const upstream = ancestors(target)
            const todo = [...ancestors(head)]
              .filter((hash) => !upstream.has(hash))
              .map(commitOf)
              .filter((commit) => commit.parents.length <= 1)
              .sort((a, b) => a.seq - b.seq)
            const force = branch === undefined ? undefined : forced.get(branch)
            if (force !== undefined && todo.length > 0) forced.delete(branch as string)
            else if (isAncestor(target, head)) return
            const overwritten = untracked(checkout).filter((path) => treeOf(target).has(path))
            if (overwritten.length > 0) {
              return yield* refuse(
                1,
                `error: The following untracked working tree files would be overwritten by checkout:\n${overwritten.map((path) => `\t${path}\n`).join("")}Please move or remove them before you switch branches.\nAborting`,
              )
            }
            const replayed = replay(
              checkout,
              { ...(branch === undefined ? {} : { branch }), orig: head },
              target,
              todo,
              force,
            )
            if (replayed.conflicts.length > 0) {
              return yield* new RebaseConflict({ files: replayed.conflicts })
            }
          }),
        )

      const abortRebase = (worktree: string) =>
        operation(gitCall(gitOps.abortRebase), worktree, (refuse) =>
          Effect.gen(function* () {
            const checkout = yield* inRepo(refuse, worktree)
            const rebasing = checkout.rebase
            if (rebasing === undefined) return yield* refuse(128, "fatal: no rebase in progress")
            checkout.head =
              rebasing.branch === undefined
                ? { detached: rebasing.orig }
                : { branch: rebasing.branch }
            delete checkout.rebase
            switchTo(checkout, treeOf(rebasing.orig))
          }),
        )

      const rebaseInProgress = (worktree: string) =>
        operation(gitCall(gitOps.gitPaths, rebaseFolders), worktree, (refuse) =>
          Effect.map(inRepo(refuse, worktree), (checkout) => checkout.rebase !== undefined),
        )

      const fastForward = (repo: string, branch: string) =>
        operation(gitCall(gitOps.fastForward, branch), repo, (refuse) =>
          Effect.gen(function* () {
            const checkout = yield* inRepo(refuse, repo)
            const target = resolve(checkout, branch)
            if (target === undefined) {
              return yield* refuse(1, `merge: ${branch} - not something we can merge`)
            }
            if (checkout.conflicts.size > 0) {
              return yield* refuse(
                128,
                "error: Merging is not possible because you have unmerged files.",
              )
            }
            const head = headOf(checkout)
            if (isAncestor(target, head)) return
            if (!isAncestor(head, target)) {
              return yield* refuse(128, "fatal: Not possible to fast-forward, aborting.")
            }
            const changed = changedPaths(treeOf(head), treeOf(target))
            const { unstaged, staged } = changes(checkout)
            const local = [...new Set([...unstaged, ...staged])].filter((path) =>
              changed.includes(path),
            )
            if (local.length > 0) {
              return yield* refuse(
                1,
                `error: Your local changes to the following files would be overwritten by merge:\n${local.map((path) => `\t${path}\n`).join("")}Please commit your changes or stash them before you merge.\nAborting`,
              )
            }
            const overwritten = untracked(checkout).filter((path) => treeOf(target).has(path))
            if (overwritten.length > 0) {
              return yield* refuse(
                1,
                `error: The following untracked working tree files would be overwritten by merge:\n${overwritten.map((path) => `\t${path}\n`).join("")}Please move or remove them before you merge.\nAborting`,
              )
            }
            if ("branch" in checkout.head) branches.set(checkout.head.branch, target)
            else checkout.head = { detached: target }
            for (const path of changed) {
              setFile(checkout.index, path, treeOf(target).get(path))
              setFile(checkout.work, path, treeOf(target).get(path))
            }
          }),
        )

      // --verify --quiet: a rev that names nothing fails with exit 1, saying nothing.
      const revParse = (dir: string, rev: string) =>
        operation(gitCall(gitOps.revParse, rev), dir, (refuse) =>
          Effect.gen(function* () {
            const hash = resolve(yield* inRepo(refuse, dir), rev)
            return hash === undefined ? yield* refuse(1, "") : hash
          }),
        )

      /** The worktree that has the branch checked out, or is rebasing it. */
      const holderOf = (branch: string) =>
        [...checkouts.values()].find(
          (each) =>
            ("branch" in each.head && each.head.branch === branch) ||
            each.rebase?.branch === branch,
        )

      const git = Git.of({
        addWorktree: (repo, path, options) =>
          operation(gitCall(gitOps.addWorktree, path, options), repo, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, repo)
              const where = normalize(path)
              const existing = checkouts.get(where)
              if (existing?.gone) {
                return yield* refuse(
                  128,
                  `fatal: '${where}' is a missing but already registered worktree;\nuse 'add -f' to override, or 'prune' or 'remove' to clear`,
                )
              }
              if (existing !== undefined || locate(where) !== undefined) {
                return yield* refuse(128, `fatal: '${where}' already exists`)
              }
              let start: Sha
              if (options.base === undefined) {
                const tip = branches.get(options.branch)
                if (tip === undefined) {
                  return yield* refuse(128, `fatal: invalid reference: ${options.branch}`)
                }
                const holder = holderOf(options.branch)
                if (holder !== undefined) {
                  return yield* refuse(
                    128,
                    `fatal: '${options.branch}' is already used by worktree at '${holder.path}'`,
                  )
                }
                start = tip
              } else {
                if (branches.has(options.branch)) {
                  return yield* refuse(
                    128,
                    `fatal: a branch named '${options.branch}' already exists`,
                  )
                }
                const base = resolve(checkout, options.base)
                if (base === undefined) {
                  return yield* refuse(128, `fatal: invalid reference: ${options.base}`)
                }
                branches.set(options.branch, base)
                start = base
              }
              seq += 1
              checkouts.set(where, {
                path: where,
                seq,
                head: { branch: options.branch },
                index: new Map(treeOf(start)),
                work: new Map(treeOf(start)),
                conflicts: new Map(),
                gone: false,
              })
            }),
          ),
        addDetachedWorktree: (repo, path, commit) =>
          operation(gitCall(gitOps.addDetachedWorktree, path, commit), repo, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, repo)
              const where = normalize(path)
              if (checkouts.has(where) || locate(where) !== undefined) {
                return yield* refuse(128, `fatal: '${where}' already exists`)
              }
              const hash = resolve(checkout, commit)
              if (hash === undefined) {
                return yield* refuse(128, `fatal: invalid reference: ${commit}`)
              }
              seq += 1
              checkouts.set(where, {
                path: where,
                seq,
                head: { detached: hash },
                index: new Map(treeOf(hash)),
                work: new Map(treeOf(hash)),
                conflicts: new Map(),
                gone: false,
              })
            }),
          ),
        removeWorktree: (repo, path, options = {}) =>
          operation(gitCall(gitOps.removeWorktree, path, options.force), repo, (refuse) =>
            Effect.gen(function* () {
              yield* inRepo(refuse, repo)
              const where = normalize(path)
              const checkout = checkouts.get(where)
              if (checkout === undefined) {
                return yield* refuse(128, `fatal: '${where}' is not a working tree`)
              }
              if (where === main) {
                return yield* refuse(128, `fatal: '${where}' is a main working tree`)
              }
              if (!checkout.gone && !options.force && status(checkout, []).length > 0) {
                return yield* refuse(
                  128,
                  `fatal: '${where}' contains modified or untracked files, use --force to delete it`,
                )
              }
              checkouts.delete(where)
            }),
          ),
        worktrees: (repo) =>
          operation(gitCall(gitOps.worktrees), repo, (refuse) =>
            Effect.map(inRepo(refuse, repo), () =>
              [...checkouts.values()]
                .sort((a, b) => a.seq - b.seq)
                .map(
                  (each): Worktree => ({
                    path: each.path,
                    head: headOf(each),
                    ...("branch" in each.head && each.rebase === undefined
                      ? { branch: each.head.branch }
                      : {}),
                    prunable: each.gone,
                  }),
                ),
            ),
          ),
        pruneWorktrees: (repo) =>
          operation(gitCall(gitOps.pruneWorktrees), repo, (refuse) =>
            Effect.map(inRepo(refuse, repo), () => {
              for (const [path, each] of checkouts) if (each.gone) checkouts.delete(path)
            }),
          ),
        createBranch: (repo, branch, start) =>
          operation(gitCall(gitOps.createBranch, branch, start), repo, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, repo)
              if (branch === "" || /[\s~^:?*[\\]|\.\.|^-|\/$|\.lock$/.test(branch)) {
                return yield* refuse(128, `fatal: '${branch}' is not a valid branch name`)
              }
              if (branches.has(branch)) {
                return yield* refuse(128, `fatal: a branch named '${branch}' already exists`)
              }
              const hash = resolve(checkout, start)
              if (hash === undefined) {
                return yield* refuse(128, `fatal: not a valid object name: '${start}'`)
              }
              branches.set(branch, hash)
            }),
          ),
        deleteBranch: (repo, branch, options = {}) =>
          operation(gitCall(gitOps.deleteBranch, branch, options.force), repo, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, repo)
              const tip = branches.get(branch)
              if (tip === undefined) return yield* refuse(1, `error: branch '${branch}' not found`)
              const holder = holderOf(branch)
              if (holder !== undefined) {
                return yield* refuse(
                  1,
                  `error: cannot delete branch '${branch}' used by worktree at '${holder.path}'`,
                )
              }
              if (!options.force && !isAncestor(tip, headOf(checkout))) {
                return yield* refuse(1, `error: the branch '${branch}' is not fully merged`)
              }
              branches.delete(branch)
            }),
          ),
        rebase,
        abortRebase,
        rebaseInProgress,
        abandonRebase: (worktree) =>
          rebaseInProgress(worktree).pipe(
            Effect.flatMap((inProgress) => (inProgress ? abortRebase(worktree) : Effect.void)),
            Effect.ignore,
          ),
        // rev-parse first, which fails on a rev that names nothing, then reset to its hash, as live.
        resetBranch: resetTo(writer, revParse, (worktree, hash) =>
          operation(gitCall(gitOps.reset, hash), worktree, (refuse) =>
            Effect.map(inRepo(refuse, worktree), (checkout) => {
              if ("branch" in checkout.head) branches.set(checkout.head.branch, hash)
              else checkout.head = { detached: hash }
              switchTo(checkout, treeOf(hash))
            }),
          ),
        ),
        mergeBase: (repo, a, b) =>
          operation(gitCall(gitOps.mergeBase, a, b), repo, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, repo)
              const [x, y] = [resolve(checkout, a), resolve(checkout, b)]
              if (x === undefined || y === undefined) {
                return yield* refuse(
                  128,
                  `fatal: Not a valid object name ${x === undefined ? a : b}`,
                )
              }
              const base = mergeBaseOf(x, y)
              return base === undefined ? yield* refuse(1, "") : base
            }),
          ),
        holds: (repo, base, branch) =>
          operation(gitCall(gitOps.holds, base, branch), repo, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, repo)
              const [ours, theirs] = [resolve(checkout, base), resolve(checkout, branch)]
              if (ours === undefined || theirs === undefined) {
                return yield* refuse(
                  128,
                  `fatal: ${ours === undefined ? base : branch} - not something we can merge`,
                )
              }
              const since = mergeBaseOf(ours, theirs)
              if (since === undefined)
                return yield* refuse(128, "fatal: refusing to merge unrelated histories")
              // Merging changes nothing when base has each file as the branch changed it.
              const kept = treeOf(ours)
              const changed = treeOf(theirs)
              return changedPaths(treeOf(since), changed).every(
                (path) => kept.get(path) === changed.get(path),
              )
            }),
          ),
        fastForward,
        log: (repo, base, head = "HEAD") =>
          operation(gitCall(gitOps.log, base, head), repo, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, repo)
              const [from, to] = [resolve(checkout, base), resolve(checkout, head)]
              if (from === undefined || to === undefined) {
                return yield* refuse(
                  128,
                  `fatal: ambiguous argument '${base}..${head}': unknown revision or path not in the working tree.`,
                )
              }
              const excluded = ancestors(from)
              return [...ancestors(to)]
                .filter((hash) => !excluded.has(hash))
                .map(commitOf)
                .sort((a, b) => b.seq - a.seq)
                .map(
                  (commit): Commit => ({
                    hash: commit.hash,
                    subject: subjectOf(commit.message),
                    message: commit.message,
                  }),
                )
            }),
          ),
        status: (dir, paths = []) =>
          operation(gitCall(gitOps.status, paths), dir, (refuse) =>
            Effect.map(inRepo(refuse, dir), (checkout) => status(checkout, paths)),
          ),
        changedFiles: (dir, base, head = "HEAD") =>
          operation(gitCall(gitOps.changedFiles, base, head), dir, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, dir)
              const [from, to] = [resolve(checkout, base), resolve(checkout, head)]
              if (from === undefined || to === undefined) {
                return yield* refuse(
                  128,
                  `fatal: ambiguous argument '${base}...${head}': unknown revision or path not in the working tree.`,
                )
              }
              const since = mergeBaseOf(from, to)
              if (since === undefined) {
                return yield* refuse(128, `fatal: ${base}...${head}: no merge base`)
              }
              return changedPaths(treeOf(since), treeOf(to))
            }),
          ),
        filesBetween: (dir, from, to) =>
          operation(gitCall(gitOps.filesBetween, from, to), dir, (refuse) =>
            Effect.gen(function* () {
              const checkout = yield* inRepo(refuse, dir)
              const [a, b] = [resolve(checkout, from), resolve(checkout, to)]
              if (a === undefined || b === undefined) {
                return yield* refuse(
                  128,
                  `fatal: ambiguous argument '${a === undefined ? from : to}': unknown revision or path not in the working tree.`,
                )
              }
              return changedPaths(treeOf(a), treeOf(b))
            }),
          ),
        fileAt: (dir, commit, path) =>
          operation(gitCall(gitOps.fileAt, commit, path), dir, (refuse) =>
            Effect.gen(function* () {
              const hash = resolve(yield* inRepo(refuse, dir), commit)
              const text = hash === undefined ? undefined : treeOf(hash).get(path)
              return text === undefined
                ? yield* refuse(128, `fatal: path '${path}' does not exist in '${commit}'`)
                : text
            }),
          ),
        trackedFiles: (dir) =>
          operation(gitCall(gitOps.trackedFiles), dir, (refuse) =>
            Effect.map(inRepo(refuse, dir), (checkout) => [...checkout.index.keys()].sort()),
          ),
        // No paths runs no git, as live.
        mergedByUnion: (dir, paths) =>
          paths.length === 0
            ? Effect.succeed([])
            : operation(gitCall(gitOps.mergedByUnion), dir, (refuse) =>
                Effect.map(inRepo(refuse, dir), (checkout) => {
                  const merge = mergeAttribute(checkout.work.get(".gitattributes") ?? "")
                  return paths.filter((path) => merge(path) === "union")
                }),
              ),
        revParse,
        branchExists: (repo, branch) =>
          operation(gitCall(gitOps.branchExists, branch), repo, (refuse) =>
            Effect.map(inRepo(refuse, repo), () => branches.has(branch)),
          ),
        commonDir: (dir) =>
          operation(gitCall(gitOps.commonDir), dir, (refuse) =>
            Effect.map(inRepo(refuse, dir), () => posix.join(main, ".git")),
          ),
        topLevel: (dir) =>
          operation(gitCall(gitOps.topLevel), dir, (refuse) =>
            Effect.map(inRepo(refuse, dir), (checkout) => checkout.path),
          ),
        currentBranch: (dir) =>
          operation(gitCall(gitOps.currentBranch), dir, (refuse) =>
            Effect.map(inRepo(refuse, dir), (checkout) =>
              "branch" in checkout.head && checkout.rebase === undefined
                ? Option.some(checkout.head.branch)
                : Option.none(),
            ),
          ),
        version: (dir) =>
          operation(gitCall(gitOps.version), dir, () =>
            Effect.succeed(seed.version ?? "git version 2.47.1"),
          ),
      })

      // The Repository's helpers: a test misusing one (a folder outside the repository, a rev that
      // names nothing) is a defect in the test, so they die rather than fail.

      const misuse = (message: string) => Effect.die(new Error(message))

      const checkoutAt = (dir: string) =>
        Effect.suspend(() => {
          const checkout = locate(dir)
          return checkout === undefined
            ? misuse(`${dir} is in no worktree of ${main}`)
            : Effect.succeed(checkout)
        })

      const revAt = (rev: string, dir: string) =>
        Effect.flatMap(checkoutAt(dir), (checkout) => {
          const hash = resolve(checkout, rev)
          return hash === undefined ? misuse(`${rev} names no commit`) : Effect.succeed(hash)
        })

      const write = (dir: string, files: Files) =>
        Effect.map(checkoutAt(dir), (checkout) => {
          for (const [path, content] of Object.entries(files)) {
            setFile(checkout.work, path, content ?? undefined)
          }
          return checkout
        })

      const stageIn = (checkout: Checkout, paths?: ReadonlyArray<string>) => {
        const all = [...new Set([...checkout.index.keys(), ...checkout.work.keys()])]
        for (const path of all.filter((each) => paths === undefined || under(each, paths))) {
          setFile(checkout.index, path, checkout.work.get(path))
          checkout.conflicts.delete(path)
        }
      }

      const repository = Repository.of({
        dir: main,
        calls: Effect.sync(() => [...calls]),
        commit: (dir, message, files = {}) =>
          Effect.flatMap(write(dir, files), (checkout) => {
            stageIn(checkout)
            const cleaned = cleanMessage(message)
            if (cleaned === "") return misuse("git refuses a commit with an empty message")
            const hash = newCommit([headOf(checkout)], cleaned, checkout.index)
            if ("branch" in checkout.head) branches.set(checkout.head.branch, hash)
            else checkout.head = { detached: hash }
            return Effect.succeed(hash)
          }),
        write: (dir, files) => Effect.asVoid(write(dir, files)),
        stage: (dir, paths) => Effect.map(checkoutAt(dir), (checkout) => stageIn(checkout, paths)),
        checkout: (dir, rev) =>
          Effect.flatMap(checkoutAt(dir), (checkout) => {
            const { unstaged, staged } = changes(checkout)
            if (unstaged.length + staged.length + checkout.conflicts.size > 0) {
              return misuse(`${checkout.path} has changes to commit or discard first`)
            }
            const holder = branches.has(rev) ? holderOf(rev) : undefined
            if (holder !== undefined && holder !== checkout) {
              return misuse(`${rev} is checked out in ${holder.path}`)
            }
            const hash = resolve(checkout, rev)
            if (hash === undefined) return misuse(`${rev} names no commit`)
            checkout.head = branches.has(rev) ? { branch: rev } : { detached: hash }
            switchTo(checkout, treeOf(hash))
            return Effect.void
          }),
        removeFolder: (path) =>
          Effect.flatMap(checkoutAt(path), (checkout) =>
            checkout.path === main || checkout.path !== normalize(path)
              ? misuse(`${path} is not a linked worktree's folder`)
              : Effect.sync(() => {
                  checkout.gone = true
                }),
          ),
        continueRebase: (dir, resolved = {}) =>
          Effect.flatMap(write(dir, resolved), (checkout) => {
            const rebasing = checkout.rebase
            if (rebasing === undefined) return misuse(`no rebase is in progress in ${dir}`)
            stageIn(checkout, [
              ...checkout.conflicts.keys(),
              ...checkout.index.keys(),
              ...Object.keys(resolved),
            ])
            const head = headOf(checkout)
            const current = sameTree(checkout.index, treeOf(head))
              ? head
              : newCommit([head], rebasing.stopped.message, checkout.index)
            return Effect.succeed(replay(checkout, rebasing, current, rebasing.remaining).conflicts)
          }),
        conflict: (branch, files) => Effect.sync(() => void forced.set(branch, files)),
        fail: (op, fault = {}) =>
          Effect.sync(() => void faults.push({ op, fault, left: fault.times ?? 1 })),
        head: (rev = "HEAD", dir = main) => revAt(rev, dir),
        tree: (rev, dir = main) => Effect.map(revAt(rev, dir), treeOf),
        read: (dir, path) => Effect.map(checkoutAt(dir), (checkout) => checkout.work.get(path)),
      })

      const start = newCommit(
        [],
        "Start\n",
        new Map(Object.entries(seed.files ?? { "README.md": "# demo\n" })),
      )
      const branch = seed.branch ?? "main"
      branches.set(branch, start)
      checkouts.set(main, {
        path: main,
        seq: 0,
        head: { branch },
        index: new Map(treeOf(start)),
        work: new Map(treeOf(start)),
        conflicts: new Map(),
        gone: false,
      })

      return Context.make(Git, git).pipe(
        Context.add(GitWriter, writer),
        Context.add(Repository, repository),
      )
    }),
  )
