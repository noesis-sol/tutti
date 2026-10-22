// RunView (§ 3.5): an immutable projection of what the dashboard shows (totals, ticket rows,
// cards, open attention requests, banners for holds and usage, the wind-down and the hint). It is
// derived afresh from the ledger's phases, the workers' states, the open requests and the run's
// status each time one changes, and kept nowhere else. Transcripts are not in it.
//
// project() is the pure part: it keeps the identity of every part that hasn't changed (a row, a
// card, the totals, the whole view), so React's memoisation works. make() forks the fiber that
// writes it into a SubscriptionRef, at most 30 times a second, so a burst of SDK messages costs one
// render. Text from tickets is sanitised here, where it enters RunView (§ 7.10).
import {
  Clock,
  Data,
  Duration,
  Effect,
  type Stream as EffectStream,
  Queue,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import type { AttentionRequest } from "../agent/Attention.ts"
import type { LatestAction } from "../agent/Transcripts.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { formatDuration } from "../project/configFile.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { type ProbeView, probeLabel, probeWorker } from "./environment.ts"
import { type Entry, handBackWaits, type State, showsCard } from "./ledger.ts"
import { type Levels, type Pressure, type Reading, unknownMemory } from "./load.ts"
import { resetLabel } from "./localTime.ts"
import type { CheckAhead } from "./mergetrain.ts"
import { type Activity, countsUnder, type PhaseTag, TicketPhase } from "./phase.ts"

/** A hold on the run, for its banner: `BLOCKED`, `USAGE_LIMIT` with its reset, … */
export interface RunHold {
  readonly word: string
  /** When it lifts by itself, in epoch milliseconds; null when nothing says. */
  readonly resetsAt: number | null
  /** The run waits for it with nothing else running: its banner counts down to `resetsAt`. */
  readonly waiting?: true
}

/** The account's usage (§ 4.12): how much of its limit is used, 0 to 1, and when it resets. */
export interface Usage {
  readonly utilization: number
  readonly resetsAt: number | null
  /** The limit's name, as in `five-hour`. */
  readonly limit?: string
  /** Overage is in use. */
  readonly overage?: true
}

/** The solo ticket (§ 5): running alone, or next, with no new ticket starting until it runs. */
export interface Solo {
  readonly ticket: string
  readonly running: boolean
}

/** What the run says about itself, beside its tickets. */
export interface Status {
  /** tutti's version, for the title line. */
  readonly version: string
  /** Where finished tickets land. */
  readonly branch: string
  /** The ticket a scoped run (`--ticket`) works on; null for none. */
  readonly scope: string | null
  /** When the run began, in epoch milliseconds, for its run time. */
  readonly began: number
  /** How many workers may run at once. */
  readonly concurrency: number
  readonly holds: ReadonlyArray<RunHold>
  readonly usage: Usage | null
  /** Something stopped the run, and the running tickets are finishing. */
  readonly stopping: boolean
  /** The run is quitting (§ 4.8): `Quitting… waiting for t-1's worker`; null when it isn't. */
  readonly quitting: string | null
  /**
   * Everything else is done and these tickets' workers wait on you (D19, § 5 item 14), by a request
   * open or a conflict hand-back waiting (§ 4.3): the run stays open for them, showing the end-of-run
   * box; null when it isn't so.
   */
  readonly endOfRun: ReadonlyArray<string> | null
  readonly solo: Solo | null
  /** How many other tutti and orchestra runs share the machine, as the last look found them. */
  readonly shared: number
  /** The machine's load, as the run last read it (load.ts); null until it has, or when it doesn't. */
  readonly load: Reading | null
  /** The tickets not closed that the queue draws from (`9 of 16`); null until the run says. */
  readonly unclosed: number | null
  /** The triage organ's verdicts on tickets set aside, by ticket: `environment · high · …`. */
  readonly verdicts: ReadonlyMap<string, string>
  /** How the checks of tickets waiting to merge go ahead of their turn, by ticket (mergetrain.ts). */
  readonly checksAhead: ReadonlyMap<string, CheckAhead>
  /** The environment probe's session, while it runs (§ 4.9): shown as a card labelled `probe`. */
  readonly probe: ProbeView | null
  /** What the dashboard's warning line says for the whole run: the colour scheme's notices. */
  readonly warnings: ReadonlyArray<string>
}

export const emptyStatus: Status = {
  version: "",
  branch: "",
  scope: null,
  began: 0,
  concurrency: 0,
  holds: [],
  usage: null,
  stopping: false,
  quitting: null,
  endOfRun: null,
  solo: null,
  shared: 0,
  load: null,
  unclosed: null,
  verdicts: new Map(),
  checksAhead: new Map(),
  probe: null,
  warnings: [],
}

/** Everything RunView is derived from. */
export interface Inputs {
  readonly ledger: State
  /** Each open worker's state, by its ticket. */
  readonly workers: ReadonlyMap<string, WorkerState>
  /** The open attention requests, every worker's, oldest first. */
  readonly requests: ReadonlyArray<AttentionRequest>
  readonly status: Status
  /** Each open worker's latest action (§ 4.4), by its ticket; none when left out. */
  readonly actions?: ReadonlyMap<string, LatestAction>
  /**
   * The time the view is projected at, which a usage limit's reset is read against: its weekday
   * and date shown when it isn't that day. Left out, a reset is read on its own day, as `14:05`.
   */
  readonly now?: number
}

/** The streams make() reads its inputs from: each gives its value now, then each change. */
export interface Sources {
  readonly ledger: EffectStream.Stream<State>
  readonly workers: EffectStream.Stream<ReadonlyMap<string, WorkerState>>
  readonly requests: EffectStream.Stream<ReadonlyArray<AttentionRequest>>
  readonly status: EffectStream.Stream<Status>
  /** None when left out. */
  readonly actions?: EffectStream.Stream<ReadonlyMap<string, LatestAction>>
}

/** The dashboard's totals (§ 5.1, § 7.2). */
export interface Totals {
  readonly completed: number
  /** Set aside: deferred, and left for review. */
  readonly deferred: number
  readonly review: number
  /** Those set aside with the triage organ's verdict in. */
  readonly triaged: number
  /** Each ticket once: Asked, Blocked, and those whose worker waits on you. */
  readonly needsYou: number
  /** Workers at work, of `slots`. */
  readonly workers: number
  readonly slots: number
  readonly queued: number
  /** The tickets not closed the queue draws from; null until the run says. */
  readonly unclosed: number | null
  readonly heldBack: number
  /** Back in the queue as the setup failed in their worktrees, until a ticket merges or a probe. */
  readonly setupFailed: number
  /** The queue takes no new tickets: the run winds down, or is held. */
  readonly queueHeld: boolean
}

/**
 * A row of the tickets table, from the moment the run picks its ticket up. It keeps its place but
 * as its ticket leaves Current, when it moves to the end.
 */
export interface Row {
  readonly ticket: string
  readonly title: string
  /** The row's status, as `▶ testing`: its mark and its word. */
  readonly mark: string
  readonly word: string
  /** What the row says of the ticket: its title, or how it finished. */
  readonly note: string
  /** The triage organ's verdict, which replaces the note of a ticket set aside once it is in. */
  readonly verdict: string | null
}

/** What a card shows instead of a spinner when its worker isn't at work (§ 5.1). */
export type Motion = "spinner" | "◼" | "◆" | "•"

/** A card, for a ticket with work under way. */
export interface Card {
  readonly ticket: string
  readonly title: string
  /** Its worker's number, stable for the session: the cards' order, never shown (§ 7.2). */
  readonly worker: number
  readonly phase: TicketPhase
  /** Its worker's state, while its session is open. */
  readonly state: WorkerState | null
  /** The card's status: the worker's state, or the phase's word. */
  readonly status: string
  readonly motion: Motion
  /** When it entered its phase, for the elapsed time; epoch milliseconds. */
  readonly since: number
  /** The action line, when the phase gives one (a merge's step, a recheck). */
  readonly action: string | null
  /** Its worker's latest action, for the action line when the phase gives none. */
  readonly latest: LatestAction | null
  /** You steered its worker and haven't released it (§ 4.3). */
  readonly steered: boolean
  /** Its worker's open requests, oldest first. */
  readonly requests: ReadonlyArray<AttentionRequest>
  /**
   * The memory its worker's processes take, in bytes, as the run last read it: unknownMemory when
   * they can't be found; absent when the reading has none for it.
   */
  readonly memory?: number
}

/** A banner on the title line. */
export type Banner = Data.TaggedEnum<{
  Usage: Usage
  Hold: RunHold
}>

export const Banner = Data.taggedEnum<Banner>()

/** A ticket's `■` on the wind-down line (§ 5.1). */
export type WindDownMark = "windingDown" | "done" | "needsYou" | "faint"

/** A worker the end-of-run box names, what each of its open requests asks, and its hand-back. */
export interface Waiting {
  readonly ticket: string
  /** `Allow Bash(rm -rf build)?`, `a question`, `a merge conflict waits for you`. */
  readonly asks: ReadonlyArray<string>
}

export interface WindDownView {
  /** Each ticket running when the wind-down began, in that order. */
  readonly marks: ReadonlyArray<{ readonly ticket: string; readonly mark: WindDownMark }>
  /** How many of them still run. */
  readonly running: number
}

/** A key the hint names, and what it does: `Tab select`. */
export interface Key {
  readonly keys: string
  readonly does: string
}

/** What the title line says of the run besides its banners. */
export interface TitleView {
  readonly version: string
  readonly branch: string
  readonly scope: string | null
  /** When the run began, in epoch milliseconds. */
  readonly began: number
  readonly stopping: boolean
  /** What quitting waits for, shown in place of `· stopping`; null when the run isn't quitting. */
  readonly quitting: string | null
  readonly solo: Solo | null
  /** How many other runs share the machine: `· shared with 2 runs` when any. */
  readonly shared: number
}

/** What the load line says of the machine (load.ts's Reading), the memory summed. */
export interface LoadView {
  /** The memory of the workers whose processes were found, in bytes. */
  readonly workers: number
  /** How many running workers' processes couldn't be found. */
  readonly unknown: number
  /** The memory of what tutti runs besides its workers, its merge check above all, in bytes. */
  readonly check: number
  readonly pressure: Pressure
  /** The memory available, in bytes, where the kernel says (Linux); -1 where it doesn't. */
  readonly available: number
  /** The pages swapped in and out a minute; -1 before two readings tell. */
  readonly swapping: number
  /** The 1-minute load average; -1 when not known. */
  readonly load1: number
  /** 0 when not known. */
  readonly cores: number
  readonly levels: Levels
}

export interface RunView {
  readonly title: TitleView
  /** The load line's figures; null until the run has read the machine's load. */
  readonly load: LoadView | null
  readonly totals: Totals
  readonly rows: ReadonlyArray<Row>
  /** In their workers' number order. */
  readonly cards: ReadonlyArray<Card>
  readonly requests: ReadonlyArray<AttentionRequest>
  /** Usage first, then each hold. */
  readonly banners: ReadonlyArray<Banner>
  readonly windDown: WindDownView | null
  /** The workers the end-of-run box names (D19), in place of the cards; null with no box. */
  readonly endOfRun: ReadonlyArray<Waiting> | null
  readonly hint: ReadonlyArray<Key>
  /** The warning line's notices, each once. */
  readonly warnings: ReadonlyArray<string>
}

export const emptyView: RunView = {
  title: {
    version: "",
    branch: "",
    scope: null,
    began: 0,
    stopping: false,
    quitting: null,
    solo: null,
    shared: 0,
  },
  load: null,
  totals: {
    completed: 0,
    deferred: 0,
    review: 0,
    triaged: 0,
    needsYou: 0,
    workers: 0,
    slots: 0,
    queued: 0,
    unclosed: null,
    heldBack: 0,
    setupFailed: 0,
    queueHeld: false,
  },
  rows: [],
  cards: [],
  requests: [],
  banners: [],
  windDown: null,
  endOfRun: null,
  hint: [],
  warnings: [],
}

/**
 * At most this often RunView is written: about 30 times a second. Whole milliseconds: TestClock
 * moves to each sleep's end, so a sleep of 33.33… ms left a whole-run test's clock at a fraction,
 * and the times taken from it then (attention_answered's after_ms) weren't whole.
 */
export const interval = Duration.millis(33)

// The phases a ticket is set aside in, whose note the triage organ's verdict replaces.
const setAside: ReadonlySet<PhaseTag> = new Set(["Deferred", "Review"])

// The phases in which a worker is at work, which its state refines.
const atWork: ReadonlySet<PhaseTag> = new Set(["Working", "Resolving", "Fixing"])

/**
 * What a Working ticket's worker is doing, for its row: what its open requests ask first, then its
 * state, then the phase's own activity.
 */
export const activityOf = (
  phase: TicketPhase,
  state: WorkerState | undefined,
  requests: ReadonlyArray<AttentionRequest>,
): Activity | null => {
  if (phase._tag !== "Working") return null
  const first = requests[0]
  if (first !== undefined) return first.kind._tag === "Question" ? "answer" : "allow"
  switch (state?._tag) {
    case "Starting":
      return "starting"
    case "Working":
      return state.doing
    case "Retrying":
      return "retrying"
    case "NeedsYou":
      return "allow"
    case "UsageLimited":
      return "limit"
  }
  return phase.activity
}

/** The phase a row and the totals show: a Working ticket with its worker's activity. */
const shown = (
  phase: TicketPhase,
  state: WorkerState | undefined,
  requests: ReadonlyArray<AttentionRequest>,
): TicketPhase => {
  const activity = activityOf(phase, state, requests)
  return activity === null || phase._tag !== "Working" || activity === phase.activity
    ? phase
    : TicketPhase.Working({ activity })
}

/** `n` as an English ordinal: 1st, 2nd, 3rd, 4th, 11th, 21st. */
export const ordinal = (n: number): string => {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
  }
  return `${n}th`
}

