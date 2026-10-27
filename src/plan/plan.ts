// tutti plan [--apply] (§ 8.1), as orchestra v0.9.0's plan: blocks links that order the open
// tickets touching the same code, so they run one after the other instead of side by side, the
// higher-priority ticket first. Tickets are linked when they name the same function the repository
// declares (declared.ts), as a run holds them apart, or work on the same small file and aren't
// compared on it by function, read from their footprints (footprint.ts):
// a ticket with commits on its branch is footprinted from what the branch changes, as a run does,
// and the files git merges by union and the queue's shared files (.tutti/settings.json) link
// nothing.
// Without --apply the proposal is only printed; with it each link is added with bd dep add, after a
// warning when a run holds the repository's lock. A stop (Ctrl+C, SIGTERM: an interruption) as it
// reads says it changed nothing, and one during --apply stops it between two links, saying which it
// added and which not: the link under way is added whole, its bd uninterruptible and, as exec starts
// every command, in a process group of its own, out of the terminal's Ctrl+C. runMain exits 130.
import { Console, Effect, type FileSystem } from "effect"
import type { ConfigFileInvalid } from "../project/configFile.ts"
import { checkCommands, readSettings, scriptedChecks } from "../project/settings.ts"
import { checkScriptLines } from "../run/checkScripts.ts"
import { readDeclared } from "../run/declared.ts"
import {
  branchFootprint,
  emptyFootprint,
  type Footprint,
  ticketFootprint,
} from "../run/footprint.ts"
import { type Mentions, mentionsIn, readSources, sharedFile, sharedFunc } from "../run/overlap.ts"
import { type RepoFiles, repoFiles } from "../run/repoFiles.ts"
import { takes } from "../run/scope.ts"
import { Beads, type BeadsError, type Issue, type TicketId } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { RunLock } from "../services/RunLock.ts"
import { branchOf } from "../services/Worktrees.ts"
import { sanitize, sanitizeLine } from "../ui/sanitize.ts"

/** A blocks link: `blocked` waits for `blocker` (bd dep add <blocked> <blocker>). */
export interface Link {
  readonly blocker: TicketId
  readonly blocked: TicketId
  /** What both touch, for a proposed link. */
  readonly why: string
}

/**
 * The most lines a file can have for two tickets naming it, and no function in common, to be
 * ordered: in a larger file they likely work in different places.
 */
export const smallFileLines = 200

/** The ticket's priority, 0 the highest; 9 when it has none. */
export const priorityOf = (issue: Issue): number => issue.priority ?? 9

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** A part of an ID without its leading zeros, and whether it is a number. */
const idNumber = (part: string): readonly [string, boolean] =>
  /^[0-9]+$/.test(part) ? [part.replace(/^0+/, ""), true] : [part, false]

/**
 * Orders ticket IDs as text, except that the numbers between their dots, the subticket numbers bd
 * gives an epic's children, compare as numbers: e.2 before e.10. A number goes before text in the
 * same place, and IDs that differ only in leading zeros fall back to text, so the order is total.
 */
export const compareIds = (a: string, b: string): number => {
  const as = a.split(".")
  const bs = b.split(".")
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const [x, xNum] = idNumber(as[i] ?? "")
    const [y, yNum] = idNumber(bs[i] ?? "")
    const c =
      xNum && yNum
        ? x.length - y.length || compareText(x, y)
        : xNum
          ? -1
          : yNum
            ? 1
            : compareText(x, y)
    if (c !== 0) return Math.sign(c)
  }
  return Math.sign(as.length - bs.length) || compareText(a, b)
}

/** The tickets in the order they are to run: priority, then the older, then compareIds. */
const inOrder = (open: ReadonlyArray<Issue>): ReadonlyArray<Issue> =>
  [...open].sort(
    (a, b) =>
      priorityOf(a) - priorityOf(b) ||
      compareText(a.createdAt, b.createdAt) ||
      compareIds(a.id, b.id),
  )

/**
 * The ticket's footprint for planning: for a ticket whose branch changes files on top of the
 * checked-out branch (`branch`), branchFootprint's, as a run's. A predicted footprint is a guess:
 * good enough to keep two tickets apart for a while, not to order them for good.
 */
