// The usage-limit hold (§ 2, § 4.12, § 5 item 10), the run's own (run.ts makes it). Many workers on
// one subscription meet the account's usage limits together, and the SDK says when: each worker's
// session emits `rate_limit_event`s (UsageLimits gathers them), and a turn that ended on the limit
// leaves its worker UsageLimited (WorkerState).
//
// - `allowed_warning`: the title line shows `usage 85% of the five-hour limit · resets 14:05`, and
//   the log says USAGE once per limit. Dispatch doesn't change (§ 15, Q9).
// - `rejected`, an organ call refused for the limit (which UsageLimits reports as a rejection), or
//   a worker UsageLimited without one (a 429 alone): the hold. No new tickets start
//   (the run's `taking`), organ calls are skipped (OrganHold, from UsageLimits), the title line
//   shows `USAGE_LIMIT · resets 14:05` and the warning line `usage limit (five-hour) · resets 14:05
//   · 3 workers wait for it`, and a notification fires once. A UsageLimited worker never settles
//   (settle.ts), so it isn't nudged, triaged or counted toward the environment hold
//   (environment.ts): its ticket's fiber waits for it.
// - At the reset plus liftAfter, the hold is lifted (`USAGE_LIMIT lifted`) and each UsageLimited
//   worker you haven't steered is sent a client_composed message to carry on. A worker handed back
//   its ticket while at the limit (handback.ts's give) is sent the hand-back in its place.
// - The hold lifts on what the account says, not only on the clock (LimitHold): a reset at or
//   before now is unknown, as one the clock or the server has wrong; an unknown reset is tried again
//   retryEvery after the hold began; and a session's `allowed` or `allowed_warning` event for the
//   held limit, liftAfter or more after the hold began, shows the account under it again and lifts
//   the hold, whether or not a reset is known. Lifts
//   are at least retryEvery apart, so a limit that keeps refusing holds the run again at most that
//   often, never at request speed.
// - Before it lifts on the clock (at the reset or the next try, not on a session's word), the hold
//   asks the account (UsageProbe): one tiny model turn, in place of a carry-on per worker that the
//   limit may refuse again. Refused, the hold holds on to the reset the probe's rate_limit_event
//   gave, or tries again retryEvery later (`USAGE_LIMIT: a probe is refused for the five-hour limit
//   still; it resets at 14:05, in 42m`); unanswered, it lifts on the clock as before.
// - With nothing else running, the run waits for the reset, the title line counting down and the
//   log saying the countdown every countdownEvery; for a reset that has passed, for the next try.
//   It ends USAGE_LIMIT (exit 8) only when no reset was ever given or the reset is later than
//   --usage-limit-wait. A worker at the limit on a hand-back counts as
//   waiting once its hand-back waits for the limit (handBacks): kept for the reset, or on its turn
//   that ended on it. A hand-back kept for the reset that the run's end overtakes is never sent: the
//   end takes it back (unsent), aborts a conflict hand-back's rebase, for the next run to merge its
//   ticket again, and names it in the closing line (neverHanded).
//
// Overage in use is shown beside the usage line, and every change of a limit's status is a
// usage_limit record.
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Ref,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import { type AgentGone, AgentHost, type MessageUuid } from "../agent/AgentHost.ts"
import { type RateLimit, UsageLimits, type Waiting } from "../agent/UsageLimits.ts"
import { type ProbeAnswer, UsageProbe } from "../agent/UsageProbe.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { OrganHold } from "../organs/Organs.ts"
import { formatDuration } from "../project/configFile.ts"
import { Notifier } from "../services/Notifier.ts"
import { Store } from "../services/Store.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import { type AtReset, type HandBackMode, handedWords } from "./handback.ts"
import { type StopReason, stopFor } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { resetLabel, timestamp } from "./localTime.ts"
import {
  detail,
  Log,
  Tag,
  tagged,
  usageLimit,
  usageLimitLifted,
  usageProbeRefused,
  usageProbeUnanswered,
  usageWarning,
} from "./log.ts"
import type { TicketPhase } from "./phase.ts"
import { countdown, type RunHold, type Usage } from "./runView.ts"
import { resetHandBackText, resetText } from "./told.ts"

