// tutti login and tutti colours read the configuration leniently (§ 4.13, § 7.11): a settings key
// written by a newer tutti, or a bad TUTTI_* variable, doesn't stop them. Login reads only --claude
// (TUTTI_CLAUDE) and the billing; colours says the problems and previews all the same. Run on a
// temporary project and user config.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Console, Effect, Exit } from "effect"
import { Command } from "effect/cli"
import { defaultSettings, load, loadLenient } from "../src/cli/AppConfig.ts"
import { planServices, tuttiWith } from "../src/cli/commands.ts"
import { noFlags } from "../src/cli/flags.ts"

/** A project whose settings are `settings`, and a user config folder with `user` in its config. */
const projectWith = (settings: object, user?: object) => {
  const top = mkdtempSync(join(tmpdir(), "tutti-lenient-"))
  const repo = join(top, "project")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  writeFileSync(join(repo, ".tutti", "settings.json"), JSON.stringify(settings))
  const xdg = join(top, "config")
  mkdirSync(join(xdg, "tutti"), { recursive: true })
  if (user !== undefined) writeFileSync(join(xdg, "tutti", "config.json"), JSON.stringify(user))
  return { repo, xdg }
}

/** A settings file a newer tutti wrote: a key this one doesn't know. */
const newerSettings = { concurrent: 2, newer_key: true }

/** That key's problem, in the project at `repo`. */
const unknownKey = (repo: string) =>
  `${join(repo, ".tutti", "settings.json")}: newer_key: unknown key "newer_key"`

/** Runs `tutti <args>` in `project` with `variables` set, its output and errors collected. */
const run = async (
  args: ReadonlyArray<string>,
  project: { readonly repo: string; readonly xdg: string },
  variables: Record<string, string> = {},
) => {
  const printed: Array<string> = []
  const errors: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
    error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
  })
  // The appearance is chosen, so the terminal isn't asked for its background.
  const env = {
    XDG_CONFIG_HOME: project.xdg,
    HOME: project.xdg,
    TUTTI_APPEARANCE: "dark",
    ...variables,
  }
  const exit = await Effect.runPromiseExit(
    Command.runWith(tuttiWith(Effect.succeed(project.repo), planServices), {
      version: "test",
      renderErrors: false,
    })(args).pipe(
      Effect.provide(BunServices.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      Effect.provideService(Console.Console, console),
    ),
  )
  return { exit, out: Bun.stripANSI(printed.join("\n")).split("\n"), errors }
}

/** Reads the configuration of `project` with `variables` set, through `read`. */
const readIn = <A, E>(
  read: Effect.Effect<A, E, BunServices.BunServices>,
  project: { readonly xdg: string },
  variables: Record<string, string>,
) =>
  Effect.runPromiseExit(
    read.pipe(
      Effect.provide(BunServices.layer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { XDG_CONFIG_HOME: project.xdg, HOME: project.xdg, ...variables },
          }),
        ),
      ),
    ),
  )

describe("loadLenient", () => {
  test("gives the configuration beside the problems load fails with", async () => {
    const project = projectWith(newerSettings, { billing: "api" })
    const variables = { TUTTI_CONCURRENT: "200" }
    const strict = await readIn(load(noFlags, project.repo), project, variables)
    expect(Exit.isFailure(strict)).toBe(true)
    const lenient = await readIn(loadLenient(noFlags, project.repo), project, variables)
    if (Exit.isFailure(lenient)) throw new Error(String(lenient.cause))
    const read = lenient.value
    expect(read.problems).toHaveLength(1)
    expect(read.problems[0]).toStartWith("TUTTI_CONCURRENT ")
    expect(read.settingsProblems).toEqual([unknownKey(project.repo)])
    expect(read.userProblems).toEqual([])
    // The settings with a problem give their defaults; the user config still gives the billing.
    expect(read.value.settings.concurrent).toBe(defaultSettings.concurrent)
    expect(read.value.billing).toBe("api")
  })

  test("reads only the variables named, as though the others were unset", async () => {
    const project = projectWith({})
    const variables = {
      TUTTI_CONCURRENT: "200",
      TUTTI_WORKER_MODEL: "",
      TUTTI_BILLING: "api",
      TUTTI_CLAUDE: "/opt/claude",
    }
    const lenient = await readIn(
      loadLenient(noFlags, project.repo, ["TUTTI_CLAUDE", "TUTTI_BILLING"]),
      project,
      variables,
    )
    if (Exit.isFailure(lenient)) throw new Error(String(lenient.cause))
    expect(lenient.value.problems).toEqual([])
    expect(lenient.value.value.billing).toBe("api")
    expect(lenient.value.value.claude).toBe("/opt/claude")
  })
})

describe("tutti login", () => {
  test("runs past a bad settings file and TUTTI_* variables to resolving its Claude Code", async () => {
    const project = projectWith(newerSettings)
    const { exit, errors } = await run(
      ["login", "--claude", join(project.repo, "no-claude")],
      project,
      { TUTTI_CONCURRENT: "200", TUTTI_FEATURE: "x", TUTTI_TICKET: "y" },
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStartWith(
      `tutti login: The Claude Code at ${join(project.repo, "no-claude")} (--claude) doesn't run`,
    )
  })

  test("says the user config's problems, and logs in all the same", async () => {
    const project = projectWith({}, { newer_key: 1 })
    const { errors } = await run(["login", "--claude", join(project.repo, "no-claude")], project)
    expect(errors[0]).toStartWith("tutti login: ")
    expect(errors[0]).toContain(`unknown key "newer_key"`)
    expect(errors[1]).toContain("(--claude) doesn't run")
  })

  test("stops at a bad billing, which it reads", async () => {
    const project = projectWith({})
    const { exit, errors } = await run(["login"], project, { TUTTI_BILLING: "free" })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStartWith("tutti login: TUTTI_BILLING ")
  })
})

describe("tutti colours", () => {
  test("previews with a bad settings file and variable, says their problems and exits 1", async () => {
    const project = projectWith(newerSettings)
    const { exit, out, errors } = await run(["colours"], project, { TUTTI_CONCURRENT: "200" })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(out[0]).toBe("Colour scheme orchestra")
    expect(errors).toHaveLength(2)
    expect(errors[0]).toStartWith("tutti colours: TUTTI_CONCURRENT ")
    expect(errors[1]).toBe(`tutti colours: ${unknownKey(project.repo)}`)
  })

  test("says the setup's problems before the scheme's own", async () => {
    const project = projectWith(newerSettings)
    const { exit, out, errors } = await run(["colours", "nowhere"], project)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(out[0]).toBe("Colour scheme orchestra, used instead of 'nowhere'")
    expect(errors[0]).toBe(`tutti colours: ${unknownKey(project.repo)}`)
    expect(errors[1]).toStartWith("tutti colours: colour scheme 'nowhere' isn't used")
  })
})
