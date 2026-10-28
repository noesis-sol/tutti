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
  Option,
  Queue,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import type { AttentionRequest } from "../agent/Attention.ts"
import type { ContextUsage } from "../agent/contextUsage.ts"
import type { LatestAction } from "../agent/Transcripts.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { formatDuration } from "../project/configFile.ts"
import type { Issue, TicketId } from "../services/Beads.ts"
import { shortHash } from "../services/Git.ts"
import type { Motion, Shown, Tone } from "../ui/marks.ts"
import type { OpenQuestion } from "../ui/questions.ts"
import { sanitize, sanitizeLine } from "../ui/sanitize.ts"
import { type ProbeView, probeLabel, probeWorker } from "./environment.ts"
import type { FullCheckRun } from "./fullcheck.ts"
import { type Entry, handBackWaits, type State, showsCard } from "./ledger.ts"
import { type Levels, type Pressure, type Reading, unknownMemory } from "./load.ts"
import { resetLabel } from "./localTime.ts"
import type { CheckAhead } from "./mergetrain.ts"
import { asideOvernight } from "./overnightAside.ts"
import {
  type Activity,
  activityRows,
  countsUnder,
  factsOf,
  phaseFacts,
  TicketPhase,
  type WindDownMark,
} from "./phase.ts"
import { noSums, type Resources, resourcesOf } from "./resources.ts"
import { keep, keepAll, same } from "./same.ts"
import type { Sums } from "./spending.ts"

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

/**
 * One of the account's usage windows (§ 4.12), as the title line shows it at all times: its
 * name, as the SDK gives it (`five_hour`, `seven_day`), how much of it is used, 0 to 1, and when it
 * resets.
 */
export interface UsageWindow {
  readonly name: string
  readonly utilization: number
  readonly resetsAt: number | null
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
  readonly scope: TicketId | null
  /** A spec run's spec, its path, which names its scope; none for another run. */
  readonly spec?: string | null
  /** When the run began, in epoch milliseconds, for its run time. */
  readonly began: number
  /** How many workers may run at once. */
  readonly concurrency: number
  readonly holds: ReadonlyArray<RunHold>
  readonly usage: Usage | null
  /** The account's windows, in the order the SDK first gave them; none until it has. */
  readonly windows: ReadonlyArray<UsageWindow>
  /**
   * How much the five-hour window has risen over the run, 0 to 1 (usageWindows.ts); null until the
   * run has heard it.
   */
  readonly rise: number | null
  /** Workers bill a subscription login, whose dollars are API-price estimates (§ 4.13). */
  readonly subscription: boolean
  /** What each ticket's workers' turns and all of them spent so far (spending.ts). */
  readonly spending: Sums
  /** How full each worker's context window is, by ticket, as its session last said. */
  readonly contexts: ReadonlyMap<string, ContextUsage>
  /** Something stopped the run, and the running tickets are finishing. */
  readonly stopping: boolean
  /** The run is quitting (§ 4.8): `Quitting… waiting for t-1's worker`; null when it isn't. */
  readonly quitting: string | null
  /**
   * Everything else is done and these tickets' workers wait on you (D19, § 5 item 14), by a request
   * open or a conflict hand-back waiting (§ 4.3): the run stays open for them, showing the end-of-run
   * box; null when it isn't so.
   */
  readonly endOfRun: ReadonlyArray<TicketId> | null
  /**
   * What the end-of-run full check runs while it runs (endOfRun.ts, fullcheck.ts): its setup, then
   * the check; null otherwise, whatever its outcome.
   */
  readonly fullCheck: FullCheckRun | null
  readonly solo: Solo | null
  /** How many other tutti and orchestra runs share the machine, as the last look found them. */
  readonly shared: number
  /** The run's keep-awake command holds the machine awake (keepAwake.ts): its title line's badge. */
  readonly keepAwake: boolean
  /** --auto-answer's words for its title line's pill, `auto-answer after 10m`; null without it. */
  readonly autoAnswer: string | null
  /** The machine's load, as the run last read it (load.ts); null until it has, or when it doesn't. */
  readonly load: Reading | null
  /** The tickets not closed that the queue draws from (`9 of 16`); null until the run says. */
  readonly unclosed: number | null
  /**
   * Why each ticket waiting in the queue is held back, as the log last said it (schedule.ts's
   * QueueShown): for a parent or a ticket not merged (`waits`), and for an overlap (`skips`).
   */
  readonly holdTexts: {
    readonly waits: Readonly<Record<string, string>>
    readonly skips: Readonly<Record<string, string>>
  }
  /**
   * The questions Asked tickets wait on, by the question's ID, as the look last read bd's open list
   * (run.ts): for the panel beside the tickets table (§ 7.2). One not read yet is missing.
   */
  readonly questions: ReadonlyMap<string, OpenQuestion>
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
  windows: [],
  rise: null,
  subscription: false,
  spending: noSums,
  contexts: new Map(),
  stopping: false,
  quitting: null,
  endOfRun: null,
  fullCheck: null,
  solo: null,
  shared: 0,
  keepAwake: false,
  autoAnswer: null,
  load: null,
  unclosed: null,
  holdTexts: { waits: {}, skips: {} },
  questions: new Map(),
  verdicts: new Map(),
  checksAhead: new Map(),
  probe: null,
  warnings: [],
}