/** The time from `now` to `at`, rounded up to the minute, as a countdown gives it: `2h5m`, `1m`. */
export const countdown = (at: number, now: number): string =>
  formatDuration(Duration.minutes(Math.max(1, Math.ceil((at - now) / 60_000))))

/** A row's mark and word for `phase`, as § 5.1's table gives them. */
export const rowStatus = (phase: TicketPhase): { readonly mark: string; readonly word: string } => {
  switch (phase._tag) {
    case "Queued":
      return { mark: "◷", word: "queued" }
    case "HeldBack":
      return { mark: "◷", word: "held back" }
    case "Working":
      switch (phase.activity) {
        case "allow":
          return { mark: "■", word: "allow?" }
        case "answer":
          return { mark: "■", word: "answer?" }
        case "limit":
          return { mark: "◷", word: "limit" }
      }
      return { mark: "▶", word: phase.activity }
    case "ToMerge":
      return { mark: "◼", word: "to merge" }
    case "Merging":
      return { mark: "◆", word: "merging" }
    case "Resolving":
      return { mark: "⟳", word: "resolving" }
    case "Fixing":
      return { mark: "⟳", word: "fixing" }
    case "Done":
      return { mark: "✓", word: "done" }
    case "Asked":
      return { mark: "?", word: "for you" }
    case "Waiting":
      return { mark: "◷", word: "waiting" }
    case "Deferred":
      return { mark: "↷", word: "deferred" }
    case "Review":
      return { mark: "!", word: "review" }
    case "Blocked":
      return { mark: "■", word: "blocked" }
    case "Stopped":
      return { mark: "■", word: "stopped" }
  }
}

