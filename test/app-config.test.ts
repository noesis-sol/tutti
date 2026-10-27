import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Duration, Effect, Exit, Option, Result } from "effect"
import { Command } from "effect/cli"
import fc from "fast-check"
import {
  AppConfig,
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  load,
  resolve,
  type SetupProblem,
  type Sources,
} from "../src/cli/AppConfig.ts"
import {
  cliFlags,
  count,
  noFlags,
  onOff,
  type RunFlagName,
  type RunFlags,
  runFlags,
  variableOf,
} from "../src/cli/flags.ts"
import type { Settings } from "../src/project/settings.ts"
import type { UserConfig } from "../src/project/userConfig.ts"
import { defaultMachineWorkers, defaultMachineWorkersFrom, runsDir } from "../src/run/machine.ts"
import { appConfig, layer as testLayer } from "../src/testing/AppConfig.ts"

const repo = "/work/project"

const flagsOf = (given: Partial<Record<RunFlagName, string>>): RunFlags => ({
  ...noFlags,
  ...Object.fromEntries(Object.entries(given).map(([key, text]) => [key, Option.some(text)])),
})

interface Layers {
  readonly flags?: Partial<Record<RunFlagName, string>>
  readonly env?: Record<string, string>
  readonly user?: Partial<UserConfig>
  readonly settings?: (settings: Settings) => Settings
}

const sourcesOf = ({ flags = {}, env = {}, user = {}, settings = (s) => s }: Layers): Sources => ({
  repo,
  flags: flagsOf(flags),
  env: (name) => env[name],
  user: { ...defaultUserConfig, ...user },
  settings: settings(defaultSettings),
})

const configOf = (layers: Layers): AppConfigValue => {
  const resolved = resolve(sourcesOf(layers))
  if (Result.isFailure(resolved)) throw new Error(`expected a config, got ${resolved.failure}`)
  return resolved.success
}

