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
import type { WorkerState } from "../agent/WorkerState.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import type { Entry, State } from "./ledger.ts"
import { type Activity, countsUnder, hasCard, type PhaseTag, TicketPhase } from "./phase.ts"

/** A hold on the run, for its banner: `BLOCKED`, `USAGE_LIMIT` with its reset, … */
export interface RunHold {
  readonly word: string
  /** When it lifts by itself, in epoch milliseconds; null when nothing says. */
  readonly resetsAt: number | null
}

/** The account's usage (§ 4.12): how much of its limit is used, 0 to 1, and when it resets. */
export interface Usage {
  readonly utilization: number
  readonly resetsAt: number | null
}

/** What the run says about itself, beside its tickets. */
export interface Status {
  /** Where finished tickets land. */
  readonly branch: string
  /** How many workers may run at once. */
  readonly concurrency: number
  readonly holds: ReadonlyArray<RunHold>
  readonly usage: Usage | null
}

export const emptyStatus: Status = { branch: "", concurrency: 0, holds: [], usage: null }

/** Everything RunView is derived from. */
export interface Inputs {
  readonly ledger: State
  /** Each open worker's state, by its ticket. */
  readonly workers: ReadonlyMap<string, WorkerState>
  /** The open attention requests, every worker's, oldest first. */
  readonly requests: ReadonlyArray<AttentionRequest>
  readonly status: Status
}

/** The streams make() reads its inputs from: each gives its value now, then each change. */
export interface Sources {
  readonly ledger: EffectStream.Stream<State>
  readonly workers: EffectStream.Stream<ReadonlyMap<string, WorkerState>>
  readonly requests: EffectStream.Stream<ReadonlyArray<AttentionRequest>>
  readonly status: EffectStream.Stream<Status>
}

/** The dashboard's totals (§ 5.1, § 7.2). */
export interface Totals {
  readonly completed: number
  /** Set aside: deferred, and left for review. */
  readonly deferred: number
  readonly review: number
  /** Each ticket once: Asked, Blocked, and those whose worker waits on you. */
  readonly needsYou: number
  /** Workers at work, of `slots`. */
  readonly workers: number
  readonly slots: number
  readonly queued: number
  readonly heldBack: number
  /** The queue takes no new tickets: the run winds down, or is held. */
  readonly queueHeld: boolean
}

/** A row of the tickets table, which keeps its place from the moment the run picks it up. */
export interface Row {
  readonly ticket: string
  readonly title: string
  /** The row's status, as `▶ testing`: its mark and its word. */
  readonly mark: string
  readonly word: string
  /** What the row says of the ticket: its title, or how it finished. */
  readonly note: string
}

/** What a card shows instead of a spinner when its worker isn't at work (§ 5.1). */
export type Motion = "spinner" | "◷" | "◆" | "•"

/** A card, for a ticket with work under way. */
export interface Card {
  readonly ticket: string
  readonly title: string
  /** Its worker's number, stable for the session (§ 7.2). */
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
  /** Its worker's open requests, oldest first. */
  readonly requests: ReadonlyArray<AttentionRequest>
}

/** A banner on the title line. */
export type Banner = Data.TaggedEnum<{
  Usage: { readonly utilization: number; readonly resetsAt: number | null }
  Hold: { readonly word: string; readonly resetsAt: number | null }
}>

export const Banner = Data.taggedEnum<Banner>()

/** A ticket's `■` on the wind-down line (§ 5.1). */
export type WindDownMark = "windingDown" | "done" | "needsYou" | "faint"

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

export interface RunView {
  readonly totals: Totals
  readonly rows: ReadonlyArray<Row>
  /** In their workers' number order. */
  readonly cards: ReadonlyArray<Card>
  readonly requests: ReadonlyArray<AttentionRequest>
  /** Usage first, then each hold. */
  readonly banners: ReadonlyArray<Banner>
  readonly windDown: WindDownView | null
  readonly hint: ReadonlyArray<Key>
}

export const emptyView: RunView = {
  totals: {
    completed: 0,
    deferred: 0,
    review: 0,
    needsYou: 0,
    workers: 0,
    slots: 0,
    queued: 0,
    heldBack: 0,
    queueHeld: false,
  },
  rows: [],
  cards: [],
  requests: [],
  banners: [],
  windDown: null,
  hint: [],
}