const requestWord = (request: AttentionRequest): string => {
  switch (request.kind._tag) {
    case "Permission":
      return "permission"
    case "Question":
      return "question"
    case "Elicitation":
      return "input"
  }
}

/** What a request asks, as the end-of-run box names it: `Allow Bash(rm -rf build)?`. */
export const asks = (request: AttentionRequest): string => {
  switch (request.kind._tag) {
    case "Permission":
      return `Allow ${request.kind.tool}(${request.kind.summary})?`
    case "Question":
      return "a question"
    case "Elicitation":
      return `input for ${request.kind.server}`
  }
}

/** What the end-of-run box names for a worker a conflict hand-back waits for (§ 4.3). */
export const conflictWaits = "a merge conflict waits for you"

/**
 * What a card's status says of a worker in `state` with `requests` open (§ 4.2), at `now`:
 * `usage limit · resets 14:05`, or `resets Fri Oct 23 14:05` when the reset isn't that day; read
 * on its own day without `now`.
 */
export const stateStatus = (
  state: WorkerState | undefined,
  requests: ReadonlyArray<AttentionRequest>,
  activity: Activity,
  now?: number,
): string => {
  const first = requests[0]
  if (first !== undefined) {
    const count = requests.length > 1 ? ` (${requests.length})` : ""
    return `${requestWord(first)} — waiting for you${count}`
  }
  switch (state?._tag) {
    case undefined:
      return activity
    case "Starting":
      return "starting"
    case "Working":
      return state.doing
    case "Retrying":
      return `retrying ${state.attempt}/${state.max}${state.status === null ? "" : ` (${state.status})`}`
    case "NeedsYou":
      return "permission — waiting for you"
    case "UsageLimited":
      return state.resetsAt === null
        ? "usage limit"
        : `usage limit · resets ${resetLabel(state.resetsAt, now ?? state.resetsAt)}`
    case "Idle":
      return "done"
    case "Failed":
      return state.interrupted ? "stopped" : "failed"
    case "Closed":
      return "closed"
    case "Gone":
      return "gone"
  }
}

