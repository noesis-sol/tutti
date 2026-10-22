// An interrupt has a time limit (§ 4.8): the live AgentHost's interrupt and the cancel_async_message
// requests after it are SDK control requests with no timer of their own, so a Claude Code alive but
// not answering them would hold whoever interrupts it, the hand-back's time limit, steering or a
// quit. Past the limit the session is aborted and closed and its worker is gone. Over the fake
// Claude Code (test/fixtures/fake-claude/claude.ts), whose control requests go unanswered.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Schedule, Stream } from "effect"
import { AgentGone, AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer, unansweredWhy } from "../src/agent/AgentHostLive.ts"
import type { Attention } from "../src/agent/Attention.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import type { WorkerState } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { interrupt } from "../src/run/steer.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

type Env = AgentHost | Attention | Transcripts | Ledger | Log | EventStream

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** The interrupt's time limit in these tests. */
const limit = Duration.millis(500)

/** Waits, at most 10 s, for the ticket's worker to reach a state with `tag`; the last state. */
const reaches = (ticket: string, tag: WorkerState["_tag"]) =>
  Effect.flatMap(AgentHost, (host) =>
    host.state(ticket).pipe(
      Stream.takeUntil((s) => s._tag === tag),
      Stream.runCollect,
      Effect.map((states) => states.at(-1)),
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die(`${ticket} never reached ${tag}`),
      }),
    ),
  )

/** Runs `effect` with the live host over the fake, playing `scenario`, in a fresh folder. */
const overFake = <A, E>(
  scenario: Record<string, unknown>,
  effect: (dir: string) => Effect.Effect<A, E, Env>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-interrupt-limit-"))
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env: {
      ...testEnv,
      FAKE_CLAUDE_SCENARIO: JSON.stringify({ ...scenario, log: join(dir, "fake.jsonl") }),
    },
    interruptLimit: limit,
  })
  return Effect.runPromise(
    effect(dir).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(
            Layer.mergeAll(
              ledgerLayer(),
              configLayer(appConfig({ claude: fake, settings: defaultSettings }, dir)),
              BunServices.layer,
            ),
          ),
        ),
      ),
    ),
  )
}

/** A CLI with interrupt receipts and without interrupt_cancel_queued_v1, as `--claude` may be. */
const noCancelQueued = { init: { capabilities: ["interrupt_receipt_v1"] } }

/** Waits, at most 10 s, until the fake has read `n` user messages. */
const fakeRead = (file: string, n: number) =>
  Effect.sync(() =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.includes('"type":"user"')).length
      : 0,
  ).pipe(
    Effect.repeat({ until: (k) => k >= n, schedule: Schedule.spaced(Duration.millis(20)) }),
    Effect.timeout(Duration.seconds(10)),
  )

/** Starts t-1 over the fake in a hanging turn, with `queued` of your messages behind it. */
const working = (dir: string, queued: number) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* host.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
    yield* host.send("t-1", "Go.", "clientComposed")
    yield* reaches("t-1", "Working")
    for (let i = 0; i < queued; i++) yield* host.send("t-1", `And ${i}.`, "human")
    yield* fakeRead(join(dir, "fake.jsonl"), 1 + queued)
    return host
  })

/**
 * Interrupts t-1 with `by`: what it gave, how long it took, the worker's state after, whether its
 * session's close ended within 10 s, and the processes left.
 */
const interruptWedged = <A, E>(dir: string, queued: number, by: Effect.Effect<A, E, Env>) =>
  Effect.gen(function* () {
    const host = yield* working(dir, queued)
    const started = Date.now()
    const given = yield* Effect.result(by)
    const took = Date.now() - started
    const state = yield* reaches("t-1", "Gone")
    const closed = yield* host.close("t-1").pipe(Effect.timeoutOption(Duration.seconds(10)))
    return {
      given,
      took,
      state,
      closed: closed._tag === "Some",
      processes: [...(yield* host.processes).keys()],
      log: yield* texts,
    }
  })

const why = unansweredWhy(limit)

describe("the live AgentHost: an interrupt Claude Code doesn't answer", () => {
  test("ends at its time limit, AgentGone; the session closes and the worker is gone", async () => {
    const done = await overFake({ turns: [[{ hang: true }]], interrupt: "unanswered" }, (dir) =>
      interruptWedged(
        dir,
        0,
        Effect.flatMap(AgentHost, (host) => host.interrupt("t-1")),
      ),
    )
    expect(done.given._tag).toBe("Failure")
    if (done.given._tag === "Failure") {
      expect(done.given.failure).toBeInstanceOf(AgentGone)
      expect(done.given.failure).toMatchObject({ ticket: "t-1", why })
    }
    expect(done.took).toBeGreaterThanOrEqual(400)
    expect(done.took).toBeLessThan(5000)
    expect(done.state).toEqual({ _tag: "Gone", why })
    expect(done.closed).toBe(true)
    expect(done.processes).toEqual([])
    expect(done.log.some((l) => l.includes(`t-1: ${why}`))).toBe(true)
  })

  test("a cancel_async_message it doesn't answer counts toward the same limit", async () => {
    const done = await overFake(
      { ...noCancelQueued, turns: [[{ hang: true }]], cancelAsync: "unanswered" },
      (dir) =>
        interruptWedged(
          dir,
          2,
          Effect.flatMap(AgentHost, (host) => host.interrupt("t-1")),
        ),
    )
    expect(done.given._tag).toBe("Failure")
    if (done.given._tag === "Failure") expect(done.given.failure).toMatchObject({ why })
    expect(done.took).toBeLessThan(5000)
    expect(done.state).toEqual({ _tag: "Gone", why })
    expect(done.closed).toBe(true)
  })

  test("steering's interrupt doesn't hang on it: it answers false", async () => {
    const done = await overFake({ turns: [[{ hang: true }]], interrupt: "unanswered" }, (dir) =>
      interruptWedged(dir, 0, interrupt("t-1")),
    )
    expect(done.given).toMatchObject({ _tag: "Success", success: false })
    expect(done.took).toBeLessThan(5000)
    expect(done.state).toEqual({ _tag: "Gone", why })
  })

  test("an interrupt it answers within the limit gives its receipt, the session open", async () => {
    const done = await overFake({ turns: [[{ hang: true }]] }, (dir) =>
      Effect.gen(function* () {
        const host = yield* working(dir, 0)
        const receipt = yield* host.interrupt("t-1")
        const state = yield* reaches("t-1", "Failed")
        return { receipt, state: state?._tag, processes: [...(yield* host.processes).keys()] }
      }),
    )
    expect(done.receipt).toEqual({ stillQueued: [], cancelled: [] })
    expect(done.state).toBe("Failed")
    expect(done.processes).toEqual(["t-1"])
  })
})
