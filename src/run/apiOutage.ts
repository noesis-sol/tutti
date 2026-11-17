// The API-outage hold (§ 4.2, § 4.12), the run's own (run.ts makes it). A turn that fails as Claude's
// API is unavailable, after Claude Code's own retries (a 5xx or 529, an overload, no connection:
// WorkerState's apiOutage), leaves its worker ApiUnavailable, which never settles: its ticket isn't
// read, nudged, deferred, triaged or counted toward the environment hold, as each worker would fail
// the same way, whatever its ticket, until the API answers again.
//
// - The first such worker holds the run: no new tickets start (the gate's apiHeld), the dashboard
//   shows the API_UNAVAILABLE banner, the log says `API_UNAVAILABLE: t-1's turn failed as Claude's
//   API was unavailable (…), after Claude Code's own retries; no new tickets until it answers again,
//   and tutti asks it in 1m`, and a notification fires. The running workers go on.
// - The hold asks the API (UsageProbe: one turn of a few tokens) firstProbe after it began, then
//   twice as long after each probe that got no answer, up to probeEveryMost, for as long as it
//   takes: an outage overnight holds the run until the API is back, rather than defer the queue a
//   ticket at a time or end the run. Each hold starts the backoff afresh.
// - The machine's sleep (Wake's sleeps) has it ask again askAfterWake after the wake, whatever wait
//   was left, the backoff afresh: the network may be back with the machine, as the lid opened. A
//   probe a sleep cut that got no answer is the sleep's, not the API's: it doesn't double the wait,
//   and the hold asks again askAfterWake after the wake (tutti-ko5f).
// - A probe answered, even refused for the usage limit (the usage-limit hold takes that on), lifts
//   the hold (`API_UNAVAILABLE lifted`): each ApiUnavailable worker you haven't steered is sent a
//   client_composed message to carry on where it left off, but one whose hand-back was taken from
//   git (ToMerge, Merging, Done), which is told nothing, and the run takes tickets again.
//
// The environment probe's session, the feature interview's, which you drive, and the spec's
// breakdown, which ends on it as on a failed turn (breakdown.ts), are left out: no hold runs before
// the run to carry them on. A worker whose ticket has gone on since, its hand-back ended or set
// aside, isn't told to carry on either.
import {
  Clock,
  Duration,
  Effect,
  FiberSet,
  Option,
  Ref,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { interviewWorker } from "../agent/inView.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { detail, type Line, Log, Tag, tagged } from "../core/log.ts"
import { UsageProbe } from "../organs/UsageProbe.ts"
import { formatDuration } from "../project/configFile.ts"
import type { TicketId } from "../services/Beads.ts"
import { EventStream } from "../services/EventStream.ts"
import { Notifier } from "../services/Notifier.ts"
import { Wake } from "../services/Wake.ts"
import { breakdownWorker } from "./breakdown.ts"
import { probeWorker } from "./environment.ts"
import { Ledger } from "./ledger.ts"
import { apiBackText } from "./told.ts"

/** The hold's word, on its banner and its lines. */
export const holdWord = Tag.apiUnavailable

/** How long after the hold began it first asks the API. */
export const firstProbe: Duration.Duration = Duration.minutes(1)

/** The longest wait between two probes that the doubling reaches. */
export const probeEveryMost: Duration.Duration = Duration.minutes(15)

/** How long after the machine wakes the hold asks the API, its network given time to come back. */
export const askAfterWake: Duration.Duration = Duration.seconds(5)

/** How long the hold waits before its probe after `probes` probes that got no answer. */
export const probeAfter = (probes: number): Duration.Duration =>
  Duration.min(Duration.times(firstProbe, 2 ** Math.min(probes, 30)), probeEveryMost)

/** The line said as `ticket`'s turn, failing with `error`, holds the run, the probe due in `wait`. */
export const heldLine = (ticket: TicketId, error: string, wait: Duration.Duration): Line =>
  tagged(
    holdWord,
  )`${ticket}'s turn failed as Claude's API was unavailable (${error}), after Claude Code's own retries; no new tickets until it answers again, and tutti asks it in ${formatDuration(wait)}`

/** The line said as a probe got no answer, for `reason`, the next due in `wait`. */
export const unansweredLine = (reason: string, wait: Duration.Duration): Line =>
  tagged(
    holdWord,
  )`a probe of Claude's API got no answer either (${reason}); tutti asks it again in ${formatDuration(wait)}`

/** The line said as the machine woke in the hold's wait, its probe due in `wait`. */
export const wokeLine = (wait: Duration.Duration): Line =>
  detail`the machine woke: tutti asks Claude's API again in ${formatDuration(wait)}`

/** The line said as a probe a sleep cut got no answer, for `reason`, the next due in `wait`. */
export const sleptProbeLine = (reason: string, wait: Duration.Duration): Line =>
  detail`a probe of Claude's API got no answer as the machine slept (${reason}); tutti asks it again in ${formatDuration(wait)}`

/** The line said as the hold is lifted, `after` it began. */
export const liftedLine = (after: Duration.Duration): Line =>
  tagged(holdWord)`lifted: Claude's API answered a probe ${formatDuration(after)} after the hold`

/** The run's API-outage hold. */
export interface ApiOutage {
  /** Whether it holds the run: no new tickets start. */
  readonly held: Effect.Effect<boolean>
  /** Follows every worker the host knows, for as long as the run goes. */
  readonly watch: Effect.Effect<void>
}

/** A worker waiting for the API: its error, as its turn's result said it. */
type Waiting = ReadonlyMap<TicketId, string>

/**
 * Whether the hold looks after the worker `ticket`: not the environment probe's, the interview's or
 * the breakdown's.
 */
const followed = (ticket: TicketId): boolean =>
  ticket !== probeWorker && ticket !== interviewWorker && ticket !== breakdownWorker

/**
 * The run's API-outage hold. `show` puts its banner on (true) or off; `wakeUp` wakes the run, which
 * starts tickets again once it lifts.
 */
export const make = (options: {
  readonly show: (held: boolean) => Effect.Effect<void>
  readonly wakeUp: Effect.Effect<void>
}): Effect.Effect<
  ApiOutage,
  never,
  AgentHost | UsageProbe | Ledger | Log | EventStream | Notifier | Scope.Scope
> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const probe = yield* UsageProbe
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const notifier = yield* Notifier
    const wake = yield* Wake
    // When the hold began, null while it doesn't hold the run.
    const since = yield* Ref.make<number | null>(null)
    const waiting = yield* Ref.make<Waiting>(new Map())
    const probes = yield* FiberSet.make<void>()
    // Holding, lifting and following the workers run one at a time, so no worker is told twice.
    const one = yield* Semaphore.make(1)

    const hold = (text: Line, lifted?: true) =>
      logs.writeWith(
        [text],
        events.emit({
          kind: "hold",
          text: tagged(Tag.hold)`${text}`,
          ...(lifted === undefined ? {} : { lifted }),
        }),
      )

    // The hold lifted: each worker waiting for the API told to carry on.
    const lift = Effect.gen(function* () {
      const began = yield* Ref.getAndSet(since, null)
      if (began === null) return
      const now = yield* Clock.currentTimeMillis
      yield* options.show(false)
      yield* hold(liftedLine(Duration.millis(now - began)), true)
      const due = yield* Ref.getAndSet(waiting, new Map())
      const entries = (yield* ledger.current).tickets
      for (const ticket of due.keys()) {
        const entry = entries.get(ticket)
        if (entry?.steered === true) {
          yield* logs.write(
            detail`${ticket}: Claude's API answers again; you steer its worker, so tutti tells it nothing`,
          )
          continue
        }
        const phase = entry?.phase._tag
        if (phase === "ToMerge" || phase === "Merging" || phase === "Done") {
          yield* logs.write(
            detail`${ticket}: Claude's API answers again; its hand-back was taken from git, so tutti tells its worker nothing`,
          )
          continue
        }
        // Its ticket went on without it meanwhile: set aside, or its hand-back ended.
        if (
          phase !== undefined &&
          phase !== "Working" &&
          phase !== "Resolving" &&
          phase !== "Fixing"
        ) {
          yield* logs.write(
            detail`${ticket}: Claude's API answers again; its ticket is ${phase} now, so tutti tells its worker nothing`,
          )
          continue
        }
        const sent = yield* Effect.result(
          host.send(ticket, { text: apiBackText, from: "clientComposed" }),
        )
        if (sent._tag === "Success") {
          yield* logs.write(detail`${ticket}: Claude's API answers again; its worker carries on`)
        }
      }
      yield* options.wakeUp
    }).pipe(one.withPermit)

    // The first sleep of the machine noticed that ended after the instant `from`; never without one.
    const wokeAfter = (from: number) =>
      wake.sleeps.pipe(
        Stream.filter((sleep) => sleep.to > from),
        Stream.runHead,
        Effect.flatMap((woke) => (Option.isSome(woke) ? Effect.succeed(woke.value) : Effect.never)),
      )

    // Asks the API after each wait, doubled after each probe that got no answer, until one is; a
    // sleep of the machine has it ask again askAfterWake after the wake, the backoff afresh.
    const probing = Effect.gen(function* () {
      let wait = probeAfter(0)
      // The wait after the next probe that gets no answer: probeAfter(doubled).
      let doubled = 1
      // Where the sleeps already acted on end, so that one isn't taken for a wake again.
      let seen = 0
      const woken = (to: number) => {
        seen = Math.max(seen, to)
        wait = askAfterWake
        doubled = 0
      }
      for (;;) {
        const from = yield* Clock.currentTimeMillis
        const woke = yield* Effect.raceFirst(
          Effect.as(Effect.sleep(wait), null),
          wokeAfter(Math.max(from, seen)),
        )
        if (woke !== null || (yield* wake.sleptSince(from)) > 0) {
          woken(woke?.to ?? (yield* Clock.currentTimeMillis))
          yield* logs.write(wokeLine(wait))
          continue
        }
        const asked = yield* Clock.currentTimeMillis
        const answer = yield* probe.probe(null)
        if (answer._tag !== "Unanswered") return yield* lift
        if ((yield* wake.sleptSince(asked)) > 0) {
          woken(yield* Clock.currentTimeMillis)
          yield* logs.write(sleptProbeLine(answer.reason, wait))
          continue
        }
        wait = probeAfter(doubled)
        doubled += 1
        yield* logs.write(unansweredLine(answer.reason, wait))
      }
    })

    // A worker's turn failed on the API: the hold, if it isn't on already.
    const unavailable = (ticket: TicketId, error: string) =>
      Effect.gen(function* () {
        yield* Ref.update(waiting, (all) => new Map(all).set(ticket, error))
        if ((yield* Ref.get(since)) !== null) {
          yield* logs.write(
            detail`${ticket}: its turn failed as Claude's API was unavailable too; its worker waits for it`,
          )
          return
        }
        yield* Ref.set(since, yield* Clock.currentTimeMillis)
        yield* options.show(true)
        yield* hold(heldLine(ticket, error, probeAfter(0)))
        yield* notifier.notify("Claude's API is unavailable; the run holds until it answers again")
        yield* FiberSet.run(probes, probing)
      }).pipe(one.withPermit)

    // The worker went on: it waits for the API no more.
    const going = (ticket: TicketId) =>
      Ref.update(waiting, (all) => {
        if (!all.has(ticket)) return all
        const rest = new Map(all)
        rest.delete(ticket)
        return rest
      }).pipe(one.withPermit)

    const seen = (ticket: TicketId, state: WorkerState) =>
      state._tag === "ApiUnavailable" ? unavailable(ticket, state.error) : going(ticket)

    const watch = Effect.scoped(
      Effect.gen(function* () {
        const known = new Set<TicketId>()
        const ensure = (ticket: TicketId): Effect.Effect<void, never, Scope.Scope> =>
          Effect.suspend(() => {
            if (known.has(ticket) || !followed(ticket)) return Effect.void
            known.add(ticket)
            return Effect.asVoid(Effect.forkScoped(follow(ticket)))
          })
        // Once its stream ends, a worker the host still knows was started again: followed anew.
        const follow = (ticket: TicketId): Effect.Effect<void, never, Scope.Scope> =>
          host.state(ticket).pipe(
            Stream.changes,
            Stream.runForEach((state) => seen(ticket, state)),
            Effect.ignore,
            Effect.andThen(Effect.sync(() => known.delete(ticket))),
            Effect.andThen(Effect.result(host.current(ticket))),
            Effect.flatMap((current) =>
              current._tag === "Success" ? ensure(ticket) : going(ticket),
            ),
          )
        yield* Stream.runForEach(host.workers, (tickets) =>
          Effect.forEach(tickets, ensure, { discard: true }),
        )
      }),
    )

    return {
      held: Effect.map(Ref.get(since), (began) => began !== null),
      watch,
    } satisfies ApiOutage
  })