const cardStatus = (
  phase: TicketPhase,
  state: WorkerState | undefined,
  requests: ReadonlyArray<AttentionRequest>,
  now: number | undefined,
): string => {
  switch (phase._tag) {
    case "Working":
      return stateStatus(state, requests, phase.activity, now)
    case "Resolving":
      return "resolving"
    case "Fixing":
      return "fixing check"
    case "ToMerge":
      return `to merge (${ordinal(phase.place)})`
    case "Merging":
      return "merging"
  }
  return rowStatus(phase).word
}

/** The status of a Blocked ticket's card while its conflict hand-back waits for you (§ 4.3). */
export const handBackStatus = "conflict waits for you"

/** Whether a worker in `state` with `requests` open is at work, so its card's spinner turns. */
const working = (state: WorkerState | undefined, requests: ReadonlyArray<AttentionRequest>) =>
  requests.length === 0 &&
  (state === undefined ||
    state._tag === "Starting" ||
    state._tag === "Working" ||
    state._tag === "Retrying")

const motionOf = (
  phase: TicketPhase,
  state: WorkerState | undefined,
  requests: ReadonlyArray<AttentionRequest>,
): Motion => {
  if (phase._tag === "ToMerge") return "◼"
  if (phase._tag === "Merging") return "◆"
  return working(state, requests) ? "spinner" : "•"
}

