// tutti colours [<name>] (§ 7.11, § 8.1): every role with where its colour comes from and a sample
// in each variant, a mock of the dashboard in the terminal's variant, and what keeps a scheme from
// being used, which exits 1. Run on schemes written to a temporary project and user config.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Console, Effect, Exit } from "effect"
import { Command } from "effect/cli"
import { previewLines } from "../src/cli/colours.ts"
import { planServices, tuttiWith } from "../src/cli/commands.ts"
import { type LoadedScheme, loadScheme, orchestra, roles } from "../src/ui/theme.ts"

const dusk = {
  name: "dusk",
  description: "orchestra's scheme with a teal live colour and a rose pill",
  extends: "orchestra",
  colours: {
    live: { light: "#0F766E", dark: "#2DD4BF" },
    pill: "#E11D48",
    frame: "ansi:8",
  },
}

const bad = { name: "bad", extends: "orchestra", colours: { frame: "ansi:300" } }

/** A project with `schemes` in its `.tutti/colour-schemes/`, `settings` in its settings, and a user config folder. */
const projectWith = (
  schemes: ReadonlyArray<{ readonly name: string }>,
  settings: object = {},
): { readonly repo: string; readonly xdg: string } => {
  const top = mkdtempSync(join(tmpdir(), "tutti-colours-"))
  const repo = join(top, "project")
  const folder = join(repo, ".tutti", "colour-schemes")
  mkdirSync(folder, { recursive: true })
  for (const scheme of schemes) {
    writeFileSync(join(folder, `${scheme.name}.json`), JSON.stringify(scheme))
  }
  writeFileSync(join(repo, ".tutti", "settings.json"), JSON.stringify(settings))
  const xdg = join(top, "config")
  mkdirSync(xdg)
  return { repo, xdg }
}

const loadIn = (name: string, repo: string): Promise<LoadedScheme> =>
  Effect.runPromise(
    loadScheme(name, {
      project: join(repo, ".tutti", "colour-schemes"),
      user: join(repo, "no-user-schemes"),
    }).pipe(Effect.provide(BunServices.layer)),
  )

const now = new Date(2026, 9, 18, 14, 0, 0).getTime()

/** The preview's lines without their ANSI styles. */
const preview = (loaded: LoadedScheme, asked: string, noColor = false) =>
  previewLines({
    asked,
    loaded,
    appearance: "dark",
    depth: "truecolor",
    noColor,
    width: 80,
    now,
  }).map((line) => Bun.stripANSI(line))

/** The role table's line for `role`, split into its columns. */
const roleRow = (lines: ReadonlyArray<string>, role: string) =>
  lines
    .find((line) => line.trim().split(/\s+/)[0] === role)
    ?.trim()
    .split(/\s+/)