const problemsOf = (layers: Layers): ReadonlyArray<string> => {
  const resolved = resolve(sourcesOf(layers))
  if (Result.isSuccess(resolved)) throw new Error("expected problems, got a config")
  return resolved.failure
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

const minutes = Duration.minutes

describe("flags", () => {
  test("each flag's variable is TUTTI_ and its name", () => {
    expect(runFlags.concurrent.variable).toBe("TUTTI_CONCURRENT")
    expect(runFlags.ticket.variable).toBe("TUTTI_TICKET")
    expect(runFlags.noMouse.variable).toBe("TUTTI_NO_MOUSE")
    expect(runFlags.colourScheme.variable).toBe("TUTTI_COLOUR_SCHEME")
    expect(runFlags.usageLimitWait.variable).toBe("TUTTI_USAGE_LIMIT_WAIT")
    expect(runFlags.claude.variable).toBe("TUTTI_CLAUDE")
    for (const flag of Object.values(runFlags)) expect(flag.variable).toBe(variableOf(flag.name))
  })

  test("§ 8.2's flags are all there", () => {
    expect(Object.values(runFlags).map((flag) => flag.name)).toEqual([
      "concurrent",
      "machine-workers",
      "auto-answer",
      "overnight",
      "force-overnight",
      "overnight-free-disk",
      "tickets",
      "ticket",
      "feature",
      "spec",
      "refine",
      "spec-timeout",
      "spec-effort",
      "yes",
      "ticket-limit",
      "limit",
      "worker-effort",
      "worker-model",
      "organ-model",
      "organ-effort",
      "triage",
      "review",
      "notify",
      "check-timeout",
      "check-full-timeout",
      "resolve-conflicts",
      "plain",
      "no-mouse",
      "prompt",
      "worktrees",
      "billing",
      "usage-limit-wait",
      "claude",
      "colour-scheme",
    ])
  })

  test("effect/cli parses them to their texts", async () => {
    const flags = await parse([
      "-c",
      "3",
      "--triage=false",
      "--no-mouse",
      "--plain",
      "--ticket",
      "tutti-1",
      "--feature",
      "dark mode",
      "--colour-scheme=solarized",
    ])
    expect(flags).toEqual({
      ...noFlags,
      concurrent: Option.some("3"),
      triage: Option.some("false"),
      noMouse: Option.some("true"),
      plain: Option.some("true"),
      ticket: Option.some("tutti-1"),
      feature: Option.some("dark mode"),
      colourScheme: Option.some("solarized"),
    })
    expect(await parse([])).toEqual(noFlags)
    expect((await parse(["--concurrent=16"])).concurrent).toEqual(Option.some("16"))
  })

  test("a bad value gets past the parser, so AppConfig reports it with the rest", async () => {
    const flags = await parse(["--concurrent", "lots", "--triage=maybe"])
    const resolved = resolve({ ...sourcesOf({}), flags })
    expect(resolved).toEqual(
      Result.fail([
        "--concurrent must be a whole number from 1 to 16 (got 'lots').",
        "--triage must be 1 or 0, true or false, yes or no, or on or off (got 'maybe').",
      ]),
    )
  })

  test("on or off: 1, true, yes, on and 0, false, no, off, in any case", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = onOff(text)
        const word = text.toLowerCase()
        if (["1", "true", "yes", "on"].includes(word))
          return Result.isSuccess(result) && result.success
        if (["0", "false", "no", "off"].includes(word)) {
          return Result.isSuccess(result) && !result.success
        }
        return Result.isFailure(result) && result.failure.includes(`(got '${text}')`)
      }),
    )
    expect(onOff("YES")).toEqual(Result.succeed(true))
    expect(onOff("Off")).toEqual(Result.succeed(false))
  })

  test("a count takes whole numbers in its range, and no other text", () => {
    const concurrent = count(1, 16)
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = concurrent(text)
        const n = Number(text)
        const valid = /^\d+$/.test(text) && n >= 1 && n <= 16
        return valid ? Result.isSuccess(result) && result.success === n : Result.isFailure(result)
      }),
    )
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), (n) =>
        Result.isSuccess(concurrent(String(n))) ? n >= 1 && n <= 16 : n < 1 || n > 16,
      ),
    )
  })
})

