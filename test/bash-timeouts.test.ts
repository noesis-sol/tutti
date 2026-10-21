// A worker's checks get their time in the foreground (tutti-kkb.11): Claude Code's Bash moves a
// command to the background after 2 minutes unless given a longer timeout, so tutti sets Bash's
// default timeout to the merge check's time limit and its maximum to that or 10 minutes, whichever
// is longer, and the worker prompt says to pass Bash no timeout of its own.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Schedule } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { bashTimeouts, probeEnv, workerEnv, workerVariables } from "../src/agent/env.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

// The live host's test starts the fake Claude Code as a process: up to a second on an idle machine.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

const timeoutVariables = ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"] as const

describe("Bash's timeouts", () => {
  test("the default is the merge check's limit, the maximum the same when it is over 10 minutes", () => {
    expect(bashTimeouts(Duration.minutes(30))).toEqual({
      BASH_DEFAULT_TIMEOUT_MS: "1800000",
      BASH_MAX_TIMEOUT_MS: "1800000",
    })
  })

  test("the maximum stays Bash's 10 minutes for a shorter check", () => {
    expect(bashTimeouts(Duration.minutes(5))).toEqual({
      BASH_DEFAULT_TIMEOUT_MS: "300000",
      BASH_MAX_TIMEOUT_MS: "600000",
    })
    expect(bashTimeouts(Duration.minutes(10))).toEqual({
      BASH_DEFAULT_TIMEOUT_MS: "600000",
      BASH_MAX_TIMEOUT_MS: "600000",
    })
  })

  test("a limit in part of a millisecond is rounded up to whole ones", () => {
    expect(bashTimeouts(Duration.nanos(1_500_000n)).BASH_DEFAULT_TIMEOUT_MS).toBe("2")
  })

  test("workerVariables sets them only given the check's limit", () => {
    expect(workerVariables("1.2.3", Duration.minutes(45))).toMatchObject({
      BASH_DEFAULT_TIMEOUT_MS: "2700000",
      BASH_MAX_TIMEOUT_MS: "2700000",
    })
    for (const name of timeoutVariables) {
      expect(workerVariables("1.2.3")).not.toHaveProperty(name)
    }
  })

  test("workerEnv lays them over the environment's own", () => {
    const result = workerEnv({
      env: { PATH: "/usr/bin", BASH_DEFAULT_TIMEOUT_MS: "120000", BASH_MAX_TIMEOUT_MS: "600000" },
      subscription: true,
      billing: "subscription",
      checkTimeout: Duration.minutes(30),
    })
    expect(result.BASH_DEFAULT_TIMEOUT_MS).toBe("1800000")
    expect(result.BASH_MAX_TIMEOUT_MS).toBe("1800000")
    expect(result.PATH).toBe("/usr/bin")
  })

  test("the probe's environment doesn't set them", () => {
    const result = probeEnv({ env: { PATH: "/usr/bin" } })
    for (const name of timeoutVariables) expect(result).not.toHaveProperty(name)
  })
})

/** The fake's log: the environment variables it was asked for, as each session started. */
const loggedEnv = (file: string): ReadonlyArray<Record<string, string | null>> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .flatMap((entry) => (entry.env === undefined ? [] : [entry.env]))
    : []

describe("a worker's session", () => {
  test("gets Bash's timeouts from checks.fast.timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-bash-timeouts-"))
    const log = join(dir, "fake.jsonl")
    const config = appConfig(
      {
        claude: fake,
        settings: {
          ...defaultSettings,
          checks: {
            ...defaultSettings.checks,
            fast: {
              ...defaultSettings.checks.fast,
              command: "scripts/check-fast.sh",
              timeout: Duration.minutes(45),
            },
          },
        },
      },
      dir,
    )
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: { servers: [], note: noServersNote },
      account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
      env: {
        ...process.env,
        BASH_DEFAULT_TIMEOUT_MS: "120000",
        FAKE_CLAUDE_SCENARIO: JSON.stringify({ log, env: timeoutVariables }),
      },
    })
    const env = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* AgentHost
        yield* agents.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
        return yield* Effect.sync(() => loggedEnv(log)).pipe(
          Effect.repeat({
            until: (found) => found.length > 0,
            schedule: Schedule.spaced(Duration.millis(20)),
          }),
          Effect.timeoutOrElse({
            duration: Duration.seconds(10),
            orElse: () => Effect.die("the fake never logged its environment"),
          }),
        )
      }).pipe(
        Effect.provide(
          host.pipe(
            Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
            Layer.provideMerge(
              Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
            ),
          ),
        ),
      ),
    )
    expect(env).toEqual([{ BASH_DEFAULT_TIMEOUT_MS: "2700000", BASH_MAX_TIMEOUT_MS: "2700000" }])
  })
})

describe("the worker prompt", () => {
  test("says to run checks in the foreground with no timeout of the worker's own", () => {
    const rules = builtInWorkerPrompt.replace(/\s+/g, " ")
    expect(rules).toContain("Run the checks in the foreground, never in the background")
    expect(rules).toContain(
      "tutti sets Bash's default timeout to as long as the merge check may take, so pass Bash no timeout of your own: a shorter one moves the check to the background when it runs out.",
    )
  })
})
