// --overnight's flags (§ 8.2; tutti-kkb.46): it runs the current tickets without asking, keeps the
// machine awake whatever keep_awake says (keep-awake-default.test.ts), turns on --auto-answer,
// which its own flag overrides, and goes with neither --feature nor a --force-overnight of its own; --overnight-free-disk is the free disk its pre-flight wants.
import { describe, expect, test } from "bun:test"
import { Duration, Option, Result } from "effect"
import {
  type AppConfigValue,
  defaultOvernightFreeDisk,
  defaultSettings,
  defaultUserConfig,
  resolve,
} from "../src/cli/AppConfig.ts"
import { noFlags, type RunFlagName, type RunFlags } from "../src/cli/flags.ts"
import { asking } from "../src/run/choose.ts"

const flagsOf = (given: Partial<Record<RunFlagName, string>>): RunFlags => ({
  ...noFlags,
  ...Object.fromEntries(Object.entries(given).map(([key, text]) => [key, Option.some(text)])),
})

const resolved = (flags: Partial<Record<RunFlagName, string>>, env: Record<string, string> = {}) =>
  resolve({
    repo: "/work/project",
    flags: flagsOf(flags),
    env: (name) => env[name],
    user: defaultUserConfig,
    settings: defaultSettings,
  })

const configOf = (
  flags: Partial<Record<RunFlagName, string>>,
  env: Record<string, string> = {},
): AppConfigValue => {
  const result = resolved(flags, env)
  if (Result.isFailure(result)) throw new Error(`expected a config, got ${result.failure}`)
  return result.success
}

const problemsOf = (flags: Partial<Record<RunFlagName, string>>): ReadonlyArray<string> => {
  const result = resolved(flags)
  if (Result.isSuccess(result)) throw new Error("expected problems, got a config")
  return result.failure
}

describe("--overnight", () => {
  test("is off by default, and so is the auto-answer it turns on", () => {
    const config = configOf({})
    expect(config).toMatchObject({
      overnight: false,
      forceOvernight: false,
      overnightFreeDisk: defaultOvernightFreeDisk,
      autoAnswer: null,
      tickets: false,
    })
    expect(defaultOvernightFreeDisk).toBe(20)
  })

  test("keeps the machine awake, turns on --auto-answer at once, and runs the current tickets", () => {
    const config = configOf({ overnight: "true" })
    expect(config).toMatchObject({ overnight: true, keepAwake: true, tickets: true })
    expect(config.autoAnswer).toEqual(Duration.zero)
    expect(configOf({}, { TUTTI_OVERNIGHT: "1" }).overnight).toBe(true)
  })

  test("never asks what to work on", () => {
    const tty = { stdinIsTty: true, stdoutIsTty: true }
    const dashboard = { _tag: "Dashboard" } as const
    expect(asking(tty, configOf({}), dashboard)).toBe("renderer")
    expect(asking(tty, configOf({ overnight: "true" }), dashboard)).toBe("no")
    expect(asking(tty, configOf({ overnight: "true", ticket: "tut-1" }), dashboard)).toBe("no")
  })

  test("--auto-answer=false or a time given with it overrides the auto-answer", () => {
    expect(configOf({ overnight: "true", autoAnswer: "false" }).autoAnswer).toBeNull()
    expect(configOf({ overnight: "true", autoAnswer: "10m" }).autoAnswer).toEqual(
      Duration.minutes(10),
    )
    expect(configOf({ overnight: "true" }, { TUTTI_AUTO_ANSWER: "0" }).autoAnswer).toBeNull()
  })

  test("with --feature is a usage problem", () => {
    expect(problemsOf({ overnight: "true", feature: "dark mode" })).toEqual([
      "--overnight can't be combined with --feature: an overnight run works on the current tickets, or --ticket's.",
    ])
  })

  test("--force-overnight without it is a usage problem", () => {
    expect(problemsOf({ forceOvernight: "true" })).toEqual([
      "--force-overnight only applies with --overnight.",
    ])
    expect(configOf({ overnight: "true", forceOvernight: "true" }).forceOvernight).toBe(true)
    // Off, it asks for nothing.
    expect(configOf({ forceOvernight: "false" }).forceOvernight).toBe(false)
  })

  test("--overnight-free-disk takes the GB wanted, 0 for none", () => {
    expect(configOf({ overnight: "true", overnightFreeDisk: "50" }).overnightFreeDisk).toBe(50)
    expect(configOf({ overnight: "true", overnightFreeDisk: "0" }).overnightFreeDisk).toBe(0)
    expect(problemsOf({ overnightFreeDisk: "lots" })).toEqual([
      "--overnight-free-disk must be a whole number (got 'lots').",
    ])
  })
})
