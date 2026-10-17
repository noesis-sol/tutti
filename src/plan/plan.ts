// tutti plan [--apply] (§ 8.1), as orchestra v0.7.7's plan: blocks links that order the open
// tickets touching the same code, so they run one after the other instead of side by side, the
// higher-priority ticket first. Tickets are linked when they name the same function, or work on the
// same small file and aren't compared on it by function, read from their footprints (footprint.ts).
// Without --apply the proposal is only printed; with it each link is added with bd dep add.
import { Console, Effect, type FileSystem } from "effect"
import type { ConfigFileInvalid } from "../project/configFile.ts"
import { readSettings } from "../project/settings.ts"
import {
  emptyFootprint,
  type Footprint,
  type Mentions,
  mentionsIn,
  type RepoFiles,
  readSources,
  repoFiles,
  sharedFile,
  sharedFunc,
  ticketFootprint,
} from "../run/footprint.ts"
import { takes } from "../run/scope.ts"
import { Beads, type BeadsError, type Issue } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"

/** A blocks link: `blocked` waits for `blocker` (bd dep add <blocked> <blocker>). */
export interface Link {
  readonly blocker: string
  readonly blocked: string
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
 * The ticket's footprint for planning. A predicted footprint is a guess: good enough to keep two
 * tickets apart for a while, not to order them for good.
 */
const planFootprint = (issue: Issue, repo: RepoFiles): Footprint => {
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
const reaches = (after: ReadonlyMap<string, ReadonlyArray<string>>, from: string, to: string) => {
  const seen = new Set([from])
  for (const next = [from]; next.length > 0; ) {
    for (const n of after.get(next.pop() as string) ?? []) {
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
 * yet) is small and mentions none. Area labels, predicted files and the files the check commands
 * name, unless a ticket's files metadata lists them, don't link tickets, and a pair already ordered
 * by `existing` links, directly or through other tickets, gets none. Each ticket is linked to the
 * nearest one before it first, so tickets touching one function form a chain.
 */
export const planLinks = (
  open: ReadonlyArray<Issue>,
  existing: ReadonlyArray<Link>,
  repo: RepoFiles,
  source: (file: string) => string | undefined,
): ReadonlyArray<Link> => {
  const tickets = inOrder(open)
  const fps = tickets.map((issue) => planFootprint(issue, repo))
  const contents = new Map<string, string>()
  for (const fp of fps) {
    for (const f of fp.files) {
      const content = source(f)
      if (content !== undefined) contents.set(f, content)
    }
  }
  const mentions = mentionsIn(contents)
  const small = (file: string) =>
    (contents.get(file)?.split("\n").length ?? 1) - 1 <= smallFileLines
  const after = new Map<string, Array<string>>()
  const link = (blocker: string, blocked: string) =>
    after.set(blocker, [...(after.get(blocker) ?? []), blocked])
  for (const l of existing) link(l.blocker, l.blocked)
  const links: Array<Link> = []
  tickets.forEach((later, j) => {
    for (let i = j - 1; i >= 0; i--) {
      const a = tickets[i]?.id as string
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

/** A link as the proposal lists it: `  <blocked> (P2) waits for <blocker> (P1): both touch <why>`. */
export const linkLine = (link: Link, priorities: ReadonlyMap<string, number>): string =>
  `  ${link.blocked} (P${priorities.get(link.blocked) ?? 9}) waits for ${link.blocker} (P${priorities.get(link.blocker) ?? 9}): both touch ${link.why}`

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
      return `${error.command} exited with ${error.exitCode}: ${error.stderr.trim()}`
    case "BeadsTimedOut":
      return `${error.command} took too long`
    case "BeadsUnreadable":
      return `${error.command}: ${error.reason}`
  }
}

/**
 * Proposes the links between the open tickets of the project at repo, on stdout, and adds them with
 * apply. Fails with what went wrong, said on stderr: settings that can't be read, bd failing to list
 * the tickets, or a link bd didn't add.
 */
export const plan = (
  repo: string,
  apply: boolean,
): Effect.Effect<void, string, Beads | Git | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const settings = yield* readSettings(repo).pipe(Effect.mapError(settingsProblem))
    const listed = yield* beads
      .list({ status: "open" })
      .pipe(Effect.mapError((error) => `cannot read the open tickets: ${beadsProblem(error)}`))
    const open = listed.filter((issue) =>
      takes({ excludeTypes: settings.queue.exclude_types }, issue),
    )
    const check = settings.checks.fast.command
    const repoFilesNow = yield* (yield* Git).trackedFiles(repo).pipe(
      Effect.map((files) => repoFiles(files, check === null ? [] : [check])),
      Effect.orElseSucceed(() => repoFiles(undefined, check === null ? [] : [check])),
    )
    const sources = yield* readSources(
      repo,
      open.map((issue) => planFootprint(issue, repoFilesNow)),
    )
    const links = planLinks(open, existingLinks(listed), repoFilesNow, (file) => sources.get(file))
    if (links.length === 0) {
      return yield* Console.log(
        `No links to add: no two of the ${plural(open.length, "open ticket")} touch the same code without being ordered already.`,
      )
    }
    const priorities = new Map(open.map((issue) => [issue.id, priorityOf(issue)]))
    yield* Console.log(
      `${apply ? "Adding" : "Proposed"} ${plural(links.length, "blocks link")} between the ${plural(open.length, "open ticket")}:`,
    )
    let failed = 0
    for (const link of links) {
      yield* Console.log(linkLine(link, priorities))
      if (!apply) continue
      const added = yield* Effect.result(beads.addDependency(link.blocked, link.blocker))
      if (added._tag === "Failure") {
        failed++
        yield* Console.error(
          `tutti plan: bd dep add ${link.blocked} ${link.blocker}: ${beadsProblem(added.failure)}`,
        )
      }
    }
    if (!apply) return yield* Console.log("Nothing changed. Add them with: tutti plan --apply")
    if (failed === 0) return yield* Console.log(`Added ${plural(links.length, "link")}.`)
    yield* Console.log(`Added ${links.length - failed} of ${plural(links.length, "link")}.`)
    return yield* Effect.fail(`bd didn't add ${plural(failed, "link")}`)
  })
