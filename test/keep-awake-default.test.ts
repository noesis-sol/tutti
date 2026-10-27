// Keeping the machine awake by default (§ 8.2, tutti-22jf): a run keeps it awake unless keep_awake
// is false in the project's settings or the user config, whose choice wins; --overnight keeps it
// awake whatever they say. --keep-awake and TUTTI_KEEP_AWAKE are retired: out of --help, still
// taken with any value, and named once in the START block. tutti init writes the key, init --update
// adds it where missing, the orchestra import copies orchestra's, and the published schemas have it.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Option, Result } from "effect"
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
import { importSettings } from "../src/init/import.ts"
import { latestVersion, promptChanges } from "../src/init/templates.ts"
import { updateTemplates } from "../src/init/update.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { Settings } from "../src/project/settings.ts"
import settingsTemplate from "../src/project/templates/settings.json" with { type: "json" }
import { UserConfig, userConfigShown } from "../src/project/userConfig.ts"
import { keepAwakeNotes } from "../src/run/keepAwake.ts"

const root = join(import.meta.dir, "..")

// The --help test starts tutti as a bun process, which bun's 5 s default fails when other checks
// run beside this one.
setDefaultTimeout(30_000)

/** The run's configuration from `sources` over no flags, variables, user config or settings. */
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

const settings = (keepAwake: boolean) => ({ ...defaultSettings, keep_awake: keepAwake })
const user = (keepAwake: boolean | null) => ({ ...defaultUserConfig, keep_awake: keepAwake })

const retiredNote =
  "is no longer read: tutti keeps the machine awake unless keep_awake is false in .tutti/settings.json or ~/.config/tutti/config.json"

describe("whether a run keeps the machine awake", () => {
  test("with neither setting, it does, and the START block says nothing of it", () => {
    const config = configOf()
    expect(config.keepAwake).toBe(true)
    expect(config.keepAwakeOffBy).toBeNull()
    expect(keepAwakeNotes(config)).toEqual([])
  })

  test("the project's false turns it off, and the START block names the settings", () => {
    const config = configOf({ settings: settings(false) })
    expect(config.keepAwake).toBe(false)
    expect(keepAwakeNotes(config)).toEqual(["keep awake: off, keep_awake in .tutti/settings.json"])
  })

  test("the user config's choice wins over the project's either way", () => {
    const off = configOf({ settings: settings(true), user: user(false) })
    expect(off.keepAwake).toBe(false)
    expect(keepAwakeNotes(off)).toEqual([`keep awake: off, keep_awake in ${defaultUserFile}`])
    const shown = configOf({ user: user(false), userFile: "~/xdg/tutti/config.json" })
    expect(keepAwakeNotes(shown)).toEqual([
      "keep awake: off, keep_awake in ~/xdg/tutti/config.json",
    ])
    const on = configOf({ settings: settings(false), user: user(true) })
    expect(on.keepAwake).toBe(true)
    expect(keepAwakeNotes(on)).toEqual([])
    expect(configOf({ settings: settings(false), user: user(null) }).keepAwake).toBe(false)
  })

  test("--overnight keeps it awake with both false", () => {
    const flags: RunFlags = { ...noFlags, overnight: Option.some("true") }
    const config = configOf({ flags, settings: settings(false), user: user(false) })
    expect(config.keepAwake).toBe(true)
    expect(keepAwakeNotes(config)).toEqual([])
  })
})

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