/** How long after its reset the hold is lifted (§ 4.12). */
export const liftAfter: Duration.Duration = Duration.minutes(1)

/**
 * How long the hold waits at least between two lifts, and before it tries again a reset it doesn't
 * know, as orchestra's 15 minutes.
 */
export const retryEvery: Duration.Duration = Duration.minutes(15)

/** How often the log says the countdown while the run waits for the reset. */
export const countdownEvery: Duration.Duration = Duration.minutes(10)

/** The hold's word, on its banner, its lines and its stop. */
export const holdWord = "USAGE_LIMIT"

/** A limit's name as the lines say it: `five-hour` for `five_hour`; null, the account's usage. */
export const limitName = (limit: string | null): string =>
  limit === null ? "account's usage" : limit.replaceAll("_", "-")

/**
 * What the run's closing line says of a hand-back kept for the reset and never sent, the run ending
 * first: a rebase aborted, for the next run to merge the ticket again, or, `stuck`, its worktree
 * left mid-rebase as the abort failed.
 */
export const neverHanded = ({
  id,
  mode,
  stuck,
}: {
  readonly id: string
  readonly mode: HandBackMode
  /** The worktree left mid-rebase. */
  readonly stuck?: string | undefined
}): string => {
  const what = `${id}'s worker, at the usage limit, was never handed its ${handedWords(mode)}`
  if (stuck !== undefined) {
    return `${what}, and its rebase could not be aborted, so ${stuck} is left mid-rebase`
  }
  return mode === "resolving"
    ? `${what}: its rebase is aborted, for the next run to merge ${id} again`
    : `${what}: the next run merges ${id} again`
}

/** `3 workers wait for it`, `1 worker waits for it`; empty for none. */
const waitFor = (n: number): string =>
  n === 0 ? "" : n === 1 ? "1 worker waits for it" : `${n} workers wait for it`

/**
 * The warning line's notice at `now` while the hold is on: `usage limit (five-hour) · resets 14:05
 * · …`, the reset with its weekday and date when it isn't today.
 */
export const holdNotice = (
  limit: string | null,
  resetsAt: number | null,
  waiting: number,
  now: number,
) =>
  [
    `usage limit (${limitName(limit)})`,
    ...(resetsAt === null ? [] : [`resets ${resetLabel(resetsAt, now)}`]),
    ...(waiting === 0 ? [] : [waitFor(waiting)]),
  ].join(" · ")

/** The stop the run ends with when it can't wait for the reset (exit 8). */
export const limitStop = (s: {
  readonly limit: string | null
  readonly resetsAt: number | null
  readonly now: number
  readonly wait: Duration.Duration
  readonly waiting: number
}): StopReason => {
  const reached =
    s.resetsAt === null
      ? `the ${limitName(s.limit)} limit is reached and when it resets is unknown`
      : `the ${limitName(s.limit)} limit resets at ${resetLabel(s.resetsAt, s.now)}, in ${countdown(s.resetsAt, s.now)}, later than --usage-limit-wait (${formatDuration(s.wait)})`
  const who = s.waiting === 0 ? "" : `; ${waitFor(s.waiting)}`
  return stopFor(holdWord, `${reached}${who}; run tutti again once it resets`, {
    held: true,
  })
}

/** What the hold shows on the dashboard: the usage banner, its own banner and its notice. */
export interface UsageView {
  readonly usage: Usage | null
  readonly hold: RunHold | null
  readonly notice: string | null
}