describe("precedence", () => {
  test("concurrent: flag, then variable, then settings, then 1", () => {
    const settings = (s: Settings): Settings => ({ ...s, concurrent: 2 })
    const env = { TUTTI_CONCURRENT: "4" }
    expect(configOf({}).settings.concurrent).toBe(1)
    expect(configOf({ settings }).settings.concurrent).toBe(2)
    expect(configOf({ settings, env }).settings.concurrent).toBe(4)
    expect(configOf({ settings, env, flags: { concurrent: "3" } }).settings.concurrent).toBe(3)
  })

  test("the colour scheme: flag, TUTTI_COLOUR_SCHEME, user config, settings, orchestra (§ 7.11)", () => {
    const settings = (s: Settings): Settings => ({ ...s, ui: { colour_scheme: "project" } })
    const user = { colour_scheme: "mine" }
    const env = { TUTTI_COLOUR_SCHEME: "this-shell" }
    expect(configOf({}).colourScheme).toBe("orchestra")
    expect(configOf({ settings }).colourScheme).toBe("project")
    expect(configOf({ settings, user }).colourScheme).toBe("mine")
    expect(configOf({ settings, user, env }).colourScheme).toBe("this-shell")
    expect(
      configOf({ settings, user, env, flags: { colourScheme: "this-run" } }).colourScheme,
    ).toBe("this-run")
  })

  test("the user config's choices: flag, then variable, then the user config", () => {
    expect(configOf({}).notify).toBe(true)
    expect(configOf({ user: { notify: false } }).notify).toBe(false)
    expect(configOf({ user: { notify: false }, env: { TUTTI_NOTIFY: "on" } }).notify).toBe(true)
    expect(
      configOf({ user: { notify: false }, env: { TUTTI_NOTIFY: "on" }, flags: { notify: "false" } })
        .notify,
    ).toBe(false)

    expect(configOf({}).mouse).toBe(true)
    expect(configOf({ user: { mouse: false } }).mouse).toBe(false)
    expect(configOf({ user: { mouse: false }, env: { TUTTI_NO_MOUSE: "0" } }).mouse).toBe(true)
    expect(configOf({ env: { TUTTI_NO_MOUSE: "0" }, flags: { noMouse: "true" } }).mouse).toBe(false)

    expect(configOf({}).billing).toBe("subscription")
    expect(configOf({ user: { billing: "api" } }).billing).toBe("api")
    expect(configOf({ env: { TUTTI_BILLING: "api" } }).billing).toBe("api")
    expect(
      configOf({
        user: { billing: "api" },
        env: { TUTTI_BILLING: "api" },
        flags: { billing: "subscription" },
      }).billing,
    ).toBe("subscription")

    expect(configOf({ user: { appearance: "dark" } }).appearance).toBe("dark")
    expect(
      configOf({ user: { appearance: "dark" }, env: { TUTTI_APPEARANCE: "light" } }).appearance,
    ).toBe("light")
  })

  test("the settings a flag overrides: flag, then variable, then settings, then default", () => {
    const settings = (s: Settings): Settings => ({
      ...s,
      checks: {
        ...s.checks,
        fast: { ...s.checks.fast, timeout: minutes(10) },
        full: { ...s.checks.full, timeout: minutes(90) },
      },
      workers: { ...s.workers, effort: "low", model: "sonnet", ticket_limit: Duration.hours(1) },
      organs: { effort: "high", model: "haiku", triage: false, review: false },
      merge: { ...s.merge, resolve_conflicts: false },
    })
    const defaults = configOf({}).settings
    expect(defaults.checks.fast.timeout).toEqual(minutes(30))
    expect(defaults.workers.ticket_limit).toBeNull()

    const fromSettings = configOf({ settings }).settings
    expect(fromSettings).toEqual(settings(defaultSettings))

    const env = {
      TUTTI_CHECK_TIMEOUT: "5m",
      TUTTI_CHECK_FULL_TIMEOUT: "2h",
      TUTTI_WORKER_EFFORT: "max",
      TUTTI_WORKER_MODEL: "opus",
      TUTTI_TICKET_LIMIT: "0",
      TUTTI_ORGAN_EFFORT: "medium",
      TUTTI_ORGAN_MODEL: "sonnet",
      TUTTI_TRIAGE: "yes",
      TUTTI_REVIEW: "1",
      TUTTI_RESOLVE_CONFLICTS: "true",
    }
    const fromEnv = configOf({ settings, env }).settings
    expect(fromEnv.checks.fast.timeout).toEqual(minutes(5))
    expect(fromEnv.checks.full.timeout).toEqual(Duration.hours(2))
    expect(fromEnv.workers).toMatchObject({ effort: "max", model: "opus", ticket_limit: null })
    expect(fromEnv.organs).toEqual({
      effort: "medium",
      model: "sonnet",
      triage: true,
      review: true,
    })
    expect(fromEnv.merge.resolve_conflicts).toBe(true)

    const fromFlags = configOf({
      settings,
      env,
      flags: {
        checkTimeout: "1m",
        checkFullTimeout: "3h",
        workerEffort: "xhigh",
        workerModel: "fable",
        ticketLimit: "2h",
        organEffort: "low",
        organModel: "opus",
        triage: "off",
        review: "no",
        resolveConflicts: "0",
      },
    }).settings
    expect(fromFlags.checks.fast.timeout).toEqual(minutes(1))
    expect(fromFlags.checks.full.timeout).toEqual(Duration.hours(3))
    expect(fromFlags.workers).toMatchObject({
      effort: "xhigh",
      model: "fable",
      ticket_limit: Duration.hours(2),
    })
    expect(fromFlags.organs).toEqual({ effort: "low", model: "opus", triage: false, review: false })
    expect(fromFlags.merge.resolve_conflicts).toBe(false)
    // What no flag overrides is the settings' own.
    expect(fromFlags.queue).toEqual(defaultSettings.queue)
  })

  test("the run's own choices: flag, then variable, then default", () => {
    const defaults = configOf({})
    expect(defaults).toMatchObject({
      tickets: false,
      ticket: null,
      feature: null,
      yes: false,
      limit: null,
      plain: false,
      prompt: join(repo, ".tutti", "worker-prompt.md"),
      worktrees: "/work/project-tutti",
      claude: null,
    })
    expect(defaults.usageLimitWait).toEqual(Duration.hours(6))

    const env = {
      TUTTI_TICKETS: "1",
      TUTTI_TICKET: "tutti-7",
      TUTTI_LIMIT: "5",
      TUTTI_PLAIN: "on",
      TUTTI_PROMPT: "/prompts/worker.md",
      TUTTI_WORKTREES: "../trees",
      TUTTI_USAGE_LIMIT_WAIT: "0",
      TUTTI_CLAUDE: "/usr/local/bin/claude",
    }
    const fromEnv = configOf({ env })
    expect(fromEnv).toMatchObject({
      tickets: true,
      ticket: "tutti-7",
      limit: 5,
      plain: true,
      prompt: "/prompts/worker.md",
      worktrees: "/work/trees",
      claude: "/usr/local/bin/claude",
    })
    expect(fromEnv.usageLimitWait).toEqual(Duration.zero)

    const fromFlags = configOf({
      env,
      flags: {
        tickets: "false",
        ticket: "tutti-8",
        limit: "0",
        plain: "false",
        prompt: "my-prompt.md",
        worktrees: "/elsewhere",
        usageLimitWait: "90m",
        claude: "claude",
      },
    })
    expect(fromFlags).toMatchObject({
      tickets: false,
      ticket: "tutti-8",
      limit: 0,
      plain: false,
      prompt: join(repo, "my-prompt.md"),
      worktrees: "/elsewhere",
      claude: "claude",
    })
    expect(fromFlags.usageLimitWait).toEqual(minutes(90))

    const feature = configOf({ env: { TUTTI_FEATURE: " dark mode " }, flags: { yes: "true" } })
    expect(feature).toMatchObject({ feature: "dark mode", yes: true })
  })

  test("an empty variable is unset", () => {
    expect(configOf({ env: { TUTTI_CONCURRENT: "", TUTTI_NOTIFY: "" } })).toMatchObject({
      notify: true,
      settings: { concurrent: 1 },
    })
  })

  test("orchestra's unprefixed variables are not read", () => {
    const env = {
      LIMIT: "3",
      NOTIFY: "0",
      TRIAGE: "0",
      REVIEW: "0",
      WT_ROOT: "/trees",
      WORKER_PROMPT: "/prompt.md",
      ORCHESTRA_CONCURRENT: "8",
      ORCHESTRA_TICKET: "x-1",
    }
    expect(configOf({ env })).toEqual(configOf({}))
  })
})

