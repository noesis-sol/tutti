// The run's loop (run.ts, § 5): its watchers forked (watchers.ts), the start's steps run
// (start.ts), then the loop (look.ts), which looks at the run at each wake until nothing is left
// (runEnd.ts) or the run quits: the first request to quit, a panic in one of the run's fibers, or
// a worker's turn refused for Claude's login that the login check's probes find refused too
// (§ 4.8, quitting.ts) cuts it short. Where no look runs, the environment hold's wait for its probe
// and the end's steps, a fiber of the run's takes the wakes, reading which questions are answered
// at each, for the dashboard.
import { Deferred, Effect, type FileSystem, Ref, type Scope, SubscriptionRef } from "effect"
import type { Notifier } from "../../services/Notifier.ts"
import { readAnswers } from "../asked.ts"
import { stopFor } from "../holds.ts"
import type { Ledger } from "../ledger.ts"
import { make as makeLoop } from "../look.ts"
import type { Quits, Quitting } from "../quitting.ts"
import { showOn } from "../runView.ts"
import { reads } from "../wakes.ts"
import type { WorkEnv } from "../work.ts"
import { make as makeLooks } from "./looks.ts"
import type { RunParts } from "./parts.ts"
import { firstLine, type RunEnv, showEndOfRun } from "./shared.ts"
import { make as startRun } from "./start.ts"
import { afterStart, make as makeWatchers, type Watchers } from "./watchers.ts"

/** How the loop ended, and what the end does with the run's watchers and quits. */
export interface Looped {
  /** The quit that cut the loop short, or null for a loop that ended by itself. */
  readonly quit: Quitting | null
  readonly watch: Watchers["watch"]
  readonly quits: Quits
  /** Takes the wakes where no look runs, reading which questions are answered at each. */
  readonly answersAtWakes: Effect.Effect<never>
}

/** The run's loop, from its watchers and the start's steps to the loop's end or a quit. */
export const loop = (
  parts: RunParts,
): Effect.Effect<Looped, never, RunEnv | Ledger | Scope.Scope> =>
  Effect.gen(function* () {
    const { options } = parts
    const { config, ledger, attention, status, screen, commands, wakes, holds } = parts.services
    const { quitting, panicked, environment, usage, triage, gate, disk } = parts.holds
    const { critic, auditor, playbook, queue } = parts.merge
    const { scheduler } = parts.starting
    const watchers = yield* makeWatchers(parts)
    const started = yield* startRun(parts, watchers)
    yield* afterStart(parts, watchers)
    const { lookAtAsked, fill, autoAnswering, outage, askedUnread } = yield* makeLooks(
      parts,
      started,
    )
    const { unslotted } = started
    // The loop (look.ts): it looks at each wake until nothing is left, then ends the run.
    const fillContext = yield* Effect.context<WorkEnv | FileSystem.FileSystem | Notifier>()
    // Where no look runs, the environment hold's wait for its probe and the end's steps, the wakes
    // are this one's: it reads which questions are answered at each, for the dashboard, as a look
    // that takes nothing back does (asked.ts). A look after the wait looks whatever it took.
    const answersAtWakes: Effect.Effect<never> =
      screen === null
        ? Effect.never
        : Effect.forever(
            Effect.gen(function* () {
              if (reads(yield* wakes.take)) {
                const { look } = yield* lookAtAsked
                yield* readAnswers(look)
                yield* showOn(status, "answered")(look.noSlot)
              }
              yield* wakes.next(Effect.never)
            }),
          ).pipe(Effect.provideContext(fillContext))
    const { untilEnd } = yield* makeLoop({
      fill: (why) => Effect.provideContext(fill(why), fillContext),
      wakes,
      gate,
      holds,
      ledger,
      attention,
      scheduler,
      queue,
      triage,
      critic,
      auditor,
      playbook,
      usage,
      commands,
      environment: { probe: (stops) => environment.probe(stops, answersAtWakes) },
      resuming: Effect.map(
        Effect.all([Ref.get(unslotted), Ref.get(askedUnread)]),
        ([all, unread]) => all.size > 0 || unread,
      ),
      answering: Ref.get(autoAnswering),
      unread: Effect.map(Ref.get(outage), (now) => now !== null),
      ...(disk === undefined ? {} : { diskHeld: disk.held }),
      setAside: Effect.map(queue.handBacks.setAside, (all) => all.map((each) => each.id)),
      ...(options.filing === undefined
        ? {}
        : { filing: Effect.map(SubscriptionRef.get(options.filing), (now) => now !== null) }),
      showEndOfRun: (tickets) => showEndOfRun(status, tickets),
      dashboard: screen !== null,
      overnight: config.overnight,
    })

    // A panic in the loop quits the run as one in its other fibers does.
    const guardedLoop = Effect.catchDefect(Effect.as(untilEnd, null), (defect) =>
      Effect.andThen(
        panicked("the run", stopFor("PANIC", `the run's loop: ${firstLine(defect)}`), defect),
        Effect.never,
      ),
    )
    // A quit heard before the loop, during the start's steps, starts no ticket.
    const quit = (yield* Deferred.isDone(quitting))
      ? yield* Deferred.await(quitting)
      : yield* Effect.raceFirst(guardedLoop, Deferred.await(quitting))
    return { quit, watch: watchers.watch, quits: watchers.quits, answersAtWakes }
  })
