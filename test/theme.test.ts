import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { TextAttributes } from "@opentui/core"
import { ConfigProvider, Effect, Option, Result } from "effect"
import fc from "fast-check"
import { colourSchemeSchemaFile, colourSchemeSchemaText } from "../scripts/colour-scheme-schema.ts"
import { load } from "../src/cli/AppConfig.ts"
import { noFlags } from "../src/cli/flags.ts"
import {
  ansiOf,
  appearanceOf,
  type Colour,
  type LoadedScheme,
  loadScheme,
  makeTheme,
  orchestra,
  outputAppearance,
  parseBackgroundReply,
  parseColour,
  queryAppearance,
  type Role,
  roles,
  type SchemeFolders,
  schemeNotices,
  styleNames,
} from "../src/ui/theme.ts"

/** § 7.11's three tables: each role's light and dark colour in the orchestra scheme. */
const orchestraTable: Record<Role, readonly [string, string]> = {
  live: ["#0E7490", "#22D3EE"],
  done: ["#15803D", "#4ADE80"],
  notice: ["#A16207", "#FACC15"],
  needsYou: ["#B91C1C", "#F87171"],
  windingDown: ["#C2410C", "#FB923C"],
  frame: ["#9CA3AF", "#6B7280"],
  organ: ["#6D28D9", "#A78BFA"],
  organText: ["#7C3AED", "#C4B5FD"],
  toMerge: ["#1D4ED8", "#60A5FA"],
  merging: ["#BE185D", "#F472B6"],
  emphasis: ["#374151", "#E5E7EB"],
  pill: ["#7D56F4", "#7D56F4"],
  pillText: ["#FAFAFA", "#FAFAFA"],
  heading1: ["#6D28D9", "#A78BFA"],
  heading2: ["#0E7490", "#22D3EE"],
  heading3: ["#374151", "#E5E7EB"],
  code: ["#BE185D", "#F472B6"],
  link: ["#1D4ED8", "#60A5FA"],
  added: ["#15803D", "#4ADE80"],
  removed: ["#B91C1C", "#F87171"],
  selection: ["#7D56F4", "#7D56F4"],
  selectionText: ["#FAFAFA", "#FAFAFA"],
  formText: ["ansi:235", "ansi:252"],
  formTitle: ["#5A56E0", "#7571F9"],
  formAccent: ["#F780E2", "#F780E2"],
  formAccentText: ["#FFFDF5", "#FFFDF5"],
  formSelected: ["#02BA84", "#02BF87"],
  formSelectedMark: ["#02CF92", "#02A877"],
  formError: ["#FF4672", "#ED567A"],
  formMuted: ["default", "ansi:243"],
  formButton: ["ansi:252", "ansi:237"],
  formPlaceholder: ["ansi:248", "ansi:238"],
  formFrame: ["ansi:238", "ansi:238"],
}

const colourOf = (text: string): Colour => Result.getOrThrow(parseColour(text))

describe("the orchestra scheme", () => {
  test("holds § 7.11's colours exactly, light and dark", () => {
    expect(Object.keys(orchestraTable).sort()).toEqual([...roles].sort())
    for (const role of roles) {
      const [light, dark] = orchestraTable[role]
      expect({ role, ...orchestra.colours[role] }).toEqual({
        role,
        light: colourOf(light),
        dark: colourOf(dark),
      })
      expect(orchestra.from[role]).toBe("orchestra")
    }
  })
})

describe("colours", () => {
  test("reads each form", () => {
    expect(parseColour("#0e7490")).toEqual(Result.succeed({ _tag: "Hex", hex: "#0E7490" }))
    expect(parseColour("ansi:0")).toEqual(Result.succeed({ _tag: "Slot", slot: 0 }))
    expect(parseColour("ansi:255")).toEqual(Result.succeed({ _tag: "Slot", slot: 255 }))
    expect(parseColour("default")).toEqual(Result.succeed({ _tag: "Default" }))
  })

  test("says why a colour can't be read", () => {
    expect(parseColour("ansi:300")).toEqual(Result.fail("'ansi:300' is not a palette slot (0–255)"))
    for (const text of [
      "#12345",
      "#GGGGGG",
      "cyan",
      "ansi:",
      "ansi:-1",
      "ansi:007",
      "Default",
      "",
    ]) {
      expect(parseColour(text)).toEqual(
        Result.fail(`'${text}' is not a colour: use #RRGGBB, ansi:N (0–255) or default`),
      )
    }
  })

  test("reads any text without throwing, and every colour it writes", () => {
    fc.assert(fc.property(fc.string(), (text) => void parseColour(text)))
    const hex = fc
      .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
      .map(([a, b]) => `#${a.toString(16).padStart(2, "0")}${b.toString(16).padStart(4, "0")}`)
    const slot = fc.integer({ min: 0, max: 255 }).map((n) => `ansi:${n}`)
    fc.assert(
      fc.property(fc.oneof(hex, slot, fc.constant("default")), (text) =>
        Result.isSuccess(parseColour(text)),
      ),
    )
    fc.assert(
      fc.property(fc.integer({ min: 256 }), (n) => Result.isFailure(parseColour(`ansi:${n}`))),
    )
  })
})

