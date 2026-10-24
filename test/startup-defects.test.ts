// A startup check that fails with a defect still says what failed, and the SDK's query() throwing
// as it is called (no Claude Code for the platform) fails the login probe and a worker's start
// with what to do, rather than as a defect: tutti never exits 2 saying nothing.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { query } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option } from "effect"
import fc from "fast-check"
import { Account, AccountProbeFailed, startProbeWith } from "../src/agent/Account.ts"
import { AgentHost, AgentStartFailed } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { queryThrew } from "../src/agent/claudeBinary.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { type AppConfigValue, defaultSettings, SetupProblem } from "../src/cli/AppConfig.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { check, failures, report, type StartupFailed } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import * as TestGit from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

/** What the SDK's query() throws when it finds no platform package. */
const noBinary = new Error(
  "Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without " +
    "--omit=optional, or set options.pathToClaudeCodeExecutable.",
)

/** A query() that throws `error` as it is called, as the SDK's does. */
const throwing =
  (error: unknown): typeof query =>
  () => {
    throw error
  }

describe("queryThrew", () => {
  test("a missing platform package says what to do", () => {
    const said = queryThrew(noBinary)
    expect(said).toContain("no Claude Code for linux-x64")
    expect(said).toContain("--omit=optional")
    expect(said).toContain("--claude <path>")
  })

  test("any other error is its message", () => {
    expect(queryThrew(new Error("Invalid pluginDelivery."))).toBe("Invalid pluginDelivery.")
    expect(queryThrew("plain")).toBe("plain")
  })

  test("is one line, whatever was thrown", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(queryThrew(new Error(text))).not.toMatch(/[\n\t]/)
      }),
    )
  })
})

describe("failures", () => {
  test("a defect is an internal error in its check", () => {
    const cause = Cause.die(new Error("boom")) as Cause.Cause<SetupProblem>
    expect(failures(cause, "the worker prompt")).toEqual([
      "Internal error in the worker prompt: boom. Please report it.",
    ])
  })

  test("failures and defects are each reported", () => {
    const cause = Cause.fromReasons<SetupProblem>([
      Cause.makeFailReason(new SetupProblem({ problems: ["a", "b"] })),
      Cause.makeDieReason("not an Error"),
    ])
    expect(failures(cause, "the configuration")).toEqual([
      "a",
      "b",
      "Internal error in the configuration: not an Error. Please report it.",
    ])
  })
})

/** A folder with a repository `tutti init` has set up. */
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-startup-defects-")))
  const repo = join(dir, "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  writeFileSync(join(repo, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
  mkdirSync(join(repo, ".beads"))
  return repo
}

/** The startup checks in a fresh repository, with `config` and `account` as given. */
const run = (options: {
  readonly config?: (repo: string) => Effect.Effect<AppConfigValue, SetupProblem>
  readonly account?: Layer.Layer<Account>
}) => {
  const repo = project()
  return Effect.runPromise(
    Effect.exit(
      check({
        cwd: repo,
        env: {},
        config: options.config ?? ((top) => Effect.succeed(TestAppConfig.appConfig({}, top))),
        beads: () => TestBeads.layer(),
        claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
        account: options.account ?? TestAccount.layer(),
      }),
    ).pipe(
      Effect.provide(TestGit.layer({ dir: repo })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..", "home") } })),
      ),
      Effect.provide(BunServices.layer),
    ),
  )
}

/** The checks' StartupFailed, which they must have failed with. */
const failed = (exit: Exit.Exit<unknown, StartupFailed>): StartupFailed => {
  if (Exit.isSuccess(exit)) throw new Error("the checks passed")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
  return reason.error
}

describe("the startup checks: a defect in a check", () => {
  test("in the login probe is a problem line", async () => {
    const dying = Layer.succeed(Account, Account.of({ probe: Effect.die(new Error("boom")) }))
    const failure = failed(await run({ account: dying }))
    expect(failure.problems).toEqual(["Internal error in the login probe: boom. Please report it."])
    expect(report(failure)).toContain("Internal error in the login probe: boom")
  })

  test("in loading the configuration is a problem line", async () => {
    const failure = failed(await run({ config: () => Effect.die("config exploded") }))
    expect(failure.problems).toContain(
      "Internal error in the configuration: config exploded. Please report it.",
    )
  })

  test("never leaves the report empty", async () => {
    const dying = Layer.succeed(Account, Account.of({ probe: Effect.die(undefined) }))
    const failure = failed(await run({ account: dying }))
    expect(failure.problems.length).toBeGreaterThan(0)
    expect(report(failure)).not.toBe("")
  })

  test("the login probe's query() throwing fails it with what to do", async () => {
    const account = Account.layerWith(startProbeWith(), { PATH: "/usr/bin" }).pipe(
      Layer.provide(ClaudeCode.layerWith(throwing(noBinary))),
    )
    const failure = failed(
      await run({
        account: Layer.provide(
          account,
          TestAppConfig.layer(TestAppConfig.appConfig({ claude: null })),
        ),
      }),
    )
    expect(failure.problems).toEqual([
      new AccountProbeFailed({ reason: queryThrew(noBinary) }).message,
    ])
  })
})

describe("AgentHost live: query() throwing as the session starts", () => {
  test("fails the start as AgentStartFailed, and the worker doesn't stay Starting", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-start-throws-")))
    const config = TestAppConfig.appConfig({ claude: null, settings: defaultSettings }, dir)
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: { servers: [], note: noServersNote },
      account: { billing: { _tag: "Subscription", keyUnused: false } },
    })
    const { exit, state } = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* AgentHost
        const exit = yield* Effect.exit(
          agents.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir }),
        )
        return { exit, state: yield* agents.current("t-1") }
      }).pipe(
        Effect.provide(
          host.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                attentionLayer(waitForTest),
                transcriptsLayer(),
                ClaudeCode.layerWith(throwing(noBinary)).pipe(Layer.provide(workersIn(testEnv))),
              ),
            ),
            Layer.provideMerge(
              Layer.mergeAll(
                logLayer(),
                eventsLayer(),
                TestAppConfig.layer(config),
                BunServices.layer,
              ),
            ),
          ),
        ),
      ),
    )
    expect(Exit.findErrorOption(exit)).toEqual(
      Option.some(new AgentStartFailed({ ticket: "t-1", reason: queryThrew(noBinary) })),
    )
    expect(state).toEqual(WorkerState.Gone({ why: queryThrew(noBinary) }))
  })
})
