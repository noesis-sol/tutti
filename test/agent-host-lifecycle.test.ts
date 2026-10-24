// A session's lifecycle in the live AgentHost (§ 4.8): a resume waits for the session's Claude Code
// still closing to exit, closing or ending a session while it starts cancels the start, and a
// worker folds only its session's events.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer, Option, Schedule, Stream } from "effect"
import { AgentHost, AgentStartFailed, makeWorkers } from "../src/agent/AgentHost.ts"
import { closedWhy, layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { read } from "../src/agent/reading.ts"
import { WorkerEvent, WorkerState } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

// Each test starts the fake Claude Code as a process, which lingers as it closes.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

const sessionId = "11111111-1111-4111-8111-111111111111"

/** The fake's log, a JSON object a line, in the order its processes wrote them. */
const entries = (file: string): ReadonlyArray<Record<string, unknown>> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : []

/** The PIDs of the fake's processes, in the order they started. */
const started = (file: string) =>
  entries(file).flatMap((e) => (e.args === undefined ? [] : [e.pid as number]))

/** Runs `effect` with the live host over the fake playing `scenario`, in a fresh folder. */
const run = <A, E>(
  scenario: Record<string, unknown>,
  effect: (where: { dir: string; log: string }) => Effect.Effect<A, E, AgentHost>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-host-lifecycle-"))
  const log = join(dir, "fake.jsonl")
  const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false } },
  })
  return Effect.runPromise(
    effect({ dir, log }).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(waitForTest),
              transcriptsLayer(),
              ClaudeCode.layer.pipe(
                Layer.provide(
                  workersIn({
                    ...testEnv,
                    FAKE_CLAUDE_SCENARIO: JSON.stringify({ ...scenario, log }),
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

/** Waits, at most 10 s, for the ticket's worker to reach a state `matches`. */
const until = (ticket: string, matches: (state: WorkerState) => boolean) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const found = yield* host.state(ticket).pipe(
      Stream.filter(matches),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die(`${ticket} never reached the state`),
      }),
    )
    return Option.getOrThrow(found)
  })

/** Waits, at most 10 s, until the fake's log has an entry `matches`. */
const logged = (file: string, matches: (entry: Record<string, unknown>) => boolean) =>
  Effect.sync(() => entries(file).some(matches)).pipe(
    Effect.repeat({ until: (found) => found, schedule: Schedule.spaced(Duration.millis(20)) }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(10),
      orElse: () => Effect.die(`the fake's log never showed it: ${readFileSync(file, "utf8")}`),
    }),
  )

/** Whether the process `pid` logged its exit before the process `after` started. */
const exitedBefore = (file: string, pid: number, after: number) => {
  const all = entries(file)
  const exited = all.findIndex((e) => e.exited === pid)
  const next = all.findIndex((e) => e.args !== undefined && e.pid === after)
  return exited !== -1 && next !== -1 && exited < next
}