/** The usage-limit hold, the run's own (run.ts makes it). */
export interface UsageLimitHold {
  /** Whether the hold is on: no new tickets. */
  readonly held: Effect.Effect<boolean>
  /** The tickets whose workers are UsageLimited now. */
  readonly limited: Effect.Effect<ReadonlySet<string>>
  /**
   * On each look of the run, `alone` saying whether nothing runs but workers waiting for the limit:
   * with the hold on and nothing else running, the run waits for the reset, the countdown shown
   * and said. The stop to end the run with when the reset is unknown or later than
   * --usage-limit-wait; null otherwise.
   */
  look(alone: boolean): Effect.Effect<StopReason | null>
  /**
   * The tickets whose hand-backs wait for their workers to leave the limit: kept for the reset, or
   * on their workers' turns that ended on it.
   */
  readonly handBacks: Effect.Effect<ReadonlySet<string>>
  /** Keeps the hand-backs due to workers at the limit, to send at the reset as their carry-on. */
  readonly atReset: AtReset
  /**
   * Takes back every hand-back kept for the reset, as the run ends before it: the tickets whose
   * workers were never sent theirs, and what each was to be handed. The reset sends them nothing.
   */
  readonly unsent: Effect.Effect<ReadonlyMap<string, HandBackMode>>
}

/**
 * A hand-back kept for the reset: what it hands back, its prompt, whether its worker was steered
 * when it was kept (handed over to it all the same, § 4.3), and what came of its send.
 */
interface Kept {
  readonly mode: HandBackMode
  readonly prompt: string
  readonly steered: boolean
  readonly sent: Deferred.Deferred<MessageUuid | undefined, AgentGone>
}

/** When the held limit is expected to have reset. Times are epoch milliseconds. */
export type Reset = Data.TaggedEnum<{
  /** The reset the account gave, still to come. */
  Known: { readonly at: number }
  /**
   * No reset given, or the one given (`passed`) has passed already: the hold tries again at
   * `nextTry`.
   */
  Unknown: { readonly nextTry: number; readonly passed: number | null }
  /** A session said, at `at`, that the account is under the limit again. */
  Allowed: { readonly at: number }
}>

export const Reset = Data.taggedEnum<Reset>()

/** The usage-limit hold. `lifted` is when it was last lifted, for the next lift's spacing. */
export type LimitHold = Data.TaggedEnum<{
  Free: { readonly lifted: number | null }
  Held: {
    readonly since: number
    readonly limit: string | null
    readonly reset: Reset
    readonly lifted: number | null
  }
}>

export const LimitHold = Data.taggedEnum<LimitHold>()

/** A reset `at` given at `now`, as the hold reads it: one at or before now is unknown. */
export const resetOf = (at: number | null, now: number): Reset =>
  at !== null && at > now
    ? Reset.Known({ at })
    : Reset.Unknown({ nextTry: now + Duration.toMillis(retryEvery), passed: at })

/** When a hold lifts: at its reset plus liftAfter, its next try or once allowed, retryEvery apart. */
export const liftTime = (held: LimitHold & { readonly _tag: "Held" }): number => {
  const due = Reset.$match(held.reset, {
    Known: ({ at }) => at + Duration.toMillis(liftAfter),
    Unknown: ({ nextTry }) => nextTry,
    Allowed: ({ at }) => at,
  })
  return held.lifted === null ? due : Math.max(due, held.lifted + Duration.toMillis(retryEvery))
}

/** The reset a hold shows: its known reset; null otherwise. */
const shownReset = (reset: Reset): number | null => (reset._tag === "Known" ? reset.at : null)

interface HoldState {
  /** Each limit's last status, for the records of its changes. */
  readonly statuses: ReadonlyMap<string, RateLimit["status"]>
  /** The limits whose warning the log has said. */
  readonly warned: ReadonlySet<string>
  /** The last rejection: what a hold for a worker's 429 alone names. */
  readonly rejected: { readonly limit: string | null; readonly resetsAt: number | null } | null
  readonly usage: Usage | null
  readonly hold: LimitHold
  /** The tickets whose workers are UsageLimited. */
  readonly limited: ReadonlySet<string>
  /** When the run began waiting for the reset with nothing else running; null when it isn't. */
  readonly waiting: number | null
  /** When the countdown was last said. */
  readonly said: number
}

