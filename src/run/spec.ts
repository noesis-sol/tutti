// A spec run (§ 4.14), `tutti --spec <file>`: the spec, a Markdown or plain-text file on this
// machine, committed in the main checkout so that workers can read it, broken down into Beads
// tickets under a root epic, and run as --ticket <root epic> runs. This module has the spec's side:
//
// - readSpec, a startup check: the file is there, text in UTF-8, not empty, not in .git, not where
//   git ignores it (workers only see committed files); one outside the repository is committed as a
//   copy, `.tutti/specs/<its name>`, whose commits record where it came from (`Spec-Source:`), so a
//   spec of the same name from another folder is refused rather than take the other's tickets;
// - commitSpec: the spec committed alone on the branch checked out, `tutti: add spec <name>` or
//   `tutti: update spec <name>` with its SHA-256, or left as it is when committed already;
// - specState: the root epic an earlier run filed for the spec, found by its metadata (`spec`, the
//   spec's path in the repository, on every issue of its tree), and what to do with it: carry on
//   (unchanged), nothing (built), an update (changed since its `spec_sha256`), or the breakdown
//   carried on (no `spec_sha256`, set last of all, so the breakdown that filed it didn't finish);
// - updateFile: what an update's breakdown reads, the spec's diff and the tree, a line an issue;
// - checkFiled: the tree as bd has it once the breakdown is over, and what is amiss in it.
//
// The breakdown itself is src/agent/breakdown.ts.
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Data, Effect, FileSystem, Option, Result } from "effect"
import { compareIds } from "../plan/plan.ts"
import { Beads, type BeadsError, type Issue, type TicketId } from "../services/Beads.ts"
import { Git, type GitError, type Sha } from "../services/Git.ts"
import { runFolder } from "../services/Worktrees.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { specKey } from "./start.ts"

/** Where a spec from outside the repository is committed, as a copy named after its file. */
export const specsFolder = ".tutti/specs"

/** The root epic's metadata naming the version of the spec its tree was filed for. */
export const SpecMetadata = {
  /** The spec's path in the repository, on every issue of its tree. */
  spec: specKey,
  /** The SHA-256 of the spec the tree was filed for: set last of all, once it is filed. */
  sha256: "spec_sha256",
  /** The commit that committed that spec. */
  commit: "spec_commit",
} as const

/** The trailer of a copy's commits naming the file it was copied from. */
export const sourceTrailer = "Spec-Source"

/** What an update's breakdown reads, under the main checkout's .tutti/run/. */
export const specUpdateName = "spec-update.md"

/** The spec a run builds, as the startup checks read it. */
export interface Spec {
  /** The file as --spec (or TUTTI_SPEC) gave it, for what is said of it. */
  readonly given: string
  /** What gave it: `--spec` or `TUTTI_SPEC`. */
  readonly from: string
  /** The file, absolute. */
  readonly source: string
  /** Where it is committed, from the repository's top: where it is, or its copy. */
  readonly path: string
  /** It is outside the repository, committed as a copy at `path`. */
  readonly copy: boolean
  readonly text: string
  /** Its SHA-256, in hex. */
  readonly sha256: string
}

/** The first 12 hex digits of a SHA-256 or a commit, as lines show them. */
export const short = (hex: string): string => hex.slice(0, 12)

/** `path` with the home folder as `~`, as a copy's commits record it. */
export const tildePath = (path: string, home: string = homedir()): string =>
  home !== "" && (path === home || path.startsWith(`${home}${sep}`))
    ? `~${path.slice(home.length)}`
    : path