/** A project folder and a user folder for schemes, with `files` written into them. */
const foldersWith = (files: {
  readonly project?: Record<string, unknown>
  readonly user?: Record<string, unknown>
}): SchemeFolders => {
  const top = mkdtempSync(join(tmpdir(), "tutti-theme-"))
  const folders = { project: join(top, "project"), user: join(top, "user") }
  for (const where of ["project", "user"] as const) {
    mkdirSync(folders[where])
    for (const [name, content] of Object.entries(files[where] ?? {})) {
      const text = typeof content === "string" ? content : JSON.stringify(content)
      writeFileSync(join(folders[where], `${name}.json`), text)
    }
  }
  return folders
}

const loadIn = (name: string, folders: SchemeFolders): Promise<LoadedScheme> =>
  Effect.runPromise(loadScheme(name, folders).pipe(Effect.provide(BunServices.layer)))

const scheme = (name: string, colours: Record<string, unknown>, more: object = {}) => ({
  name,
  colours,
  ...more,
})

const allRoles = (colour: string) => Object.fromEntries(roles.map((role) => [role, colour]))

describe("the lookup order", () => {
  test("the project's folder, then the user's, then the built-ins", async () => {
    const both = foldersWith({
      project: { dusk: scheme("dusk", { live: "#111111" }, { extends: "orchestra" }) },
      user: { dusk: scheme("dusk", { live: "#222222" }, { extends: "orchestra" }) },
    })
    const fromProject = await loadIn("dusk", both)
    expect(fromProject.fallback).toBeNull()
    expect(fromProject.scheme.colours.live.dark).toEqual(colourOf("#111111"))

    const userOnly = foldersWith({
      user: { dusk: scheme("dusk", { live: "#222222" }, { extends: "orchestra" }) },
    })
    expect((await loadIn("dusk", userOnly)).scheme.colours.live.dark).toEqual(colourOf("#222222"))

    const builtIn = await loadIn("orchestra", foldersWith({}))
    expect(builtIn).toEqual({ scheme: orchestra, fallback: null, warnings: [] })
  })

  test("the first file found is the one used, even when it can't be", async () => {
    const folders = foldersWith({
      project: { dusk: "{ not json" },
      user: { dusk: scheme("dusk", allRoles("#222222")) },
    })
    const loaded = await loadIn("dusk", folders)
    expect(loaded.scheme).toBe(orchestra)
    expect(loaded.fallback).toStartWith(
      `colour scheme 'dusk' isn't used: ${join(folders.project, "dusk.json")} isn't valid JSON: `,
    )
  })

  test("a file with a built-in's name is ignored with a warning", async () => {
    const folders = foldersWith({
      project: { orchestra: scheme("orchestra", { live: "#111111" }, { extends: "orchestra" }) },
      user: { orchestra: "not even JSON" },
    })
    const loaded = await loadIn("orchestra", folders)
    expect(loaded.scheme).toEqual(orchestra)
    expect(loaded.fallback).toBeNull()
    expect(loaded.warnings).toEqual([
      `${join(folders.project, "orchestra.json")} is ignored: orchestra is a built-in colour scheme's name`,
      `${join(folders.user, "orchestra.json")} is ignored: orchestra is a built-in colour scheme's name`,
    ])
    expect(schemeNotices(loaded)).toEqual(loaded.warnings)

    // Reached through extends too, and said once.
    const extending = foldersWith({
      project: {
        orchestra: scheme("orchestra", {}),
        dusk: scheme("dusk", { live: "#111111" }, { extends: "orchestra" }),
      },
    })
    const dusk = await loadIn("dusk", extending)
    expect(dusk.fallback).toBeNull()
    expect(dusk.scheme.colours.done).toEqual(orchestra.colours.done)
    expect(dusk.warnings).toHaveLength(1)
  })
})