describe("the preview", () => {
  test("lists every role with where its colour comes from and both variants' samples", async () => {
    const { repo } = projectWith([dusk])
    const lines = preview(await loadIn("dusk", repo), "dusk")
    for (const role of roles) expect(roleRow(lines, role)).toBeDefined()
    expect(roleRow(lines, "live")).toEqual(["live", "dusk", "██", "#0F766E", "██", "#2DD4BF"])
    expect(roleRow(lines, "pill")).toEqual(["pill", "dusk", "#E11D48", "#E11D48"])
    expect(roleRow(lines, "frame")).toEqual(["frame", "dusk", "██", "ansi:8", "██", "ansi:8"])
    expect(roleRow(lines, "done")).toEqual(["done", "orchestra", "██", "#15803D", "██", "#4ADE80"])
    expect(roleRow(lines, "formMuted")).toEqual([
      "formMuted",
      "orchestra",
      "██",
      "default",
      "██",
      "ansi:248",
    ])
    expect(lines[0]).toBe("Colour scheme dusk")
    expect(lines[1]).toBe(dusk.description)
    expect(lines.at(-1)).toBe("✓ dusk can be used.")
  })

  test("draws the samples in each variant's colours", async () => {
    const { repo } = projectWith([dusk])
    const loaded = await loadIn("dusk", repo)
    const styled = previewLines({
      asked: "dusk",
      loaded,
      appearance: "light",
      depth: "truecolor",
      noColor: false,
      width: 80,
      now,
    })
    const live = styled.find((line) => Bun.stripANSI(line).trim().startsWith("live "))
    expect(live).toContain("\x1b[38;2;15;118;110m██")
    expect(live).toContain("\x1b[38;2;45;212;191m██")
    const pill = styled.find((line) => Bun.stripANSI(line).trim().startsWith("pill "))
    expect(pill).toContain("\x1b[48;2;225;29;72m  ")
  })

  test("draws a mock card, ticket row, attention card and hint in the terminal's variant", () => {
    const lines = preview({ scheme: orchestra, fallback: null, warnings: [] }, "orchestra")
    const text = lines.join("\n")
    expect(text).toContain("In the terminal's dark variant:")
    expect(text).toContain("tut-12  editing  6m31s")
    expect(text).toContain("▸ Edit src/run/merge.ts")
    expect(text).toContain("tut-14  permission — waiting for you")
    expect(text).toContain("[ Deny ]  [ Allow ]")
    expect(lines.some((line) => /│ ◼ to merge\s+│ tut-13\s+│ Tidy the log/.test(line))).toBe(true)
    expect(text).toContain("Tab select · Enter open")
  })

  test("draws the mock's frames and words in the scheme's roles", async () => {
    const { repo } = projectWith([dusk])
    const styled = previewLines({
      asked: "dusk",
      loaded: await loadIn("dusk", repo),
      appearance: "dark",
      depth: "truecolor",
      noColor: false,
      width: 80,
      now,
    })
    // The working card is framed `live`, dusk's teal; the tickets table `frame`, slot 8.
    expect(styled).toContain(`\x1b[38;2;45;212;191m╭${"─".repeat(70)}╮\x1b[0m`)
    expect(styled.some((line) => line.startsWith("\x1b[38;5;8m╭"))).toBe(true)
  })

  test("under NO_COLOR, says so and draws no colour", () => {
    const styled = previewLines({
      asked: "orchestra",
      loaded: { scheme: orchestra, fallback: null, warnings: [] },
      appearance: "dark",
      depth: "truecolor",
      noColor: true,
      width: 80,
      now,
    })
    const text = styled.join("\n")
    expect(Bun.stripANSI(text)).toContain(
      "NO_COLOR is set: every role is drawn in the terminal's default colour.",
    )
    expect(text).not.toContain("\x1b[38;")
    expect(text).not.toContain("\x1b[48;")
  })

  test("heads an unusable scheme's preview with orchestra, used instead", () => {
    const lines = preview(
      { scheme: orchestra, fallback: "colour scheme 'bad' isn't used: …", warnings: [] },
      "bad",
    )
    expect(lines[0]).toBe("Colour scheme orchestra, used instead of 'bad'")
    expect(lines.some((line) => line.includes("can be used"))).toBe(false)
  })
})

describe("tutti colours", () => {
  const run = async (args: ReadonlyArray<string>, project: ReturnType<typeof projectWith>) => {
    const printed: Array<string> = []
    const errors: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
      error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
    })
    // The appearance is chosen, so the terminal isn't asked for its background.
    const env = { XDG_CONFIG_HOME: project.xdg, HOME: project.xdg, TUTTI_APPEARANCE: "dark" }
    const exit = await Effect.runPromiseExit(
      Command.runWith(tuttiWith(Effect.succeed(project.repo), planServices), {
        version: "test",
        renderErrors: false,
      })(["colours", ...args]).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        Effect.provideService(Console.Console, console),
      ),
    )
    const out = Bun.stripANSI(printed.join("\n")).split("\n")
    return { exit, out, errors }
  }

  test("a valid scheme exits 0 with every role listed", async () => {
    const { exit, out, errors } = await run(["dusk"], projectWith([dusk]))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(errors).toEqual([])
    for (const role of roles) expect(roleRow(out, role)).toBeDefined()
    expect(roleRow(out, "live")?.slice(0, 2)).toEqual(["live", "dusk"])
    expect(roleRow(out, "done")?.slice(0, 2)).toEqual(["done", "orchestra"])
    expect(out.at(-1)).toBe("✓ dusk can be used.")
  })

  test("an invalid one exits 1 naming the problem", async () => {
    const { exit, out, errors } = await run(["bad"], projectWith([bad]))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(errors).toEqual([
      "tutti colours: colour scheme 'bad' isn't used: 'colours.frame': 'ansi:300' is not a palette slot (0–255)",
    ])
    expect(out[0]).toBe("Colour scheme orchestra, used instead of 'bad'")
  })

  test("a scheme that isn't found exits 1 saying where it was looked for", async () => {
    const project = projectWith([])
    const { exit, errors } = await run(["nowhere"], project)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStartWith(
      `tutti colours: colour scheme 'nowhere' isn't used: it isn't found in ${join(project.repo, ".tutti", "colour-schemes")}`,
    )
  })

  test("without a name, previews the scheme in use: the project's here", async () => {
    const { exit, out } = await run([], projectWith([dusk], { ui: { colour_scheme: "dusk" } }))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(out[0]).toBe("Colour scheme dusk")
  })

  test("without a name or any setting, previews orchestra", async () => {
    const { exit, out } = await run([], projectWith([]))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(out[0]).toBe("Colour scheme orchestra")
    expect(roleRow(out, "live")).toEqual(["live", "orchestra", "██", "#0E7490", "██", "#22D3EE"])
  })
})