describe("AgentHost live: a session's lifecycle", () => {
  test("a resume waits for the session gone without tutti closing it to exit", async () => {
    // A setup problem kills its Claude Code at once; a startup failure's result closes it as usual.
    const refused = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["refused"],
      num_turns: 0,
      startup_failure_reason: "refused",
    }
    const { state, pids, log } = await run(
      { turns: [[{ message: refused }]], lingerOnClose: 800 },
      ({ dir, log }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", { sessionId, cwd: dir })
          yield* host.send("t-1", { text: "go", from: "clientComposed" })
          const state = yield* until("t-1", (s) => s._tag === "Gone")
          // Its Claude Code is still winding down: the resume waits for it.
          yield* host.resume("t-1", { sessionId, cwd: dir }, { text: "on", from: "clientComposed" })
          return { state, pids: started(log), log }
        }),
    )
    expect(state).toEqual(WorkerState.Gone({ why: "refused" }))
    expect(pids).toHaveLength(2)
    expect(exitedBefore(log, pids[0] ?? 0, pids[1] ?? 0)).toBe(true)
  })

  test("a resume waits for the session being closed to exit", async () => {
    const { closed, pids, log } = await run({ lingerOnClose: 800 }, ({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", { sessionId, cwd: dir })
        yield* host.send("t-1", { text: "go", from: "clientComposed" })
        yield* until("t-1", (s) => s._tag === "Idle")
        const closing = yield* Effect.forkChild(host.close("t-1"))
        const closed = yield* until("t-1", (s) => s._tag === "Closed")
        yield* host.resume("t-1", { sessionId, cwd: dir }, { text: "on", from: "clientComposed" })
        yield* Fiber.join(closing)
        return { closed, pids: started(log), log }
      }),
    )
    expect(closed).toEqual(WorkerState.Closed())
    expect(pids).toHaveLength(2)
    expect(exitedBefore(log, pids[0] ?? 0, pids[1] ?? 0)).toBe(true)
  })

  test("close while the session starts cancels the start and closes Claude Code", async () => {
    const { exit, state, waited, sent } = await run({ initializeLag: 20_000 }, ({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const starting = yield* Effect.forkChild(host.start("t-1", { sessionId, cwd: dir }))
        yield* logged(log, (e) => e.args !== undefined)
        const from = Date.now()
        yield* host.close("t-1")
        const exit = yield* Fiber.await(starting)
        const waited = Date.now() - from
        // Closed, its stdin has ended.
        yield* logged(log, (e) => e.closed === true)
        const sent = yield* Effect.exit(host.send("t-1", { text: "lost", from: "clientComposed" }))
        return { exit, state: yield* host.current("t-1"), waited, sent }
      }),
    )
    expect(Exit.findErrorOption(exit)).toEqual(
      Option.some(new AgentStartFailed({ ticket: "t-1", reason: closedWhy })),
    )
    expect(state).toEqual(WorkerState.Closed())
    expect(waited).toBeLessThan(10_000)
    expect(Exit.isFailure(sent)).toBe(true)
  })

  test("end while the session starts cancels the start and forgets the worker", async () => {
    const { exit, known, again } = await run({ initializeLag: 20_000 }, ({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const starting = yield* Effect.forkChild(host.start("t-1", { sessionId, cwd: dir }))
        yield* logged(log, (e) => e.args !== undefined)
        yield* host.end("t-1")
        const exit = yield* Fiber.await(starting)
        const known = yield* Effect.exit(host.current("t-1"))
        // The ticket has no session left: a start is free to go.
        const again = yield* Effect.forkChild(host.start("t-1", { sessionId, cwd: dir }))
        yield* logged(log, (e) => e.args !== undefined && started(log).length === 2)
        yield* host.close("t-1")
        return { exit, known, again: yield* Fiber.await(again) }
      }),
    )
    expect(Exit.findErrorOption(exit)).toEqual(
      Option.some(new AgentStartFailed({ ticket: "t-1", reason: closedWhy })),
    )
    expect(Exit.isFailure(known)).toBe(true)
    expect(Exit.findErrorOption(again)).toEqual(
      Option.some(new AgentStartFailed({ ticket: "t-1", reason: closedWhy })),
    )
  })
})

describe("makeWorkers: events of an earlier session", () => {
  test("are dropped: only the worker's session now is folded", async () => {
    const init = {
      type: "system",
      subtype: "init",
      session_id: "b",
      permissionMode: "default",
    } as unknown as SDKMessage
    const states = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* makeWorkers()
          const first = yield* workers.open("t-1", "a", false)
          yield* workers.fold(first, WorkerEvent.Closed({ session: "a" }))
          const closed = yield* workers.current("t-1")
          const entry = yield* workers.open("t-1", "b", false)
          // The first session's last words, after the second has started.
          yield* workers.fold(entry, WorkerEvent.Ended({ session: "a", why: "late" }))
          yield* workers.fold(entry, WorkerEvent.Sent({ session: "a", uuid: "u-1" }))
          const starting = yield* workers.current("t-1")
          yield* workers.fold(entry, WorkerEvent.Message({ session: "b", reading: read(init) }))
          yield* workers.fold(entry, WorkerEvent.Sent({ session: "b", uuid: "u-2" }))
          return { closed, starting, working: yield* workers.current("t-1") }
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
        Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
      ),
    )
    expect(states.closed).toEqual(WorkerState.Closed())
    expect(states.starting).toEqual(WorkerState.Starting())
    expect(states.working._tag).toBe("Working")
  })
})
