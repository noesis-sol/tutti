// A Claude Code process tutti spawns for the SDK, kept one way (src/agent/sessionProcess.ts): its
// stderr's end kept for the reason its session failed (tutti-7l57), its exit waited for once its
// session is closed, its group killed when the exit doesn't come in time or at once when asked.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer, Option, Schedule, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { startProbe } from "../src/agent/Account.ts"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { endedWhy, layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServers } from "../src/agent/mcp.ts"
import { withSessionProcess, withStderr } from "../src/agent/sessionProcess.ts"
import { UsageProbe } from "../src/agent/UsageProbe.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { layer as organLayer } from "../src/organs/AgentSdkLanguageModel.ts"
import { processAlive } from "../src/services/processTree.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as costLayer } from "../src/testing/OrganCost.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

setDefaultTimeout(30_000)

/** A SessionProcess over sh running `script`, spawned as the SDK would, with what it got on stderr. */
const shell = (script: string) => {
  const received: Array<string> = []
  const { options, process } = withSessionProcess({
    stderr: (data: string) => received.push(data),
  } satisfies Options)
  const child = options.spawnClaudeCodeProcess?.({
    command: "/bin/sh",
    args: ["-c", script],
    cwd: "/",
    env: { PATH: testEnv.PATH },
    signal: new AbortController().signal,
  } satisfies SpawnOptions)
  return { process, child, received }
}

describe("withSessionProcess", () => {
  test("keeps the end of the stderr, still passing it on", async () => {
    const { process, received } = shell("echo one >&2; echo two >&2")
    await Effect.runPromise(process.exited)
    await Effect.runPromise(process.closeAndWait(() => {}, Duration.seconds(5)))
    expect(received.join("")).toBe("one\ntwo\n")
    expect(process.stderrTail()).toBe("one\ntwo")
    expect(process.stderrTail(4)).toBe("two")
  })

  test("closeAndWait closes the session and waits for its process to exit", async () => {
    const { process, child } = shell("cat > /dev/null; echo bye >&2")
    let closed = false
    await Effect.runPromise(
      process.closeAndWait(() => {
        closed = true
        child?.stdin.end()
      }, Duration.seconds(5)),
    )
    expect(closed).toBe(true)
    expect(child?.exitCode).toBe(0)
    expect(process.stderrTail()).toBe("bye")
  })

  test("closeAndWait kills a process that doesn't exit in time", async () => {
    const { process, child } = shell("trap '' TERM; while :; do sleep 1; done")
    const pid = process.child()?.pid as number
    await Effect.runPromise(process.closeAndWait(() => {}, Duration.millis(200)))
    await Effect.runPromise(process.exited)
    expect(child?.signalCode).toBe("SIGKILL")
    expect(processAlive(pid)).toBe(false)
  })

  test("kill ends it at once", async () => {
    const { process, child } = shell("while :; do sleep 1; done")
    await Effect.runPromise(process.kill)
    await Effect.runPromise(process.exited)
    expect(child?.signalCode).toBe("SIGKILL")
  })

  test("never spawned: closing only closes, and there is no stderr", async () => {
    const { process } = withSessionProcess({})
    let closed = false
    await Effect.runPromise(
      process.closeAndWait(() => {
        closed = true
      }, Duration.seconds(1)),
    )
    await Effect.runPromise(process.kill)
    expect(closed).toBe(true)
    expect(process.child()).toBeUndefined()
    expect(process.stderrTail()).toBe("")
  })
})

describe("withStderr", () => {
  test("adds the stderr on one line, when there is any", () => {
    expect(withStderr("exited with code 1", "")).toBe("exited with code 1")
    expect(withStderr("exited with code 1", "No conversation\n  found")).toBe(
      "exited with code 1: No conversation found",
    )
  })
})

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** A fresh folder, and the fake Claude Code's environment playing `scenario`, logging there. */
const fakeWith = (scenario: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-session-process-"))
  const log = join(dir, "fake.jsonl")
  const env = { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify({ ...scenario, log }) }
  return { dir, log, env, config: appConfig({ claude: fake, settings: defaultSettings }, dir) }
}

/** The PID of the first Claude Code the fake's log says started. */
const firstPid = (log: string): number | undefined => {
  if (!existsSync(log)) return undefined
  const started = readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { args?: unknown; pid?: number })
    .find((e) => e.args !== undefined)
  return started?.pid
}

/** Succeeds once the fake's log says it started. */
const fakeStarted = (log: string) =>
  Effect.suspend(() => (firstPid(log) === undefined ? Effect.fail("not yet") : Effect.void)).pipe(
    Effect.retry(Schedule.spaced(Duration.millis(20))),
  )

