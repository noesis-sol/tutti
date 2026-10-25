import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { holdsWorker, Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import { workerStates } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as hostLayer, type Script, wait } from "../src/testing/AgentHost.ts"
import { allowAll, layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

/** Runs `effect` in a scope, with the ledger and the scripted host playing `scripts`. */
const run = <A, E>(
  scripts: Readonly<Record<string, Script>>,
  effect: Effect.Effect<A, E, AgentHost | Ledger | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(hostLayer(scripts), Ledger.layer).pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(allowAll), transcriptsLayer())),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

const session = (ticket: string, sessionId = "s-1") => ({ sessionId, cwd: `/work/${ticket}` })

/** Moves the ticket to Working, as a dispatch does before its worker is started. */
const dispatch = (ticket: TicketId) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.transition(ticket, Move.Ready(), { title: ticket })
    yield* ledger.transition(ticket, Move.Dispatched())
  })

/** A fiber with the first of `states` that `seen` holds for. */
const first = (
  states: Stream.Stream<ReadonlyMap<string, WorkerState>>,
  seen: (all: ReadonlyMap<string, WorkerState>) => boolean,
) =>
  states.pipe(
    Stream.filter(seen),
    Stream.take(1),
    Stream.runHead,
    Effect.map((found) => (found._tag === "Some" ? found.value : undefined)),
    Effect.forkChild,
  )

describe("the workers' states on the dashboard", () => {
  test("two tickets dispatched together show both workers' states", async () => {
    const shown = await run(
      { "t-1": [[wait]], "t-2": [[wait]] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const ledger = yield* Ledger
        yield* dispatch("t-1" as TicketId)
        yield* dispatch("t-2" as TicketId)
        const phases = [...(yield* ledger.current).tickets.values()].map((e) => e.phase)
        expect(phases.every(holdsWorker)).toBe(true)
        // The dashboard follows from here: both tickets hold a worker the host doesn't know yet.
        const states = yield* workerStates
        const both = yield* first(states, (all) => all.size === 2)
        yield* host.start("t-1" as TicketId, session("t-1"))
        yield* host.start("t-2" as TicketId, session("t-2"))
        return yield* Fiber.join(both)
      }),
    )
    expect(shown).toEqual(
      new Map([
        ["t-1", WorkerState.Starting()],
        ["t-2", WorkerState.Starting()],
      ]),
    )
  })

  test("an ended worker leaves the states, and is shown again once started again", async () => {
    const seen = await run(
      { "t-1": [[wait], [wait]] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const states = yield* workerStates
        const started = yield* first(states, (all) => all.has("t-1"))
        yield* host.start("t-1" as TicketId, session("t-1"))
        const before = yield* Fiber.join(started)
        const gone = yield* first(states, (all) => !all.has("t-1"))
        yield* host.end("t-1" as TicketId)
        const after = yield* Fiber.join(gone)
        const again = yield* first(states, (all) => all.has("t-1"))
        yield* host.start("t-1" as TicketId, session("t-1", "s-2"))
        return { before, after, again: yield* Fiber.join(again) }
      }),
    )
    expect(seen.before?.get("t-1")).toEqual(WorkerState.Starting())
    expect(seen.after?.size).toBe(0)
    expect(seen.again?.get("t-1")).toEqual(WorkerState.Starting())
  })
})
