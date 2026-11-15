// The settings' linear block (tutti-qatu.2): optional, its presence turning the Linear sync on.
// Without it the settings decode as before, the START block is unchanged and nothing of Linear
// runs; with it the startup checks warn of each lack, never failing the start, or the START block
// names the team and how often the run pulls. --no-linear and TUTTI_NO_LINEAR run once without it.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Duration, Effect, Exit, Layer, Option, Result } from "effect"
import { Command } from "effect/cli"
import type { AppConfigValue } from "../src/core/AppConfig.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import { cliFlags, noFlags, type RunFlags } from "../src/project/flags.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { Settings, settingsFile } from "../src/project/settings.ts"
import { UserConfig } from "../src/project/userConfig.ts"
import { linearLine, linearStateTypes, stateMapKey } from "../src/run/linearCheck.ts"
import {
  defaultSettings,
  defaultUserConfig,
  resolve,
  type Sources,
} from "../src/run/resolveConfig.ts"
import { check, type Started, startBlock } from "../src/run/startup.ts"
import { Beads, BeadsTimedOut, decodeConfiguration } from "../src/services/Beads.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"

/** The settings `json` decodes to, or the problems it has, each `<path>: <message>`. */
const decoded = (json: unknown) => {
  const exit = decodeConfig(Settings, settingsFile, json)
  if (Exit.isSuccess(exit)) return Result.succeed(exit.value)
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(Cause.pretty(exit.cause))
  return Result.fail(reason.error.problems.map((p) => `${p.path}: ${p.message}`))
}

const block = { team: "NOE", pull_every: Duration.minutes(10) }
const withBlock = { ...TestAppConfig.testSettings, linear: block }

/** bd's configuration with a state map for every one of Linear's state types. */
const stateMaps = Object.fromEntries(
  linearStateTypes.map((type) => [stateMapKey(type), type === "backlog" ? "deferred" : "open"]),
)

