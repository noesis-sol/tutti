// What holds a ready ticket back besides a free slot (§ 5 item 5, § 5.1 HeldBack), as orchestra's
// holds.go and footprint.go have it. A parent runs last: it waits until each of its subtickets is
// closed and merged, as its worker couldn't close it before and its work builds on theirs. A ticket
// waits for a blocker, and a follow-up for the ticket it was filed from (discovered-from, which bd
// doesn't count as blocking), until that one merges: bd ready lists a ticket once its blockers are
// closed, but their code isn't on the base until they merge. With a slot free, a ticket whose
// footprint overlaps a running ticket's is skipped for the next. A solo ticket runs alone (the
// scheduler's pick). The log says once why each ticket waits, and again only when that changes.
//
// What holds the whole run, its stop reasons and the exit codes they end it with, is below, then
// the holds that come with time: TICKET_LIMIT, LONG_RUNNING and BLOCKED.
import { Clock, Duration, Effect, Option, Stream } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { type AttentionRequest, describe } from "../agent/Attention.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, type Dependency, type Issue } from "../services/Beads.ts"
import { awakeSince, sleepAwake } from "../services/Wake.ts"
import type { EventStream } from "./eventstream.ts"
import type { Footprint } from "./footprint.ts"
import type { State } from "./ledger.ts"
import { detail, type Line, type Log, line, Tag, ticketLine } from "./log.ts"
import { holdWord as machineWord } from "./machine.ts"
import { type Mentions, shared } from "./overlap.ts"
import { type Hold, phaseFacts } from "./phase.ts"
import type { RunHold, Usage } from "./runView.ts"
import { warn } from "./say.ts"
import { ledgerView } from "./scope.ts"
import type { UsageView } from "./usageLimit.ts"

/** The label of a ticket that runs alone (§ 2 Solo). */
export const soloLabel = "solo"

export const isSolo = (issue: Pick<Issue, "labels">): boolean => issue.labels.includes(soloLabel)

/** What holds a ticket back, and why, as the log's `… waits: <text>` or `skipping …: <text>` says. */
export interface Held {
  readonly why: Hold
  readonly text: string
}

/**
 * Whether a ticket of the run may not have merged: only then can a blocker, or the ticket a
 * follow-up was filed from, hold one back, and the ready tickets' links are read.
 */
export const pending = (state: State): boolean =>
  [...state.tickets.values()].some((entry) => phaseFacts[entry.phase._tag].unsettled)

/**
 * The tickets bd has closed and labelled `unmerged` (left so by an earlier run) that this run hasn't
 * merged since: their code isn't on the base, so they hold back their parents and the tickets
 * waiting on them, as the run's own do. The label is bd's; the run, once it merged one, knows better.
 */
export const leftUnmerged = <I extends Pick<Issue, "id">>(
  state: State,
  labelled: ReadonlyArray<I>,
): ReadonlyArray<I> =>
  labelled.filter((issue) => state.tickets.get(issue.id)?.phase._tag !== "Done")

/** The run's tickets that may not have merged, whose parents wait for them. */
export const unmerged = (state: State): ReadonlyArray<string> =>
  [...state.tickets.values()]
    .filter((entry) => phaseFacts[entry.phase._tag].unsettled)
    .map((entry) => entry.ticket)

/**
 * The tickets that wait for their subtickets: the parents of `open`, the tickets bd lists as not
 * closed (and those left unmerged), and of the run's tickets that may be closed and not merged
 * (`parentOf` gives theirs).
 */
export const parentsWaiting = (
  open: ReadonlyArray<Pick<Issue, "parent">>,
  state: State,
  parentOf: ReadonlyMap<string, string>,
): ReadonlySet<string> => {
  const parents = new Set<string>()
  for (const issue of open) if (issue.parent !== undefined) parents.add(issue.parent)
  for (const id of unmerged(state)) {
    const parent = parentOf.get(id)
    if (parent !== undefined && parent !== "") parents.add(parent)
  }
  return parents
}

/** The hold of a parent whose subtickets aren't all closed and merged. */
export const parentHold: Held = {
  why: "parent",
  text: "its subtickets are not all closed and merged",
}

/** The hold of a ticket whose links bd couldn't show: it waits. */
export const unreadableHold: Held = { why: "merge", text: "its dependencies could not be read" }