/** The environment probe's card, worker 0, as a Working ticket's, its session in `state`. */
const probeCard = (
  probe: ProbeView,
  state: WorkerState | undefined,
  load: Reading | null,
  now: number | undefined,
): Card => {
  const phase = TicketPhase.Working({ activity: "working" })
  return {
    ticket: probeLabel,
    title: probeLabel,
    worker: 0,
    phase,
    state: state ?? null,
    status: cardStatus(phase, state, [], now),
    motion: motionOf(phase, state, []),
    since: probe.since,
    action: "checking that commands run on this machine",
    latest: null,
    steered: false,
    requests: [],
    ...memoryOf(load, probeWorker),
  }
}

/** What a card says of its ticket's check ahead of its turn to merge, as orchestra's dashboard. */
export const checkAheadText = (ahead: CheckAhead): string => {
  const behind = sanitizeLine(ahead.behind)
  switch (ahead.step) {
    case "rebase":
      return `rebasing onto ${behind}, to be checked ahead of its turn on top of it as it is checked`
    case "check":
      return `checked ahead of its turn, on top of ${behind} as it is checked`
    case "passed":
      return `passed its check ahead of its turn, on top of ${behind}: merges with no further check if ${behind} merges as checked`
    case "failed":
      return `failed its check ahead of its turn, on top of ${behind}: checked again in its turn`
  }
}

