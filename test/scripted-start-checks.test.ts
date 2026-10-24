// The scripted AgentHost reads a session's start and messages with the live host's code
// (sessionChecks.ts): a scripted initialize answer and the first system/init are checked as a run
// checks them, a setup problem ending the worker Gone with `setup` and logged; a result with a
// startup_failure_reason ends the worker; and a message tutti dies taking in is logged and skipped.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { permissionModeLine } from "../src/agent/Account.ts"
import { AgentHost } from "../src/agent/AgentHost.ts"
import type { Attention } from "../src/agent/Attention.ts"
import { missingProblem, notGivenProblem } from "../src/agent/mcp.ts"
import { apiKeyProblem, setupLine, skippedLine } from "../src/agent/sessionChecks.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import {
  emit,
  layer as hostLayer,
  init,
  initialize,
  type Options,
  Recording,
  result,
  type Script,
  sessionState,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

type Env = AgentHost | Recording | Attention | Transcripts | Files | Log | EventStream

/** Runs `effect` with the scripted host playing `scripts`, under TestClock. */
const run = <A, E>(
  scripts: Readonly<Record<string, Script>>,
  effect: Effect.Effect<A, E, Env>,
  options: Options = {},
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        hostLayer(scripts, options).pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

const session = (sessionId = "s-1") => ({ sessionId, cwd: "/work/t-1" })

/** Starts t-1, sends it a message and lets its script play: its state, the log and what it got. */
const startsAndSends = Effect.gen(function* () {
  const host = yield* AgentHost
  yield* host.start("t-1", session())
  yield* host.send("t-1", { text: "Go.", from: "clientComposed" })
  yield* TestClock.adjust("1 second")
  return {
    now: yield* host.current("t-1"),
    log: yield* texts,
    messages: (yield* (yield* Files).messages("t-1")).map(
      (item) => (item.message as unknown as Record<string, unknown>).type,
    ),
  }
})

describe("the scripted AgentHost: the first system/init", () => {
  test("listing a server the worker wasn't given ends it over a setup problem, logged", async () => {
    const listed = [{ name: "github", status: "connected", source: "user" }]
    const done = await run(
      { "t-1": [[wait, init({ mcp_servers: listed }), sessionState("running"), result()]] },
      startsAndSends,
    )
    const problem = notGivenProblem(["github"])
    expect(done.now).toEqual(WorkerState.Gone({ why: problem, setup: true }))
    expect(done.log).toContain(setupLine("t-1", problem))
    // Nothing after the check plays.
    expect(done.messages).not.toContain("result")
  })

  test("without a server the worker was given ends it over a setup problem", async () => {
    const servers = {
      servers: [{ name: "github", scope: "user" as const, definition: { command: "gh" } }],
      note: null,
    }
    const done = await run({ "t-1": [turn([])] }, startsAndSends, { servers })
    const problem = missingProblem(["github"])
    expect(done.now).toEqual(WorkerState.Gone({ why: problem, setup: true }))
    expect(done.log).toContain(setupLine("t-1", problem))
  })

  test("billing an API key beside the subscription login ends it over a setup problem", async () => {
    const keyed = [wait, init({ apiKeySource: "ANTHROPIC_API_KEY" }), result()]
    const done = await run({ "t-1": [keyed] }, startsAndSends)
    const problem = apiKeyProblem("ANTHROPIC_API_KEY")
    expect(done.now).toEqual(WorkerState.Gone({ why: problem, setup: true }))
    expect(done.log).toContain(setupLine("t-1", problem))
  })

  test("the same key is no problem when workers are billed to it", async () => {
    const keyed = [
      wait,
      init({ apiKeySource: "ANTHROPIC_API_KEY" }),
      result(),
      sessionState("idle"),
    ]
    const done = await run({ "t-1": [keyed] }, startsAndSends, { billing: { _tag: "ApiKey" } })
    expect(done.now._tag).toBe("Idle")
    expect(done.log).toEqual([])
  })

  test("another permission mode in effect is logged once in the run, not a problem", async () => {
    const other = turn([]).map((step, i) => (i === 1 ? init({ permissionMode: "default" }) : step))
    const done = await run(
      { "t-1": [other], "t-2": [other] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        for (const ticket of ["t-1", "t-2"]) {
          yield* host.start(ticket, { sessionId: `s-${ticket}`, cwd: `/work/${ticket}` })
          yield* host.send(ticket, { text: "Go.", from: "clientComposed" })
        }
        yield* TestClock.adjust("1 second")
        return {
          states: [yield* host.current("t-1"), yield* host.current("t-2")],
          log: yield* texts,
        }
      }),
    )
    expect(done.states.map((s) => s._tag)).toEqual(["Idle", "Idle"])
    expect(done.log).toEqual([permissionModeLine({ requested: "auto", inEffect: "default" })])
  })
})

describe("the scripted AgentHost: the initialize answer", () => {
  test("an account billing an API key stops the start: nothing sent, Gone with setup", async () => {
    const keyed = initialize({ account: { apiKeySource: "ANTHROPIC_API_KEY" } })
    const done = await run(
      { "t-1": [[keyed, ...turn([])]] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const uuid = yield* host.resume("t-1", session(), {
          text: "Go on.",
          from: "clientComposed",
        })
        return {
          uuid,
          now: yield* host.current("t-1"),
          log: yield* texts,
          sent: (yield* (yield* Recording).sentTo("t-1")).map((s) => s._tag),
        }
      }),
    )
    const problem = apiKeyProblem("ANTHROPIC_API_KEY")
    expect(done.uuid).toEqual(expect.any(String))
    expect(done.now).toEqual(WorkerState.Gone({ why: problem, setup: true }))
    expect(done.log).toEqual([setupLine("t-1", problem)])
    expect(done.sent).toEqual(["Resumed"])
  })

  test("a status listing a server the worker wasn't given stops the start", async () => {
    const status = [{ name: "github", status: "connected", source: "user" }]
    const done = await run(
      { "t-1": [[initialize({}, status), ...turn([])]] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session())
        return { now: yield* host.current("t-1"), log: yield* texts }
      }),
    )
    const problem = notGivenProblem(["github"])
    expect(done.now).toEqual(WorkerState.Gone({ why: problem, setup: true }))
    expect(done.log).toEqual([setupLine("t-1", problem)])
  })

  test("one that shows no problem lets the session play", async () => {
    const done = await run(
      { "t-1": [[initialize({ account: { apiKeySource: "none" } }, []), ...turn([])]] },
      startsAndSends,
    )
    expect(done.now._tag).toBe("Idle")
    expect(done.log).toEqual([])
  })
})

describe("the scripted AgentHost: what a session sends", () => {
  test("a result with a startup_failure_reason ends the worker Gone", async () => {
    const refused = emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [],
      num_turns: 0,
      startup_failure_reason: "cwd_unavailable",
    })
    const done = await run({ "t-1": [[wait, refused, sessionState("idle")]] }, startsAndSends)
    expect(done.now).toEqual(WorkerState.Gone({ why: "cwd_unavailable" }))
  })

  test("a message tutti dies taking in is logged and skipped, and the session plays on", async () => {
    const broken = new Error("no shape tutti knows")
    const unreadable = emit({
      get type(): string {
        throw broken
      },
    })
    const done = await run({ "t-1": [[wait, init(), unreadable, result()]] }, startsAndSends)
    expect(done.log).toEqual([skippedLine("t-1", broken)])
    expect(done.messages).toContain("result")
    expect(done.now._tag).not.toBe("Gone")
  })
})