const fresh: HoldState = {
  statuses: new Map(),
  warned: new Set(),
  rejected: null,
  usage: null,
  hold: LimitHold.Free({ lifted: null }),
  limited: new Set(),
  waiting: null,
  said: 0,
}

/** The later of two resets, unknown only when both are. */
const later = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b)

/** Whether an event of `limit` speaks of the held limit: either unnamed, or the same. */
const sameLimit = (held: string | null, limit: string | null): boolean =>
  held === null || limit === null || held === limit

/**
 * OrganHold from UsageLimits: organ calls are skipped while the usage-limit hold is on, and one
 * refused for the limit is a rejection, which puts it on.
 */
export const organHold = Layer.effect(
  OrganHold,
  Effect.gen(function* () {
    const usage = yield* UsageLimits
    return { held: usage.held, refused: usage.refused }
  }),
)

/**
 * The run's usage-limit hold, watching UsageLimits' events and the workers' states for the rest of
 * the scope. `wakeUp` wakes the run to look again (the hold put on or lifted, the workers waiting
 * for it changing); `show` shows the hold on the dashboard.
 */
export const make = (options: {
  /** The branch the run merges into, for a hand-back's carry-on. */
  readonly base: string
  readonly wakeUp: Effect.Effect<void>
  readonly show: (view: UsageView) => Effect.Effect<void>
}): Effect.Effect<
  UsageLimitHold,
  never,
  | AppConfig
  | AgentHost
  | UsageLimits
  | UsageProbe
  | Ledger
  | Log
  | EventStream
  | Notifier
  | RunFibers
  | Store
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const host = yield* AgentHost
    const usage = yield* UsageLimits
    const probe = yield* UsageProbe
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const notifier = yield* Notifier
    const store = yield* Store
    const fibers = yield* RunFibers
    const watchers = yield* fibers.make("usageLimit")
    const lifter = yield* fibers.make("usageLimit lift")
    const state = yield* Ref.make(fresh)
    // The hand-backs kept for the reset, by ticket.
    const kept = yield* Ref.make<ReadonlyMap<string, Kept>>(new Map())
    // The tickets whose hand-backs wait for their workers, at the limit on them, to leave it.
    const onIt = yield* Ref.make<ReadonlySet<string>>(new Set())
    // Changes run one at a time, so the hold is put on and lifted once.
    const one = yield* Semaphore.make(1)

    const viewOf = (s: HoldState, now: number): UsageView => ({
      usage: s.usage,
      hold:
        s.hold._tag === "Free"
          ? null
          : {
              word: holdWord,
              resetsAt: shownReset(s.hold.reset),
              ...(s.waiting === null ? {} : { waiting: true }),
            },
      notice:
        s.hold._tag === "Free"
          ? null
          : holdNotice(s.hold.limit, shownReset(s.hold.reset), s.limited.size, now),
    })
    const update = (f: (s: HoldState) => HoldState) =>
      Effect.flatMap(Ref.updateAndGet(state, f), (s) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => options.show(viewOf(s, now))),
      )

    const resetsAt = (at: number | null) =>
      at === null ? {} : { resets_at: timestamp(new Date(at)) }

    // What the probe at a try answered: Refused, the hold takes the reset it gave, and the next try
    // to go with it; otherwise null, for the lift. One at a time with the hold's other changes, which
    // interrupt the try in place of setting it.
    const probed = (held: LimitHold & { readonly _tag: "Held" }, answer: ProbeAnswer) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state)
        if (s.hold._tag === "Free") return null
        if (answer._tag === "Allowed") return null
        if (answer._tag === "Unanswered") {
          yield* logs.write(usageProbeUnanswered(answer.reason))
          return null
        }
        const now = yield* Clock.currentTimeMillis
        const limit = held.limit ?? answer.limit
        // A refusal that gives no reset keeps the one the hold had, passed now, for the countdown.
        const had = Reset.$match(held.reset, {
          Known: ({ at }) => at,
          Unknown: ({ passed }) => passed,
          Allowed: () => null,
        })
        const reset = resetOf(answer.resetsAt ?? had, now)
        const next = LimitHold.Held({ ...held, limit, reset })
        yield* update((each) => ({ ...each, hold: next }))
        const at = liftTime(next)
        const until =
          next.reset._tag === "Known"
            ? `it resets at ${resetLabel(next.reset.at, now)}, in ${countdown(next.reset.at, now)}`
            : `tutti tries again at ${resetLabel(at, now)}, in ${countdown(at, now)}`
        yield* logs.write(usageProbeRefused({ limit: limitName(limit), until }))
        yield* options.wakeUp
        return next
      }).pipe(one.withPermit)

    // At its liftTime the hold lifts: at once on a session's word that the account is under the
    // limit, else once the probe finds it so, or gets no answer, which lifts it on the clock as
    // before the probe. Refused, the hold holds on to the probe's reset, or its next try.
    const tries = (held: LimitHold & { readonly _tag: "Held" }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const wait = liftTime(held) - (yield* Clock.currentTimeMillis)
        yield* Effect.sleep(Duration.millis(Math.max(0, wait)))
        if (held.reset._tag !== "Allowed") {
          const next = yield* probed(held, yield* probe.probe(held.limit))
          if (next !== null) return yield* tries(next)
        }
        yield* lift
      })

    // Tries the hold at its liftTime, in place of any try set before.
    const liftAt = (held: LimitHold & { readonly _tag: "Held" }) =>
      Effect.gen(function* () {
        yield* FiberSet.clear(lifter)
        yield* FiberSet.run(lifter, tries(held))
      })

    // Sets the held reset, and the lift that goes with it.
    const reset = (held: LimitHold & { readonly _tag: "Held" }, next: Reset) =>
      Effect.gen(function* () {
        const moved = LimitHold.Held({ ...held, reset: next })
        yield* update((s) => ({ ...s, hold: moved }))
        yield* liftAt(moved)
      })

    // Puts the hold on, or moves its reset to the later one. A reset known replaces one unknown or
    // an allowance; one unknown replaces only an allowance, which this rejection contradicts.
    const holdOn = (limit: string | null, given: number | null) =>
      Effect.gen(function* () {
        const before = (yield* Ref.get(state)).hold
        const now = yield* Clock.currentTimeMillis
        const next = resetOf(given, now)
        if (before._tag === "Held") {
          const current = before.reset
          if (next._tag === "Known") {
            if (current._tag !== "Known" || next.at > current.at) yield* reset(before, next)
          } else if (current._tag === "Allowed") yield* reset(before, next)
          return
        }
        const held = LimitHold.Held({ since: now, limit, reset: next, lifted: before.lifted })
        yield* update((s) => ({ ...s, hold: held }))
        yield* usage.hold(true)
        const at = shownReset(next)
        const text = usageLimit({
          limit: limitName(limit),
          ...(at === null ? {} : { resets: resetLabel(at, now) }),
        })
        yield* logs.writeWith(
          [text],
          events.emit({ kind: "hold", text: tagged(Tag.hold)`${text}` }),
        )
        yield* notifier.notify(
          at === null
            ? `The ${limitName(limit)} limit is reached; the run holds until it resets`
            : `The ${limitName(limit)} limit is reached; the run holds until it resets at ${resetLabel(at, now)}`,
        )
        yield* liftAt(held)
        yield* options.wakeUp
      })

    // A session says the account is under the held limit again: the hold lifts, retryEvery after
    // the last lift at the soonest. One within liftAfter of the hold answers a request made before
    // it, and says nothing of the limit since.
    const allowed = (limit: string | null) =>
      Effect.gen(function* () {
        const before = (yield* Ref.get(state)).hold
        if (before._tag === "Free" || !sameLimit(before.limit, limit)) return
        if (before.reset._tag === "Allowed") return
        const now = yield* Clock.currentTimeMillis
        if (now - before.since < Duration.toMillis(liftAfter)) return
        yield* reset(before, Reset.Allowed({ at: now }))
      })

    // What the ticket's worker waiting for the limit is told to carry on with once it resets: its
    // hand-back, while it is Resolving or Fixing; nothing, once what it left was taken from git and
    // its ticket went on to merge; else its ticket.
    const carryOn = (ticket: string, phase: TicketPhase["_tag"] | undefined) =>
      Effect.gen(function* () {
        if (phase === "ToMerge" || phase === "Merging" || phase === "Done") return null
        if (phase !== "Resolving" && phase !== "Fixing") return resetText(ticket)
        const branch = (yield* store.ticket(ticket))?.branch ?? "your branch"
        const mode = phase === "Resolving" ? "resolving" : "fixing"
        return resetHandBackText(ticket, branch, mode, options.base)
      })

    // At the reset: the hold lifted, and each worker waiting for it told to carry on.
    const lift = Effect.gen(function* () {
      const before = yield* Ref.get(state)
      if (before.hold._tag === "Free") return
      const { limit } = before.hold
      const lifted = yield* Clock.currentTimeMillis
      yield* update((s) => ({
        ...s,
        hold: LimitHold.Free({ lifted }),
        usage: null,
        rejected: null,
        waiting: null,
        statuses: new Map([...s.statuses].filter(([, status]) => status !== "rejected")),
      }))
      yield* usage.hold(false)
      yield* events.emit({ kind: "usage_limit", status: "lifted", limit: limit ?? "unknown" })
      yield* logs.writeWith(
        [usageLimitLifted],
        events.emit({
          kind: "hold",
          text: tagged(Tag.hold)`${usageLimitLifted}`,
          lifted: true,
        }),
      )
      const entries = (yield* ledger.current).tickets
      // A hand-back kept for the reset is its worker's carry-on, unless you steered it meanwhile.
      const due = yield* Ref.getAndSet(kept, new Map())
      for (const [ticket, handBack] of due) {
        if (entries.get(ticket)?.steered === true && !handBack.steered) {
          yield* logs.write(
            detail`${ticket}: the usage limit has reset; you steer its worker, so tutti doesn't hand it its ${handedWords(handBack.mode)}`,
          )
          yield* Deferred.succeed(handBack.sent, undefined)
          continue
        }
        const sent = yield* Effect.exit(
          host.send(ticket, { text: handBack.prompt, from: "clientComposed" }),
        )
        yield* Deferred.done(handBack.sent, sent)
        if (sent._tag === "Success") {
          yield* logs.write(
            detail`${ticket}: the usage limit has reset; its worker is handed its ${handedWords(handBack.mode)}`,
          )
        }
      }
      for (const ticket of before.limited) {
        if (due.has(ticket)) continue
        if (entries.get(ticket)?.steered === true) {
          yield* logs.write(
            detail`${ticket}: the usage limit has reset; you steer its worker, so tutti tells it nothing`,
          )
          continue
        }
        const phase = entries.get(ticket)?.phase._tag
        const text = yield* carryOn(ticket, phase)
        if (text === null) {
          yield* logs.write(
            detail`${ticket}: the usage limit has reset; its hand-back was taken from git, so tutti tells its worker nothing`,
          )
          continue
        }
        const sent = yield* Effect.result(host.send(ticket, { text, from: "clientComposed" }))
        if (sent._tag === "Success") {
          yield* logs.write(
            phase === "Resolving" || phase === "Fixing"
              ? detail`${ticket}: the usage limit has reset; its worker carries on with its hand-back`
              : detail`${ticket}: the usage limit has reset; its worker carries on`,
          )
        }
      }
      yield* options.wakeUp
    }).pipe(Effect.uninterruptible, one.withPermit)

    // A rate_limit_event, from any worker's session.
    const heard = (event: RateLimit) =>
      Effect.gen(function* () {
        const key = event.limit ?? "unknown"
        const before = yield* Ref.get(state)
        const changed = before.statuses.get(key) !== event.status
        const shown =
          event.status !== "allowed" || event.overage
            ? {
                utilization: event.utilization ?? (event.status === "rejected" ? 1 : 0),
                resetsAt: event.resetsAt,
                limit: limitName(event.limit),
                ...(event.overage ? { overage: true as const } : {}),
              }
            : null
        yield* update((s) => ({
          ...s,
          statuses: new Map(s.statuses).set(key, event.status),
          usage: shown,
          ...(event.status === "rejected"
            ? { rejected: { limit: event.limit, resetsAt: event.resetsAt } }
            : {}),
        }))
        if (event.status === "allowed_warning") {
          const now = yield* Clock.currentTimeMillis
          const text = usageWarning({
            percent: Math.round((event.utilization ?? 0) * 100),
            limit: limitName(event.limit),
            ...(event.resetsAt === null ? {} : { resets: resetLabel(event.resetsAt, now) }),
          })
          const record = changed
            ? events.emit({
                kind: "usage_limit",
                status: "warning",
                limit: key,
                ...resetsAt(event.resetsAt),
                ...(event.utilization === null ? {} : { utilization: event.utilization }),
                text,
              })
            : Effect.void
          if (before.warned.has(key)) yield* record
          else {
            yield* Ref.update(state, (s) => ({ ...s, warned: new Set([...s.warned, key]) }))
            yield* logs.writeWith([text], record)
          }
        }
        if (event.status === "rejected") {
          if (changed) {
            yield* events.emit({
              kind: "usage_limit",
              status: "rejected",
              limit: key,
              ...resetsAt(event.resetsAt),
              ...(event.utilization === null ? {} : { utilization: event.utilization }),
            })
          }
          yield* holdOn(event.limit, event.resetsAt)
        } else yield* allowed(event.limit)
      }).pipe(one.withPermit)

    // The workers waiting for the limit: one puts the hold on, if no rejection did. The probe's
    // session, which has no ticket, waits for nothing of the run's.
    const watched = (waiting: Waiting) =>
      Effect.gen(function* () {
        const tickets = (yield* ledger.current).tickets
        const limited = new Set<string>()
        let at: number | null = null
        for (const [ticket, resets] of waiting) {
          if (!tickets.has(ticket)) continue
          limited.add(ticket)
          at = later(at, resets)
        }
        const before = yield* Ref.get(state)
        const same =
          limited.size === before.limited.size && [...limited].every((t) => before.limited.has(t))
        if (same) return
        yield* update((s) => ({ ...s, limited }))
        // Workers told to carry on stay UsageLimited until their turn starts: only one newly
        // limited holds the run again.
        const newly = [...limited].some((ticket) => !before.limited.has(ticket))
        if (newly && before.hold._tag === "Free") {
          const rejected = before.rejected
          // A 429 alone, with no rejected rate_limit_event, is a change of status too.
          if (rejected === null) {
            yield* events.emit({
              kind: "usage_limit",
              status: "rejected",
              limit: "unknown",
              ...resetsAt(at),
            })
          }
          yield* holdOn(rejected?.limit ?? null, later(rejected?.resetsAt ?? null, at))
        }
        yield* options.wakeUp
      }).pipe(one.withPermit)

    const subscription = yield* usage.subscribe
    yield* FiberSet.run(watchers, Stream.runForEach(subscription, heard))
    yield* FiberSet.run(watchers, Stream.runForEach(usage.waiting, watched))

    const look = (alone: boolean) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state)
        if (s.hold._tag === "Free" || !alone) {
          if (s.waiting !== null) yield* update((each) => ({ ...each, waiting: null }))
          return null
        }
        // Allowed, it lifts at once, or once retryEvery since the last lift has gone.
        if (s.hold.reset._tag === "Allowed") return null
        const now = yield* Clock.currentTimeMillis
        const wait = config.usageLimitWait
        const { limit } = s.hold
        const known = shownReset(s.hold.reset)
        const passed = s.hold.reset._tag === "Unknown" ? s.hold.reset.passed : null
        // When it lifts, as the countdown says it: its reset, or the next try of one that passed.
        const at = known ?? (passed === null ? null : liftTime(s.hold))
        if (at === null || at - now > Duration.toMillis(wait)) {
          return limitStop({ limit, resetsAt: known, now, wait, waiting: s.limited.size })
        }
        const until =
          known === null
            ? `the ${limitName(limit)} limit was to reset at ${resetLabel(passed ?? at, now)}; tutti tries again at ${resetLabel(at, now)}, in ${countdown(at, now)}`
            : `the ${limitName(limit)} limit resets at ${resetLabel(at, now)}, in ${countdown(at, now)}`
        if (s.waiting === null) {
          yield* update((each) => ({ ...each, waiting: now, said: now }))
          yield* logs.write(
            known === null
              ? tagged(Tag.usageLimit)`nothing else runs; ${until}`
              : tagged(
                  Tag.usageLimit,
                )`nothing else runs; waiting for the ${limitName(limit)} limit to reset at ${resetLabel(at, now)}, in ${countdown(at, now)}`,
          )
        } else if (now - s.said >= Duration.toMillis(countdownEvery)) {
          yield* Ref.update(state, (each) => ({ ...each, said: now }))
          yield* logs.write(detail`${until}`)
        }
        return null
      }).pipe(one.withPermit)

    // Kept only while the hold is on, so that the reset sends it: one at a time with the lift.
    const keep: AtReset["keep"] = (ticket, mode, prompt) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(state)).hold._tag === "Free") return null
        const steered = (yield* ledger.current).tickets.get(ticket)?.steered === true
        const sent = yield* Deferred.make<MessageUuid | undefined, AgentGone>()
        yield* Ref.update(
          kept,
          (all) => new Map([...all, [ticket, { mode, prompt, steered, sent }]]),
        )
        yield* options.wakeUp
        return Deferred.await(sent)
      }).pipe(one.withPermit)

    const takeBack: AtReset["takeBack"] = (ticket) =>
      Ref.modify(kept, (all) => {
        if (!all.has(ticket)) return [false, all]
        return [true, new Map([...all].filter(([each]) => each !== ticket))]
      })

    const waits: AtReset["waits"] = (ticket, wait) =>
      Effect.acquireUseRelease(
        Effect.andThen(
          Ref.update(onIt, (all) => new Set([...all, ticket])),
          options.wakeUp,
        ),
        () => wait,
        () => Ref.update(onIt, (all) => new Set([...all].filter((each) => each !== ticket))),
      )

    // One at a time with the lift, so that a hand-back is either sent or taken back.
    const unsent = Effect.map(
      Ref.getAndSet(kept, new Map()),
      (all): ReadonlyMap<string, HandBackMode> =>
        new Map([...all].map(([ticket, handBack]) => [ticket, handBack.mode])),
    ).pipe(one.withPermit)

    return {
      held: Effect.map(Ref.get(state), (s) => s.hold._tag === "Held"),
      limited: Effect.map(Ref.get(state), (s) => s.limited),
      look,
      handBacks: Effect.map(
        Effect.all([Ref.get(kept), Ref.get(onIt)]),
        ([all, waiting]): ReadonlySet<string> => new Set([...all.keys(), ...waiting]),
      ),
      atReset: { keep, takeBack, waits },
      unsent,
    } satisfies UsageLimitHold
  })
