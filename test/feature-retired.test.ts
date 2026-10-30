// What went with the unattended feature run (§ 5 item 13, § 8.2): --feature talks the feature
// through in the Interview view, so --yes and TUTTI_YES stop the run at the startup checks, with
// any value, saying what to run instead; --refine with --feature is taken and changes nothing; and
// the screen and plan organs are gone, organs.screen and organs.plan in the settings or the user
// config read whatever they are, ignored with one note each naming the key and its file, and left
// out of the published schemas.
import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Option, Result } from "effect"
import { Command } from "effect/cli"
import { schemaText } from "../scripts/gen-schemas.ts"
import {
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  defaultUserFile,
  resolve,
  type Sources,
} from "../src/cli/AppConfig.ts"
import { cliFlags, noFlags, type RunFlags, retiredFlags } from "../src/cli/flags.ts"
import { organNames } from "../src/organs/Organs.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import { Settings, settingsFile } from "../src/project/settings.ts"
import { UserConfig } from "../src/project/userConfig.ts"
import { keepAwakeNotes } from "../src/run/keepAwake.ts"

/** The resolution of `sources` over no flags, variables, user config or settings. */
const resolved = (sources: Partial<Sources> = {}) =>
  resolve({
    repo: "/work/project",
    flags: noFlags,
    env: () => undefined,
    user: defaultUserConfig,
    settings: defaultSettings,
    ...sources,
  })

const configOf = (sources: Partial<Sources> = {}): AppConfigValue => {
  const result = resolved(sources)
  if (Result.isFailure(result)) throw new Error(result.failure.join("\n"))
  return result.success
}

const problemsOf = (sources: Partial<Sources> = {}): ReadonlyArray<string> => {
  const result = resolved(sources)
  if (Result.isSuccess(result)) throw new Error("expected problems, got a config")
  return result.failure
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

const feature = Option.some("Add a greeting")

const yesSaid =
  "is no longer read: --feature always talks the feature through with you; tutti --spec <file> runs a request written to a file unattended."

describe("--yes and TUTTI_YES", () => {
  test("stop the run with any value, alone or with --feature, the flag named over its variable", async () => {
    expect(retiredFlags.yes.variable).toBe("TUTTI_YES")
    for (const args of [["--yes"], ["--yes=0"], ["--yes=maybe"], ["--feature", "x", "--yes"]]) {
      const flags = await parse(args)
      expect(Option.isSome(flags.yes)).toBe(true)
      expect(problemsOf({ flags })).toEqual([`--yes ${yesSaid}`])
    }
    const env = (name: string) => (name === "TUTTI_YES" ? "1" : undefined)
    expect(problemsOf({ env })).toEqual([`TUTTI_YES ${yesSaid}`])
    expect(problemsOf({ env, flags: { ...noFlags, feature } })).toEqual([`TUTTI_YES ${yesSaid}`])
    expect(problemsOf({ env, flags: { ...noFlags, yes: Option.some("true") } })).toEqual([
      `--yes ${yesSaid}`,
    ])
    // An empty variable is unset.
    expect(configOf({ env: (name) => (name === "TUTTI_YES" ? "" : undefined) }).feature).toBeNull()
  })

  test("are no note in the START block: the run doesn't start", async () => {
    const result = resolved({ flags: await parse(["--yes"]) })
    expect(Result.isFailure(result)).toBe(true)
    expect(keepAwakeNotes(configOf())).toEqual([])
  })
})

describe("--refine with --feature", () => {
  test("is taken, and changes nothing; without --spec or --feature it is a problem", () => {
    const config = configOf({ flags: { ...noFlags, feature, refine: Option.some("true") } })
    expect(config).toMatchObject({ feature: "Add a greeting", refine: true, spec: null })
    expect(problemsOf({ flags: { ...noFlags, refine: Option.some("true") } })).toEqual([
      "--refine only applies with --spec.",
    ])
  })
})

describe("the screen and plan organs", () => {
  test("are gone from the organs", () => {
    expect([...organNames]).toEqual(["triage", "predictor", "reviewer", "scout"])
  })

  test("organs.screen and organs.plan in the settings are read whatever they are, and noted", () => {
    const decoded = (json: unknown) => {
      const exit = decodeConfig(Settings, "settings.json", json)
      if (Exit.isFailure(exit)) throw new Error(`doesn't decode: ${JSON.stringify(json)}`)
      return exit.value
    }
    for (const value of [true, false, { effort: "low" }, null, "x"]) {
      const settings = decoded({ organs: { triage: false, screen: value, plan: value } })
      const config = configOf({ settings })
      expect(config.settings.organs).toEqual({
        effort: null,
        model: null,
        triage: false,
        review: true,
      })
      expect(keepAwakeNotes(config)).toEqual([
        `organs.screen in ${settingsFile} is no longer read: the screen organ is gone, and --feature talks the feature through with you`,
        `organs.plan in ${settingsFile} is no longer read: the plan organ is gone, and --feature talks the feature through with you`,
      ])
    }
    expect(keepAwakeNotes(configOf({ settings: decoded({ organs: { triage: true } }) }))).toEqual(
      [],
    )
    // Any other key under organs is still refused.
    expect(
      Exit.isFailure(decodeConfig(Settings, "settings.json", { organs: { scout: true } })),
    ).toBe(true)
  })

  test("organs.screen and organs.plan in the user config are read and noted, naming its file", () => {
    const decoded = (json: unknown) => {
      const exit = decodeConfig(UserConfig, "config.json", json)
      if (Exit.isFailure(exit)) throw new Error(`doesn't decode: ${JSON.stringify(json)}`)
      return exit.value
    }
    expect(decoded({}).organs).toBeUndefined()
    const user = decoded({ organs: { plan: { effort: "high" } } })
    expect(keepAwakeNotes(configOf({ user }))).toEqual([
      `organs.plan in ${defaultUserFile} is no longer read: the plan organ is gone, and --feature talks the feature through with you`,
    ])
    expect(keepAwakeNotes(configOf({ user, userFile: "/xdg/tutti/config.json" }))).toEqual([
      "organs.plan in /xdg/tutti/config.json is no longer read: the plan organ is gone, and --feature talks the feature through with you",
    ])
    expect(
      Exit.isFailure(decodeConfig(UserConfig, "config.json", { organs: { triage: true } })),
    ).toBe(true)
  })

  test("the published schemas leave the keys out, so an editor flags them", () => {
    const properties = (name: "settings.json" | "user-config.json") =>
      (JSON.parse(schemaText(name)) as { properties: Record<string, { properties?: object }> })
        .properties
    expect(Object.keys(properties("settings.json").organs?.properties ?? {})).toEqual([
      "effort",
      "model",
      "triage",
      "review",
    ])
    expect(Object.keys(properties("user-config.json"))).not.toContain("organs")
  })
})