describe("the settings' linear block", () => {
  test("is left out by default: settings without it decode as before", () => {
    const settings = decoded({ concurrent: 2 })
    if (Result.isFailure(settings)) throw new Error(settings.failure.join("\n"))
    expect(Object.hasOwn(settings.success, "linear")).toBe(false)
    expect(Object.hasOwn(defaultSettings, "linear")).toBe(false)
    expect(settings.success).toEqual({ ...defaultSettings, concurrent: 2 })
  })

  test("takes the team, and pull_every as a time, 10 minutes by default and 0 for none", () => {
    const given = decoded({ linear: { team: "NOE" } })
    if (Result.isFailure(given)) throw new Error(given.failure.join("\n"))
    expect(given.success.linear?.team).toBe("NOE")
    expect(Duration.toMillis(given.success.linear?.pull_every ?? Duration.zero)).toBe(600_000)
    const zero = decoded({ linear: { team: "NOE", pull_every: "0" } })
    if (Result.isFailure(zero)) throw new Error(zero.failure.join("\n"))
    expect(Duration.isZero(zero.success.linear?.pull_every ?? Duration.hours(1))).toBe(true)
  })

  test("without a team is refused with the settings' usual message", () => {
    expect(decoded({ linear: {} })).toEqual(Result.fail(["linear.team: Missing key"]))
    expect(decoded({ linear: { pull_every: "5m" } })).toEqual(
      Result.fail(["linear.team: Missing key"]),
    )
  })

  test("refuses a team that is no team's key, a bad time and an unknown key", () => {
    expect(decoded({ linear: { team: "NOE-1" } })).toEqual(
      Result.fail([`linear.team: Expected a Linear team's key such as "NOE", got "NOE-1"`]),
    )
    expect(Result.isFailure(decoded({ linear: { team: "NOE", pull_every: "soon" } }))).toBe(true)
    expect(decoded({ linear: { team: "NOE", enabled: true } })).toEqual(
      Result.fail([`linear.enabled: unknown key "enabled"`]),
    )
  })

  test("can't be given in the user config, which can't turn the sync on", () => {
    const exit = decodeConfig(UserConfig, "config.json", { linear: { team: "NOE" } })
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

/** The run's configuration from `sources` over no flags, variables or user config. */
const configOf = (sources: Partial<Sources> = {}): AppConfigValue => {
  const resolved = resolve({
    repo: "/work/project",
    flags: noFlags,
    env: () => undefined,
    user: defaultUserConfig,
    settings: defaultSettings,
    ...sources,
  })
  if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
  return resolved.success
}

/** Parses `args` as `tutti` would, returning the flags' texts. */
const parse = async (args: ReadonlyArray<string>): Promise<RunFlags> => {
  let parsed: RunFlags | undefined
  const command = Command.make("tutti", cliFlags, (flags) =>
    Effect.sync(() => {
      parsed = flags
    }),
  )
  const exit = await Effect.runPromiseExit(
    Command.runWith(command, { version: "test", renderErrors: false })(args).pipe(
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit) || parsed === undefined) throw new Error(`didn't parse: ${exit}`)
  return parsed
}

describe("the run's Linear sync, resolved", () => {
  test("is none without the block, and the settings' block with it", () => {
    expect(configOf()).toMatchObject({ linear: null, linearOffBy: null })
    expect(configOf({ settings: withBlock })).toMatchObject({ linear: block, linearOffBy: null })
  })

  test("--no-linear and TUTTI_NO_LINEAR=1 run once without it, saying which", async () => {
    const flags = await parse(["--no-linear"])
    expect(flags.noLinear).toEqual(Option.some("true"))
    expect(configOf({ settings: withBlock, flags })).toMatchObject({
      linear: null,
      linearOffBy: "--no-linear",
    })
    const env = (name: string) => (name === "TUTTI_NO_LINEAR" ? "1" : undefined)
    expect(configOf({ settings: withBlock, env })).toMatchObject({
      linear: null,
      linearOffBy: "TUTTI_NO_LINEAR",
    })
    // The flag given false overrides the variable.
    const off = { ...noFlags, noLinear: Option.some("false") }
    expect(configOf({ settings: withBlock, env, flags: off })).toMatchObject({
      linear: block,
      linearOffBy: null,
    })
  })

  test("--no-linear without a block says nothing", () => {
    const flags = { ...noFlags, noLinear: Option.some("true") }
    expect(configOf({ flags })).toMatchObject({ linear: null, linearOffBy: null })
  })

  test("a bad TUTTI_NO_LINEAR is a problem, as every on-or-off variable's is", () => {
    const resolved = resolve({
      repo: "/work/project",
      flags: noFlags,
      env: (name) => (name === "TUTTI_NO_LINEAR" ? "maybe" : undefined),
      user: defaultUserConfig,
      settings: withBlock,
    })
    expect(Result.isFailure(resolved)).toBe(true)
  })
})

/** A project `tutti init` has set up. */
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-linear-settings-")))
  const repo = join(dir, "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  mkdirSync(join(repo, ".beads"))
  writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  writeFileSync(join(repo, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
  return repo
}

interface Scenario {
  readonly config?: Partial<AppConfigValue>
  readonly env?: Record<string, string>
  readonly bd?: TestBeads.TestBd
  /** The Beads service over the test layer's, for a bd call that fails. */
  readonly beads?: (beads: Beads["Service"]) => Partial<Beads["Service"]>
}

/**
 * The startup checks in a project set up, with `scenario`: what they gave, and the calls of bd's
 * configuration and bd linear they made.
 */
const run = async (scenario: Scenario = {}) => {
  const repo = project()
  const calls: Array<string> = []
  const counted = Layer.effect(
    Beads,
    Effect.map(Beads, (beads) =>
      Beads.of({
        ...beads,
        configuration: () =>
          Effect.andThen(
            Effect.sync(() => calls.push("config list")),
            beads.configuration(),
          ),
        hasLinear: () =>
          Effect.andThen(
            Effect.sync(() => calls.push("linear")),
            beads.hasLinear(),
          ),
        ...scenario.beads?.(beads),
      }),
    ),
  )
  const exit = await Effect.runPromise(
    Effect.exit(
      check({
        cwd: repo,
        env: scenario.env ?? {},
        config: (top) => Effect.succeed(TestAppConfig.appConfig(scenario.config ?? {}, top)),
        beads: () => Layer.provide(counted, TestBeads.layer([], scenario.bd)),
        claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
        account: TestAccount.layer(),
      }),
    ).pipe(
      Effect.scoped,
      Effect.provide(TestGit.layer({ dir: repo })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..", "home") } })),
      ),
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`the checks failed: ${Cause.pretty(exit.cause)}`)
  return { started: exit.value, calls }
}

/** The START block's notes, the lines under its first. */
const notes = (started: Started): ReadonlyArray<string> => startBlock(started, "0.1.0").slice(1)

/** The START block's lines that name Linear. */
const linearNotes = (started: Started) => notes(started).filter((line) => line.includes("linear"))

const key = { LINEAR_API_KEY: "lin_api_test" }

describe("the startup checks of the Linear sync", () => {
  test("without the block: nothing of Linear runs, and the START block says nothing of it", async () => {
    const { started, calls } = await run({ env: key, bd: { configuration: stateMaps } })
    expect(calls).toEqual([])
    expect(started.warnings).toEqual([])
    expect(started.config.linear).toBeNull()
    expect(linearNotes(started)).toEqual([])
    // As a run's START block was before the block existed.
    const plain = await run()
    expect(notes(started)).toEqual(notes(plain.started))
  })

  test("with all it needs: the START block names the team and the interval", async () => {
    const { started, calls } = await run({
      config: { settings: withBlock },
      env: key,
      bd: { configuration: stateMaps },
    })
    expect(calls.toSorted()).toEqual(["config list", "linear"])
    expect(started.warnings).toEqual([])
    expect(started.config.linear).toEqual(block)
    expect(linearNotes(started)).toEqual(["  linear: NOE, pull at start and every 10m"])
  })

  test("bd's OAuth pair stands for the key", async () => {
    const { started } = await run({
      config: { settings: withBlock },
      env: { LINEAR_OAUTH_CLIENT_ID: "id", LINEAR_OAUTH_CLIENT_SECRET: "secret" },
      bd: { configuration: stateMaps },
    })
    expect(started.warnings).toEqual([])
    expect(started.config.linear).toEqual(block)
  })

  test("without credentials: a warning, and the run starts without the sync", async () => {
    const { started } = await run({
      config: { settings: withBlock },
      env: { LINEAR_API_KEY: "", LINEAR_OAUTH_CLIENT_ID: "id" },
      bd: { configuration: stateMaps },
    })
    expect(started.warnings).toEqual([
      "linear: not syncing: no LINEAR_API_KEY in the environment (nor LINEAR_OAUTH_CLIENT_ID and LINEAR_OAUTH_CLIENT_SECRET); export it in the shell that starts tutti",
    ])
    expect(started.config.linear).toBeNull()
    expect(linearNotes(started)).toEqual(started.warnings.map((warning) => `  ${warning}`))
  })

  test("with a bd that has no bd linear: a warning, and the run starts without the sync", async () => {
    const { started } = await run({
      config: { settings: withBlock },
      env: key,
      bd: { configuration: stateMaps, linear: false },
    })
    expect(started.warnings).toEqual([
      "linear: not syncing: the installed bd has no bd linear; update Beads",
    ])
    expect(started.config.linear).toBeNull()
  })

  test("without the state maps: a warning naming those missing, and the run starts", async () => {
    const { started } = await run({
      config: { settings: withBlock },
      env: key,
      bd: {
        configuration: { [stateMapKey("unstarted")]: "open", [stateMapKey("completed")]: "closed" },
      },
    })
    expect(started.warnings).toEqual([
      "linear: not syncing: bd's configuration has no state map for backlog, started, canceled; set each with bd config set linear.state_map.<type> <status>",
    ])
    expect(started.config.linear).toBeNull()
  })

  test("each lack at once gives its warning, and the run starts", async () => {
    const { started } = await run({ config: { settings: withBlock }, bd: { linear: false } })
    expect(started.warnings).toEqual([
      "linear: not syncing: no LINEAR_API_KEY in the environment (nor LINEAR_OAUTH_CLIENT_ID and LINEAR_OAUTH_CLIENT_SECRET); export it in the shell that starts tutti",
      "linear: not syncing: the installed bd has no bd linear; update Beads",
      "linear: not syncing: bd's configuration has no state map for backlog, unstarted, started, completed, canceled; set each with bd config set linear.state_map.<type> <status>",
    ])
  })

  test("bd failing to answer is a warning, not a failed start", async () => {
    const failing = new BeadsTimedOut({
      command: "bd linear --help",
      timeLimit: Duration.seconds(30),
    })
    const { started } = await run({
      config: { settings: withBlock },
      env: key,
      bd: { configuration: stateMaps },
      beads: () => ({ hasLinear: () => Effect.fail(failing) }),
    })
    expect(started.warnings).toEqual([
      "linear: not syncing: could not run bd linear: bd took longer than 30s",
    ])
    expect(started.config.linear).toBeNull()
  })

  test("--no-linear: nothing of Linear runs, and the START block says it is off", async () => {
    const { started, calls } = await run({
      config: { settings: withBlock, linear: null, linearOffBy: "--no-linear" },
    })
    expect(calls).toEqual([])
    expect(started.warnings).toEqual([])
    expect(linearNotes(started)).toEqual(["  linear: off, --no-linear"])
  })
})

describe("the START block's Linear line", () => {
  test("says a pull_every of 0 pulls at the start only", () => {
    expect(linearLine({ team: "NOE", pull_every: Duration.zero })).toBe(
      "linear: NOE, pull at start only",
    )
    expect(linearLine({ team: "ABC", pull_every: Duration.minutes(90) })).toBe(
      "linear: ABC, pull at start and every 1h30m",
    )
  })
})

describe("bd config list, decoded", () => {
  test("keeps each key's text, in bd's envelope or out of it, and drops schema_version", async () => {
    const flat = JSON.stringify({
      issue_prefix: "tutti",
      "linear.team_key": "NOE",
      schema_version: 1,
    })
    const enveloped = JSON.stringify({
      data: { issue_prefix: "tutti", "linear.team_key": "NOE" },
      schema_version: 1,
    })
    for (const stdout of [flat, enveloped]) {
      expect(await Effect.runPromise(decodeConfiguration("bd config list --json", stdout))).toEqual(
        {
          issue_prefix: "tutti",
          "linear.team_key": "NOE",
        },
      )
    }
  })
})