// A ticket checked ahead of its turn says so until its turn has taken its train, its check ahead
// ended (mergetrain.ts board).
const actionOf = (entry: Entry, branch: string, ahead: CheckAhead | undefined): string | null => {
  if (entry.rechecking) return `checking again: ${branch} moved on since its check failed`
  const train = entry.phase._tag === "ToMerge" || entry.phase._tag === "Merging"
  if (train && ahead !== undefined) return checkAheadText(ahead)
  if (entry.phase._tag !== "Merging") return null
  switch (entry.phase.step) {
    case "rebase":
      return `rebasing onto ${branch}`
    case "setup":
      return "running the setup"
    case "check":
      return `running the check on ${branch}`
    case "fast-forward":
      return `merging into ${branch}`
  }
}

const noteOf = (entry: Entry, title: string, branch: string): string => {
  if (entry.phase._tag !== "Done") return title
  const outcome = entry.phase.outcome
  return outcome._tag === "Merged"
    ? `${sanitizeLine(outcome.commit.slice(0, 7))} merged into ${branch}`
    : "no change to merge"
}

const latestOf = (action: LatestAction | undefined): LatestAction | null =>
  action === undefined ? null : { text: sanitizeLine(action.text), denied: action.denied }

const windDownMark = (phase: TicketPhase): WindDownMark => {
  switch (phase._tag) {
    case "Working":
    case "ToMerge":
    case "Merging":
    case "Resolving":
    case "Fixing":
      return "windingDown"
    case "Done":
      return "done"
    case "Deferred":
    case "Review":
    case "Blocked":
    case "Asked":
    case "Stopped":
      return "needsYou"
  }
  return "faint"
}

const hintOf = (
  cards: ReadonlyArray<Card>,
  requests: ReadonlyArray<AttentionRequest>,
  windingDown: boolean,
  ending: boolean,
): ReadonlyArray<Key> => {
  const keys: Array<Key> = []
  if (cards.length > 0) {
    keys.push({ keys: "Tab", does: "select" })
    keys.push({ keys: "Enter", does: "open" })
  }
  const target = requests[0]
  if (target !== undefined) {
    keys.push({ keys: "d", does: "deny" })
    if (target.kind._tag === "Permission" && !target.defaultToNo) {
      keys.push({ keys: "a", does: "allow" })
    }
  }
  if (ending) keys.push({ keys: "q", does: "end the run" })
  else keys.push({ keys: "s", does: windingDown ? "keep taking tickets" : "stop after current" })
  keys.push({ keys: "?", does: "keys" })
  return keys
}

/** A card's memory from `load`, for its worker on `ticket`: none when the reading has none. */
const memoryOf = (load: Reading | null, ticket: string): { readonly memory?: number } => {
  const memory = load?.workers.get(ticket)
  return memory === undefined ? {} : { memory }
}

/** The load line's figures from `reading`. */
export const loadView = (reading: Reading): LoadView => {
  const memories = [...reading.workers.values()]
  const { kernel } = reading
  return {
    workers: memories.reduce((sum, memory) => sum + Math.max(memory, 0), 0),
    unknown: memories.filter((memory) => memory === unknownMemory).length,
    check: reading.check,
    pressure: kernel.pressure,
    available: kernel.available,
    swapping: reading.swapping,
    load1: kernel.load1,
    cores: kernel.cores,
    levels: reading.levels,
  }
}