/**
 * Whether the run knows nothing of the linked ticket that says it hasn't merged, though bd shows it
 * closed: not merged by the run, nor running, waiting to merge or set aside unmerged in it, nor
 * labelled. Only git can say then whether its work is on the base (closedBranches.ts).
 */
export const asksGit = (state: State, link: Dependency): boolean => {
  if ((link.issue?.status ?? "closed") !== "closed") return false
  const phase = state.tickets.get(link.id)?.phase
  if (phase !== undefined && (phase._tag === "Done" || phaseFacts[phase._tag].busy)) return false
  return ledgerView(state).unmerged(link.issue ?? closedLink(link)) === undefined
}

/** A link bd show didn't describe, taken for closed: bd ready lists a ticket once its blockers are. */
const closedLink = (link: Dependency) => ({ id: link.id, status: "closed", labels: [] })

/**
 * Why the linked ticket hasn't merged, as the run knows it: its worker runs or waits on a question
 * (`running`), or it is closed and not merged (`closed`, with the reason, the run's or else git's
 * from `branches`, by ID); undefined once it has merged. One open and not running holds nothing, as
 * it may never run.
 */
const notMerged = (
  state: State,
  link: Dependency,
  branches: ReadonlyMap<string, string>,
): { readonly running: true } | { readonly closed: string } | undefined => {
  const phase = state.tickets.get(link.id)?.phase
  if (phase !== undefined && phaseFacts[phase._tag].busy) return { running: true }
  const why = ledgerView(state).unmerged(link.issue ?? closedLink(link))
  if (why !== undefined) return { closed: why }
  const off = asksGit(state, link) ? branches.get(link.id) : undefined
  return off === undefined ? undefined : { closed: off }
}

/**
 * What holds `issue` (as bd show gives it, with its links) back for a ticket not merged yet: a
 * blocker, then the ticket it was filed from. `branches` says, by ID, why git finds a closed one's
 * work only on its branch, for those the run knows nothing of (asksGit). Undefined when nothing does.
 */
export const mergeHold = (
  state: State,
  issue: Pick<Issue, "dependencies">,
  branches: ReadonlyMap<string, string> = new Map(),
): Held | undefined => {
  for (const link of issue.dependencies) {
    if (link.type !== "blocks") continue
    const why = notMerged(state, link, branches)
    if (why === undefined) continue
    const text =
      "running" in why
        ? `waiting for ${link.id} to merge`
        : `${link.id} closed but not merged (${why.closed})`
    return { why: "merge", text }
  }
  for (const link of issue.dependencies) {
    if (link.type !== "discovered-from") continue
    const why = notMerged(state, link, branches)
    if (why === undefined) continue
    const text =
      "running" in why
        ? `filed by ${link.id}'s worker; waiting for it to merge`
        : `filed by ${link.id}'s worker; ${link.id} closed but not merged (${why.closed})`
    return { why: "merge", text }
  }
  return undefined
}

/** Whether `issue`, as bd ready gives it, links to a ticket it waits on: a blocker or a source. */
export const waitsOnLinks = (issue: Pick<Issue, "dependencies">): boolean =>
  issue.dependencies.some((link) => link.type === "blocks" || link.type === "discovered-from")

/**
 * What holds a ticket with footprint `fp` back for a running ticket's (`running`, by ID): the first,
 * by ID, whose footprint it overlaps. Undefined when it overlaps none, or names nothing. A file
 * `apart` says no to (one of the settings' shared files) holds none back.
 */
export const overlapHold = (
  fp: Footprint,
  running: ReadonlyMap<string, Footprint>,
  mentions?: Mentions,
  apart?: (file: string) => boolean,
): Held | undefined => {
  for (const id of [...running.keys()].sort()) {
    const what = shared(fp, running.get(id) as Footprint, mentions, apart)
    if (what !== "") return { why: "overlap", text: `touches ${what}, like running ${id}` }
  }
  return undefined
}

/** `  <id> waits: <why>`, said once per reason. */
export const waitsLine = (id: string, why: string): Line => detail`${id} waits: ${why}`

/** `  skipping <id>: <why>`, said once per reason. */
export const skippingLine = (id: string, why: string): Line => detail`skipping ${id}: ${why}`