/** Whether `path` is `dir` or inside it. */
const within = (path: string, dir: string): boolean => {
  const rel = relative(dir, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Whether `bytes` read as text: UTF-8, with no NUL. */
export const isText = (bytes: Uint8Array): Option.Option<string> => {
  if (bytes.includes(0)) return Option.none()
  try {
    return Option.some(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return Option.none()
  }
}

/** The source a copy's commit message records, or none. */
export const sourceOf = (message: string): string | undefined => {
  const trailer = message
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(`${sourceTrailer}:`))
  return trailer?.slice(sourceTrailer.length + 1).trim() || undefined
}

/**
 * The spec `given` names (by `from`, `--spec` or `TUTTI_SPEC`), a path from `cwd`, as a run in the
 * main checkout `repo` commits it; or the problem with it, a line of the startup checks' report.
 */
export const readSpec = (
  given: string,
  from: string,
  cwd: string,
  repo: string,
): Effect.Effect<Result.Result<Spec, string>, never, FileSystem.FileSystem | Git> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const git = yield* Git
    const shown = `${sanitizeLine(given)} (${from})`
    const source = resolve(cwd, given)
    const info = yield* Effect.result(fs.stat(source))
    if (Result.isFailure(info)) {
      return info.failure._tag === "PlatformError" && info.failure.reason._tag === "NotFound"
        ? Result.fail(`Spec not found: ${shown}.`)
        : Result.fail(`Cannot read the spec ${shown}: ${sanitizeLine(info.failure.message)}.`)
    }
    if (info.success.type === "Directory") {
      return Result.fail(`The spec ${shown} is a folder: give a Markdown or plain-text file.`)
    }
    const read = yield* Effect.result(fs.readFile(source))
    if (Result.isFailure(read)) {
      return Result.fail(`Cannot read the spec ${shown}: ${sanitizeLine(read.failure.message)}.`)
    }
    const text = isText(read.success)
    if (Option.isNone(text)) {
      return Result.fail(
        `The spec ${shown} isn't text: give a Markdown or plain-text file, in UTF-8.`,
      )
    }
    if (text.value.trim() === "") {
      return Result.fail(`The spec ${shown} is empty: write what to build in it first.`)
    }
    const real = yield* fs.realPath(source).pipe(Effect.orElseSucceed(() => source))
    const top = yield* fs.realPath(repo).pipe(Effect.orElseSucceed(() => repo))
    const copy = !within(real, top)
    const path = copy
      ? `${specsFolder}/${basename(real)}`
      : relative(top, real).split(sep).join("/")
    if (!copy && (path === ".git" || path.startsWith(".git/"))) {
      return Result.fail(
        `The spec ${shown} is in the repository's .git folder, which git doesn't commit: move it.`,
      )
    }
    const ignored = yield* Effect.result(git.ignored(repo, path))
    if (Result.isSuccess(ignored) && ignored.success) {
      return Result.fail(
        `git ignores ${path}, where the spec (${from}) is kept, and workers only see committed files: move the spec, or stop ignoring that path (git check-ignore -v ${path} says where).`,
      )
    }
    if (copy) {
      // The copy's last commit names the file it was copied from: another file of that name isn't
      // this spec. A copy committed without one, by hand, is taken.
      const last = yield* git.lastCommit(repo, path).pipe(Effect.orElseSucceed(() => Option.none()))
      const recorded = Option.isSome(last) ? sourceOf(last.value.message) : undefined
      if (recorded !== undefined && recorded !== tildePath(real) && recorded !== real) {
        return Result.fail(
          `The spec ${shown} has the name of another: ${path} holds the copy of another spec, ${sanitizeLine(recorded)}, and would take its tickets. Give it another file name, which its copy takes; or, if it is that spec moved, copy it over ${path} and give ${from} that path.`,
        )
      }
    }
    return Result.succeed({
      given,
      from,
      source: real,
      path,
      copy,
      text: text.value,
      sha256: createHash("sha256").update(read.success).digest("hex"),
    })
  })

/** The spec committed: the commit that has it as it is, and whether this run committed it. */
export interface Committed {
  readonly commit: Sha
  readonly committed: boolean
}

/** The commit message for `spec`: added or updated, its SHA-256, and a copy's source. */
export const commitMessage = (spec: Spec, updated: boolean): string =>
  [
    `tutti: ${updated ? "update" : "add"} spec ${basename(spec.path)}`,
    "",
    `sha256 ${spec.sha256}`,
    ...(spec.copy ? ["", `${sourceTrailer}: ${tildePath(spec.source)}`] : []),
  ].join("\n")

