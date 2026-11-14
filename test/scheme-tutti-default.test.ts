// The built-in colour scheme is tutti (§ 7.11), and orchestra, its old name, kept as no alias: a
// setting naming it gets what any unknown name gets, and a file of that name is a scheme like any.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect } from "effect"
import { noFlags } from "../src/project/flags.ts"
import { builtInNames, loadScheme, type SchemeFolders, tuttiScheme } from "../src/project/scheme.ts"
import { load } from "../src/run/resolveConfig.ts"

const emptyFolders = (): SchemeFolders => {
  const top = mkdtempSync(join(tmpdir(), "tutti-scheme-default-"))
  const folders = { project: join(top, "project"), user: join(top, "user") }
  mkdirSync(folders.project)
  mkdirSync(folders.user)
  return folders
}

const loadIn = (name: string, folders: SchemeFolders) =>
  Effect.runPromise(loadScheme(name, folders).pipe(Effect.provide(BunServices.layer)))

/** The config a run in `project` loads, with `xdg` as XDG_CONFIG_HOME. */
const loadConfig = (project: string, xdg: string) =>
  Effect.runPromise(
    load(noFlags, project).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: xdg, HOME: "/nowhere" } }),
        ),
      ),
      Effect.provide(BunServices.layer),
    ),
  )

describe("the built-in scheme", () => {
  test("is tutti, and the only one", () => {
    expect(builtInNames).toEqual(["tutti"])
    expect(tuttiScheme.name).toBe("tutti")
    expect(new Set(Object.values(tuttiScheme.from))).toEqual(new Set(["tutti"]))
  })

  test("orchestra is an unknown name, which gives tutti and says so", async () => {
    const folders = emptyFolders()
    const loaded = await loadIn("orchestra", folders)
    expect(loaded.scheme).toBe(tuttiScheme)
    expect(loaded.fallback).toBe(
      `colour scheme 'orchestra' isn't used: it isn't found in ${folders.project}, ${folders.user} or the built-in schemes`,
    )
    expect(loaded.warnings).toEqual([])
  })

  test("a file named orchestra.json is a scheme like any other, not ignored", async () => {
    const folders = emptyFolders()
    writeFileSync(
      join(folders.project, "orchestra.json"),
      JSON.stringify({ name: "orchestra", extends: "tutti", colours: { live: "#111111" } }),
    )
    const loaded = await loadIn("orchestra", folders)
    expect(loaded.fallback).toBeNull()
    expect(loaded.warnings).toEqual([])
    expect(loaded.scheme.from).toMatchObject({ live: "orchestra", done: "tutti" })
  })

  test("the settings' colour_scheme: orchestra loads tutti with the fallback", async () => {
    const project = mkdtempSync(join(tmpdir(), "tutti-scheme-default-project-"))
    const xdg = mkdtempSync(join(tmpdir(), "tutti-scheme-default-xdg-"))
    mkdirSync(join(project, ".tutti"))
    writeFileSync(
      join(project, ".tutti", "settings.json"),
      JSON.stringify({ ui: { colour_scheme: "orchestra" } }),
    )
    const config = await loadConfig(project, xdg)
    expect(config.colourScheme).toBe("orchestra")
    expect(config.scheme.scheme).toBe(tuttiScheme)
    expect(config.scheme.fallback).toStartWith(
      "colour scheme 'orchestra' isn't used: it isn't found",
    )
  })

  test("without a setting, the scheme is tutti", async () => {
    const project = mkdtempSync(join(tmpdir(), "tutti-scheme-default-project-"))
    const xdg = mkdtempSync(join(tmpdir(), "tutti-scheme-default-xdg-"))
    const config = await loadConfig(project, xdg)
    expect(config.colourScheme).toBe("tutti")
    expect(config.scheme).toEqual({ scheme: tuttiScheme, fallback: null, warnings: [] })
  })
})