/** The line for the tickets waiting on solo ticket `id`, running or next. */
export const soloLine = (id: string, next: boolean): Line =>
  next
    ? detail`solo ticket ${id} is next: no new tickets start until the running ones finish, then it runs alone`
    : detail`waiting for solo ticket ${id} to finish`

/** A file the worktrees of two running tickets, a before b, both changed. */
export interface SharedChange {
  readonly a: string
  readonly b: string
  readonly file: string
}

/**
 * The files two running tickets' worktrees both changed, from each one's changes (by ticket): by
 * the pair, in the order of their IDs, then as a's changes list them.
 */
export const sharedChanges = (
  changed: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<SharedChange> => {
  const ids = [...changed.keys()].sort()
  const both: Array<SharedChange> = []
  ids.forEach((a, i) => {
    for (const b of ids.slice(i + 1)) {
      const theirs = changed.get(b) ?? []
      for (const file of changed.get(a) ?? []) if (theirs.includes(file)) both.push({ a, b, file })
    }
  })
  return both
}

/** The LIKELY_CONFLICT line, as orchestra words it. */
export const likelyConflictLine = (edit: SharedChange): Line =>
  detail`LIKELY_CONFLICT: ${edit.a} and ${edit.b} both edit ${edit.file}; the second to merge may conflict`

/** The reason last said for each ticket, so that it is said again only when it changes. */
export type Said = ReadonlyMap<string, string>

/**
 * `said` with `why` ("" for none) recorded as the ticket's reason, and whether it is one to say:
 * not "", and not the last.
 */
export const saying = (
  said: Said,
  id: string,
  why: string,
): { readonly said: Said; readonly say: boolean } => ({
  said: new Map(said).set(id, why),
  say: why !== "" && why !== said.get(id),
})

/** `said` without the ticket's reason: the next one is said, whatever it is. */
export const unsaid = (said: Said, id: string): Said => {
  if (!said.has(id)) return said
  const without = new Map(said)
  without.delete(id)
  return without
}

// The run's stops (§ 5 item 10): what holds the run, then ends it with an exit code. A stop holds
// the run as it comes: no new tickets start, the running ones finish (`HOLD … no new tickets while
// the N running finish`), and once nothing runs or merges the run ends with the first stop's line,
// then `; also` and each of the others. The first decides the exit code, which is orchestra's: 4
// covers Beads and git, without orchestra's TERMINAL_FAILED (an Agent SDK that can't start
// sessions holds the run as ENVIRONMENT, exit 7), and 8 is the usage limit's.

/** orchestra's exit codes, as tutti exits with them. */
export const exitCodes = {
  /** Nothing left to run, the limit reached, or wound down as asked. */
  ok: 0,
  /**
   * A setup problem found before the run started, or in a worker's first system/init, or a
   * requirement missing as it starts.
   */
  setup: 2,
  /** A worker needs you: PAUSED, BLOCKED, TICKET_LIMIT. */
  stuck: 3,
  /** Beads or git failed, or a fiber panicked. */
  tool: 4,
  /** The main checkout has uncommitted changes, or left its branch. */
  dirty: 5,
  /** A finished ticket's branch doesn't fast-forward. */
  merge: 6,
  /** Workers kept failing at once, whatever ticket they had. */
  environment: 7,
  /** The account's usage limit held for longer than --usage-limit-wait (§ 4.12). */
  usageLimit: 8,
  /** Quit. */
  interrupted: 130,
} as const

/**
 * What each exit code means, for the reviewer (§ 5 item 10): one entry a code, so a new code
 * can't go without one. Each names the stop words that end a run with it.
 */
export const exitMeanings: Record<keyof typeof exitCodes, string> = {
  ok:
    "nothing was left to start or merge, or the limit was reached; " +
    "a run of one ticket says in its final line whether all of it is merged",
  setup:
    "a setup problem: the startup checks failed, a worker's first system/init showed one " +
    "(SETUP_PROBLEM), or a requirement went missing as the run went (REQUIREMENTS_MISSING)",
  stuck: "a worker stopped the run (PAUSED, BLOCKED, TICKET_LIMIT) and needs attention",
  tool:
    "a Beads or git command failed (BEADS_FAILED, GIT_FAILED), " +
    "a ticket's worktree couldn't be set up (WORKTREE_FAILED), the run's state couldn't be written " +
    "(STATE_UNWRITABLE), or a fiber panicked (PANIC)",
  dirty: "the main checkout had uncommitted changes or left its branch (DIRTY_TREE)",
  merge: "a finished ticket's branch did not fast-forward (MERGE_FAILED)",
  environment:
    "workers kept failing at once, whichever ticket they had: the environment, not the tickets " +
    "(ENVIRONMENT)",
  usageLimit:
    "the account's usage limit held the run, and it reset too late or at an unknown time " +
    "(USAGE_LIMIT)",
  interrupted: "the run was quit (INTERRUPTED)",
}

/** Each stop reason's word, as its line starts, and the exit code the run ends with for it. */
export const stopCodes = {
  REQUIREMENTS_MISSING: exitCodes.setup,
  SETUP_PROBLEM: exitCodes.setup,
  PAUSED: exitCodes.stuck,
  BLOCKED: exitCodes.stuck,
  TICKET_LIMIT: exitCodes.stuck,
  BEADS_FAILED: exitCodes.tool,
  GIT_FAILED: exitCodes.tool,
  WORKTREE_FAILED: exitCodes.tool,
  STATE_UNWRITABLE: exitCodes.tool,
  PANIC: exitCodes.tool,
  DIRTY_TREE: exitCodes.dirty,
  MERGE_FAILED: exitCodes.merge,
  ENVIRONMENT: exitCodes.environment,
  USAGE_LIMIT: exitCodes.usageLimit,
  INTERRUPTED: exitCodes.interrupted,
} as const

export type StopWord = keyof typeof stopCodes

/** A reason the run stops for. */
export interface StopReason {
  readonly why: StopWord
  readonly code: number
  /** The line the run ends with for it, starting with `why`: `PAUSED: …`. */
  readonly text: Line
  /** The ticket it stopped the run over, if any. */
  readonly ticket?: string
  /** What it keeps that ticket from merging for, in a few words, as a `stop` record says. */
  readonly blocked?: string
  /** Its `stop` record was written as it came, so the run's end needn't write it again. */
  readonly recorded: boolean
  /** Its HOLD line was said as it came. */
  readonly held: boolean
}

/** The stop for `why`, its line `WHY: <text>`. */
export const stopFor = (
  why: StopWord,
  text: string,
  fields: Partial<Pick<StopReason, "ticket" | "blocked" | "recorded" | "held">> = {},
): StopReason => ({
  why,
  code: stopCodes[why],
  text: `${why}: ${line`${text}`}` as Line,
  recorded: false,
  held: false,
  ...fields,
})

/** A stop given as its line (`WHY: …`, or `HOLD: WHY: …` as a hold says it), with its code. */
export const stopOfLine = (
  given: { readonly why: StopWord; readonly code: number; readonly line: Line },
  fields: Partial<Pick<StopReason, "ticket" | "blocked" | "recorded" | "held">> = {},
): StopReason => {
  const hold = `HOLD: ${given.why}: `
  const text = given.line.startsWith(hold) ? given.line.slice("HOLD: ".length) : given.line
  return {
    why: given.why,
    code: given.code,
    text: text as Line,
    recorded: false,
    held: false,
    ...fields,
  }
}

/** The stops so far, in the order raised: the first decides the exit code. */
export type Stops = ReadonlyArray<StopReason>

export const noStops: Stops = []

/** The first of `stops`, which decides the exit code, or null for none. */
export const firstStop = (stops: Stops): StopReason | null => stops[0] ?? null

/** Why the run takes on no more work while the account's usage limit holds it. */
export const usageHolds = "the run holds (USAGE_LIMIT)"

/**
 * Whether the run may take work, as one decision reads it: the five values each "may it" asks of,
 * read together once (the run's gate, run.ts), so that the predicates below answer from one look.
 */
export interface Gate {
  /** The first of the stops holding the run, or null for none. */
  readonly stop: StopReason | null
  /** Whether the account's usage limit holds the run (usageLimit.ts). */
  readonly usageHeld: boolean
  /** Whether the run has ended (screenCommands.ts): nothing starts after it. */
  readonly ended: boolean
  /** Whether the run winds down (the ledger's windDown): it takes up only what is running. */
  readonly windingDown: boolean
  /** Whether the run has started as many tickets as --limit allows. */
  readonly limitReached: boolean
}

/** A gate with nothing holding the run back. */
export const openGate: Gate = {
  stop: null,
  usageHeld: false,
  ended: false,
  windingDown: false,
  limitReached: false,
}

/**
 * Whether the run holds: a stop, the usage limit, or its end. A ticket set aside is taken
 * back into the queue only while it doesn't.
 */
export const holds = (gate: Gate): boolean => gate.stop !== null || gate.usageHeld || gate.ended

/**
 * Whether the run takes back the work it has: the workers carried over and the answered tickets,
 * none while it holds or winds down, which takes up only what is running.
 */
export const takesBack = (gate: Gate): boolean => !holds(gate) && !gate.windingDown

/** Whether the run takes new tickets: as it takes work back, and short of --limit. */
export const takesNew = (gate: Gate): boolean => takesBack(gate) && !gate.limitReached

/**
 * Why the run takes on no more work, as the merges say it when they hand no failed check back
 * (orchestra's sayNoMore): a stop holds it, the usage limit does, or it winds down. Undefined when
 * it takes work.
 */
export const noMoreWork = (gate: Gate): string | undefined =>
  gate.stop !== null
    ? `the run holds (${gate.stop.text})`
    : gate.usageHeld
      ? usageHolds
      : gate.windingDown
        ? "the run is winding down"
        : undefined

/** `stops` with `stop` added after them. */
export const addStop = (stops: Stops, stop: StopReason): Stops => [...stops, stop]

/** `stops` without those `lifted` picks: the first left decides the exit code. */
export const liftStops = (stops: Stops, lifted: (stop: StopReason) => boolean): Stops =>
  stops.some(lifted) ? stops.filter((stop) => !lifted(stop)) : stops

/**
 * `stops` with `stop` swapped for `by` where it stands, or lifted with null: those raised beside it
 * stay, as the environment probe's pass or failure keeps the stops raised while it waited.
 */
export const swapStop = (stops: Stops, stop: StopReason, by: StopReason | null): Stops =>
  stops.flatMap((each) => (each !== stop ? [each] : by === null ? [] : [by]))

/** The line the run ends with: the first stop's, then `; also` and each of the others. */
export const stopsLine = (stops: Stops): Line =>
  stops.map((stop) => stop.text).join("; also ") as Line

/** The exit code the stops end the run with: the first's, or 0 with none. */
export const exitCodeOf = (stops: Stops): number => stops[0]?.code ?? exitCodes.ok

/** `stops` with `stop` first, before those it had, as quitting's or a panic's stop goes. */
export const putFirst = (stops: Stops, stop: StopReason): Stops => [stop, ...stops]

/** `stops` with `parts` added to the first's line, each after `; `; unchanged with no stop. */
export const extendFirst = (stops: Stops, parts: ReadonlyArray<string>): Stops => {
  const [first, ...others] = stops
  return first === undefined || parts.length === 0
    ? stops
    : [{ ...first, text: `${first.text}; ${parts.join("; ")}` as Line }, ...others]
}

// Everything that holds the whole run is one value, Holds, which run.ts keeps in a SubscriptionRef
// and changes only through the functions below: its stops, BLOCKED among them once per ticket, the
// tickets past --ticket-limit, the hold at --machine-workers and the usage limit's view. The title
// line's `· stopping`, its banners and the usage line are what it shows (shownHolds), as orchestra
// keeps its stops and holds in one gate.

/** What holds the whole run. */
export interface Holds {
  readonly stops: Stops
  /** The tickets whose workers went on past --ticket-limit: the run doesn't wait for them. */
  readonly overLimit: ReadonlySet<string>
  /** The run holds a free slot while the machine is at --machine-workers. */
  readonly machine: boolean
  /** What the usage limit's hold shows: the usage line, its banner and its notice. */
  readonly usage: UsageView
}

export const noHolds: Holds = {
  stops: noStops,
  overLimit: new Set(),
  machine: false,
  usage: { usage: null, hold: null, notice: null },
}

/** `holds` with its stops changed by `change`. */
export const changeStops = (holds: Holds, change: (stops: Stops) => Stops): Holds => {
  const stops = change(holds.stops)
  return stops === holds.stops ? holds : { ...holds, stops }
}

/** `holds` with `stop` raised after the others. */
export const raiseStop = (holds: Holds, stop: StopReason): Holds =>
  changeStops(holds, (stops) => addStop(stops, stop))

/** `holds` with `ticket`'s worker past its ticket limit: its TICKET_LIMIT `stop` raised. */
export const pastTicketLimit = (holds: Holds, ticket: string, stop: StopReason): Holds => ({
  ...raiseStop(holds, stop),
  overLimit: new Set([...holds.overLimit, ticket]),
})

/** The tickets the run holds with BLOCKED, each its stop's. */
export const blockedTickets = (holds: Holds): ReadonlySet<string> =>
  new Set(
    holds.stops.flatMap((stop) =>
      stop.why === "BLOCKED" && stop.ticket !== undefined ? [stop.ticket] : [],
    ),
  )

/** `holds` with the BLOCKED stop of `ticket` lifted, its requests answered. */
export const liftBlocked = (holds: Holds, ticket: string): Holds =>
  changeStops(holds, (stops) => liftStops(stops, (stop) => isBlockedOn(stop, ticket)))

/** `holds` with the machine's hold on (`full`) or off. */
export const withMachineHold = (holds: Holds, full: boolean): Holds =>
  holds.machine === full ? holds : { ...holds, machine: full }

/** `holds` showing the usage limit's `view`. */
export const showUsage = (holds: Holds, view: UsageView): Holds => ({ ...holds, usage: view })

/** What the dashboard shows of the holds: `· stopping`, the banners and the usage line. */
export interface ShownHolds {
  /** A stop holds the run, and the running tickets are finishing. */
  readonly stopping: boolean
  /** The banners, BLOCKED first, then the usage limit's and the machine's. */
  readonly holds: ReadonlyArray<RunHold>
  readonly usage: Usage | null
  /** The usage limit's notice, if it holds the run. */
  readonly notice: string | null
}

export const shownHolds = (holds: Holds): ShownHolds => ({
  stopping: holds.stops.length > 0,
  holds: [
    ...(blockedTickets(holds).size > 0 ? [{ word: Tag.blocked, resetsAt: null }] : []),
    ...(holds.usage.hold === null ? [] : [holds.usage.hold]),
    ...(holds.machine ? [{ word: machineWord, resetsAt: null }] : []),
  ],
  usage: holds.usage.usage,
  notice: holds.usage.notice,
})

// The holds that come with time (§ 4.3, § 4.5). A worker still going --ticket-limit after its
// dispatch holds the run with TICKET_LIMIT: it isn't interrupted and goes on, the run doesn't wait
// for it to end, and the run's end suspends it (§ 4.8). Without a limit, one still going after
// longRunning is said once, LONG_RUNNING. As orchestra's overTime, the time a worker waits for the
// usage limit to reset (UsageLimited, § 4.12) doesn't count, nor the time the machine sleeps
// (Wake.ts). An attention request unanswered for Attention's blockedAfter holds the run with
// BLOCKED, for its ticket; once that ticket has no request open, the hold is lifted, as what held
// the run is gone. run.ts keeps these stops.

/** How long a worker may go on, without a ticket limit, before the log says LONG_RUNNING. */
export const longRunning: Duration.Duration = Duration.hours(2)

/** The TICKET_LIMIT stop of `id`'s worker, still going `limit` after its dispatch. */
export const ticketLimitStop = (id: string, limit: string, worktree: string): StopReason =>
  stopFor(
    "TICKET_LIMIT",
    `${id} still working after ${limit} (worktree ${worktree}); its worker goes on, and is suspended when the run ends`,
    { ticket: id },
  )

/** `  LONG_RUNNING: …`, said once of a worker going on without a ticket limit. */
export const longRunningLine = (id: string): Line =>
  ticketLine(
    Tag.longRunning,
  )`${id} still working after ${formatDuration(longRunning)}; still waiting on it, as no ticket limit is set (--ticket-limit)`

/** The BLOCKED stop of `id`'s worker, its request `what` unanswered: `BLOCKED >4min: …`. */
export const blockedStop = (id: string, what: string): StopReason => ({
  why: "BLOCKED",
  code: stopCodes.BLOCKED,
  text: line`${Tag.blocked} >4min: ${id} needs you: ${what}`,
  ticket: id,
  recorded: false,
  held: false,
})

/** The line of a BLOCKED hold lifted, `id`'s requests answered. */
export const blockedLifted = (id: string): Line =>
  line`${Tag.hold} lifted: ${id}'s requests were answered`

/** Whether `stop` is the BLOCKED stop of ticket `id`. */
export const isBlockedOn = (stop: StopReason, id: string): boolean =>
  stop.why === "BLOCKED" && stop.ticket === id

/**
 * What the open requests, oldest first, say of the BLOCKED holds at `now`: the tickets with one
 * open past `after`, each with its oldest such request, and the tickets held (`blocked`) that have
 * none open any longer.
 */
export const blockedAt = (
  requests: ReadonlyArray<AttentionRequest>,
  blocked: ReadonlySet<string>,
  now: number,
  after: Duration.Duration,
): {
  readonly trips: ReadonlyArray<{ readonly ticket: string; readonly what: string }>
  readonly lifts: ReadonlyArray<string>
} => {
  const trips = new Map<string, string>()
  for (const request of requests) {
    if (now - request.createdAt < Duration.toMillis(after)) continue
    if (blocked.has(request.ticket) || trips.has(request.ticket)) continue
    trips.set(request.ticket, describe(request))
  }
  const open = new Set(requests.map((request) => request.ticket))
  return {
    trips: [...trips].map(([ticket, what]) => ({ ticket, what })),
    lifts: [...blocked].filter((ticket) => !open.has(ticket)),
  }
}

/** Waits until `ticket`'s worker is in a state `wanted` picks; never, once its session has gone. */
const until = (ticket: string, wanted: (state: WorkerState) => boolean) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const seen = yield* host.state(ticket).pipe(
      Stream.filter(wanted),
      Stream.runHead,
      Effect.orElseSucceed(() => Option.none<WorkerState>()),
    )
    if (Option.isNone(seen)) return yield* Effect.never
  })