/**
 * Commits `spec` in the main checkout `repo`, alone, on the branch checked out: a copy written
 * first, over the copy an earlier run made. A spec committed already as it is stays as it is.
 */
export const commitSpec = (
  spec: Spec,
  repo: string,
): Effect.Effect<Committed, GitError | PlatformErrorOf, FileSystem.FileSystem | Git> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const git = yield* Git
    if (spec.copy) {
      yield* fs.makeDirectory(join(repo, specsFolder), { recursive: true })
      yield* fs.writeFileString(join(repo, spec.path), spec.text)
    }
    const born = yield* Effect.result(git.revParse(repo, "HEAD"))
    const last = Result.isSuccess(born) ? yield* git.lastCommit(repo, spec.path) : Option.none()
    const changes = yield* git.status(repo, [spec.path])
    if (changes.length === 0 && Option.isSome(last)) {
      return { commit: last.value.hash, committed: false }
    }
    yield* git.addPaths(repo, [spec.path])
    yield* git.commitPaths(repo, commitMessage(spec, Option.isSome(last)), [spec.path])
    return { commit: yield* git.revParse(repo, "HEAD"), committed: true }
  })

type PlatformErrorOf = Effect.Error<ReturnType<FileSystem.FileSystem["writeFileString"]>>

// ---------------------------------------------------------------------------------------------
// The root epic

/** What a spec run does with the tree an earlier run filed for its spec, if any. */
export type SpecState = Data.TaggedEnum<{
  /** No root epic: the breakdown files the tree. */
  New: Record<never, never>
  /** The tree was filed for this very spec, and is open: the run carries on with it. */
  Unchanged: { readonly root: Issue }
  /** The tree was filed for this very spec, and its root epic is closed: nothing to run. */
  Built: { readonly root: Issue }
  /** The spec changed since the tree was filed for it, at `filedFor`: the breakdown updates it. */
  Changed: { readonly root: Issue; readonly filedFor: string | null }
  /** The breakdown that filed the root epic didn't finish: it carries on. */
  Unfinished: { readonly root: Issue }
  /** Two root epics: a setup problem. */
  TwoRoots: { readonly roots: ReadonlyArray<Issue> }
}>

export const SpecState = Data.taggedEnum<SpecState>()

