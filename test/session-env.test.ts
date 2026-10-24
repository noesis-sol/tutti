// A tutti started from a Claude Code session (the run skill, an orchestra worker trying tutti,
// `!tutti`) has that session's variables in its environment: the sessions tutti starts don't get
// them, so none runs as the parent's attended child or takes its messaging socket (tutti-y2i). The
// user's own configuration stays. scripts/test.ts drops the same names for the suites.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Schedule } from "effect"
import fc from "fast-check"
import { machineVariable } from "../scripts/test.ts"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import {
  paneVariable,
  probeEnv,
  sessionVariable,
  workerEnv,
  workerVariables,
} from "../src/agent/env.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

// The live host's test starts the fake Claude Code as a process: up to a second on an idle machine.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** What a Claude Code 2.1.301 session puts in its Bash shells' environment. */
const parentSession = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SESSION_ID: "22222222-2222-4222-8222-222222222222",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_SESSION_ATTENDED: "1",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/claude-501/inbox.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "parent-token",
  CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude",
  CLAUDE_CODE_INVOKED_SKILLS: "run",
  CLAUDE_PID: "4242",
  CLAUDE_EFFORT: "high",
  CLAUDE_AGENT_SDK_VERSION: "9.9.9",
  AI_AGENT: "claude-code",
  TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  TRACESTATE: "vendor=1",
}

/** The user's configuration, which a session tutti starts keeps. */
const userConfiguration = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
  CLAUDE_CODE_TMPDIR: "/home/me/tmp",
  CLAUDE_CODE_USE_BEDROCK: "1",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
}

describe("sessionVariable", () => {
  test("is each variable a Claude Code session gives its shells", () => {
    for (const name of Object.keys(parentSession)) {
      expect([name, sessionVariable(name)]).toEqual([name, true])
    }
  })

  test("is none of the user's configuration", () => {
    for (const name of [...Object.keys(userConfiguration), "CLAUDE_CODE_OAUTH_TOKEN", "SHELL"]) {
      expect([name, sessionVariable(name)]).toEqual([name, false])
    }
  })

  test("decides the suites' environment too", () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(parentSession)), (name) => {
        expect(machineVariable(name)).toBe(true)
      }),
    )
  })
})

describe("workerEnv", () => {
  test("leaves out the parent session's variables and keeps the user's", () => {
    const result = workerEnv({
      env: { ...userConfiguration, ...parentSession },
      subscription: false,
      billing: "subscription",
      version: "1.2.3",
    })
    expect(result).toMatchObject(userConfiguration)
    for (const name of Object.keys(parentSession)) expect(result).not.toHaveProperty(name)
  })

  test("the probe's environment leaves them out too", () => {
    const result = probeEnv({ env: { ...userConfiguration, ...parentSession } })
    expect(result).toMatchObject(userConfiguration)
    for (const name of Object.keys(parentSession)) expect(result).not.toHaveProperty(name)
  })

  test("keeps every variable that is neither a session's nor the pane's", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,20}$/), fc.string()),
        (env) => {
          const result = workerEnv({ env, subscription: false, billing: "subscription" })
          const tutti = workerVariables()
          for (const [name, value] of Object.entries(env)) {
            if (sessionVariable(name) || paneVariable(name)) expect(result).not.toHaveProperty(name)
            else expect(result[name]).toBe(tutti[name] ?? value)
          }
        },
      ),
    )
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

/** The variables `names` as a worker's session started by a tutti with `env` sees them. */
const sessionEnv = (env: Record<string, string>, names: ReadonlyArray<string>) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-session-env-"))
  const log = join(dir, "fake.jsonl")
  const config = appConfig({ claude: fake, settings: { ...defaultSettings, concurrent: 1 } }, dir)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env: { ...testEnv, ...env, FAKE_CLAUDE_SCENARIO: JSON.stringify({ log, env: names }) },
    cores: 1,
  })
  return Effect.runPromise(
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

describe("a worker's session started from a Claude Code session", () => {
  test("runs as the SDK's, with none of the parent's variables and the user's configuration", async () => {
    const [seen] = await sessionEnv(
      { ...parentSession, CLAUDE_CONFIG_DIR: "/home/me/.claude-work" },
      [...Object.keys(parentSession), "CLAUDE_CONFIG_DIR"],
    )
    expect(seen).toMatchObject({
      CLAUDECODE: null,
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_SESSION_ID: null,
      CLAUDE_CODE_CHILD_SESSION: null,
      CLAUDE_CODE_SESSION_ATTENDED: null,
      CLAUDE_CODE_MESSAGING_SOCKET: null,
      CLAUDE_CODE_MESSAGING_TOKEN: null,
      CLAUDE_CODE_EXECPATH: null,
      CLAUDE_PID: null,
      CLAUDE_EFFORT: null,
      AI_AGENT: null,
      TRACEPARENT: null,
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
    })
    expect(seen?.CLAUDE_AGENT_SDK_VERSION).not.toBe("9.9.9")
  })
})