/** Whether `a` and `b` are the same data: equal primitives, or arrays and objects of such. */
export const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every(
    (key) =>
      Object.hasOwn(b, key) &&
      same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

const keep = <A>(previous: A, next: A): A => (same(previous, next) ? previous : next)

// next's items, each the previous one with its key where that is the same; the previous list
// itself when every item is kept in the same order.
const keepAll = <A>(
  previous: ReadonlyArray<A>,
  next: ReadonlyArray<A>,
  key: (item: A) => string,
): ReadonlyArray<A> => {
  const before = new Map(previous.map((item) => [key(item), item]))
  const kept = next.map((item) => {
    const old = before.get(key(item))
    return old !== undefined && same(old, item) ? old : item
  })
  return kept.length === previous.length && kept.every((item, i) => item === previous[i])
    ? previous
    : kept
}

/** RunView for `inputs`, keeping every part of `previous` that is unchanged, and `previous` itself
 * when nothing is. */
export const project = (inputs: Inputs, previous: RunView = emptyView): RunView => {
  const { ledger, workers, requests, status } = inputs
  const actions = inputs.actions ?? new Map<string, LatestAction>()
  const branch = sanitizeLine(status.branch)
  const requestsOf = new Map<string, Array<AttentionRequest>>()
  for (const request of requests) {
    const list = requestsOf.get(request.ticket)
    if (list === undefined) requestsOf.set(request.ticket, [request])
    else list.push(request)
  }
  const none: ReadonlyArray<AttentionRequest> = []

  const totals = { ...emptyView.totals, slots: status.concurrency, unclosed: status.unclosed }
  const needsYou = new Set(requestsOf.keys())
  const rows: Array<{ readonly at: number; readonly row: Row }> = []
  const cards: Array<Card> = []
  for (const entry of ledger.tickets.values()) {
    const state = workers.get(entry.ticket)
    const open = requestsOf.get(entry.ticket) ?? none
    const phase = shown(entry.phase, state, open)
    const title = sanitizeLine(entry.title)
    const verdict = setAside.has(phase._tag) ? (status.verdicts.get(entry.ticket) ?? null) : null
    for (const total of countsUnder(phase)) {
      if (total === "needsYou") needsYou.add(entry.ticket)
      else if (total === "setAside") {
        totals[phase._tag === "Review" ? "review" : "deferred"]++
        if (verdict !== null) totals.triaged++
      } else if (total === "inQueue") totals.queued++
      else totals[total]++
    }
    if (entry.row !== null) {
      rows.push({
        at: entry.row,
        row: {
          ticket: entry.ticket,
          title,
          ...rowStatus(phase),
          note: noteOf(entry, title, branch),
          verdict: verdict === null ? null : sanitizeLine(verdict),
        },
      })
    }
    if (showsCard(entry) && entry.worker !== null) {
      const waits = handBackWaits(entry)
      cards.push({
        ticket: entry.ticket,
        title,
        worker: entry.worker,
        phase: entry.phase,
        state: atWork.has(entry.phase._tag) ? (state ?? null) : null,
        status: waits ? handBackStatus : cardStatus(phase, state, open, inputs.now),
        motion: waits ? "•" : motionOf(entry.phase, state, open),
        since: entry.since,
        action: actionOf(entry, branch, status.checksAhead.get(entry.ticket)),
        latest: latestOf(actions.get(entry.ticket)),
        steered: entry.steered,
        requests: open,
        ...memoryOf(status.load, entry.ticket),
      })
    }
  }
  if (status.probe !== null)
    cards.push(probeCard(status.probe, workers.get(probeWorker), status.load, inputs.now))
  totals.needsYou = needsYou.size
  totals.queueHeld = ledger.windDown !== null || status.holds.length > 0

  const windDown =
    ledger.windDown === null
      ? null
      : ((): WindDownView => {
          const marks = ledger.windDown.tickets.map((ticket) => {
            const entry = ledger.tickets.get(ticket)
            return { ticket, mark: entry === undefined ? "faint" : windDownMark(entry.phase) }
          })
          return { marks, running: marks.filter((m) => m.mark === "windingDown").length }
        })()

  const banners: Array<Banner> = []
  if (status.usage !== null) banners.push(Banner.Usage(status.usage))
  for (const hold of status.holds) {
    banners.push(Banner.Hold({ ...hold, word: sanitizeLine(hold.word) }))
  }

  const heading: TitleView = {
    version: sanitizeLine(status.version),
    branch,
    scope: status.scope === null ? null : sanitizeLine(status.scope),
    began: status.began,
    stopping: status.stopping,
    quitting: status.quitting === null ? null : sanitizeLine(status.quitting),
    solo:
      status.solo === null
        ? null
        : { ticket: sanitizeLine(status.solo.ticket), running: status.solo.running },
    shared: status.shared,
  }
  const warnings = [...new Set(status.warnings.map(sanitizeLine))]
  const load = status.load === null ? null : loadView(status.load)
  // The box names each worker the run waits on that still has a request open, or a conflict
  // hand-back waiting for it (§ 4.3).
  const waiting = (status.endOfRun ?? []).flatMap((ticket): ReadonlyArray<Waiting> => {
    const entry = ledger.tickets.get(ticket)
    const all = [
      ...(requestsOf.get(ticket) ?? []).map(asks),
      ...(entry !== undefined && handBackWaits(entry) ? [conflictWaits] : []),
    ]
    return all.length === 0 ? [] : [{ ticket: sanitizeLine(ticket), asks: all }]
  })
  const endOfRun = waiting.length === 0 ? null : waiting

  cards.sort((a, b) => a.worker - b.worker)
  const next: RunView = {
    title: keep(previous.title, heading),
    load: keep(previous.load, load),
    totals: keep(previous.totals, totals),
    rows: keepAll(
      previous.rows,
      rows.sort((a, b) => a.at - b.at).map(({ row }) => row),
      (row) => row.ticket,
    ),
    cards: keepAll(previous.cards, cards, (card) => card.ticket),
    requests: keepAll(previous.requests, requests, (request) => request.id),
    banners: keep(previous.banners, banners),
    windDown: keep(previous.windDown, windDown),
    endOfRun: keep(previous.endOfRun, endOfRun),
    hint: keep(previous.hint, hintOf(cards, requests, ledger.windDown !== null, endOfRun !== null)),
    warnings: keep(previous.warnings, warnings),
  }
  const parts = Object.keys(next) as ReadonlyArray<keyof RunView>
  return parts.every((part) => next[part] === previous[part]) ? previous : next
}

/**
 * A SubscriptionRef holding RunView, and the fibers that keep it: one takes the latest of
 * `sources`, and one projects it at most once per `interval`, the first change at once and the
 * latest of a burst after it. The fibers live as long as the scope.
 */
export const make = (
  sources: Sources,
): Effect.Effect<SubscriptionRef.SubscriptionRef<RunView>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const view = yield* SubscriptionRef.make(emptyView)
    const latest = yield* Queue.sliding<Inputs>(1)
    yield* Stream.zipLatestAll(
      sources.ledger,
      sources.workers,
      sources.requests,
      sources.status,
      sources.actions ?? Stream.succeed(new Map<string, LatestAction>()),
    ).pipe(
      Stream.runForEach(([ledger, workers, requests, status, actions]) =>
        Queue.offer(latest, { ledger, workers, requests, status, actions }),
      ),
      Effect.forkScoped,
    )
    yield* Effect.gen(function* () {
      const inputs = yield* Queue.take(latest)
      const previous = yield* SubscriptionRef.get(view)
      const next = project({ ...inputs, now: yield* Clock.currentTimeMillis }, previous)
      if (next !== previous) yield* SubscriptionRef.set(view, next)
      yield* Effect.sleep(interval)
    }).pipe(Effect.forever, Effect.forkScoped)
    return view
  })