describe("extends", () => {
  test("a role the file leaves out comes from the scheme it extends", async () => {
    const folders = foldersWith({
      project: {
        dusk: scheme(
          "dusk",
          { live: { light: "#0F766E", dark: "#2DD4BF" }, pill: "#E11D48", frame: "ansi:8" },
          { extends: "base", description: "teal" },
        ),
      },
      user: { base: scheme("base", { done: "default" }, { extends: "orchestra" }) },
    })
    const { scheme: dusk, fallback, warnings } = await loadIn("dusk", folders)
    expect(fallback).toBeNull()
    expect(warnings).toEqual([])
    expect(dusk.name).toBe("dusk")
    expect(dusk.description).toBe("teal")
    expect(dusk.colours.live).toEqual({ light: colourOf("#0F766E"), dark: colourOf("#2DD4BF") })
    expect(dusk.colours.pill).toEqual({ light: colourOf("#E11D48"), dark: colourOf("#E11D48") })
    expect(dusk.colours.frame).toEqual({ light: colourOf("ansi:8"), dark: colourOf("ansi:8") })
    expect(dusk.colours.done).toEqual({ light: colourOf("default"), dark: colourOf("default") })
    expect(dusk.colours.merging).toEqual(orchestra.colours.merging)
    expect(dusk.from).toMatchObject({ live: "dusk", done: "base", merging: "orchestra" })
  })

  test("a file without extends that gives every role is a whole scheme", async () => {
    const folders = foldersWith({ user: { mono: scheme("mono", allRoles("ansi:7")) } })
    const loaded = await loadIn("mono", folders)
    expect(loaded.fallback).toBeNull()
    for (const role of roles) expect(loaded.scheme.colours[role].light).toEqual(colourOf("ansi:7"))
  })
})