/**
 * Shows each value it is given as `key` on `status`, reading and setting it in one step, and
 * publishing nothing when the value is `equal` to the one shown: SubscriptionRef publishes every
 * set, changed or not, and each publish projects the whole view. A Map-valued key's source makes a
 * new Map for each change, so `Object.is` says when it changed without walking it.
 */
export const showOn =
  <K extends keyof Status>(
    status: SubscriptionRef.SubscriptionRef<Status>,
    key: K,
    equal: (shown: Status[K], value: Status[K]) => boolean = same,
  ) =>
  (value: Status[K]): Effect.Effect<void> =>
    SubscriptionRef.updateSome(status, (now) =>
      equal(now[key], value) ? Option.none() : Option.some({ ...now, [key]: value }),
    )

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
  /** Of those, the Asked ones: each waits on your answer to a question ticket (Shift+A, § 7.3). */
  readonly asked: number
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
 * as its ticket leaves Current, when it moves to the end. Its status, as `▶ testing`, is its mark,
 * its word and its tone, and whether the rest of the row is faint.
 */
export interface Row extends Shown {
  /** Its ticket's ID, the key the run's commands take; draw `label` instead. */
  readonly ticket: TicketId
  /** Its ticket's ID as drawn: a worker files tickets, so it is sanitised (§ 7.10). */
  readonly label: string
  readonly title: string
  /** What the row says of the ticket: its title, how it finished, or the question it waits on. */
  readonly note: string
  /** The triage organ's verdict, which replaces the note of a ticket set aside once it is in. */
  readonly verdict: string | null
}

/**
 * A link of a ticket's to another, as bd show gives it: `parent-child`, `blocks`, …; `dependent`
 * when the other depends on this one (bd show --include-dependents).
 */
export interface TicketLink {
  readonly type: string
  readonly id: string
  readonly dependent?: true
}

/**
 * A ticket's issue as its worker view shows it (§ 7.5): the text a ticket author or a worker wrote,
 * sanitised (§ 7.10), its several lines kept. Its links are its parent first, then what it depends
 * on, then what depends on it.
 */
export interface TicketText {
  /** bd's issue type: task, bug, feature, …; "" when bd gives none. */
  readonly type: string
  readonly priority: number | null
  readonly description: string
  readonly design: string
  readonly acceptance: string
  readonly notes: string
  readonly labels: ReadonlyArray<string>
  readonly links: ReadonlyArray<TicketLink>
  /**
   * How many tickets depend on this one: those in `links` once bd show has listed them, else as bd
   * ready counted them, which lists none.
   */
  readonly dependents: number
}

/** Each issue read, sanitised once: an entry keeps its issue until the run reads it again. */
const ticketTexts = new WeakMap<Issue, TicketText>()

/** `issue` as its worker view shows it, sanitised. */
export const ticketText = (issue: Issue): TicketText => {
  const found = ticketTexts.get(issue)
  if (found !== undefined) return found
  const parent = issue.parent === undefined ? [] : [{ type: "parent-child", id: issue.parent }]
  const others = issue.dependencies.filter(
    (link) => !(link.type === "parent-child" && link.id === issue.parent),
  )
  const text: TicketText = {
    type: sanitizeLine(issue.type),
    priority: issue.priority ?? null,
    description: sanitize(issue.description),
    design: sanitize(issue.design),
    acceptance: sanitize(issue.acceptance),
    notes: sanitize(issue.notes),
    labels: issue.labels.map(sanitizeLine),
    dependents: issue.dependents?.length ?? issue.dependentCount ?? 0,
    links: [
      ...[...parent, ...others].map((link) => ({
        type: sanitizeLine(link.type),
        id: sanitizeLine(link.id),
      })),
      ...(issue.dependents ?? []).map((link) => ({
        type: sanitizeLine(link.type),
        id: sanitizeLine(link.id),
        dependent: true as const,
      })),
    ],
  }
  ticketTexts.set(issue, text)
  return text
}

