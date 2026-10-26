// A spec run's flags and settings (§ 4.14, § 8.2, § 8.4): --spec, --refine, --spec-timeout and
// --spec-effort, their variables, the settings' spec.timeout and spec.effort, the combinations that
// are setup problems, and orchestra's spec_timeout and spec_effort imported by init.
import { describe, expect, test } from "bun:test"
import { Duration, Option, Result } from "effect"
import {
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  resolve,
} from "../src/cli/AppConfig.ts"
import { specSetupFlags } from "../src/cli/commands.ts"
import { noFlags, type RunFlagName } from "../src/cli/flags.ts"
import { importSettings } from "../src/init/import.ts"

const resolved = (
  flags: Partial<Record<RunFlagName, string>> = {},
  env: Record<string, string> = {},
): Result.Result<AppConfigValue, ReadonlyArray<string>> =>
  resolve({
    repo: "/work/shop",
    flags: {
      ...noFlags,
      ...Object.fromEntries(Object.entries(flags).map(([key, text]) => [key, Option.some(text)])),
    },
    env: (name) => env[name],
    user: defaultUserConfig,
    settings: defaultSettings,
  })

const config = (
  flags: Partial<Record<RunFlagName, string>> = {},
  env: Record<string, string> = {},
) => {
  const result = resolved(flags, env)
  if (Result.isFailure(result)) throw new Error(result.failure.join("\n"))
  return result.success
}

const problems = (
  flags: Partial<Record<RunFlagName, string>>,
  env: Record<string, string> = {},
) => {
  const result = resolved(flags, env)
  return Result.isFailure(result) ? result.failure : []
}

describe("--spec", () => {
  test("none by default; the breakdown's time limit and effort from the settings", () => {
    const c = config()
    expect(c.spec).toBeNull()
    expect(c.refine).toBe(false)
    expect(c.settings.spec).toEqual({ timeout: Duration.minutes(60), effort: "high" })
  })

  test("the spec as given, and what gave it", () => {
    expect(config({ spec: "~/specs/shop.md" })).toMatchObject({
      spec: "~/specs/shop.md",
      specFrom: "--spec",
    })
    expect(config({}, { TUTTI_SPEC: "docs/shop.md", TUTTI_REFINE: "1" })).toMatchObject({
      spec: "docs/shop.md",
      specFrom: "TUTTI_SPEC",
      refine: true,
    })
  })

  test("--spec-timeout and --spec-effort override the settings", () => {
    expect(config({ spec: "a.md", specTimeout: "90m", specEffort: "max" }).settings.spec).toEqual({
      timeout: Duration.minutes(90),
      effort: "max",
    })
    expect(problems({ specEffort: "huge" })).toEqual([
      "--spec-effort must be low, medium, high, xhigh or max (got 'huge').",
    ])
  })

  test("can't be combined with --feature, --ticket, --tickets or --overnight, nor run none of it", () => {
    const found = problems({
      spec: "a.md",
      feature: "x",
      ticket: "t-1",
      tickets: "true",
      limit: "0",
    })
    for (const problem of [
      "--spec can't be combined with --feature: one builds a spec, the other a feature request.",
      "--spec can't be combined with --ticket (or TUTTI_TICKET): a spec run is scoped to the root epic of its tree.",
      "--spec can't be combined with --tickets: one builds a spec, the other runs the current tickets.",
      "--spec would break the spec down and run none of it: --limit (or TUTTI_LIMIT) is 0. Raise --limit.",
    ]) {
      expect(found).toContain(problem)
    }
    expect(problems({ overnight: "true" }, { TUTTI_SPEC: "a.md" })).toContain(
      "TUTTI_SPEC can't be combined with --overnight: an overnight run works on the current tickets, or --ticket's.",
    )
  })

  test("--refine without a spec is a problem", () => {
    expect(problems({ refine: "true" })).toEqual(["--refine only applies with --spec."])
  })
})

describe("orchestra's spec settings, imported", () => {
  test("spec_timeout and spec_effort go to spec.timeout and spec.effort", () => {
    const imported = importSettings({ spec_timeout: "90m", spec_effort: "max" })
    expect(imported.json).toEqual({ spec: { timeout: "90m", effort: "max" } })
    expect(imported.imported).toEqual([
      { key: "spec_timeout", to: "spec.timeout" },
      { key: "spec_effort", to: "spec.effort" },
    ])
    expect(imported.leftOut).toEqual([])
  })
})

describe("a spec run's setup", () => {
  test("is init without a terminal: its defaults, declining what it offers, checks to come", () => {
    expect(specSetupFlags(null)).toEqual({
      force: false,
      checkFast: "",
      checkFull: "",
      verifier: false,
      changelogUnion: false,
      installBeads: false,
      mcp: [],
    })
    expect(specSetupFlags(3).concurrent).toBe(3)
  })
})