describe("a scheme that can't be used", () => {
  /** Loads `name` from the project's folder holding `files`, expecting orchestra and `reason`. */
  const refused = async (name: string, files: Record<string, unknown>, reason: string) => {
    const loaded = await loadIn(name, foldersWith({ project: files }))
    expect(loaded).toEqual({
      scheme: orchestra,
      fallback: `colour scheme '${name}' isn't used: ${reason}`,
      warnings: [],
    })
  }

  test("its name isn't found", async () => {
    const folders = foldersWith({})
    expect(await loadIn("dusk", folders)).toEqual({
      scheme: orchestra,
      fallback: `colour scheme 'dusk' isn't used: it isn't found in ${folders.project}, ${folders.user} or the built-in schemes`,
      warnings: [],
    })
  })

  test("its name isn't one a file can have", async () => {
    for (const name of ["../dusk", "a/b", ".hidden", ""]) {
      await refused(
        name,
        {},
        `'${name}' isn't a scheme's name: use letters, digits, '.', '_' and '-'`,
      )
    }
  })

  test("the file isn't valid JSON", async () => {
    const folders = foldersWith({ project: { dusk: "{" } })
    const loaded = await loadIn("dusk", folders)
    expect(loaded.scheme).toBe(orchestra)
    expect(loaded.fallback).toMatch(
      /^colour scheme 'dusk' isn't used: .*dusk\.json isn't valid JSON: .+$/,
    )
  })

  test("a key isn't one the format knows", async () => {
    await refused(
      "dusk",
      { dusk: scheme("dusk", {}, { extends: "orchestra", colors: {} }) },
      `'colors': unknown key "colors"`,
    )
  })

  test("a role is unknown", async () => {
    await refused(
      "dusk",
      { dusk: scheme("dusk", { lve: "#000000" }, { extends: "orchestra" }) },
      `'colours.lve': unknown key "lve"`,
    )
  })

  test("a colour can't be read, with the message the dashboard shows", async () => {
    await refused(
      "dusk",
      { dusk: scheme("dusk", { frame: "ansi:300" }, { extends: "orchestra" }) },
      "'colours.frame': 'ansi:300' is not a palette slot (0–255)",
    )
    await refused(
      "dusk",
      { dusk: scheme("dusk", { live: { light: "#12345", dark: 4 } }, { extends: "orchestra" }) },
      "'colours.live.light': '#12345' is not a colour: use #RRGGBB, ansi:N (0–255) or default; 'colours.live.dark': Expected string, got 4",
    )
  })

  test("every problem in the file is in its one reason", async () => {
    const folders = foldersWith({
      project: { dusk: { colours: { frame: "ansi:300" }, extends: "orchestra", theme: 1 } },
    })
    const loaded = await loadIn("dusk", folders)
    expect(loaded.scheme).toBe(orchestra)
    const prefix = "colour scheme 'dusk' isn't used: "
    expect(loaded.fallback).toStartWith(prefix)
    expect((loaded.fallback ?? "").slice(prefix.length).split("; ").sort()).toEqual(
      [
        `'theme': unknown key "theme"`,
        "'name': Missing key",
        "'colours.frame': 'ansi:300' is not a palette slot (0–255)",
      ].sort(),
    )
  })

  test("its name doesn't match the file's", async () => {
    await refused(
      "dusk",
      { dusk: scheme("dawn", {}, { extends: "orchestra" }) },
      "'name': 'dawn' doesn't match the file's name, 'dusk'",
    )
  })

  test("roles are missing and there's no extends", async () => {
    const { live: _, done: __, ...most } = allRoles("#000000")
    await refused(
      "dusk",
      { dusk: scheme("dusk", most) },
      "'colours': roles are missing and there's no 'extends': live, done",
    )
  })

  test("extends names a scheme that can't be found", async () => {
    const folders = foldersWith({ project: { dusk: scheme("dusk", {}, { extends: "dawn" }) } })
    expect((await loadIn("dusk", folders)).fallback).toBe(
      `colour scheme 'dusk' isn't used: 'extends': 'dawn' isn't found in ${folders.project}, ${folders.user} or the built-in schemes`,
    )
  })

  test("extends names a scheme that can't be used", async () => {
    await refused(
      "dusk",
      {
        dusk: scheme("dusk", {}, { extends: "dawn" }),
        dawn: scheme("dawn", { frame: "ansi:300" }, { extends: "orchestra" }),
      },
      "'extends': 'dawn' can't be used: 'colours.frame': 'ansi:300' is not a palette slot (0–255)",
    )
  })

  test("extends loops back", async () => {
    await refused(
      "dusk",
      { dusk: scheme("dusk", {}, { extends: "dusk" }) },
      "'extends' loops back: dusk → dusk",
    )
    await refused(
      "dusk",
      {
        dusk: scheme("dusk", {}, { extends: "dawn" }),
        dawn: scheme("dawn", {}, { extends: "dusk" }),
      },
      "'extends': 'dawn' can't be used: 'extends' loops back: dusk → dawn → dusk",
    )
  })

  test("its one notice is the fallback", async () => {
    const loaded = await loadIn("dusk", foldersWith({}))
    expect(schemeNotices(loaded)).toEqual([loaded.fallback as string])
  })
})

describe("AppConfig", () => {
  const loadConfig = (project: string, xdg: string, env: Record<string, string> = {}) =>
    Effect.runPromise(
      load(noFlags, project).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { ...env, XDG_CONFIG_HOME: xdg, HOME: "/nowhere" } }),
          ),
        ),
        Effect.provide(BunServices.layer),
      ),
    )

  const dirs = () => {
    const project = mkdtempSync(join(tmpdir(), "tutti-theme-project-"))
    const xdg = mkdtempSync(join(tmpdir(), "tutti-theme-xdg-"))
    mkdirSync(join(project, ".tutti", "colour-schemes"), { recursive: true })
    mkdirSync(join(xdg, "tutti", "colour-schemes"), { recursive: true })
    return { project, xdg }
  }

  test("loads the scheme chosen, from the project's folder or the user's", async () => {
    const { project, xdg } = dirs()
    writeFileSync(
      join(project, ".tutti", "colour-schemes", "dusk.json"),
      JSON.stringify(scheme("dusk", { live: "#111111" }, { extends: "orchestra" })),
    )
    writeFileSync(
      join(xdg, "tutti", "colour-schemes", "mine.json"),
      JSON.stringify(scheme("mine", { live: "#222222" }, { extends: "dusk" })),
    )
    const dusk = await loadConfig(project, xdg, { TUTTI_COLOUR_SCHEME: "dusk" })
    expect(dusk.colourScheme).toBe("dusk")
    expect(dusk.scheme.fallback).toBeNull()
    expect(dusk.scheme.scheme.colours.live.dark).toEqual(colourOf("#111111"))
    const mine = await loadConfig(project, xdg, { TUTTI_COLOUR_SCHEME: "mine" })
    expect(mine.scheme.scheme.from).toMatchObject({ live: "mine", done: "orchestra" })
  })

  test("a scheme that can't be used gives orchestra and its reason, not a setup problem", async () => {
    const { project, xdg } = dirs()
    const config = await loadConfig(project, xdg, { TUTTI_COLOUR_SCHEME: "dusk" })
    expect(config.scheme.scheme).toBe(orchestra)
    expect(config.scheme.fallback).toStartWith("colour scheme 'dusk' isn't used: it isn't found")
  })

  test("NO_COLOR, set and not empty, is noColor", async () => {
    const { project, xdg } = dirs()
    expect((await loadConfig(project, xdg)).noColor).toBe(false)
    expect((await loadConfig(project, xdg, { NO_COLOR: "" })).noColor).toBe(false)
    expect((await loadConfig(project, xdg, { NO_COLOR: "1" })).noColor).toBe(true)
  })
})

