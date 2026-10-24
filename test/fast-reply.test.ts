// A worker that answers a send at once (tutti-5zpb): a caller waits on the answer with
// AgentHost.answered, which reads the worker's state, where the send is outstanding from its push
// until the answer, so a reply that came before the wait began isn't missed. A worker just started
// is the sharpest case: its script's fiber, forked by the start, takes the send and plays its
// whole turn before any fiber forked after it has run.
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Layer, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { give, type HandBack } from "../src/run/handback.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { layer as hostLayer, type Script, turn } from "../src/testing/AgentHost.ts"
import { allowAll, layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { advance, backlog, type Env, scenario } from "./harness.ts"

const id = "t-1"
const session = { sessionId: "s-1", cwd: "/work/t-1" }

/** Runs `effect` with the scripted host playing `scripts`, under TestClock. */
const hosted = <A, E>(
  scripts: Readonly<Record<string, Script>>,
  effect: Effect.Effect<A, E, AgentHost | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(
        hostLayer(scripts).pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(allowAll), transcriptsLayer())),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** Lets every fiber run as far as it can without the clock moving. */
const quiet = Effect.gen(function* () {
  for (let i = 0; i < 2_000; i++) yield* Effect.yieldNow
})

describe("a reply that comes at once", () => {
  test("a wait begun once the send has returned sees its answer, however soon it came", async () => {
    const seen = await hosted(
      { [id]: [turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start(id, session)
        const uuid = yield* host.send(id, "go", "clientComposed")
        const fiber = yield* Effect.forkChild(host.answered(id, uuid))
        yield* quiet
        // Answered without the clock moving: nothing waited on a message already come.
        return fiber.pollUnsafe()
      }),
    )
    expect(seen !== undefined && Exit.isSuccess(seen)).toBe(true)
  })

  test("a wait ends when the worker is ended, and at once for one the host doesn't know", async () => {
    const ended = await hosted(
      { [id]: [turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start(id, session)
        yield* host.send(id, "go", "clientComposed")
        yield* host.state(id).pipe(
          Stream.filter((state) => state._tag === "Idle"),
          Stream.runHead,
        )
        // Its script's steps have run out: this send stays queued, outstanding.
        const uuid = yield* host.send(id, "again", "clientComposed")
        const fiber = yield* Effect.forkChild(host.answered(id, uuid))
        yield* quiet
        const before = fiber.pollUnsafe()
        yield* host.end(id)
        yield* Fiber.join(fiber)
        return before
      }),
    )
    expect(ended).toBeUndefined()
    await hosted(
      {},
      AgentHost.use((host) => host.answered(id, "u-1")),
    )
  })

  test("a hand-back the worker answers at once is taken, without waiting for its time limit", async () => {
    const handBack: HandBack = {
      ticket: { id, title: "One ticket", branch: `tutti/${id}`, worktree: session.cwd },
      mode: "resolving",
      prompt: "Resolve the conflicts.",
      what: line`its conflicts handed back`,
      onto: "main",
      to: "main",
      done: Effect.succeed(false),
    }
    const ran = await scenario(
      {
        backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
        scripts: () => ({ [id]: [turn([])] }),
      },
      Effect.gen(function* () {
        const host = yield* AgentHost
        // Past the time limit once every fiber has run as far as it can: a hand-back still waiting
        // for its answer then is ended late.
        yield* Effect.forkChild(Effect.andThen(quiet, advance(Duration.minutes(31))))
        // Just started, its state Starting: the hand-back is sent to its open session, and its
        // script's fiber, forked by the start, answers it before any fiber give forks has run.
        yield* host.start(id, session)
        return yield* give(handBack, Duration.minutes(30), { loaded: Effect.succeed(false) })
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
        string | undefined,
        unknown,
        Env | Scope.Scope
      >,
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    // Taken within its time limit, with nothing to say: the hand-back's turn is over.
    expect(ran.exit.value).toBeUndefined()
    const sent = ran.sent.flatMap((each) =>
      each._tag === "Message" && each.ticket === id ? [String(each.message.message.content)] : [],
    )
    expect(sent).toEqual([handBack.prompt])
  })
})