/** A card, for a ticket with work under way. */
export interface Card {
  /** Its ticket's ID, the key the run's commands take; draw `label` instead. */
  readonly ticket: TicketId
  /** Its ticket's ID as drawn: a worker files tickets, so it is sanitised (§ 7.10). */
  readonly label: string
  readonly title: string
  /** Its worker's number, stable for the session: the cards' order, never shown (§ 7.2). */
  readonly worker: number
  readonly phase: TicketPhase
  /** Its worker's state, while its session is open. */
  readonly state: WorkerState | null
  /** The card's status: the worker's state, or the phase's word. */
  readonly status: string
  /** The tone of its status (§ 7.11's Statuses). */
  readonly tone: Tone
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
  readonly requests: ReadonlyArray<ShownRequest>
  /** Its issue, for its worker view's description and whole ticket; absent until the run reads it. */
  readonly issue?: TicketText
  /**
   * The memory its worker's processes take, in bytes, as the run last read it: unknownMemory when
   * they can't be found; absent when the reading has none for it.
   */
  readonly memory?: number
}

/** The account's windows, on the title line while no usage banner is. */
export interface Windows {
  readonly windows: ReadonlyArray<UsageWindow>
}

/** A banner on the title line. */
export type Banner = Data.TaggedEnum<{
  Usage: Usage
  Windows: Windows
  Hold: RunHold
}>

export const Banner = Data.taggedEnum<Banner>()

/** A worker the end-of-run box names, what each of its open requests asks, and its hand-back. */
export interface Waiting {
  readonly ticket: string
  /** `Allow Bash(rm -rf build)?`, `a question`, `a merge conflict waits for you`. */
  readonly asks: ReadonlyArray<string>
}

export interface WindDownView {
  /** Each ticket running when the wind-down began, in that order. */
  readonly marks: ReadonlyArray<{ readonly ticket: TicketId; readonly mark: WindDownMark }>
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
  /** A spec run's spec, which the title line names in place of its root epic; none otherwise. */
  readonly spec?: string | null
  /** When the run began, in epoch milliseconds. */
  readonly began: number
  readonly stopping: boolean
  /** What quitting waits for, shown in place of `· stopping`; null when the run isn't quitting. */
  readonly quitting: string | null
  readonly solo: Solo | null
  /** How many other runs share the machine: `· shared with 2 runs` when any. */
  readonly shared: number
  /** The machine is kept awake for the run: the ` keep awake ` badge. */
  readonly keepAwake: boolean
  /** The ` auto-answer ` pill's words with --auto-answer, `auto-answer after 10m`; null without. */
  readonly autoAnswer: string | null
}