describe("problems", () => {
  test("a bad on-or-off value, from a flag or a variable", () => {
    expect(problemsOf({ flags: { review: "nope" } })).toEqual([
      "--review must be 1 or 0, true or false, yes or no, or on or off (got 'nope').",
    ])
    expect(problemsOf({ env: { TUTTI_NOTIFY: "sometimes", TUTTI_PLAIN: "2" } })).toEqual([
      "TUTTI_NOTIFY must be 1 or 0, true or false, yes or no, or on or off (got 'sometimes').",
      "TUTTI_PLAIN must be 1 or 0, true or false, yes or no, or on or off (got '2').",
    ])
  })

  test("concurrent out of range", () => {
    for (const bad of ["0", "17", "-1", "2.5", "two", " 3"]) {
      expect(problemsOf({ flags: { concurrent: bad } })).toEqual([
        `--concurrent must be a whole number from 1 to 16 (got '${bad}').`,
      ])
      expect(problemsOf({ env: { TUTTI_CONCURRENT: bad } })).toEqual([
        `TUTTI_CONCURRENT must be a whole number from 1 to 16 (got '${bad}').`,
      ])
    }
    expect(configOf({ flags: { concurrent: "16" } }).settings.concurrent).toBe(16)
  })

  test("a flag overrides its variable's bad value, which is then no problem", () => {
    expect(
      configOf({
        env: { TUTTI_CONCURRENT: "99", TUTTI_TRIAGE: "maybe" },
        flags: { concurrent: "2", triage: "1" },
      }),
    ).toMatchObject({ settings: { concurrent: 2, organs: { triage: true } } })
  })

  test("times, choices and text", () => {
    expect(
      problemsOf({
        flags: {
          checkTimeout: "0",
          checkFullTimeout: "soon",
          ticketLimit: "2 hours",
          usageLimitWait: "-1h",
          workerEffort: "huge",
          billing: "free",
          ticket: "  ",
          limit: "-3",
        },
        env: { TUTTI_APPEARANCE: "sepia", TUTTI_ORGAN_EFFORT: "none" },
      }),
    ).toEqual([
      "--ticket needs a ticket ID.",
      "--ticket-limit must be a time such as 30m or 2h, or 0 (got '2 hours').",
      "--limit must be a whole number (got '-3').",
      "--worker-effort must be low, medium, high, xhigh or max (got 'huge').",
      "TUTTI_ORGAN_EFFORT must be low, medium, high, xhigh or max (got 'none').",
      "--check-timeout must be a time longer than 0, such as 30m (got '0').",
      "--check-full-timeout must be a time such as 30m or 2h (got 'soon').",
      "--billing must be subscription or api (got 'free').",
      "--usage-limit-wait must be a time such as 30m or 2h, or 0 (got '-1h').",
      "TUTTI_APPEARANCE must be auto, light or dark (got 'sepia').",
    ])
  })

  test("flags that don't go together", () => {
    expect(problemsOf({ flags: { feature: "dark mode", ticket: "tutti-1" } })).toEqual([
      "--feature can't be combined with --ticket (or TUTTI_TICKET): a feature run is scoped to the epic it files.",
    ])
    expect(problemsOf({ flags: { feature: "dark mode", tickets: "true" } })).toEqual([
      "--feature can't be combined with --tickets: one runs a new feature, the other the current tickets.",
    ])
    expect(problemsOf({ flags: { yes: "true" } })).toEqual(["--yes only applies with --feature."])
    expect(problemsOf({ flags: { feature: "" } })).toEqual([
      `--feature needs the request: --feature "<what to build>".`,
    ])
    // A standing choice in a variable is no problem on a run it doesn't apply to.
    expect(
      configOf({ env: { TUTTI_TICKETS: "1", TUTTI_YES: "1" }, flags: { feature: "x" } }),
    ).toMatchObject({ feature: "x", tickets: true, yes: true })
    expect(configOf({ env: { TUTTI_YES: "1" } }).yes).toBe(true)
  })

  test("the worktrees must be outside the repository", () => {
    expect(problemsOf({ flags: { worktrees: "trees" } })).toEqual([
      "--worktrees (or TUTTI_WORKTREES) (/work/project/trees) must be outside the repository, or git sees the worktrees as untracked files.",
    ])
    expect(problemsOf({ env: { TUTTI_WORKTREES: "/work/project" } })).toHaveLength(1)
    expect(configOf({ flags: { worktrees: "/work/project-trees" } }).worktrees).toBe(
      "/work/project-trees",
    )
  })
})