describe("styles", () => {
  test("are orchestra's, with its roles' colours, as OpenTUI colours", () => {
    const dark = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
    const light = makeTheme(orchestra, { appearance: "light", depth: "truecolor", noColor: false })
    expect(Object.keys(dark.styles)).toEqual([...styleNames])
    const ints = (hex: string): [number, number, number, number] => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
      255,
    ]
    const bold = TextAttributes.BOLD
    const table: Array<[keyof typeof dark.styles, Role | null, number]> = [
      ["picked", "live", bold],
      ["closed", "done", bold],
      ["deferred", "notice", 0],
      ["stop", "needsYou", bold],
      ["windDown", "windingDown", 0],
      ["heldBack", "notice", 0],
      ["done", "done", 0],
      ["organ", "organ", bold],
      ["say", "organText", 0],
      ["testing", "notice", bold],
      ["toMerge", "toMerge", 0],
      ["merging", "merging", bold],
      ["key", "emphasis", bold],
      ["tickets", "emphasis", bold],
      ["dim", null, TextAttributes.DIM],
      ["title", "pillText", bold],
    ]
    for (const [name, role, attributes] of table) {
      for (const [theme, at] of [
        [light, 0],
        [dark, 1],
      ] as const) {
        const style = theme.styles[name]
        expect({ name, attributes: style.attributes }).toEqual({ name, attributes })
        expect({ name, fg: style.fg?.toInts() }).toEqual({
          name,
          fg: role === null ? undefined : ints(orchestraTable[role][at]),
        })
      }
    }
    expect(dark.styles.title.bg?.toInts()).toEqual(ints("#7D56F4"))
    expect(dark.styles.picked.bg).toBeUndefined()
    expect(dark.rgba("formText").intent).toBe("indexed")
    expect(dark.rgba("formText").slot).toBe(252)
    expect(light.rgba("formMuted").intent).toBe("default")
  })

  test("paint ANSI strings for output outside the renderer", () => {
    const dark = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
    expect(dark.styles.picked.paint("tutti-1")).toBe("\x1b[1m\x1b[38;2;34;211;238mtutti-1\x1b[0m")
    expect(dark.styles.deferred.paint("↷")).toBe("\x1b[38;2;250;204;21m↷\x1b[0m")
    expect(dark.styles.dim.paint("12s")).toBe("\x1b[2m12s\x1b[0m")
    expect(dark.styles.title.paint(" tutti ")).toBe(
      "\x1b[1m\x1b[38;2;250;250;250m\x1b[48;2;125;86;244m tutti \x1b[0m",
    )
    const in256 = makeTheme(orchestra, { appearance: "dark", depth: "256", noColor: false })
    expect(in256.styles.picked.open).toBe("\x1b[1m\x1b[38;5;45m")
    expect(in256.ansi("pill")).toBe("\x1b[48;5;99m")
  })

  test("NO_COLOR draws every role in the default colour, keeping bold, faint and the text", () => {
    const plain = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
    for (const role of roles) {
      expect(plain.rgba(role, "fg").intent).toBe("default")
      expect(plain.rgba(role, "bg").intent).toBe("default")
      expect(plain.ansi(role)).toBe("")
    }
    expect(plain.styles.picked.paint("▶ working")).toBe("\x1b[1m▶ working\x1b[0m")
    expect(plain.styles.deferred.paint("↷ deferred")).toBe("↷ deferred")
    expect(plain.styles.dim.paint("12s")).toBe("\x1b[2m12s\x1b[0m")
    expect(plain.styles.title.attributes).toBe(TextAttributes.BOLD)
    expect(plain.styles.title.bg?.intent).toBe("default")
  })
})

