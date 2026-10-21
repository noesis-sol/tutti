import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Duration, Effect, Exit, Option } from "effect"
import fc from "fast-check"
import {
  type ConfigFileInvalid,
  type ConfigProblem,
  formatDuration,
  parseDuration,
} from "../src/project/configFile.ts"
import {
  defaultSetupFiles,
  readSettings,
  type Settings,
  settingsPath,
} from "../src/project/settings.ts"
import { readUserConfig, userConfigPath } from "../src/project/userConfig.ts"

const example = {
  $schema: "https://raw.githubusercontent.com/noesis-sol/tutti/main/schema/settings.json",
  version: 1,
  concurrent: 2,
  keep_awake: false,
  checks: {
    fast: { command: "scripts/check-fast.sh", timeout: "30m" },
    full: { command: "scripts/check-full.sh", timeout: "60m" },
    setup: { command: "bun install --frozen-lockfile", files: ["bun.lock"] },
  },
  workers: {
    mcp_servers: ["postgres"],
    permission_mode: "auto",
    effort: "medium",
    model: null,
    ticket_limit: "2h",
    ask_user_question: true,
  },
  templates: { worker_prompt: 5, verifier: 2 },
  organs: { effort: null, model: null, triage: true, review: true },
  queue: { exclude_types: ["epic"], footprint: true },
  merge: { resolve_conflicts: true, resolve_timeout: "20m", check_hand_backs: 2 },
  environment_hold: { count: 2, window: "2m", probe: "10m" },
  ui: { colour_scheme: "orchestra" },
}

const project = (settings?: unknown): string => {
  const repo = mkdtempSync(join(tmpdir(), "tutti-settings-"))
  if (settings !== undefined) {
    mkdirSync(join(repo, ".tutti"))
    const text = typeof settings === "string" ? settings : JSON.stringify(settings)
    writeFileSync(settingsPath(repo), text)
  }
  return repo
}

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(Effect.exit(Effect.provide(effect, BunServices.layer)))

const settingsOf = async (settings?: unknown) => {
  const exit = await run(readSettings(project(settings)))
  if (Exit.isFailure(exit)) throw new Error(`expected settings, got ${exit.cause}`)
  return exit.value
}