describe("the live layer", () => {
  const setUp = (settings: unknown, userConfig: unknown) => {
    const project = mkdtempSync(join(tmpdir(), "tutti-app-config-"))
    if (settings !== undefined) {
      mkdirSync(join(project, ".tutti"))
      writeFileSync(join(project, ".tutti", "settings.json"), JSON.stringify(settings))
    }
    const xdg = mkdtempSync(join(tmpdir(), "tutti-xdg-"))
    if (userConfig !== undefined) {
      mkdirSync(join(xdg, "tutti"))
      writeFileSync(join(xdg, "tutti", "config.json"), JSON.stringify(userConfig))
    }
    return { project, xdg }
  }

  const loadIn = (
    dirs: { project: string; xdg: string },
    flags: RunFlags,
    env: Record<string, string> = {},
  ) =>
    Effect.runPromise(
      Effect.exit(
        load(flags, dirs.project).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { ...env, XDG_CONFIG_HOME: dirs.xdg, HOME: "/nowhere" },
              }),
            ),
          ),
          Effect.provide(BunServices.layer),
        ),
      ),
    )

  test("reads the flags, the variables, the user config and the settings", async () => {
    const dirs = setUp(
      { concurrent: 3, ui: { colour_scheme: "project" }, organs: { triage: false } },
      { colour_scheme: "mine", notify: false },
    )
    const exit = await loadIn(dirs, flagsOf({ review: "false" }), { TUTTI_TRIAGE: "1" })
    if (Exit.isFailure(exit)) throw new Error(`${exit.cause}`)
    expect(exit.value).toMatchObject({
      repo: dirs.project,
      colourScheme: "mine",
      notify: false,
      settings: { concurrent: 3, organs: { triage: true, review: false } },
    })
  })

  test("every problem is listed together in one SetupProblem", async () => {
    const dirs = setUp({ concurrent: 40, workers: { effort: "huge" } }, { billing: "free" })
    const exit = await loadIn(dirs, flagsOf({ concurrent: "0", triage: "maybe" }), {
      TUTTI_NOTIFY: "perhaps",
    })
    if (Exit.isSuccess(exit)) throw new Error("expected a SetupProblem")
    const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    const error = reason?.error as SetupProblem
    expect(error._tag).toBe("SetupProblem")
    const settingsFile = join(dirs.project, ".tutti", "settings.json")
    const userFile = join(dirs.xdg, "tutti", "config.json")
    expect(error.problems).toEqual([
      "--concurrent must be a whole number from 1 to 16 (got '0').",
      "--triage must be 1 or 0, true or false, yes or no, or on or off (got 'maybe').",
      "TUTTI_NOTIFY must be 1 or 0, true or false, yes or no, or on or off (got 'perhaps').",
      `${userFile}: billing: Expected one of subscription, api, got "free"`,
      `${settingsFile}: concurrent: Expected a value between 1 and 16, got 40`,
      `${settingsFile}: workers.effort: Expected one of low, medium, high, xhigh, max, or null, got "huge"`,
    ])
    expect(error.message).toBe(error.problems.join("\n"))
  })

  test("missing files give the defaults", async () => {
    const dirs = setUp(undefined, undefined)
    const exit = await loadIn(dirs, noFlags)
    if (Exit.isFailure(exit)) throw new Error(`${exit.cause}`)
    // The folder of runs is orchestra's in HOME's cache folder (src/run/machine.ts).
    const runs = runsDir((name) => (name === "HOME" ? "/nowhere" : undefined))
    // The live layer counts this machine's cores for the default cap, where appConfig takes
    // testCores (10): CI's runners have 2 (2026-10-22).
    const cores = availableParallelism()
    expect(exit.value).toEqual(
      appConfig(
        {
          runs,
          // appConfig's settings name a merge check; a project with no settings file names none.
          settings: defaultSettings,
          machineWorkers: defaultMachineWorkers(cores),
          machineWorkersFrom: defaultMachineWorkersFrom(cores),
        },
        dirs.project,
      ),
    )
  })
})

describe("the test layer", () => {
  test("provides a literal value, the defaults with overrides laid over them", async () => {
    const value = appConfig({ limit: 3, plain: true })
    expect(value).toMatchObject({ repo, limit: 3, plain: true, colourScheme: "orchestra" })
    const read = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return (yield* AppConfig).limit
        }),
        testLayer(value),
      ),
    )
    expect(read).toBe(3)
  })
})