describe("ANSI for each colour form and depth", () => {
  const cases: Array<[string, "fg" | "bg", "truecolor" | "256", string]> = [
    ["#0E7490", "fg", "truecolor", "\x1b[38;2;14;116;144m"],
    ["#0E7490", "bg", "truecolor", "\x1b[48;2;14;116;144m"],
    ["#0E7490", "fg", "256", "\x1b[38;5;30m"],
    ["#0E7490", "bg", "256", "\x1b[48;5;30m"],
    ["ansi:8", "fg", "truecolor", "\x1b[38;5;8m"],
    ["ansi:243", "bg", "256", "\x1b[48;5;243m"],
    ["default", "fg", "truecolor", "\x1b[39m"],
    ["default", "bg", "256", "\x1b[49m"],
  ]
  for (const [colour, layer, depth, sequence] of cases) {
    test(`${colour} as ${layer} at ${depth}`, () => {
      expect(ansiOf(colourOf(colour), layer, depth)).toBe(sequence)
    })
  }

  test("a scheme's default on a background role is the default background", () => {
    const theme = makeTheme(
      { ...orchestra, colours: { ...orchestra.colours, pill: orchestra.colours.formMuted } },
      { appearance: "light", depth: "truecolor", noColor: false },
    )
    expect(theme.ansi("pill")).toBe("\x1b[49m")
    expect(theme.rgba("pill").intent).toBe("default")
    expect(theme.styles.title.open).toBe("\x1b[1m\x1b[38;2;250;250;250m\x1b[49m")
  })
})

describe("the appearance", () => {
  test("the user's choice overrides the terminal's, and dark without either", () => {
    expect(appearanceOf("light", "dark")).toBe("light")
    expect(appearanceOf("dark", "light")).toBe("dark")
    expect(appearanceOf("auto", "light")).toBe("light")
    expect(appearanceOf("auto", null)).toBe("dark")
  })

  test("outside the renderer: the choice, else the renderer's, else the terminal's, else dark", async () => {
    expect(await Effect.runPromise(outputAppearance("light", "dark"))).toBe("light")
    expect(await Effect.runPromise(outputAppearance("auto", "light"))).toBe("light")
    // The tests' stdin isn't a terminal, so the query has no answer.
    expect(await Effect.runPromise(queryAppearance)).toEqual(Option.none())
    expect(await Effect.runPromise(outputAppearance("auto", null))).toBe("dark")
  })

  test("reads an OSC 11 reply", () => {
    expect(parseBackgroundReply("\x1b]11;rgb:ffff/ffff/ffff\x07")).toEqual(Option.some("light"))
    expect(parseBackgroundReply("\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\")).toEqual(Option.some("dark"))
    expect(parseBackgroundReply("\x1b]11;rgb:fd/f6/e3\x07")).toEqual(Option.some("light"))
    expect(parseBackgroundReply("\x1b]11;#FDF6E3\x07")).toEqual(Option.some("light"))
    expect(parseBackgroundReply("\x1b]11;rgba:0000/0000/0000/ffff\x07")).toEqual(
      Option.some("dark"),
    )
    expect(parseBackgroundReply("\x1b[?62;22c")).toEqual(Option.none())
    expect(parseBackgroundReply("\x1b]11;rgb:ffff/ffff")).toEqual(Option.none())
  })

  test("reads any text without throwing", () => {
    fc.assert(fc.property(fc.string(), (text) => void parseBackgroundReply(text)))
    const part = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16).padStart(4, "0"))
    fc.assert(
      fc.property(fc.tuple(part, part, part), fc.string(), ([r, g, b], noise) =>
        Option.isSome(parseBackgroundReply(`${noise}\x1b]11;rgb:${r}/${g}/${b}\x07`)),
      ),
    )
  })
})

test("schema/colour-scheme.json is the format's JSON Schema, up to date", () => {
  expect(readFileSync(colourSchemeSchemaFile, "utf8")).toBe(colourSchemeSchemaText())
  const document = JSON.parse(colourSchemeSchemaText())
  expect(Object.keys(document.properties.colours.properties)).toEqual([...roles])
})
