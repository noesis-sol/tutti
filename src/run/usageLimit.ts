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
//   worker you haven't steered is sent a client_composed message to carry on.
// - With nothing else running, the run waits for the reset, the title line counting down and the
//   log saying the countdown every countdownEvery. It ends USAGE_LIMIT (exit 8) only when the reset
//   time is unknown or later than --usage-limit-wait.
//
// Overage in use is shown beside the usage line, and every change of a limit's status is a
// usage_limit record.
import {
  Clock,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Ref,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { type RateLimit, UsageLimits, type Waiting } from "../agent/UsageLimits.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { OrganHold } from "../organs/Organs.ts"
import { formatDuration } from "../project/configFile.ts"
import { Notifier } from "../services/Notifier.ts"
import { Store } from "../services/Store.ts"
import { timestamp } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import type { HandBackMode } from "./handback.ts"
import { type StopReason, stopFor } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { detail, Log, Tag, tagged, usageLimit, usageLimitLifted, usageWarning } from "./log.ts"
import type { TicketPhase } from "./phase.ts"
import { clock, countdown, type RunHold, type Usage } from "./runView.ts"

/** How long after its reset the hold is lifted (§ 4.12). */
export const liftAfter: Duration.Duration = Duration.minutes(1)

/** How often the log says the countdown while the run waits for the reset. */
export const countdownEvery: Duration.Duration = Duration.minutes(10)

/** The hold's word, on its banner, its lines and its stop. */
export const holdWord = "USAGE_LIMIT"

/** A limit's name as the lines say it: `five-hour` for `five_hour`; null, the account's usage. */
export const limitName = (limit: string | null): string =>
  limit === null ? "account's usage" : limit.replaceAll("_", "-")

/** The message a worker waiting for the limit is sent once it has reset. */
export const carryOnText = (id: string): string =>
  `tutti: the account's usage limit has reset. Carry on with your ticket ${id} where you left off.`

/**
 * The message a worker waiting for the limit on its hand-back onto `base` (handback.ts) is sent once
 * it has reset: the hand-back to carry on with, not its ticket, which it closed already, as orchestra
 * tells it.
 */
export const carryOnHandBack = (
  id: string,
  branch: string,
  mode: HandBackMode,
  base: string,
): string => {
  const what =
    mode === "resolving"
      ? `the rebase of ${branch} onto ${base} tutti handed back to you, resolving its conflicts, finishing it and running the tests`
      : `the failing check tutti handed back to you, fixing ${branch} so that it passes and committing the fix`
  return (
    `tutti: the account's usage limit has reset. Carry on where you left off with ${what}, ` +
    `as tutti's message asked, not with ${id} itself, which you closed already. ` +
    "If you had finished that before the limit, check that git shows it done and say DONE."
  )
}

/** `3 workers wait for it`, `1 worker waits for it`; empty for none. */
const waitFor = (n: number): string =>
  n === 0 ? "" : n === 1 ? "1 worker waits for it" : `${n} workers wait for it`

/** The warning line's notice while the hold is on: `usage limit (five-hour) · resets 14:05 · …`. */
export const holdNotice = (limit: string | null, resetsAt: number | null, waiting: number) =>
  [
    `usage limit (${limitName(limit)})`,
    ...(resetsAt === null ? [] : [`resets ${clock(resetsAt)}`]),
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
      : `the ${limitName(s.limit)} limit resets at ${clock(s.resetsAt)}, in ${countdown(s.resetsAt, s.now)}, later than --usage-limit-wait (${formatDuration(s.wait)})`
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
}

interface HoldState {
  /** Each limit's last status, for the records of its changes. */
  readonly statuses: ReadonlyMap<string, RateLimit["status"]>
  /** The limits whose warning the log has said. */
  readonly warned: ReadonlySet<string>
  /** The last rejection: what a hold for a worker's 429 alone names. */
  readonly rejected: { readonly limit: string | null; readonly resetsAt: number | null } | null
  readonly usage: Usage | null
  /** The hold, while it is on. */
  readonly hold: { readonly limit: string | null; readonly resetsAt: number | null } | null
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
  hold: null,
  limited: new Set(),
  waiting: null,
  said: 0,
}

/** The later of two resets, unknown only when both are. */
const later = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b)

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
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const notifier = yield* Notifier
    const store = yield* Store
    const fibers = yield* RunFibers
    const watchers = yield* fibers.make("usageLimit")
    const lifter = yield* fibers.make("usageLimit lift")
    const state = yield* Ref.make(fresh)
    // Changes run one at a time, so the hold is put on and lifted once.
    const one = yield* Semaphore.make(1)

    const viewOf = (s: HoldState): UsageView => ({
      usage: s.usage,
      hold:
        s.hold === null
          ? null
          : {
              word: holdWord,
              resetsAt: s.hold.resetsAt,
              ...(s.waiting === null ? {} : { waiting: true }),
            },
      notice: s.hold === null ? null : holdNotice(s.hold.limit, s.hold.resetsAt, s.limited.size),
    })
    const update = (f: (s: HoldState) => HoldState) =>
      Effect.flatMap(Ref.updateAndGet(state, f), (s) => options.show(viewOf(s)))

    const resetsAt = (at: number | null) =>
      at === null ? {} : { resets_at: timestamp(new Date(at)) }

    // Lifts the hold at its reset plus liftAfter, in place of any lift set before.
    const liftAt = (at: number | null) =>
      Effect.gen(function* () {
        yield* FiberSet.clear(lifter)
        if (at === null) return
        const wait = at + Duration.toMillis(liftAfter) - (yield* Clock.currentTimeMillis)
        yield* FiberSet.run(
          lifter,
          Effect.andThen(Effect.sleep(Duration.millis(Math.max(0, wait))), lift),
        )
      })

    // Puts the hold on, or moves its reset to the later one.
    const holdOn = (limit: string | null, at: number | null) =>
      Effect.gen(function* () {
        const before = (yield* Ref.get(state)).hold
        if (before !== null) {
          const moved = later(before.resetsAt, at)
          if (moved === before.resetsAt) return
          yield* update((s) => ({ ...s, hold: { limit: before.limit, resetsAt: moved } }))
          yield* liftAt(moved)
          return
        }
        yield* update((s) => ({ ...s, hold: { limit, resetsAt: at } }))
        yield* usage.hold(true)
        const text = usageLimit({
          limit: limitName(limit),
          ...(at === null ? {} : { resets: clock(at) }),
        })
        yield* events.emit({ kind: "hold", text: tagged(Tag.hold)`${text}` })
        yield* logs.write(text)
        yield* notifier.notify(
          at === null
            ? `The ${limitName(limit)} limit is reached; the run holds until it resets`
            : `The ${limitName(limit)} limit is reached; the run holds until it resets at ${clock(at)}`,
        )
        yield* liftAt(at)
        yield* options.wakeUp
      })

    // What the ticket's worker waiting for the limit is told to carry on with once it resets: its
    // hand-back, while it is Resolving or Fixing; nothing, once what it left was taken from git and
    // its ticket went on to merge; else its ticket.
    const carryOn = (ticket: string, phase: TicketPhase["_tag"] | undefined) =>
      Effect.gen(function* () {
        if (phase === "ToMerge" || phase === "Merging" || phase === "Done") return null
        if (phase !== "Resolving" && phase !== "Fixing") return carryOnText(ticket)
        const branch = (yield* store.ticket(ticket))?.branch ?? "your branch"
        const mode = phase === "Resolving" ? "resolving" : "fixing"
        return carryOnHandBack(ticket, branch, mode, options.base)
      })

    // At the reset: the hold lifted, and each worker waiting for it told to carry on.
    const lift = Effect.gen(function* () {
      const before = yield* Ref.get(state)
      if (before.hold === null) return
      const { limit } = before.hold
      yield* update((s) => ({
        ...s,
        hold: null,
        usage: null,
        rejected: null,
        waiting: null,
        statuses: new Map([...s.statuses].filter(([, status]) => status !== "rejected")),
      }))
      yield* usage.hold(false)
      yield* events.emit({ kind: "usage_limit", status: "lifted", limit: limit ?? "unknown" })
      yield* events.emit({
        kind: "hold",
        text: tagged(Tag.hold)`${usageLimitLifted}`,
        lifted: true,
      })
      yield* logs.write(usageLimitLifted)
      const entries = (yield* ledger.current).tickets
      for (const ticket of before.limited) {
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
        const sent = yield* Effect.result(host.send(ticket, text, "clientComposed"))
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
          const text = usageWarning({
            percent: Math.round((event.utilization ?? 0) * 100),
            limit: limitName(event.limit),
            ...(event.resetsAt === null ? {} : { resets: clock(event.resetsAt) }),
          })
          if (changed) {
            yield* events.emit({
              kind: "usage_limit",
              status: "warning",
              limit: key,
              ...resetsAt(event.resetsAt),
              ...(event.utilization === null ? {} : { utilization: event.utilization }),
              text,
            })
          }
          if (!before.warned.has(key)) {
            yield* Ref.update(state, (s) => ({ ...s, warned: new Set([...s.warned, key]) }))
            yield* logs.write(text)
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
        }
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
        if (newly && before.hold === null) {
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
        if (s.hold === null || !alone) {
          if (s.waiting !== null) yield* update((each) => ({ ...each, waiting: null }))
          return null
        }
        const now = yield* Clock.currentTimeMillis
        const wait = config.usageLimitWait
        const { limit, resetsAt: at } = s.hold
        if (at === null || at - now > Duration.toMillis(wait)) {
          return limitStop({ limit, resetsAt: at, now, wait, waiting: s.limited.size })
        }
        if (s.waiting === null) {
          yield* update((each) => ({ ...each, waiting: now, said: now }))
          yield* logs.write(
            tagged(
              Tag.usageLimit,
            )`nothing else runs; waiting for the ${limitName(limit)} limit to reset at ${clock(at)}, in ${countdown(at, now)}`,
          )
        } else if (now - s.said >= Duration.toMillis(countdownEvery)) {
          yield* Ref.update(state, (each) => ({ ...each, said: now }))
          yield* logs.write(
            detail`the ${limitName(limit)} limit resets at ${clock(at)}, in ${countdown(at, now)}`,
          )
        }
        return null
      }).pipe(one.withPermit)

    return {
      held: Effect.map(Ref.get(state), (s) => s.hold !== null),
      limited: Effect.map(Ref.get(state), (s) => s.limited),
      look,
    } satisfies UsageLimitHold
  })