/** Runs `effect` with the live AgentHost over the fake playing `scenario`. */
const withHost = <A, E>(
  scenario: Record<string, unknown>,
  effect: (dir: string) => Effect.Effect<A, E, AgentHost>,
) => {
  const { dir, env, config } = fakeWith(scenario)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: noServers,
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env,
  })
  return Effect.runPromiseExit(
    effect(dir).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
          ),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

const sessionIn = (dir: string) => ({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })

/** The typed failure `exit` must be. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

describe("what Claude Code last wrote to stderr, in the reason its session failed", () => {
  test("a worker whose Claude Code exits mid-turn is Gone saying it", async () => {
    const exit = await withHost(
      { turns: [[{ stderr: "Error: the transcript is missing\n" }, { exit: 1 }]] },
      (dir) =>
        Effect.gen(function* () {
          const agents = yield* AgentHost
          yield* agents.start("t-1", sessionIn(dir))
          yield* agents.send("t-1", "go", "clientComposed")
          const found = yield* agents.state("t-1").pipe(
            Stream.filter((each) => each._tag === "Gone"),
            Stream.runHead,
            Effect.timeout(Duration.seconds(10)),
          )
          return Option.getOrThrow(found)
        }),
    )
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    const why = (exit.value as { why: string }).why
    expect(why.startsWith(endedWhy)).toBe(true)
    expect(why).toContain("Error: the transcript is missing")
  })

  test("a worker whose Claude Code exits as it starts fails its start saying it", async () => {
    const exit = await withHost(
      { stderrAtStart: "No conversation found with session ID 1111\n", exitAtStart: 1 },
      (dir) =>
        Effect.flatMap(Effect.service(AgentHost), (agents) => agents.start("t-1", sessionIn(dir))),
    )
    const error = failureOf(exit) as { _tag: string; reason: string }
    expect(error._tag).toBe("AgentStartFailed")
    expect(error.reason).toContain("No conversation found with session ID 1111")
  })

  test("a login probe whose Claude Code exits as it starts fails saying it", async () => {
    const { config, env } = fakeWith({ stderrAtStart: "Error: bad binary\n", exitAtStart: 1 })
    const exit = await Effect.runPromiseExit(
      startProbe({ config, env }).pipe(
        Effect.provide(ClaudeCode.layer.pipe(Layer.provide(configLayer(config)))),
      ),
    )
    const { reason } = failureOf(exit)
    expect(reason).toContain("exited with code 1")
    expect(reason).toContain("Error: bad binary")
  })
})

describe("an organ's or the usage probe's turn cut short", () => {
  test("an interrupted organ call returns once its Claude Code is gone", async () => {
    const { log, env, config } = fakeWith({ turns: [[{ hang: true }]], eofAfterTurn: true })
    let interruptedAt = Number.POSITIVE_INFINITY
    const exit = await Effect.runPromiseExit(
      LanguageModel.generateText({ prompt: "Hang." }).pipe(
        Effect.as("answered"),
        Effect.raceFirst(
          fakeStarted(log).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                interruptedAt = Date.now()
              }),
            ),
            Effect.as("interrupted"),
          ),
        ),
        Effect.provide(
          organLayer({ account: { subscription: true }, env }).pipe(
            Layer.provideMerge(ClaudeCode.layer),
            Layer.provideMerge(Layer.mergeAll(costLayer(), configLayer(config), BunServices.layer)),
          ),
        ),
      ),
    )
    expect(exit).toEqual(Exit.succeed("interrupted"))
    const pid = firstPid(log)
    expect(pid === undefined ? "never started" : processAlive(pid)).toBe(false)
    // Killed at once: not left to wait out the SDK's 2 s grace before its SIGTERM.
    expect(Date.now() - interruptedAt).toBeLessThan(1500)
  })

  test("an interrupted usage probe returns once its Claude Code is gone", async () => {
    const { log, env, config } = fakeWith({ turns: [[{ hang: true }]], eofAfterTurn: true })
    let interruptedAt = Number.POSITIVE_INFINITY
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Effect.service(UsageProbe), (usage) => usage.probe(null)).pipe(
        Effect.as("answered"),
        Effect.raceFirst(
          fakeStarted(log).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                interruptedAt = Date.now()
              }),
            ),
            Effect.as("interrupted"),
          ),
        ),
        Effect.provide(
          UsageProbe.layer({ account: { subscription: true }, env }).pipe(
            Layer.provideMerge(ClaudeCode.layer),
            Layer.provideMerge(Layer.mergeAll(costLayer(), configLayer(config), BunServices.layer)),
          ),
        ),
      ),
    )
    expect(exit).toEqual(Exit.succeed("interrupted"))
    const pid = firstPid(log)
    expect(pid === undefined ? "never started" : processAlive(pid)).toBe(false)
    // Killed at once: not left to wait out the SDK's 2 s grace before its SIGTERM.
    expect(Date.now() - interruptedAt).toBeLessThan(1500)
  })
})