/** What the load line says of the machine (load.ts's Reading), the memory summed. */
export interface LoadView {
  /** The memory of the workers whose processes were found, in bytes. */
  readonly workers: number
  /** How many running workers' processes couldn't be found. */
  readonly unknown: number
  /** The memory of what tutti runs besides its workers, its merge check above all, in bytes. */
  readonly check: number
  /** What `check` is named: the end-of-run full check while it runs, the merge check otherwise. */
  readonly checkName: "merge check" | "full check"
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

/** An open request as RunView holds it, with its ticket's ID sanitised to draw (§ 7.10). */
export interface ShownRequest extends AttentionRequest {
  /** Its ticket's ID as drawn; `ticket` is the key an answer names. */
  readonly label: string
}

/** `request` as RunView holds it: its ticket's ID sanitised to draw. */
export const shownRequest = (request: AttentionRequest): ShownRequest => ({
  ...request,
  label: sanitizeLine(request.ticket),
})

/**
 * A ticket waiting in the queue, for the Up next panel (§ 7.2): Queued, HeldBack or Waiting, in the
 * order the run took them in, with why it waits; `held` null for one only a free slot holds back.
 */
export interface QueueRow {
  readonly ticket: TicketId
  /** Its ID as drawn, sanitised (§ 7.10). */
  readonly label: string
  readonly title: string
  /** Why it waits, as the log says it: `touches src/a.ts, like running t-1`; null for none. */
  readonly held: string | null
}

/**
 * What needs you, for the panel beside the tickets table (§ 7.2): an Asked ticket's question, its
 * issue once the look has read it (null until then), or a Blocked ticket and why.
 */
export type Need = Data.TaggedEnum<{
  Question: {
    readonly ticket: TicketId
    readonly label: string
    readonly title: string
    /** The question's ID, sanitised. */
    readonly id: string
    readonly question: OpenQuestion | null
  }
  Blocked: {
    readonly ticket: TicketId
    readonly label: string
    readonly title: string
    /** `MERGE_CONFLICT`, `DIRTY_TREE`, … */
    readonly why: string
  }
}>

export const Need = Data.taggedEnum<Need>()

export interface RunView {
  readonly title: TitleView
  /** The load line's figures; null until the run has read the machine's load. */
  readonly load: LoadView | null
  readonly totals: Totals
  readonly rows: ReadonlyArray<Row>
  /** The tickets waiting in the queue, ready ones first, then those held back or waiting. */
  readonly queue: ReadonlyArray<QueueRow>
  /** What needs you: the Asked tickets' questions, then the Blocked tickets, in the run's order. */
  readonly needs: ReadonlyArray<Need>
  /** In their workers' number order. */
  readonly cards: ReadonlyArray<Card>
  /** What each card's worker consumes, for its view's figures (§ 7.5); the probe has none. */
  readonly resources: ReadonlyArray<Resources>
  readonly requests: ReadonlyArray<ShownRequest>
  /** The usage, or else the account's windows, first; then each hold. */
  readonly banners: ReadonlyArray<Banner>
  readonly windDown: WindDownView | null
  /** The workers the end-of-run box names (D19), in place of the cards; null with no box. */
  readonly endOfRun: ReadonlyArray<Waiting> | null
  /** What the end-of-run full check runs, its command sanitised, for Current's box; null otherwise. */
  readonly fullCheck: FullCheckRun | null
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
    keepAwake: false,
    autoAnswer: null,
  },
  load: null,
  totals: {
    completed: 0,
    deferred: 0,
    review: 0,
    triaged: 0,
    needsYou: 0,
    asked: 0,
    workers: 0,
    slots: 0,
    queued: 0,
    unclosed: null,
    heldBack: 0,
    setupFailed: 0,
    queueHeld: false,
  },
  rows: [],
  queue: [],
  needs: [],
  cards: [],
  resources: [],
  requests: [],
  banners: [],
  windDown: null,
  endOfRun: null,
  fullCheck: null,
  warnings: [],
}

/**
 * At most this often RunView is written: about 30 times a second. Whole milliseconds: TestClock
 * moves to each sleep's end, so a sleep of 33.33… ms left a whole-run test's clock at a fraction,
 * and the times taken from it then (attention_answered's after_ms) weren't whole.
 */
export const interval = Duration.millis(33)

/**
 * What a Working ticket's worker is doing, for its row, its card and the totals: what its open
 * requests ask first, then its state; `starting` while neither says. The ledger doesn't keep it.
 */
export const activityOf = (
  state: WorkerState | undefined,
  requests: ReadonlyArray<AttentionRequest>,
): Activity => {
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
  return "starting"
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

/**
 * A row's mark, word and tone for `phase`, as § 5.1's table gives them; `activity` is a Working
 * ticket's worker's (activityOf).
 */
export const rowStatus = (phase: TicketPhase, activity: Activity = "starting"): Shown =>
  factsOf(phase).row(phase, activity)

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
    case "LoginRefused":
      return "login refused"
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
  activity: Activity,
  state: WorkerState | undefined,
  requests: ReadonlyArray<AttentionRequest>,
  now: number | undefined,
): string => {
  switch (phase._tag) {
    case "Working":
      return stateStatus(state, requests, activity, now)
    case "Resolving":
      return "resolving"
    case "Fixing":
      return "fixing check"
    case "ToMerge":
      return `to merge (${ordinal(phase.place)})`
    case "Merging":
      return "merging"
  }
  return rowStatus(phase, activity).word
}