/**
 * Waits until `ticket`'s worker has gone on for `span` since `since`, the time it was UsageLimited
 * and the time the machine slept not counted.
 */
export const goneOn = (
  ticket: string,
  span: Duration.Duration,
  since: number,
): Effect.Effect<void, never, AgentHost> =>
  Effect.gen(function* () {
    let left = Duration.toMillis(span) - (yield* awakeSince(since))
    for (;;) {
      const from = yield* Clock.currentTimeMillis
      const limited = yield* Effect.raceFirst(
        Effect.as(sleepAwake(Duration.millis(Math.max(0, left))), false),
        Effect.as(
          until(ticket, (state) => state._tag === "UsageLimited"),
          true,
        ),
      )
      if (!limited) return
      left -= yield* awakeSince(from)
      yield* until(ticket, (state) => state._tag !== "UsageLimited")
    }
  })

/**
 * The time hold of `ticket`'s worker, dispatched at `since`, its worktree at `worktree`: once it
 * has gone on --ticket-limit, its ticket is noted and `onLimit` given its TICKET_LIMIT stop;
 * without a limit, LONG_RUNNING is said once it has gone on longRunning. Run for as long as the
 * worker goes on, and interrupted once it has settled.
 */
export const timeLimit = (
  ticket: string,
  worktree: string,
  since: number,
  onLimit: (stop: StopReason) => Effect.Effect<void>,
): Effect.Effect<void, never, AppConfig | AgentHost | Beads | Log | EventStream> =>
  Effect.gen(function* () {
    const limit = (yield* AppConfig).settings.workers.ticket_limit
    yield* goneOn(ticket, limit ?? longRunning, since)
    if (limit === null) {
      const text = longRunningLine(ticket)
      yield* warn(text, ticket)
      return
    }
    const after = formatDuration(limit)
    yield* Effect.ignore(
      (yield* Beads).update(ticket, {
        appendNotes: `tutti: its worker was still working after the ${after} ticket limit (worktree ${worktree}).`,
      }),
    )
    yield* onLimit(ticketLimitStop(ticket, after, worktree))
  })