const planFootprint = (
  issue: Issue,
  repo: RepoFiles,
  branch: ReadonlyArray<string> = [],
): Footprint => {
  if (branch.length > 0) return branchFootprint(issue, branch, repo)
  const fp = ticketFootprint(issue, repo)
  return fp.predicted ? emptyFootprint : fp
}

/** The blocks links among the issues' dependencies, as bd list gives them. */
export const existingLinks = (issues: ReadonlyArray<Issue>): ReadonlyArray<Link> =>
  issues.flatMap((issue) =>
    issue.dependencies
      .filter((dependency) => dependency.type === "blocks" && dependency.id !== "")
      .map((dependency) => ({ blocker: dependency.id, blocked: issue.id, why: "" })),
  )

/** Whether `to` already waits for `from`, through the links in after (blocker → blocked). */
const reaches = (
  after: ReadonlyMap<TicketId, ReadonlyArray<TicketId>>,
  from: TicketId,
  to: TicketId,
) => {
  const seen = new Set([from])
  for (const next = [from]; next.length > 0; ) {
    for (const n of after.get(next.pop() as TicketId) ?? []) {
      if (n === to) return true
      if (!seen.has(n)) {
        seen.add(n)
        next.push(n)
      }
    }
  }
  return false
}

/**
 * What two footprints share closely enough to order their tickets, or "": a function both name,
 * else a small file both work on that they aren't compared on by function.
 */
const planShared = (
  a: Footprint,
  b: Footprint,
  mentions: Mentions,
  small: (file: string) => boolean,
): string => sharedFunc(a, b) || sharedFile(a, b, mentions, small)

/**
 * The links that order the open tickets touching the same code: the higher-priority ticket (then
 * the older one, then the lower ID by compareIds) goes first. `source` gives a repository file's
 * contents, for its line count and the functions it mentions; a file it hasn't (one not written
 * yet) is small and mentions none. Area labels, predicted files, the files git merges by union and
 * the queue's shared files (`RepoFiles.shared`), and the files the check commands name, unless a
 * ticket's files metadata lists them, don't link
 * tickets, nor does a file neither ticket is to change (one both only cite), and a pair already
 * ordered by `existing` links, directly or through other tickets, gets none. Each ticket is linked
 * to the nearest one before it first, so tickets touching one function form a chain. `branches`
 * holds, by ticket, the files its branch changes on top of the checked-out branch: a ticket with
 * some, reopened or carried over, is footprinted from them (`branchFootprint`), as a run does.
 */
export const planLinks = (
  open: ReadonlyArray<Issue>,
  existing: ReadonlyArray<Link>,
  repo: RepoFiles,
  source: (file: string) => string | undefined,
  branches: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
): ReadonlyArray<Link> => {
  const tickets = inOrder(open)
  const fps = tickets.map((issue) => planFootprint(issue, repo, branches.get(issue.id)))
  const contents = new Map<string, string>()
  for (const fp of fps) {
    for (const f of fp.files) {
      const content = source(f)
      if (content !== undefined) contents.set(f, content)
    }
  }
  const mentions = mentionsIn(contents)
  const small = (file: string) =>
    !repo.shared(file) && (contents.get(file)?.split("\n").length ?? 1) - 1 <= smallFileLines
  const after = new Map<TicketId, Array<TicketId>>()
  const link = (blocker: TicketId, blocked: TicketId) =>
    after.set(blocker, [...(after.get(blocker) ?? []), blocked])
  for (const l of existing) link(l.blocker, l.blocked)
  const links: Array<Link> = []
  tickets.forEach((later, j) => {
    for (let i = j - 1; i >= 0; i--) {
      const a = tickets[i]?.id as TicketId
      const b = later.id
      const why = planShared(fps[i] ?? emptyFootprint, fps[j] ?? emptyFootprint, mentions, small)
      if (why === "" || reaches(after, a, b) || reaches(after, b, a)) continue
      link(a, b)
      links.push({ blocker: a, blocked: b, why })
    }
  })
  return links
}