const problemsIn = (exit: Exit.Exit<unknown, ConfigFileInvalid>): ReadonlyArray<ConfigProblem> => {
  if (Exit.isSuccess(exit)) throw new Error(`expected problems, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error.problems
}

/** The problems with the settings: the example with `change` applied to a copy of it. */
const settingsProblems = async (change: (settings: typeof example) => void) => {
  const settings = structuredClone(example)
  change(settings)
  const repo = project(settings)
  const problems = problemsIn(await run(readSettings(repo)))
  for (const problem of problems) expect(problem.file).toBe(settingsPath(repo))
  return problems.map(({ path, message }) => ({ path, message }))
}

const minutes = (n: number) => Duration.minutes(n)

describe("settings", () => {
  test("§ 8.4's example decodes to the expected value", async () => {
    const settings = await settingsOf(example)
    expect(settings).toEqual({
      $schema: example.$schema,
      version: 1,
      concurrent: 2,
      keep_awake: false,
      checks: {
        fast: { command: "scripts/check-fast.sh", timeout: minutes(30) },
        full: { command: "scripts/check-full.sh", timeout: minutes(60) },
        own: { command: null },
        setup: { command: "bun install --frozen-lockfile", files: ["bun.lock"] },
      },
      requires: [],
      workers: {
        mcp_servers: ["postgres"],
        permission_mode: "auto",
        effort: "medium",
        model: null,
        ticket_limit: Duration.hours(2),
        ask_user_question: true,
      },
      templates: { worker_prompt: 5, verifier: 2 },
      organs: { effort: null, model: null, triage: true, review: true },
      queue: { exclude_types: ["epic"], footprint: true },
      merge: {
        resolve_conflicts: true,
        resolve_timeout: minutes(20),
        check_hand_backs: 2,
        train: 1,
      },
      environment_hold: { count: 2, window: minutes(2), probe: minutes(10) },
      ui: { colour_scheme: "orchestra" },
    })
  })

  const defaults: Settings = {
    version: 1,
    concurrent: 1,
    keep_awake: false,
    checks: {
      fast: { command: null, timeout: minutes(30) },
      full: { command: null, timeout: minutes(60) },
      own: { command: null },
      setup: { command: null, files: defaultSetupFiles },
    },
    requires: [],
    workers: {
      mcp_servers: [],
      permission_mode: "auto",
      effort: "high",
      model: null,
      ticket_limit: null,
      ask_user_question: true,
    },
    templates: { worker_prompt: 0, verifier: 0 },
    organs: { effort: null, model: null, triage: true, review: true },
    queue: { exclude_types: ["epic"], footprint: true },
    merge: {
      resolve_conflicts: true,
      resolve_timeout: minutes(20),
      check_hand_backs: 2,
      train: 1,
    },
    environment_hold: { count: 2, window: minutes(2), probe: minutes(10) },
    ui: { colour_scheme: "orchestra" },
  }

  test("a missing file gives the defaults", async () => {
    expect(await settingsOf()).toEqual(defaults)
  })

  test("an empty object gives the defaults", async () => {
    expect(await settingsOf({})).toEqual(defaults)
  })

  test("a section with some keys takes the defaults for the others", async () => {
    const settings = await settingsOf({ workers: { model: "opus" }, checks: { fast: {} } })
    expect(settings.workers).toEqual({ ...defaults.workers, model: "opus" })
    expect(settings.checks.fast).toEqual(defaults.checks.fast)
  })

  test("the permission modes it takes", async () => {
    for (const mode of ["auto", "default", "acceptEdits"]) {
      const settings = await settingsOf({ workers: { permission_mode: mode } })
      expect<string>(settings.workers.permission_mode).toBe(mode)
    }
  })

  test("bypassPermissions and plan as permission_mode are refused, saying why", async () => {
    expect(
      await settingsProblems((s) => {
        s.workers.permission_mode = "bypassPermissions"
      }),
    ).toEqual([
      {
        path: "workers.permission_mode",
        message:
          "can't be bypassPermissions: a worker in it would run every command unchecked, where auto " +
          "has Claude Code's classifier check them. Use one of auto, default, acceptEdits",
      },
    ])
    expect(
      await settingsProblems((s) => {
        s.workers.permission_mode = "plan"
      }),
    ).toEqual([
      {
        path: "workers.permission_mode",
        message:
          "can't be plan: a worker in it only plans, and never changes a file. Use one of auto, " +
          "default, acceptEdits",
      },
    ])
  })

  test("each enum's bad value is reported with its path", async () => {
    expect(
      await settingsProblems((s) => {
        s.workers.permission_mode = "yolo"
        s.workers.effort = "huge"
        ;(s.organs as { effort: unknown }).effort = "tiny"
      }),
    ).toEqual([
      {
        path: "workers.permission_mode",
        message: `Expected one of auto, default, acceptEdits, got "yolo"`,
      },
      {
        path: "workers.effort",
        message: `Expected one of low, medium, high, xhigh, max, or null, got "huge"`,
      },
      {
        path: "organs.effort",
        message: `Expected one of low, medium, high, xhigh, max, or null, got "tiny"`,
      },
    ])
  })

  test("an unknown key is a problem naming it, at the top or in a section", async () => {
    expect(
      await settingsProblems((s) => {
        Object.assign(s, { check_fast: "scripts/check-fast.sh" })
        Object.assign(s.workers, { terminal: "tmux" })
      }),
    ).toEqual([
      { path: "check_fast", message: `unknown key "check_fast"` },
      { path: "workers.terminal", message: `unknown key "terminal"` },
    ])
  })

  test("$schema is allowed, and may be left out", async () => {
    const { $schema: _, ...rest } = example
    expect((await settingsOf(rest)).$schema).toBeUndefined()
  })

  test("a bad duration is reported with its path", async () => {
    expect(
      await settingsProblems((s) => {
        s.checks.fast.timeout = "soon"
        s.workers.ticket_limit = "2 hours"
        ;(s.merge as { resolve_timeout: unknown }).resolve_timeout = 20
        s.environment_hold.window = "0"
      }),
    ).toEqual([
      { path: "checks.fast.timeout", message: `Expected a time such as "30m" or "2h", got "soon"` },
      {
        path: "workers.ticket_limit",
        message: `Expected a time such as "30m" or "2h", got "2 hours"`,
      },
      { path: "merge.resolve_timeout", message: "Expected string, got 20" },
      {
        path: "environment_hold.window",
        message: `Expected a time longer than 0, such as "30m", got "0"`,
      },
    ])
  })

  test("every problem in a section is reported, a zero time's among them", async () => {
    expect(
      await settingsProblems((s) => {
        ;(s.workers as { permission_mode: unknown }).permission_mode = "plan"
        s.workers.ticket_limit = "0"
        ;(s.workers as { model: unknown }).model = 3
        Object.assign(s.workers, { foo: 1 })
        s.merge.resolve_timeout = "soon"
        ;(s.merge as { resolve_conflicts: unknown }).resolve_conflicts = "yes"
      }),
    ).toEqual([
      { path: "workers.foo", message: `unknown key "foo"` },
      {
        path: "workers.permission_mode",
        message:
          "can't be plan: a worker in it only plans, and never changes a file. Use one of auto, " +
          "default, acceptEdits",
      },
      { path: "workers.model", message: "Expected string | null, got 3" },
      {
        path: "workers.ticket_limit",
        message: `Expected a time longer than 0, such as "30m", got "0"`,
      },
      { path: "merge.resolve_conflicts", message: `Expected boolean, got "yes"` },
      {
        path: "merge.resolve_timeout",
        message: `Expected a time such as "30m" or "2h", got "soon"`,
      },
    ])
  })

  test("times take Go's units and the probe takes 0", async () => {
    const settings = await settingsOf({
      checks: { full: { timeout: "1h30m" } },
      environment_hold: { window: "90s", probe: "0" },
    })
    expect(settings.checks.full.timeout).toEqual(minutes(90))
    expect(settings.environment_hold.window).toEqual(Duration.seconds(90))
    expect(settings.environment_hold.probe).toEqual(Duration.zero)
  })

  test("concurrent must be a whole number from 1 to 16", async () => {
    for (const concurrent of [0, 17, 1.5]) {
      const problems = await settingsProblems((s) => {
        s.concurrent = concurrent
      })
      expect(problems.map(({ path }) => path)).toEqual(["concurrent"])
    }
    expect((await settingsOf({ concurrent: 16 })).concurrent).toBe(16)
  })

  test("other bad values are reported with their paths", async () => {
    expect(
      await settingsProblems((s) => {
        ;(s as { version: unknown }).version = 2
        s.queue.exclude_types = ["epic,chore"]
        s.merge.check_hand_backs = -1
        s.checks.setup.files = ["bun.lock", ""]
        ;(s.ui as { colour_scheme: unknown }).colour_scheme = null
      }),
    ).toEqual([
      { path: "version", message: "Expected 1, got 2" },
      {
        path: "checks.setup.files[1]",
        message: `Expected a value with a length of at least 1, got ""`,
      },
      {
        path: "queue.exclude_types[0]",
        message: `Expected an issue type such as "epic", got "epic,chore"`,
      },
      {
        path: "merge.check_hand_backs",
        message: "Expected a value greater than or equal to 0, got -1",
      },
      { path: "ui.colour_scheme", message: "Expected string, got null" },
    ])
  })

  test("a file that isn't JSON, or isn't an object, is one problem", async () => {
    const repo = project("{ concurrent: 2 }")
    const [problem, ...more] = problemsIn(await run(readSettings(repo)))
    expect(more).toEqual([])
    expect(problem?.file).toBe(settingsPath(repo))
    expect(problem?.path).toBe("")
    expect(problem?.message).toStartWith("isn't valid JSON: ")

    expect(problemsIn(await run(readSettings(project([])))).map(({ path }) => path)).toEqual([""])
  })

  test("a file that can't be read is one problem", async () => {
    const repo = project()
    mkdirSync(settingsPath(repo), { recursive: true })
    const problems = problemsIn(await run(readSettings(repo)))
    expect(problems.map(({ path }) => path)).toEqual([""])
    expect(problems[0]?.message).toStartWith("can't be read: ")
  })
})

describe("user config", () => {
  const withEnv = <A, E>(
    env: Record<string, string>,
    effect: Effect.Effect<A, E, BunServices.BunServices>,
  ) => run(Effect.provide(effect, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

  const userConfigIn = (config: unknown) => {
    const xdg = mkdtempSync(join(tmpdir(), "tutti-xdg-"))
    mkdirSync(join(xdg, "tutti"))
    writeFileSync(join(xdg, "tutti", "config.json"), JSON.stringify(config))
    return withEnv({ XDG_CONFIG_HOME: xdg, HOME: "/nowhere" }, readUserConfig)
  }

  test("it is in $XDG_CONFIG_HOME/tutti, else ~/.config/tutti", async () => {
    const path = async (env: Record<string, string>) => {
      const exit = await withEnv(env, userConfigPath)
      if (Exit.isFailure(exit)) throw new Error(`${exit.cause}`)
      return exit.value
    }
    expect(await path({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" })).toBe("/xdg/tutti/config.json")
    expect(await path({ HOME: "/home/me" })).toBe("/home/me/.config/tutti/config.json")
    expect(await path({ XDG_CONFIG_HOME: "", HOME: "/home/me" })).toBe(
      "/home/me/.config/tutti/config.json",
    )
    expect(await path({ XDG_CONFIG_HOME: "relative", HOME: "/home/me" })).toBe(
      "/home/me/.config/tutti/config.json",
    )
  })

  test("the reader honours XDG_CONFIG_HOME", async () => {
    const exit = await userConfigIn({ mouse: false, billing: "api", colour_scheme: "solarized" })
    expect(exit).toEqual(
      Exit.succeed({
        mouse: false,
        notify: true,
        billing: "api",
        appearance: "auto",
        colour_scheme: "solarized",
      }),
    )
  })

  test("a missing file gives the defaults", async () => {
    const exit = await withEnv({ HOME: mkdtempSync(join(tmpdir(), "tutti-home-")) }, readUserConfig)
    expect(exit).toEqual(
      Exit.succeed({
        mouse: true,
        notify: true,
        billing: "subscription",
        appearance: "auto",
        colour_scheme: null,
      }),
    )
  })

  test("each enum's bad value and an unknown key are reported with their paths", async () => {
    const problems = problemsIn(
      await userConfigIn({ billing: "free", appearance: "sepia", notify: "no", theme: "dark" }),
    )
    expect(problems.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: "theme", message: `unknown key "theme"` },
      { path: "notify", message: `Expected boolean, got "no"` },
      { path: "billing", message: `Expected one of subscription, api, got "free"` },
      { path: "appearance", message: `Expected one of auto, light, dark, got "sepia"` },
    ])
    for (const problem of problems) expect(problem.file).toEndWith(join("tutti", "config.json"))
  })
})

describe("durations", () => {
  test("Go's units, from ms to h", () => {
    expect(parseDuration("30m")).toEqual(Option.some(minutes(30)))
    expect(parseDuration("1h30m")).toEqual(Option.some(minutes(90)))
    expect(parseDuration("1.5h")).toEqual(Option.some(minutes(90)))
    expect(parseDuration("250ms")).toEqual(Option.some(Duration.millis(250)))
    expect(parseDuration("0")).toEqual(Option.some(Duration.zero))
    for (const bad of ["", "30", "m", "30 m", "-5m", "2d", "1h 30m", "30mm"]) {
      expect(parseDuration(bad)).toEqual(Option.none())
    }
  })

  test("formatDuration writes what parseDuration reads back", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), (millis) => {
        const text = formatDuration(Duration.millis(millis))
        expect(parseDuration(text)).toEqual(Option.some(Duration.millis(millis)))
      }),
    )
  })

  test("parseDuration takes any text without throwing", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const parsed = parseDuration(text)
        if (Option.isSome(parsed)) expect(Duration.toMillis(parsed.value)).toBeGreaterThanOrEqual(0)
      }),
    )
  })
})
