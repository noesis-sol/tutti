// Sessions that can't start (§ 4.8), outside the live tests: AgentHost's live layer, over the Agent
// SDK, with no real Claude Code. A Claude Code whose spawn fails is AgentStartFailed with the reason
// `Claude Code couldn't be launched`, not the SDK's libc wording, and its worker Gone with the same
// reason, and closing the host doesn't wait out closeLimit for the process that never started; a
// session whose folder isn't there is AgentStartFailed with `its folder isn't there: <path>`,
// Claude Code never spawned. Through the
// run's start and resume, the first sets the ticket aside (START_FAILED) and the second fails the
// resume with the folder's reason.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { Cause } from "../src/run/phase.ts"
import { resume } from "../src/run/sessions.ts"
import { start } from "../src/run/start.ts"
import { Store } from "../src/services/Store.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { allowAll, layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { backlog, expectLog, scenario } from "./harness.ts"

// The SDK spawns (or fails to spawn) a process for each start: bun's 5 s default fails them when
// other checks run beside this one.
setDefaultTimeout(30_000)

const launchFailed = "Claude Code couldn't be launched"

/** A new folder, its real path. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-spawn-failure-${name}-`)))

/**
 * A Claude Code that is there but can't be launched: an executable whose interpreter is missing,
 * so its spawn fails ENOENT, which the SDK words as a libc mismatch.
 */
const unlaunchable = () => {
  const dir = folder("claude")
  const claude = join(dir, "claude")
  writeFileSync(claude, `#!${join(dir, "no-such-interpreter")}\n`)
  chmodSync(claude, 0o755)
  return claude
}

/** The fake Claude Code (test/fixtures/fake-claude/claude.ts), which logs each start to `log`. */
const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** The live host's options: the worker setup, and the fake's scenario logging to `log`. */
const hostOptions = (log: string) => ({
  prompt: { text: "Work on TICKET_ID.", file: null },
  servers: { servers: [], note: noServersNote },
  account: { billing: { _tag: "Subscription", keyUnused: false } as const, subscription: true },
  env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify({ log }) },
})

/** How long, in real time, a test's host may take to close. */
const promptly = 5_000

/**
 * `run`, which must end within `promptly`. Under TestClock time moves only when a test moves it,
 * so a close that waited out closeLimit for a Claude Code that never started would never end.
 */
const closesPromptly = <A>(run: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the host didn't close within ${promptly} ms`)),
      promptly,
    )
  })
  return Promise.race([run, late]).finally(() => clearTimeout(timer))
}

/** Runs `effect` with the live host, its Claude Code `claude`, in a fresh folder, under TestClock. */
const withHost = <A, E>(
  claude: string,
  effect: (where: { dir: string; log: string }) => Effect.Effect<A, E, AgentHost>,
): Promise<A> => {
  const dir = folder("work")
  const log = join(dir, "fake.jsonl")
  const host = liveLayer(hostOptions(log)).pipe(
    Layer.provideMerge(
      Layer.mergeAll(attentionLayer(allowAll), transcriptsLayer(), ClaudeCode.layer),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        logLayer(),
        eventsLayer(),
        configLayer(appConfig({ claude }, dir)),
        BunServices.layer,
      ),
    ),
  )
  return closesPromptly(
    Effect.runPromise(
      effect({ dir, log }).pipe(Effect.provide(host), Effect.provide(TestClock.layer())),
    ),
  )
}

/** The AgentStartFailed an exit failed with. */
const startFailedOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("it started")
  const [reason] = exit.cause.reasons
  if (reason?._tag !== "Fail") throw new Error(`it failed otherwise: ${exit.cause}`)
  return reason.error as { readonly _tag: string; readonly reason: string }
}