describe("--keep-awake and TUTTI_KEEP_AWAKE, retired", () => {
  test("are left out of --help", async () => {
    const proc = Bun.spawn(["bun", join(root, "src", "main.ts"), "--help"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(out).toContain("--overnight")
    expect(out).not.toContain("--keep-awake")
    expect(out).not.toContain("TUTTI_KEEP_AWAKE")
    expect(out.replace(/\s+/g, " ")).toContain("keeps the machine awake whatever keep_awake says")
  })

  test("are accepted with any value, alone or with one, and change nothing", async () => {
    for (const args of [["--keep-awake"], ["--keep-awake=off"], ["--keep-awake=maybe"]]) {
      const flags = await parse(args)
      expect(Option.isSome(flags.keepAwake)).toBe(true)
      const config = configOf({ flags, settings: settings(false) })
      expect(config.keepAwake).toBe(false)
    }
    const variable = (value: string) => (name: string) =>
      name === retiredFlags.keepAwake.variable ? value : undefined
    expect(retiredFlags.keepAwake.variable).toBe("TUTTI_KEEP_AWAKE")
    expect(configOf({ env: variable("not a value") }).keepAwake).toBe(true)
  })

  test("are named once in the START block, the flag over its variable", () => {
    const flags: RunFlags = { ...noFlags, keepAwake: Option.some("true") }
    const env = (name: string) => (name === "TUTTI_KEEP_AWAKE" ? "1" : undefined)
    expect(keepAwakeNotes(configOf({ flags }))).toEqual([`--keep-awake ${retiredNote}`])
    expect(keepAwakeNotes(configOf({ env }))).toEqual([`TUTTI_KEEP_AWAKE ${retiredNote}`])
    expect(keepAwakeNotes(configOf({ flags, env }))).toEqual([`--keep-awake ${retiredNote}`])
    expect(keepAwakeNotes(configOf({ env: () => "" }))).toEqual([])
    const off = configOf({ flags, settings: settings(false) })
    expect(keepAwakeNotes(off)).toEqual([
      `--keep-awake ${retiredNote}`,
      "keep awake: off, keep_awake in .tutti/settings.json",
    ])
  })
})

describe("keep_awake in the files", () => {
  test("the settings take a boolean, true by default, and refuse anything else", () => {
    const decoded = (json: unknown) => decodeConfig(Settings, "settings.json", json)
    const value = (json: unknown) => {
      const exit = decoded(json)
      if (Exit.isFailure(exit)) throw new Error(`doesn't decode: ${JSON.stringify(json)}`)
      return exit.value.keep_awake
    }
    expect(value({})).toBe(true)
    expect(value({ keep_awake: false })).toBe(false)
    for (const wrong of ["yes", null, 1])
      expect(Exit.isFailure(decoded({ keep_awake: wrong }))).toBe(true)
  })

  test("the user config's is optional, null when not given", () => {
    const value = (json: unknown) => {
      const exit = decodeConfig(UserConfig, "config.json", json)
      if (Exit.isFailure(exit)) throw new Error(`doesn't decode: ${JSON.stringify(json)}`)
      return exit.value.keep_awake
    }
    expect(value({})).toBeNull()
    expect(value({ keep_awake: false })).toBe(false)
    expect(value({ keep_awake: true })).toBe(true)
  })

  test("the user config is named from ~ where it is in the home folder", async () => {
    const shown = (env: Record<string, string>) =>
      Effect.runPromise(
        userConfigShown.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
      )
    expect(await shown({ HOME: "/home/me" })).toBe("~/.config/tutti/config.json")
    expect(await shown({ HOME: "/home/me", XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/tutti/config.json",
    )
  })

  test("the published schemas have the key", () => {
    const keepAwake = (name: "settings.json" | "user-config.json") =>
      (JSON.parse(schemaText(name)) as { properties: Record<string, unknown> }).properties
        .keep_awake
    expect(keepAwake("settings.json")).toEqual({ type: "boolean", default: true })
    expect(keepAwake("user-config.json")).toMatchObject({ default: null })
  })
})

describe("tutti init and keep_awake", () => {
  test("the settings init writes have it, true", () => {
    expect((settingsTemplate as Record<string, unknown>).keep_awake).toBe(true)
  })

  test("the orchestra import copies orchestra's", () => {
    for (const value of [true, false]) {
      const imported = importSettings({ keep_awake: value })
      expect(imported.json).toEqual({ keep_awake: value })
      expect(imported.leftOut).toEqual([])
    }
  })

  const project = (settings: Record<string, unknown> | null) => {
    const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-keep-awake-init-"))), "repo")
    mkdirSync(join(repo, ".tutti"), { recursive: true })
    writeFileSync(join(repo, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
    if (settings !== null) {
      writeFileSync(join(repo, ".tutti", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`)
    }
    return repo
  }
  const update = (repo: string) =>
    Effect.runPromise(updateTemplates(repo).pipe(Effect.provide(BunServices.layer)))
  const written = (repo: string) =>
    JSON.parse(readFileSync(join(repo, ".tutti", "settings.json"), "utf8")) as Record<
      string,
      unknown
    >
  const upToDate = { templates: { worker_prompt: latestVersion(promptChanges) } }

  test("init --update adds it where it is missing, and says so", async () => {
    const repo = project({ concurrent: 2, ...upToDate })
    const result = await update(repo)
    expect(written(repo)).toEqual({ concurrent: 2, ...upToDate, keep_awake: true })
    expect(result.steps.map((each) => each.detail)).toContain(
      `added "keep_awake": true: runs keep the machine awake unless it is false`,
    )
    expect(result.steps.flatMap((each) => each.commit ?? [])).toContain(".tutti/settings.json")
  })

  test("init --update keeps a keep_awake that is there", async () => {
    const repo = project({ keep_awake: false, ...upToDate })
    const before = readFileSync(join(repo, ".tutti", "settings.json"), "utf8")
    const result = await update(repo)
    expect(readFileSync(join(repo, ".tutti", "settings.json"), "utf8")).toBe(before)
    expect(result.steps.some((each) => each.label === "settings")).toBe(false)
  })

  test("init --update writes it in a project with no settings", async () => {
    const repo = project(null)
    await update(repo)
    expect(written(repo).keep_awake).toBe(true)
  })
})
