// A session whose Claude Code never answers its initialize within startLimit, as on a machine short
// of memory (AgentHostLive's make, sessions.ts' resume): AgentStartFailed says so, transient, a
// failure that may pass. Through the run's resume of a worker gone, it is tried once more
// resumeRetry later, and failing again its ticket is left for review with its record kept in
// state.json, suspended, for a later run to resume. AgentHost's live layer, over the fake Claude
// Code (test/fixtures/fake-claude/claude.ts), whose initialize answer waits longer than any test.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer, startLimit } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import { resumeFailedWhy, resumeGone, resumeRetry, workerGone } from "../src/run/sessions.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Store } from "../src/services/Store.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { allowAll, layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { backlog, expectLog, scenario } from "./harness.ts"
import { workersIn } from "./workerEnv.ts"

// Each start spawns the fake as a process, and closing it waits for it to exit.
setDefaultTimeout(60_000)

const id = "t-1" as TicketId
const sessionId = "11111111-1111-4111-8111-111111111111"
const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")
const unanswered = `no answer within ${Duration.format(startLimit)}`

/** A new folder, its real path. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-initialize-timeout-${name}-`)))

/** The live host over the fake, logging to `log`, answering its initialize 10 minutes late. */
const hostOver = (log: string) =>
  liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false } },
  }).pipe(
    Layer.provideMerge(
      ClaudeCode.layer.pipe(
        Layer.provide(
          workersIn({
            ...testEnv,
            FAKE_CLAUDE_SCENARIO: JSON.stringify({ log, initializeLag: 600_000 }),
          }),
        ),
      ),
    ),
  )

/**
 * Runs `effect` in a fiber, moving TestClock on 10 s every 20 ms of real time until it is done: the
 * fake's spawns and exits take real time, the limits waited out TestClock's.
 */
const advancing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    const until = Date.now() + 45_000
    while (fiber.pollUnsafe() === undefined && Date.now() < until) {
      yield* Effect.promise(() => Bun.sleep(20))
      yield* TestClock.adjust(Duration.seconds(10))
    }
    return yield* Fiber.join(fiber)
  })

/** The error an exit failed with. */
const errorOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("it started")
  const [reason] = exit.cause.reasons
  if (reason?._tag !== "Fail") throw new Error(`it failed otherwise: ${exit.cause}`)
  return reason.error
}

describe("a session that gets no initialize answer within startLimit", () => {
  test("fails its resume with AgentStartFailed, transient: a failure that may pass", async () => {
    const dir = folder("work")
    const host = hostOver(join(dir, "fake.jsonl")).pipe(
      Layer.provideMerge(Layer.mergeAll(attentionLayer(allowAll), transcriptsLayer())),
      Layer.provideMerge(
        Layer.mergeAll(
          logLayer(),
          eventsLayer(),
          configLayer(appConfig({ claude: fake }, dir)),
          BunServices.layer,
        ),
      ),
    )
    const { exit, state } = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* AgentHost
        const exit = yield* advancing(
          Effect.exit(
            agents.resume(
              id,
              { sessionId, cwd: dir },
              { text: "Carry on.", from: "clientComposed" },
            ),
          ),
        )
        return { exit, state: yield* agents.current(id) }
      }).pipe(Effect.provide(host), Effect.provide(TestClock.layer())),
    )
    const failed = errorOf(exit)
    expect(failed).toMatchObject({ _tag: "AgentStartFailed", ticket: id, transient: true })
    expect(failed).not.toHaveProperty("startupFailureReason")
    expect((failed as { reason: string }).reason).toContain(unanswered)
    expect(state).toMatchObject({ _tag: "Gone" })
  })

  test("the run's resume tries it once more, then leaves the ticket for review, its record kept, suspended", async () => {
    const root = folder("worktrees")
    const worktree = join(root, id)
    mkdirSync(worktree)
    const ran = await scenario(
      {
        config: { claude: fake },
        backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
        worktrees: { root },
      },
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveSession(id, { session: sessionId, worktree, branch: `tutti/${id}` })
        const ledger = yield* Ledger
        yield* ledger.transition(id, Move.Ready(), { title: "One ticket" })
        yield* ledger.transition(id, Move.Dispatched())
        const back = yield* advancing(resumeGone(id, "exit 1"))
        if (back._tag !== "Failed") return { back, record: undefined }
        yield* workerGone({ ticket: id, worktree, why: back.reason, transient: back.transient })
        return { back, record: yield* store.ticket(id) }
      }).pipe(Effect.provide(Layer.merge(Ledger.layer, hostOver(join(root, "fake.jsonl"))))),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const { back, record } = ran.exit.value
    expect(back).toEqual(expect.objectContaining({ _tag: "Failed", transient: true }))
    expect(back._tag === "Failed" && back.reason).toContain(unanswered)
    expect(record).toEqual(
      expect.objectContaining({ session: sessionId, suspended: resumeFailedWhy, phase: "Review" }),
    )
    expectLog(ran, [
      new RegExp(
        `^ {2}t-1's session ${sessionId} could not be resumed \\(.*${unanswered}.*\\); trying again in ${Duration.format(resumeRetry)}$`,
      ),
      /^ {2}WORKER_GONE: t-1 is in progress, but its worker is gone and its session could not be resumed \(.*no answer within.*\); worktree .* left for review, no longer followed; its session is kept, and the next run resumes it; or finish it by hand$/,
    ])
  })
})