/** The status of a Blocked ticket's card while its conflict hand-back waits for you (§ 4.3). */
export const handBackStatus = "conflict waits for you"

/**
 * The tone of a card's status (§ 7.11's Statuses), for a ticket in `phase` whose worker is in
 * `state` with `requests` open: `stop` while it waits for you, whether by a request, the CLI or a
 * conflict hand-back; else the phase's, the worker's state's, or a Working ticket's `activity`.
 */
export const statusTone = (
  phase: TicketPhase,
  state: WorkerState | null,
  requests: ReadonlyArray<AttentionRequest>,
  activity: Activity = "starting",
): Tone => {
  if (requests.length > 0 || state?._tag === "NeedsYou" || phase._tag === "Blocked") return "stop"
  switch (phase._tag) {
    case "ToMerge":
      return "toMerge"
    case "Merging":
      return "merging"
    case "Resolving":
    case "Fixing":
      return "deferred"
  }
  switch (state?._tag) {
    case "Starting":
    case "Closed":
      return "dim"
    case "Working":
      return state.doing === "testing" ? "testing" : "picked"
    case "Retrying":
    case "UsageLimited":
      return "deferred"
    case "Idle":
      return "done"
    case "Failed":
      return state.interrupted ? "deferred" : "failed"
    case "LoginRefused":
    case "Gone":
      return "failed"
  }
  if (phase._tag !== "Working") return "dim"
  // A card's `starting` is faint, where its row's is `picked`.
  return activity === "starting" ? "dim" : activityRows[activity].tone
}

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
  if (phase._tag === "ToMerge") return "toMerge"
  if (phase._tag === "Merging") return "merging"
  return working(state, requests) ? "spinner" : "idle"
}

