import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Duration, Effect, Exit, Layer } from "effect"
import {
  AccountProbeFailed,
  type Initialization,
  type ProbeLimits,
  probeCloseLimit,
  probeTimeout,
  startProbeWith,
} from "../src/agent/Account.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"

// The login probe, startProbe in src/agent/Account.ts, over the Agent SDK's query() with the fake
// Claude Code (test/fixtures/fake-claude/claude.ts) in place of the real one. Each test starts the
// fake as a process, up to a second on an idle machine, more when other checks run beside it.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** A scenario for the fake Claude Code. */
interface Scenario {
  readonly initialize?: Record<string, unknown>
  readonly settings?: Record<string, unknown>
  readonly stderrAtStart?: string
  readonly exitAtStart?: number
  readonly initializeLag?: number
  readonly lingerOnClose?: number
  readonly descendant?: boolean
}

/** The live probe's limits, or shorter ones where a test waits them out. */
const live: ProbeLimits = { timeout: probeTimeout, closeLimit: probeCloseLimit }

/** Runs the probe over the fake playing `scenario` in a fresh checkout; with the fake's log. */
const probe = async (scenario: Scenario, limits: ProbeLimits = live) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-account-probe-"))
  const log = join(dir, "fake.jsonl")
  const env = { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify({ ...scenario, log }) }
  const config = appConfig({ claude: fake }, dir)
  const exit = await Effect.runPromiseExit(
    startProbeWith(limits)({ config, env }).pipe(
      Effect.scoped,
      Effect.provide(ClaudeCode.layer.pipe(Layer.provide(configLayer(config)))),
    ),
  )
  return { exit, entries: entries(log), log }
}

/** The fake's log: one entry a line. */
const entries = (file: string): Array<Record<string, unknown>> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : []

/** The probe's failure, which `exit` must be. */
const failure = (exit: Exit.Exit<Initialization, AccountProbeFailed>): AccountProbeFailed => {
  if (Exit.isSuccess(exit)) throw new Error(`the probe answered: ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error
  if (!(error instanceof AccountProbeFailed))
    throw new Error(`no AccountProbeFailed: ${exit.cause}`)
  return error
}

/** Whether the process `pid` is still there. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits, at most `ms`, until none of `pids` is there; the ones still there. */
const goneWithin = async (pids: ReadonlyArray<number>, ms: number) => {
  const until = Date.now() + ms
  while (pids.some(alive) && Date.now() < until) await Bun.sleep(20)
  return pids.filter(alive)
}

const untrusted =
  "Ignoring 1 permissions.allow entry from /work/.claude/settings.json: this workspace has not been trusted.\n"

describe("the login probe over the fake Claude Code", () => {
  test("reads the Initialization from initialize's answer, its settings and its stderr", async () => {
    const { exit, entries: logged } = await probe({
      initialize: {
        account: {
          email: "ada@example.com",
          organization: "Analytical Engines",
          subscriptionType: "Claude Max",
          apiProvider: "firstParty",
        },
        current_permission_mode: "acceptEdits",
      },
      settings: {
        errors: [{ file: "/work/.claude/settings.json", path: "hooks", message: "bad hooks" }],
      },
      stderrAtStart: untrusted,
    })
    expect(Exit.isSuccess(exit) ? exit.value : exit.cause).toEqual({
      account: {
        email: "ada@example.com",
        organization: "Analytical Engines",
        subscriptionType: "Claude Max",
        apiKeySource: null,
        apiProvider: "firstParty",
      },
      permissionMode: "acceptEdits",
      settingsErrors: [
        { file: "/work/.claude/settings.json", path: "hooks", message: "bad hooks" },
      ],
      untrustedFiles: ["/work/.claude/settings.json"],
    })
    // The session was closed once it had answered: its stdin ended, and it asked for the settings.
    expect(logged.some((e) => e.closed === true)).toBe(true)
    const requests = logged.flatMap((e) => {
      const stdin = e.stdin as { request?: { subtype?: string } } | undefined
      return stdin?.request?.subtype === undefined ? [] : [stdin.request.subtype]
    })
    expect(requests).toEqual(["initialize", "get_settings"])
  })

  test("a Claude Code that never answers fails 'no answer within' the timeout", async () => {
    const timeout = Duration.millis(500)
    const started = Date.now()
    const { exit, entries: logged } = await probe(
      { initializeLag: 60_000 },
      { timeout, closeLimit: probeCloseLimit },
    )
    expect(failure(exit).reason).toBe(`no answer within ${Duration.format(timeout)}`)
    // It was closed, and exited, rather than left waiting out its lag.
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(logged.some((e) => e.closed === true)).toBe(true)
    const pid = logged.find((e) => e.args !== undefined)?.pid as number
    expect(await goneWithin([pid], 2000)).toEqual([])
  })

  test("a Claude Code that won't exit once closed has its process group killed after the close limit", async () => {
    const started = Date.now()
    const {
      exit,
      entries: logged,
      log,
    } = await probe(
      { lingerOnClose: 60_000, descendant: true },
      { timeout: probeTimeout, closeLimit: Duration.millis(300) },
    )
    const took = Date.now() - started
    expect(Exit.isSuccess(exit)).toBe(true)
    const pid = logged.find((e) => e.args !== undefined)?.pid as number
    const descendant = logged.find((e) => e.descendant !== undefined)?.descendant as number
    expect(typeof pid).toBe("number")
    expect(typeof descendant).toBe("number")
    // Closed, it lingered; the probe killed it and the process it started, before the SDK's own
    // SIGKILL (7 s after the close) and long before it would have exited itself.
    expect(logged.some((e) => e.closed === true)).toBe(true)
    expect(took).toBeLessThan(6000)
    expect(await goneWithin([pid, descendant], 2000)).toEqual([])
    // Killed, not exited on its own.
    expect(entries(log).some((e) => e.exited !== undefined)).toBe(false)
  })

  test("a Claude Code that exits at once fails with the SDK's reason", async () => {
    const { exit } = await probe({ exitAtStart: 1 })
    const { reason } = failure(exit)
    expect(reason).toContain("exited with code 1")
  })
})
