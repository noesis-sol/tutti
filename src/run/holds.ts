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
import { EventStream } from "./eventstream.ts"
import { type Footprint, type Mentions, shared } from "./footprint.ts"
import type { State } from "./ledger.ts"
import { detail, type Line, Log, line, Tag, ticketLine } from "./log.ts"
import type { Hold, PhaseTag } from "./phase.ts"
import { ledgerView } from "./scope.ts"

/** The label of a ticket that runs alone (§ 2 Solo). */
export const soloLabel = "solo"

export const isSolo = (issue: Pick<Issue, "labels">): boolean => issue.labels.includes(soloLabel)

/** What holds a ticket back, and why, as the log's `… waits: <text>` or `skipping …: <text>` says. */
export interface Held {
  readonly why: Hold
  readonly text: string
}

/** The phases in which a ticket's worker runs or waits on a question: it hasn't merged, closed or not. */
const busy: ReadonlySet<PhaseTag> = new Set(["Working", "Resolving", "Fixing", "Asked"])

/** The phases of a ticket that may be closed and not merged, besides the busy ones. */
const unsettled: ReadonlySet<PhaseTag> = new Set([
  ...busy,
  "ToMerge",
  "Merging",
  "Review",
  "Blocked",
  "Stopped",
])

/**
 * Whether a ticket of the run may not have merged: only then can a blocker, or the ticket a
 * follow-up was filed from, hold one back, and the ready tickets' links are read.
 */
export const pending = (state: State): boolean =>
  [...state.tickets.values()].some((entry) => unsettled.has(entry.phase._tag))

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
    .filter((entry) => unsettled.has(entry.phase._tag))
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
  if (phase !== undefined && (phase._tag === "Done" || busy.has(phase._tag))) return false
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
  if (phase !== undefined && busy.has(phase._tag)) return { running: true }
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
 * by ID, whose footprint it overlaps. Undefined when it overlaps none, or names nothing.
 */
export const overlapHold = (
  fp: Footprint,
  running: ReadonlyMap<string, Footprint>,
  mentions?: Mentions,
): Held | undefined => {
  for (const id of [...running.keys()].sort()) {
    const what = shared(fp, running.get(id) as Footprint, mentions)
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
export interface SayOnce {
  /** Records `why` ("" for none), and says whether it is one to say: not "", and not the last. */
  changed(id: string, why: string): boolean
  /** Forgets the ticket's reason: the next one is said, whatever it is. */
  forget(id: string): void
}

export const sayOnce = (): SayOnce => {
  const said = new Map<string, string>()
  return {
    changed: (id, why) => {
      const last = said.get(id)
      said.set(id, why)
      return why !== "" && why !== last
    },
    forget: (id) => {
      said.delete(id)
    },
  }
}

// The run's stops (§ 5 item 10): what holds the run, then ends it with an exit code. A stop holds
// the run as it comes: no new tickets start, the running ones finish (`HOLD … no new tickets while
// the N running finish`), and once nothing runs or merges the run ends with the first stop's line,
// then `; also` and each of the others. The first decides the exit code, which is orchestra's: 4
// covers Beads, git and the Agent SDK (AGENT_FAILED replaces TERMINAL_FAILED), and 8 is the usage
// limit's.

/** orchestra's exit codes, as tutti exits with them. */
export const exitCodes = {
  /** Nothing left to run, the limit reached, or wound down as asked. */
  ok: 0,
  /** A setup problem found before the run started. */
  setup: 2,
  /** A worker needs you: PAUSED, BLOCKED, TICKET_LIMIT. */
  stuck: 3,
  /** Beads, git or the Agent SDK failed, or a fiber panicked. */
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

/** Each stop reason's word, as its line starts, and the exit code the run ends with for it. */
export const stopCodes = {
  PAUSED: exitCodes.stuck,
  BLOCKED: exitCodes.stuck,
  TICKET_LIMIT: exitCodes.stuck,
  BEADS_FAILED: exitCodes.tool,
  GIT_FAILED: exitCodes.tool,
  AGENT_FAILED: exitCodes.tool,
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

/** The stops so far: the first decides the exit code. */
export interface Stops {
  readonly first: StopReason | null
  readonly others: ReadonlyArray<StopReason>
}

export const noStops: Stops = { first: null, others: [] }

/**
 * Why the run takes on no more work, as the merges say it when they hand no failed check back
 * (orchestra's sayNoMore): a stop holds it, the usage limit does, or it winds down. Undefined when
 * it takes work.
 */
export const noMoreWork = (
  stops: Stops,
  usageHeld: boolean,
  windingDown: boolean,
): string | undefined =>
  stops.first !== null
    ? `the run holds (${stops.first.text})`
    : usageHeld
      ? "the run holds (USAGE_LIMIT)"
      : windingDown
        ? "the run is winding down"
        : undefined

/** `stops` with `stop` added after them. */
export const addStop = (stops: Stops, stop: StopReason): Stops =>
  stops.first === null ? { first: stop, others: [] } : { ...stops, others: [...stops.others, stop] }

/** `stops` without those `lifted` picks: the first left decides the exit code. */
export const liftStops = (stops: Stops, lifted: (stop: StopReason) => boolean): Stops => {
  const kept = [stops.first, ...stops.others].flatMap((stop) =>
    stop === null || lifted(stop) ? [] : [stop],
  )
  return { first: kept[0] ?? null, others: kept.slice(1) }
}

/** The line the run ends with: the first stop's, then `; also` and each of the others. */
export const stopsLine = (stops: Stops): Line =>
  [stops.first, ...stops.others]
    .flatMap((stop) => (stop === null ? [] : [stop.text]))
    .join("; also ") as Line

/** The exit code the stops end the run with: the first's, or 0 with none. */
export const exitCodeOf = (stops: Stops): number => stops.first?.code ?? exitCodes.ok

// The holds that come with time (§ 4.3, § 4.5). A worker still going --ticket-limit after its
// dispatch holds the run with TICKET_LIMIT: it isn't interrupted and goes on, the run doesn't wait
// for it to end, and the run's end suspends it (§ 4.8). Without a limit, one still going after
// longRunning is said once, LONG_RUNNING. As orchestra's overTime, the time a worker waits for the
// usage limit to reset (UsageLimited, § 4.12) doesn't count. An attention request unanswered for
// Attention's blockedAfter holds the run with BLOCKED, for its ticket; once that ticket has no
// request open, the hold is lifted, as what held the run is gone. run.ts keeps these stops.

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
 * not counted.
 */
export const goneOn = (
  ticket: string,
  span: Duration.Duration,
  since: number,
): Effect.Effect<void, never, AgentHost> =>
  Effect.gen(function* () {
    let left = Duration.toMillis(span) - ((yield* Clock.currentTimeMillis) - since)
    for (;;) {
      const from = yield* Clock.currentTimeMillis
      const limited = yield* Effect.raceFirst(
        Effect.as(Effect.sleep(Duration.millis(Math.max(0, left))), false),
        Effect.as(
          until(ticket, (state) => state._tag === "UsageLimited"),
          true,
        ),
      )
      if (!limited) return
      left -= (yield* Clock.currentTimeMillis) - from
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
      yield* (yield* Log).writeWith(
        [text],
        (yield* EventStream).emit({ kind: "warn", ticket, text }),
      )
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