/** The environment probe's card, worker 0, as a Working ticket's, its session in `state`. */
const probeCard = (
  probe: ProbeView,
  state: WorkerState | undefined,
  load: Reading | null,
  now: number | undefined,
): Card => {
  const phase = TicketPhase.Working()
  return {
    // No ticket has the probe's label, which its card is known by.
    ticket: probeLabel as TicketId,
    label: probeLabel,
    title: probeLabel,
    worker: 0,
    phase,
    state: state ?? null,
    status: cardStatus(phase, "working", state, [], now),
    tone: statusTone(phase, state ?? null, [], "working"),
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

const noteOf = (
  entry: Entry,
  title: string,
  branch: string,
  questions: ReadonlyMap<string, OpenQuestion>,
): string => {
  // An Asked ticket says the question it waits on, once the look has read it (§ 7.2).
  if (entry.phase._tag === "Asked") return questions.get(entry.phase.question)?.title ?? title
  // A ticket an overnight run set aside says why before its title.
  if (entry.phase._tag === "Deferred" && asideOvernight(entry.phase.why)) {
    return `(${entry.phase.why}) ${title}`
  }
  if (entry.phase._tag !== "Done") return title
  const outcome = entry.phase.outcome
  return outcome._tag === "Merged"
    ? `${sanitizeLine(shortHash(outcome.commit))} merged into ${branch}`
    : "no change to merge"
}

const latestOf = (action: LatestAction | undefined): LatestAction | null =>
  action === undefined ? null : { text: sanitizeLine(action.text), denied: action.denied }

/** A card's memory from `load`, for its worker on `ticket`: none when the reading has none. */
const memoryOf = (load: Reading | null, ticket: TicketId): { readonly memory?: number } => {
  const memory = load?.workers.get(ticket)
  return memory === undefined ? {} : { memory }
}

/** The load line's figures from `reading`. */
export const loadView = (reading: Reading, fullCheck = false): LoadView => {
  const memories = [...reading.workers.values()]
  const { kernel } = reading
  return {
    workers: memories.reduce((sum, memory) => sum + Math.max(memory, 0), 0),
    unknown: memories.filter((memory) => memory === unknownMemory).length,
    check: reading.check,
    checkName: fullCheck ? "full check" : "merge check",
    pressure: kernel.pressure,
    available: kernel.available,
    swapping: reading.swapping,
    load1: kernel.load1,
    cores: kernel.cores,
    levels: reading.levels,
  }
}

/**
 * Each ledger entry's ID and title, sanitised: an entry keeps its identity until it changes, so each
 * is sanitised once, not on every projection, Done ones included.
 */
const sanitised = new WeakMap<Entry, { readonly label: string; readonly title: string }>()
const textsOf = (entry: Entry) => {
  const found = sanitised.get(entry)
  if (found !== undefined) return found
  const texts = { label: sanitizeLine(entry.ticket), title: sanitizeLine(entry.title) }
  sanitised.set(entry, texts)
  return texts
}

/**
 * Why a ticket waiting in the queue in `phase` waits, for the Up next panel: a hold's reason as the
 * log last said it (`status.holdTexts`), else in words of its own; null for a Queued ticket, which
 * waits for a free slot alone.
 */
const heldText = (ticket: TicketId, phase: TicketPhase, status: Status): string | null => {
  const { waits, skips } = status.holdTexts
  switch (phase._tag) {
    case "HeldBack":
      switch (phase.why) {
        case "overlap":
          return skips[ticket] ?? "overlaps a running ticket"
        case "merge":
          return waits[ticket] ?? "waits for a ticket to merge"
        case "parent":
          return waits[ticket] ?? "its subtickets are not all closed and merged"
        case "solo":
          return status.solo === null
            ? "waits for a solo ticket"
            : `waits for solo ${status.solo.ticket}, ${status.solo.running ? "running" : "next"}`
      }
      return null
    case "Waiting":
      switch (phase.for._tag) {
        case "Blockers":
          return `waits for ${phase.for.ids.join(", ")} to merge`
        case "Setup":
          return "its setup failed: waits for a ticket to merge, or the probe"
        case "Probe":
          return "waits for the environment probe to pass"
        case "SetupProblem":
          return "waits for the next run, once the setup is fixed"
      }
      return null
    default:
      return null
  }
}

/** RunView for `inputs`, keeping every part of `previous` that is unchanged, and `previous` itself
 * when nothing is. */
export const project = (inputs: Inputs, previous: RunView = emptyView): RunView => {
  const { ledger, workers, status } = inputs
  const actions = inputs.actions ?? new Map<string, LatestAction>()
  const branch = sanitizeLine(status.branch)
  // Ticket IDs are sanitised here, once, as they enter RunView; every view draws `label`.
  const requests = inputs.requests.map(shownRequest)
  const requestsOf = new Map<string, Array<ShownRequest>>()
  for (const request of requests) {
    const list = requestsOf.get(request.ticket)
    if (list === undefined) requestsOf.set(request.ticket, [request])
    else list.push(request)
  }
  const none: ReadonlyArray<ShownRequest> = []

  const totals = { ...emptyView.totals, slots: status.concurrency, unclosed: status.unclosed }
  const needsYou = new Set(requestsOf.keys())
  const rows: Array<{ readonly at: number; readonly row: Row }> = []
  const ready: Array<QueueRow> = []
  const held: Array<QueueRow> = []
  const asked: Array<Need> = []
  const blocked: Array<Need> = []
  const cards: Array<Card> = []
  const resources: Array<Resources> = []
  for (const entry of ledger.tickets.values()) {
    const state = workers.get(entry.ticket)
    const open = requestsOf.get(entry.ticket) ?? none
    const phase = entry.phase
    const activity = activityOf(state, open)
    const { label, title } = textsOf(entry)
    // A ticket set aside has the triage organ's verdict in place of its note.
    const verdict =
      phaseFacts[phase._tag].notice === "setAside"
        ? (status.verdicts.get(entry.ticket) ?? null)
        : null
    if (phase._tag === "Asked") totals.asked++
    for (const total of countsUnder(phase, activity)) {
      if (total === "needsYou") needsYou.add(entry.ticket)
      else if (total === "setAside") {
        totals[phase._tag === "Review" ? "review" : "deferred"]++
        if (verdict !== null) totals.triaged++
      } else if (total === "inQueue") totals.queued++
      else totals[total]++
    }
    if (phase._tag === "Asked") {
      const question = status.questions.get(phase.question) ?? null
      const id = sanitizeLine(phase.question)
      asked.push(Need.Question({ ticket: entry.ticket, label, title, id, question }))
    } else if (phase._tag === "Blocked") {
      const why = sanitizeLine(phase.why)
      blocked.push(Need.Blocked({ ticket: entry.ticket, label, title, why }))
    }
    if (phaseFacts[phase._tag].inQueue) {
      const why = heldText(entry.ticket, phase, status)
      const each = {
        ticket: entry.ticket,
        label,
        title,
        held: why === null ? null : sanitizeLine(why),
      }
      if (why === null) ready.push(each)
      else held.push(each)
    }
    if (entry.row !== null) {
      rows.push({
        at: entry.row,
        row: {
          ticket: entry.ticket,
          label,
          title,
          ...rowStatus(phase, activity),
          note: noteOf(entry, title, branch, status.questions),
          verdict: verdict === null ? null : sanitizeLine(verdict),
        },
      })
    }
    if (showsCard(entry) && entry.worker !== null) {
      const waits = handBackWaits(entry)
      const atWork = phaseFacts[phase._tag].atWork ? (state ?? null) : null
      cards.push({
        ticket: entry.ticket,
        label,
        title,
        worker: entry.worker,
        phase,
        state: atWork,
        status: waits ? handBackStatus : cardStatus(phase, activity, state, open, inputs.now),
        tone: statusTone(phase, atWork, open, activity),
        motion: waits ? "idle" : motionOf(phase, state, open),
        since: entry.since,
        action: actionOf(entry, branch, status.checksAhead.get(entry.ticket)),
        latest: latestOf(actions.get(entry.ticket)),
        steered: entry.steered,
        requests: open,
        ...(entry.issue === undefined ? {} : { issue: ticketText(entry.issue) }),
        ...memoryOf(status.load, entry.ticket),
      })
      resources.push(
        resourcesOf({
          ticket: entry.ticket,
          took: entry.account?.took ?? entry.since,
          compactions: entry.tallies.compactions,
          sums: status.spending,
          subscription: status.subscription,
          rise: status.rise,
          context: status.contexts.get(entry.ticket),
        }),
      )
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
            return {
              ticket,
              mark: entry === undefined ? "faint" : phaseFacts[entry.phase._tag].windDown,
            }
          })
          return { marks, running: marks.filter((m) => m.mark === "windingDown").length }
        })()

  const banners: Array<Banner> = []
  if (status.usage !== null) banners.push(Banner.Usage(status.usage))
  else if (status.windows.length > 0) {
    const windows = status.windows.map((each) => ({ ...each, name: sanitizeLine(each.name) }))
    banners.push(Banner.Windows({ windows }))
  }
  for (const hold of status.holds) {
    banners.push(Banner.Hold({ ...hold, word: sanitizeLine(hold.word) }))
  }

  const heading: TitleView = {
    version: sanitizeLine(status.version),
    branch,
    scope: status.scope === null ? null : sanitizeLine(status.scope),
    ...(status.spec == null ? {} : { spec: sanitizeLine(status.spec) }),
    began: status.began,
    stopping: status.stopping,
    quitting: status.quitting === null ? null : sanitizeLine(status.quitting),
    solo:
      status.solo === null
        ? null
        : { ticket: sanitizeLine(status.solo.ticket), running: status.solo.running },
    shared: status.shared,
    keepAwake: status.keepAwake,
    autoAnswer: status.autoAnswer === null ? null : sanitizeLine(status.autoAnswer),
  }
  const warnings = [...new Set(status.warnings.map(sanitizeLine))]
  const load = status.load === null ? null : loadView(status.load, status.fullCheck !== null)
  const fullCheck =
    status.fullCheck === null
      ? null
      : { ...status.fullCheck, command: sanitizeLine(status.fullCheck.command) }
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
    queue: keepAll(previous.queue, [...ready, ...held], (each) => each.ticket),
    needs: keepAll(previous.needs, [...asked, ...blocked], (each) => each.ticket),
    cards: keepAll(previous.cards, cards, (card) => card.ticket),
    resources: keepAll(previous.resources, resources, (each) => each.ticket),
    requests: keepAll(previous.requests, requests, (request) => request.id),
    banners: keep(previous.banners, banners),
    windDown: keep(previous.windDown, windDown),
    endOfRun: keep(previous.endOfRun, endOfRun),
    fullCheck: keep(previous.fullCheck, fullCheck),
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
      const now = yield* Clock.currentTimeMillis
      yield* SubscriptionRef.updateSome(view, (previous) => {
        const next = project({ ...inputs, now }, previous)
        return next === previous ? Option.none() : Option.some(next)
      })
      yield* Effect.sleep(interval)
    }).pipe(Effect.forever, Effect.forkScoped)
    return view
  })
