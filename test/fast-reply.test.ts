// A worker that answers a send at once (tutti-5zpb): a caller that waits on the answer subscribes
// to the worker's messages before the send (AgentHost.subscribe), in its own fiber, so a reply
// published before a forked stream would have subscribed isn't missed. A worker just started is the
// sharpest case: its script's fiber, forked by the start, takes the send and publishes its whole
// turn before any fiber forked after it has run.
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Layer, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { give, type HandBack } from "../src/run/handback.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { answers } from "../src/run/settle.ts"
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
  test("a subscription taken before the send sees every message of the turn it starts", async () => {
    const seen = await hosted(
      { [id]: [turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start(id, session)
        const heard = yield* host.subscribe(id)
        const uuid = yield* host.send(id, "go", "clientComposed")
        const fiber = yield* heard.pipe(
          Stream.takeUntil(({ message }) => answers(message, uuid)),
          Stream.map(({ message }): string => message.type),
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* quiet
        // Settled without the clock moving: nothing waited on a message already published.
        return fiber.pollUnsafe()
      }),
    )
    expect(seen).toBeDefined()
    expect(seen !== undefined && Exit.isSuccess(seen) ? seen.value : seen).toEqual([
      "command_lifecycle",
      "command_lifecycle",
      "system",
      "system",
      "result",
    ])
  })

  test("a subscription ends when the worker is ended, and fails for one the host doesn't know", async () => {
    const ended = await hosted(
      { [id]: [turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start(id, session)
        const heard = yield* host.subscribe(id)
        const fiber = yield* Effect.forkChild(Stream.runCollect(heard))
        yield* host.end(id)
        return yield* Fiber.join(fiber)
      }),
    )
    expect(ended).toEqual([])
    const gone = await hosted(
      {},
      Effect.gen(function* () {
        const host = yield* AgentHost
        return yield* Effect.flip(host.subscribe(id))
      }),
    )
    expect(gone._tag).toBe("AgentGone")
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
        return yield* give(handBack, Duration.minutes(30), {})
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