/** The text at `key` of the issue's metadata, or none. */
const metadataText = (issue: Issue, key: string): string | null => {
  const value = Object.hasOwn(issue.metadata, key) ? issue.metadata[key] : undefined
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/** The root epics among the spec's issues, by ID: epics whose parent isn't one of them. */
export const rootsOf = (issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> => {
  const ids = new Set<string>(issues.map((issue) => issue.id))
  return issues
    .filter(
      (issue) => issue.type === "epic" && (issue.parent === undefined || !ids.has(issue.parent)),
    )
    .sort((a, b) => compareIds(a.id, b.id))
}

/** What to do with the spec's issues, `issues`, for the spec of SHA-256 `sha256`. */
export const specState = (issues: ReadonlyArray<Issue>, sha256: string): SpecState => {
  const roots = rootsOf(issues)
  const [root, ...others] = roots
  if (root === undefined) return SpecState.New()
  if (others.length > 0) return SpecState.TwoRoots({ roots })
  const filed = metadataText(root, SpecMetadata.sha256)
  if (filed === null) return SpecState.Unfinished({ root })
  if (filed !== sha256) {
    return SpecState.Changed({ root, filedFor: metadataText(root, SpecMetadata.commit) })
  }
  return root.status === "closed" ? SpecState.Built({ root }) : SpecState.Unchanged({ root })
}

/** The problem of a spec with two root epics. */
export const twoRootsProblem = (path: string, roots: ReadonlyArray<Issue>): string => {
  const [a, b] = roots.map((root) => sanitizeLine(root.id))
  return `The spec ${path} has two root epics, ${a} and ${b}: epics carrying its metadata (${SpecMetadata.spec}) whose parent doesn't. A spec run carries on with one, so keep one: put the other under it (bd update ${b} --parent ${a}), or take the spec's metadata off it (bd update ${b} --unset-metadata ${SpecMetadata.spec}).`
}

/** Every issue of the spec at `path`, closed ones too. */
export const specIssues = (path: string): Effect.Effect<ReadonlyArray<Issue>, BeadsError, Beads> =>
  Effect.flatMap(Beads, (beads) =>
    beads.list({ all: true, metadata: { [SpecMetadata.spec]: path } }),
  )

/** An issue on one line, for the update's file and what a stopped breakdown lists. */
export const issueLine = (issue: Issue): string =>
  [
    sanitizeLine(issue.id),
    `[${issue.status}]`,
    issue.type,
    issue.priority === undefined ? "P?" : `P${issue.priority}`,
    sanitizeLine(issue.title),
    ...(issue.parent === undefined ? [] : [`(under ${sanitizeLine(issue.parent)})`]),
  ].join(" ")

/** The text of the update's file: the spec's change, then the tree under `root`. */
export const updateText = (u: {
  readonly path: string
  readonly root: Issue
  readonly filedFor: string | null
  readonly commit: string
  /** The diff of the spec from `filedFor` to `commit`, or why there is none. */
  readonly diff: Result.Result<string, string>
  readonly tree: ReadonlyArray<Issue>
}): string => {
  const id = sanitizeLine(u.root.id)
  const change = Result.isSuccess(u.diff)
    ? ["```diff", u.diff.success.replace(/\n+$/, ""), "```"]
    : [`git can't give the diff: ${u.diff.failure}. Compare the spec as it is with the tree below.`]
  return [
    "# The spec's change",
    "",
    `The spec ${u.path} changed since the tree under ${id} was filed for it${u.filedFor === null ? "" : `, at commit ${short(u.filedFor)}`}; it is committed now at ${short(u.commit)}.`,
    "",
    "## The change",
    "",
    ...change,
    "",
    `## The tree under ${id}, open and closed`,
    "",
    ...u.tree.map((issue) => `- ${issueLine(issue)}`),
    "",
  ].join("\n")
}

/** Where the update's file is, relative to the main checkout. */
export const specUpdateFile = `${runFolder}/${specUpdateName}`

/** The diff of the spec at `path` from `from` to `to`, or why git can't give it. */
export const specDiff = (
  repo: string,
  path: string,
  from: string | null,
  to: string,
): Effect.Effect<Result.Result<string, string>, never, Git> =>
  Effect.gen(function* () {
    if (from === null) return Result.fail("the root epic names no commit it was filed for")
    const git = yield* Git
    const diff = yield* Effect.result(git.diffOf(repo, from, to, path))
    return Result.isSuccess(diff)
      ? Result.succeed(diff.success)
      : Result.fail(
          sanitizeLine(
            diff.failure._tag === "GitFailed"
              ? diff.failure.stderr.trim().split("\n")[0] || `exit code ${diff.failure.exitCode}`
              : "git took too long",
          ),
        )
  })

// ---------------------------------------------------------------------------------------------
// The tree, once filed

/** What checkFiled found: the counts, what it couldn't take, and what is amiss. */
export interface Filed {
  /** The epics, the root epic among them, and the tickets of the spec's tree. */
  readonly epics: number
  readonly tickets: number
  /** Why the run can't take the tree, or null. */
  readonly refused: string | null
  readonly warnings: ReadonlyArray<string>
}

/** `n` and `noun`, plural but for 1. */
export const plural = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`)

/** `epics` epics and `tickets` tickets, as `(5 epics, 31 tickets)` says them. */
export const treeCount = (epics: number, tickets: number): string =>
  `${plural(epics, "epic")}, ${plural(tickets, "ticket")}`

/**
 * The tree of the spec at `path` under `root`, as bd has it: refused when the root epic isn't an
 * epic, or carries another spec's metadata; otherwise counted, with warnings for the issues under
 * it without the spec's metadata, whose workers aren't told of the spec, those of the spec outside
 * it, which the run leaves out, and open tickets without files metadata, whose files tutti then
 * guesses, or without acceptance criteria.
 */
export const checkFiled = (root: TicketId, path: string): Effect.Effect<Filed, BeadsError, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const top = yield* beads.show(root)
    const id = sanitizeLine(root)
    if (top.type !== "epic") {
      return {
        epics: 0,
        tickets: 0,
        refused: `${id} is a ${sanitizeLine(top.type)}, not an epic`,
        warnings: [],
      }
    }
    const its = metadataText(top, SpecMetadata.spec)
    if (its !== null && its !== path) {
      return {
        epics: 0,
        tickets: 0,
        refused: `${id} is the root epic of another spec, ${sanitizeLine(its)}`,
        warnings: [],
      }
    }
    // The tree under it, an epic's children at a time.
    const under: Array<Issue> = []
    const seen = new Set<string>([root])
    let epics = [root]
    while (epics.length > 0) {
      const next: Array<TicketId> = []
      for (const epic of epics) {
        for (const issue of yield* beads.list({ all: true, parent: epic })) {
          if (seen.has(issue.id)) continue
          seen.add(issue.id)
          under.push(issue)
          if (issue.type === "epic") next.push(issue.id)
        }
      }
      epics = next
    }
    const spec = yield* specIssues(path)
    const warnings: Array<string> = []
    const named = (issues: ReadonlyArray<Issue>) =>
      [...issues]
        .sort((a, b) => compareIds(a.id, b.id))
        .slice(0, 5)
        .map((issue) => sanitizeLine(issue.id))
        .join(", ") + (issues.length > 5 ? ` and ${issues.length - 5} more` : "")
    const outside = spec.filter((issue) => issue.id !== root && !seen.has(issue.id))
    if (outside.length > 0) {
      warnings.push(
        `${plural(outside.length, "issue")} of the spec ${path} ${outside.length === 1 ? "is" : "are"} outside ${id}, and the run leaves ${outside.length === 1 ? "it" : "them"} out: ${named(outside)}`,
      )
    }
    const bare = under.filter((issue) => metadataText(issue, SpecMetadata.spec) !== path)
    if (bare.length > 0) {
      warnings.push(
        `${plural(bare.length, "issue")} under ${id} ${bare.length === 1 ? "doesn't" : "don't"} carry the spec's metadata, so ${bare.length === 1 ? "its worker isn't" : "their workers aren't"} told of the spec: ${named(bare)}`,
      )
    }
    const open = under.filter((issue) => issue.type !== "epic" && issue.status !== "closed")
    const noFiles = open.filter((issue) => issue.files.length === 0)
    if (noFiles.length > 0) {
      warnings.push(
        `${plural(noFiles.length, "open ticket")} under ${id} ${noFiles.length === 1 ? "has" : "have"} no files metadata, so tutti guesses ${noFiles.length === 1 ? "its" : "their"} files: ${named(noFiles)}`,
      )
    }
    const noAcceptance = open.filter((issue) => issue.acceptance.trim() === "")
    if (noAcceptance.length > 0) {
      warnings.push(
        `${plural(noAcceptance.length, "open ticket")} under ${id} ${noAcceptance.length === 1 ? "has" : "have"} no acceptance criteria: ${named(noAcceptance)}`,
      )
    }
    const epicCount = 1 + under.filter((issue) => issue.type === "epic").length
    return {
      epics: epicCount,
      tickets: under.length - (epicCount - 1),
      refused: null,
      warnings,
    }
  })

/** Sets the root epic's spec metadata: its path, and last of all the version it was filed for. */
export const markFiled = (
  root: TicketId,
  spec: Pick<Spec, "path" | "sha256">,
  commit: string,
): Effect.Effect<void, BeadsError, Beads> =>
  Effect.flatMap(Beads, (beads) =>
    Effect.asVoid(
      beads.update(root, {
        setMetadata: {
          [SpecMetadata.spec]: spec.path,
          [SpecMetadata.sha256]: spec.sha256,
          [SpecMetadata.commit]: commit,
        },
      }),
    ),
  )