describe("a failed spawn", () => {
  test("a Claude Code that can't be launched fails the start: Claude Code couldn't be launched, the worker Gone with it", async () => {
    const claude = unlaunchable()
    const { exit, state } = await withHost(claude, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const exit = yield* Effect.exit(
          host.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir }),
        )
        return { exit, state: yield* host.current("t-1") }
      }),
    )
    const failed = startFailedOf(exit)
    expect(failed).toMatchObject({ _tag: "AgentStartFailed", ticket: "t-1", reason: launchFailed })
    // Not the SDK's message, which blames the binary's libc.
    expect(failed).not.toHaveProperty("startupFailureReason")
    expect(failed.reason).not.toContain("libc")
    // The worker's Gone has the same reason: the stream's failure, which the SDK words as a libc
    // mismatch too, is seen first.
    expect(state).toEqual({ _tag: "Gone", why: launchFailed })
  })

  test("closing the host doesn't wait out closeLimit for a Claude Code that never started", async () => {
    const claude = unlaunchable()
    const began = Date.now()
    const exit = await withHost(claude, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        return yield* Effect.exit(
          host.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir }),
        )
      }),
    )
    expect(startFailedOf(exit)).toMatchObject({ reason: launchFailed })
    // withHost runs under TestClock, which no one moves: a close waiting out closeLimit never ends.
    expect(Date.now() - began).toBeLessThan(promptly)
  })

  test("the run's start sets the ticket aside: START_FAILED, its worker didn't start: Claude Code couldn't be launched", async () => {
    const root = folder("worktrees")
    const claude = unlaunchable()
    const ran = await closesPromptly(
      scenario(
        {
          config: { claude },
          backlog: backlog().ticket("t-1", { title: "One ticket" }).seeds,
          worktrees: { root },
        },
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.transition("t-1", Cause.Ready(), { title: "One ticket" })
          yield* ledger.transition("t-1", Cause.Dispatched())
          const started = yield* start({ id: "t-1", title: "One ticket", metadata: {} }, "main")
          return {
            started,
            phase: (yield* ledger.current).tickets.get("t-1")?.phase,
            record: yield* (yield* Store).ticket("t-1"),
          }
        }).pipe(
          Effect.provide(
            Layer.merge(
              Ledger.layer,
              liveLayer(hostOptions(join(root, "fake.jsonl"))).pipe(
                Layer.provide(ClaudeCode.layer),
              ),
            ),
          ),
        ),
      ),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the start failed: ${ran.exit.cause}`)
    const { started, phase, record } = ran.exit.value
    expect(started).toMatchObject({ _tag: "SetAside", why: "its worker didn't start" })
    expect(phase).toMatchObject({ _tag: "Deferred", why: "its worker didn't start" })
    // Nothing of it to resume: the next start draws a new session.
    expect(record?.session).toBeUndefined()
    const path = join(root, "t-1")
    expectLog(ran, [
      `  START_FAILED: t-1's worker didn't start: ${launchFailed} -> deferred; worktree ${path} left as it is`,
    ])
    const issue = ran.issues.find((each) => each.id === "t-1")
    expect(issue?.status).toBe("deferred")
    expect(issue?.notes).toContain(`tutti: t-1's worker didn't start (${launchFailed})`)
  })
})

describe("a session whose folder isn't there", () => {
  test("a start or a resume fails: its folder isn't there, with its path, and Claude Code isn't spawned", async () => {
    const { started, resumed, missing, log } = await withHost(fake, ({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const missing = join(dir, "gone")
        const started = yield* Effect.exit(
          host.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: missing }),
        )
        const resumed = yield* Effect.exit(
          host.resume(
            "t-2",
            { sessionId: "22222222-2222-4222-8222-222222222222", cwd: missing },
            { text: "Carry on.", from: "clientComposed" },
          ),
        )
        return { started, resumed, missing, log }
      }),
    )
    const reason = `its folder isn't there: ${missing}`
    expect(startFailedOf(started)).toMatchObject({
      _tag: "AgentStartFailed",
      ticket: "t-1",
      reason,
    })
    expect(startFailedOf(resumed)).toMatchObject({
      _tag: "AgentStartFailed",
      ticket: "t-2",
      reason,
    })
    // The fake logs its arguments as it starts: it never did.
    expect(existsSync(log)).toBe(false)
  })

  test("the run's resume of a session whose worktree is gone fails with its folder isn't there", async () => {
    const root = folder("worktrees")
    const log = join(root, "fake.jsonl")
    const worktree = join(root, "t-1")
    const ran = await scenario(
      { config: { claude: fake }, backlog: backlog().ticket("t-1").seeds, worktrees: { root } },
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveSession("t-1", {
          session: "11111111-1111-4111-8111-111111111111",
          worktree,
          branch: "tutti/t-1",
        })
        return yield* Effect.exit(
          resume("t-1", "suspended", "Carry on.", line`t-1 was suspended as the last run ended`),
        )
      }).pipe(Effect.provide(liveLayer(hostOptions(log)).pipe(Layer.provide(ClaudeCode.layer)))),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const failed = startFailedOf(ran.exit.value)
    expect(failed).toMatchObject({
      _tag: "ResumeFailed",
      ticket: "t-1",
      reason: `its folder isn't there: ${worktree}`,
    })
    expect(String((failed as unknown as Error).message)).toBe(
      `t-1's session could not be resumed: its folder isn't there: ${worktree}`,
    )
    expect(ran.log.some((text) => text.includes("RESUMED"))).toBe(false)
    expect(existsSync(log)).toBe(false)
  })
})