/** n and the noun, which takes an s unless n is 1. */
export const plural = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`)

/**
 * A link as the proposal lists it: `  <blocked> (P2) waits for <blocker> (P1): both touch <why>`.
 * Workers file tickets, and why can be a ticket's files entry, so each is sanitised (§ 7.10).
 */
export const linkLine = (link: Link, priorities: ReadonlyMap<string, number>): string =>
  `  ${sanitizeLine(link.blocked)} (P${priorities.get(link.blocked) ?? 9}) waits for ${sanitizeLine(link.blocker)} (P${priorities.get(link.blocker) ?? 9}): both touch ${sanitizeLine(link.why)}`

/** A link as a stop names it: `<blocked> waits for <blocker>`. */
const waits = (link: Link): string =>
  `${sanitizeLine(link.blocked)} waits for ${sanitizeLine(link.blocker)}`

/** What plan says on stderr when stopped before it proposed a link. */
export const stoppedReadingLine = "tutti plan: stopped before proposing any link; nothing changed."

/**
 * What plan --apply says on stderr when stopped between two links: `tutti plan: stopped. Added 1 of
 * 3 links: t-2 waits for t-1. Not added: t-3 waits for t-1, t-4 waits for t-3.`
 */
export const stoppedLine = (added: ReadonlyArray<Link>, notAdded: ReadonlyArray<Link>): string => {
  const total = plural(added.length + notAdded.length, "link")
  const named = added.length > 0 ? `: ${added.map(waits).join(", ")}` : ""
  const left = notAdded.length > 0 ? ` Not added: ${notAdded.map(waits).join(", ")}.` : ""
  return `tutti plan: stopped. Added ${added.length} of ${total}${named}.${left}`
}

const settingsProblem = (error: ConfigFileInvalid): string =>
  error.problems
    .map((problem) =>
      problem.path === ""
        ? `${problem.file} ${problem.message}`
        : `${problem.file}: ${problem.path}: ${problem.message}`,
    )
    .join("\n")

const beadsProblem = (error: BeadsError): string => {
  switch (error._tag) {
    case "BeadsFailed":
      return `${sanitizeLine(error.command)} exited with ${error.exitCode}: ${sanitize(error.stderr).trim()}`
    case "BeadsTimedOut":
      return `${sanitizeLine(error.command)} took too long`
    case "BeadsUnreadable":
      return `${sanitizeLine(error.command)}: ${sanitize(error.reason)}`
  }
}

/**
 * The files each ticket's branch changes on top of the checked-out branch, since their merge base,
 * but those git merges by union, for the tickets with a branch. A branch git can't read is left out:
 * its ticket is footprinted from its text.
 */
const branchChanges = (
  repo: string,
  open: ReadonlyArray<Issue>,
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const changes = new Map<string, ReadonlyArray<string>>()
    for (const issue of open) {
      const branch = branchOf(issue.id)
      const read = yield* Effect.gen(function* () {
        if (!(yield* git.branchExists(repo, branch))) return []
        const files = yield* git.changedFiles(repo, "HEAD", branch)
        const union = yield* git.mergedByUnion(repo, files)
        return files.filter((f) => !union.includes(f))
      }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
      if (read.length > 0) changes.set(issue.id, read)
    }
    return changes
  })

/**
 * Warns on stderr when a run, tutti's or orchestra's, holds the lock of the project at repo: it
 * holds back the tickets it hasn't started, but one it has started keeps going whatever it now
 * waits for. A lock that can't be read warns of nothing.
 */
const warnOfRun = (repo: string): Effect.Effect<void, never, Git | RunLock> =>
  Effect.gen(function* () {
    const commonDir = yield* (yield* Git).commonDir(repo)
    const held = yield* (yield* RunLock).probe({ repo, commonDir })
    if (held === undefined) return
    yield* Console.error(
      `tutti plan: warning: ${held.message}. A ticket it has started keeps going and may merge before a ticket it now waits for.`,
    )
  }).pipe(Effect.ignore)

/**
 * The open tickets of the project at repo that a run takes, and the links between them planLinks
 * proposes. Fails with what went wrong: settings that can't be read, or bd failing to list them.
 */
const proposal = (
  repo: string,
): Effect.Effect<
  { readonly open: ReadonlyArray<Issue>; readonly links: ReadonlyArray<Link> },
  string,
  Beads | Git | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const settings = yield* readSettings(repo).pipe(Effect.mapError(settingsProblem))
    const listed = yield* beads
      .list({ status: "open" })
      .pipe(Effect.mapError((error) => `cannot read the open tickets: ${beadsProblem(error)}`))
    const open = listed.filter((issue) =>
      takes({ excludeTypes: settings.queue.exclude_types }, issue),
    )
    const checks = checkCommands(settings)
    const git = yield* Git
    const repoFilesNow = yield* git.trackedFiles(repo).pipe(
      Effect.flatMap((files) =>
        Effect.gen(function* () {
          const union = yield* git
            .mergedByUnion(repo, files)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
          const declared = yield* readDeclared(repo, files)
          const scripts = yield* checkScriptLines(repo, files, scriptedChecks(settings))
          return repoFiles(
            files,
            [...checks, ...scripts],
            union,
            settings.queue.shared_files,
            declared,
          )
        }),
      ),
      Effect.orElseSucceed(() => repoFiles(undefined, checks, [], settings.queue.shared_files)),
    )
    const branches = yield* branchChanges(repo, open)
    const sources = yield* readSources(
      repo,
      open.map((issue) => planFootprint(issue, repoFilesNow, branches.get(issue.id))),
    )
    const links = planLinks(
      open,
      existingLinks(listed),
      repoFilesNow,
      (file) => sources.get(file),
      branches,
    )
    return { open, links }
  })

/**
 * Proposes the links between the open tickets of the project at repo, on stdout, and adds them with
 * apply, warning first when a run holds the lock. Fails with what went wrong, said on stderr:
 * settings that can't be read, bd failing to list the tickets, or a link bd didn't add. Interrupted
 * (a stop), it says on stderr that it changed nothing, before it proposes a link, or, as it adds
 * them, which links it added and which not; the link under way is added whole.
 */
export const plan = (
  repo: string,
  apply: boolean,
): Effect.Effect<void, string, Beads | Git | RunLock | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const { open, links } = yield* proposal(repo).pipe(
      Effect.onInterrupt(() => Console.error(stoppedReadingLine)),
    )
    if (links.length === 0) {
      return yield* Console.log(
        `No links to add: no two of the ${plural(open.length, "open ticket")} touch the same code without being ordered already.`,
      )
    }
    const priorities = new Map(open.map((issue) => [issue.id, priorityOf(issue)]))
    if (apply)
      yield* warnOfRun(repo).pipe(Effect.onInterrupt(() => Console.error(stoppedReadingLine)))
    yield* Console.log(
      `${apply ? "Adding" : "Proposed"} ${plural(links.length, "blocks link")} between the ${plural(open.length, "open ticket")}:`,
    )
    if (!apply) {
      for (const link of links) yield* Console.log(linkLine(link, priorities))
      return yield* Console.log("Nothing changed. Add them with: tutti plan --apply")
    }
    const added: Array<Link> = []
    const notAdded: Array<Link> = []
    // Each link is said and added whole; a stop comes between two.
    const add = (link: Link) =>
      Effect.gen(function* () {
        yield* Console.log(linkLine(link, priorities))
        const result = yield* Effect.result(beads.addDependency(link.blocked, link.blocker))
        if (result._tag === "Success") {
          added.push(link)
          return
        }
        notAdded.push(link)
        yield* Console.error(
          `tutti plan: bd dep add ${sanitizeLine(link.blocked)} ${sanitizeLine(link.blocker)}: ${beadsProblem(result.failure)}`,
        )
      }).pipe(Effect.uninterruptible)
    yield* Effect.forEach(links, add, { discard: true }).pipe(
      Effect.onInterrupt(() =>
        Console.error(
          stoppedLine(added, [...notAdded, ...links.slice(added.length + notAdded.length)]),
        ),
      ),
    )
    const failed = notAdded.length
    if (failed === 0) return yield* Console.log(`Added ${plural(links.length, "link")}.`)
    yield* Console.log(`Added ${links.length - failed} of ${plural(links.length, "link")}.`)
    return yield* Effect.fail(`bd didn't add ${plural(failed, "link")}`)
  })