/** At most this often RunView is written: 30 times a second. */
export const interval = Duration.millis(1000 / 30)

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

/** The local time at `millis` as a banner or card gives it: `14:05`. */
export const clock = (millis: number): string => {
  const date = new Date(millis)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

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
      return { mark: "◷", word: "to merge" }
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

/** What a card's status says of a worker in `state` with `requests` open (§ 4.2). */
export const stateStatus = (
  state: WorkerState | undefined,
  requests: ReadonlyArray<AttentionRequest>,
  activity: Activity,
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
        : `usage limit · resets ${clock(state.resetsAt)}`
    case "Idle":
      return "done"
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
): string => {
  switch (phase._tag) {
    case "Working":
      return stateStatus(state, requests, phase.activity)
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
  if (phase._tag === "ToMerge") return "◷"
  if (phase._tag === "Merging") return "◆"
  return working(state, requests) ? "spinner" : "•"
}

const actionOf = (entry: Entry, branch: string): string | null => {
  if (entry.rechecking) return `checking again: ${branch} moved on since its check failed`
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
): ReadonlyArray<Key> => {
  const keys: Array<Key> = []
  if (cards.length > 0) keys.push({ keys: "Tab", does: "select" })
  const numbered = cards.map((card) => card.worker).filter((n) => n <= 9)
  if (numbered.length > 0) {
    const highest = Math.max(...numbered)
    keys.push({ keys: highest === 1 ? "1" : `1–${highest}`, does: "open" })
  }
  const target = requests[0]
  if (target !== undefined) {
    keys.push({ keys: "d", does: "deny" })
    if (target.kind._tag === "Permission" && !target.defaultToNo) {
      keys.push({ keys: "a", does: "allow" })
    }
  }
  keys.push({ keys: "s", does: windingDown ? "keep taking tickets" : "stop after current" })
  keys.push({ keys: "?", does: "keys" })
  return keys
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
  const branch = sanitizeLine(status.branch)
  const requestsOf = new Map<string, Array<AttentionRequest>>()
  for (const request of requests) {
    const list = requestsOf.get(request.ticket)
    if (list === undefined) requestsOf.set(request.ticket, [request])
    else list.push(request)
  }
  const none: ReadonlyArray<AttentionRequest> = []

  const totals = { ...emptyView.totals, slots: status.concurrency }
  const needsYou = new Set(requestsOf.keys())
  const rows: Array<{ readonly at: number; readonly row: Row }> = []
  const cards: Array<Card> = []
  for (const entry of ledger.tickets.values()) {
    const state = workers.get(entry.ticket)
    const open = requestsOf.get(entry.ticket) ?? none
    const phase = shown(entry.phase, state, open)
    const title = sanitizeLine(entry.title)
    for (const total of countsUnder(phase)) {
      if (total === "needsYou") needsYou.add(entry.ticket)
      else if (total === "setAside") totals[phase._tag === "Review" ? "review" : "deferred"]++
      else if (total === "inQueue") totals.queued++
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
        },
      })
    }
    if (hasCard(entry.phase) && entry.worker !== null) {
      cards.push({
        ticket: entry.ticket,
        title,
        worker: entry.worker,
        phase: entry.phase,
        state: atWork.has(entry.phase._tag) ? (state ?? null) : null,
        status: cardStatus(phase, state, open),
        motion: motionOf(entry.phase, state, open),
        since: entry.since,
        action: actionOf(entry, branch),
        requests: open,
      })
    }
  }
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
    banners.push(Banner.Hold({ word: sanitizeLine(hold.word), resetsAt: hold.resetsAt }))
  }

  cards.sort((a, b) => a.worker - b.worker)
  const next: RunView = {
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
    hint: keep(previous.hint, hintOf(cards, requests, ledger.windDown !== null)),
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
    ).pipe(
      Stream.runForEach(([ledger, workers, requests, status]) =>
        Queue.offer(latest, { ledger, workers, requests, status }),
      ),
      Effect.forkScoped,
    )
    yield* Effect.gen(function* () {
      const inputs = yield* Queue.take(latest)
      const previous = yield* SubscriptionRef.get(view)
      const next = project(inputs, previous)
      if (next !== previous) yield* SubscriptionRef.set(view, next)
      yield* Effect.sleep(interval)
    }).pipe(Effect.forever, Effect.forkScoped)
    return view
  })
