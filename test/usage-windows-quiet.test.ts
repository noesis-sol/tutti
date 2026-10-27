// The account's windows on the title line in `quiet` (§ 7.11): a grey a step above faint, the
// grey typeChore reads as text with; faint as before under NO_COLOR or a scheme giving it the
// default. A scheme without extends written before the role takes orchestra's.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { TextAttributes } from "@opentui/core"
import { Effect } from "effect"
import type { Banner, TitleView } from "../src/run/runView.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import {
  type Appearance,
  loadScheme,
  makeTheme,
  orchestra,
  type Role,
  roles,
  type Scheme,
} from "../src/ui/theme.ts"

const title: TitleView = {
  version: "0.1.0",
  branch: "main",
  scope: null,
  began: 0,
  stopping: false,
  quitting: null,
  solo: null,
  shared: 0,
  keepAwake: false,
  autoAnswer: null,
}

const windows: Banner = {
  _tag: "Windows",
  windows: [
    { name: "five_hour", utilization: 0.06, resetsAt: 3_600_000 },
    { name: "seven_day", utilization: 0.12, resetsAt: 7 * 86_400_000 },
  ],
}

const themeOf = (appearance: Appearance, noColor = false, scheme: Scheme = orchestra) =>
  makeTheme(scheme, { appearance, depth: "truecolor", noColor })

const ints = (hex: string): [number, number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
  255,
]

/** The title line's segments at `width`, its windows' text after the branch and time. */
const segmentsOf = (theme: ReturnType<typeof themeOf>, width = 120) =>
  titleSegments(title, [windows], 0, theme, width)

describe("the account's windows are quiet", () => {
  test("labels, gauge, figures and · take the quiet style; the branch and time stay dim", () => {
    for (const appearance of ["dark", "light"] as const) {
      const theme = themeOf(appearance)
      const full = segmentsOf(theme)
      const at = full.findIndex((segment) => segment.text === "Current usage ")
      const windowed = full.slice(at).filter((segment) => segment.text.trim() !== "")
      expect(windowed.map((segment) => segment.text)).toEqual([
        "Current usage ",
        "━─────────",
        "6%",
        " · ",
        "This week 12%",
      ])
      for (const segment of windowed) expect(segment.look).toBe(theme.styles.quiet)
      expect(full.find((segment) => segment.text === "main · 0s")?.look).toBe(theme.styles.dim)
      // In a narrow pane, without the gauge, the same.
      const narrow = segmentsOf(theme, 50)
      const tight = narrow.slice(narrow.findIndex((s) => s.text === "This week 12%"))
      expect(tight.map((segment) => segment.text)).toEqual([
        "This week 12%",
        " · ",
        "Current usage 6%",
      ])
      for (const segment of tight) expect(segment.look).toBe(theme.styles.quiet)
    }
  })

  test("is #9CA3AF on dark and #6B7280 on light, not faint", () => {
    const dark = themeOf("dark").styles.quiet
    const light = themeOf("light").styles.quiet
    expect(dark.fg?.toInts()).toEqual(ints("#9CA3AF"))
    expect(light.fg?.toInts()).toEqual(ints("#6B7280"))
    expect(dark.attributes & TextAttributes.DIM).toBe(0)
    expect(light.attributes & TextAttributes.DIM).toBe(0)
    expect(dark.paint("6%")).toBe("\x1b[38;2;156;163;175m6%\x1b[0m")
  })

  test("is faint, in the text's colour, under NO_COLOR", () => {
    const quiet = themeOf("dark", true).styles.quiet
    expect(quiet.fg).toBeUndefined()
    expect(quiet.attributes).toBe(TextAttributes.DIM)
    expect(quiet.paint("6%")).toBe("\x1b[2m6%\x1b[0m")
  })

  test("is faint where a scheme gives quiet the default", () => {
    const scheme: Scheme = {
      ...orchestra,
      colours: {
        ...orchestra.colours,
        quiet: { light: { _tag: "Default" }, dark: { _tag: "Default" } },
      },
    }
    const quiet = themeOf("dark", false, scheme).styles.quiet
    expect(quiet.fg).toBeUndefined()
    expect(quiet.attributes).toBe(TextAttributes.DIM)
  })
})

describe("a scheme written before quiet", () => {
  const folders = () => {
    const top = mkdtempSync(join(tmpdir(), "tutti-quiet-"))
    return { project: top, user: join(top, "user") }
  }
  const load = (name: string, where: { readonly project: string; readonly user: string }) =>
    Effect.runPromise(loadScheme(name, where).pipe(Effect.provide(BunServices.layer)))
  const every = (colour: string, leaving: ReadonlyArray<Role>) =>
    Object.fromEntries(roles.filter((r) => !leaving.includes(r)).map((role) => [role, colour]))

  test("without extends and without quiet, loads, taking orchestra's", async () => {
    const where = folders()
    writeFileSync(
      join(where.project, "mono.json"),
      JSON.stringify({ name: "mono", colours: every("ansi:7", ["quiet"]) }),
    )
    const loaded = await load("mono", where)
    expect(loaded.fallback).toBeNull()
    expect(loaded.scheme.colours.quiet).toEqual(orchestra.colours.quiet)
    expect(loaded.scheme.from.quiet).toBe("orchestra")
    expect(loaded.scheme.colours.live.dark).toEqual({ _tag: "Slot", slot: 7 })
    expect(loaded.scheme.from.live).toBe("mono")
  })

  test("one that names quiet uses its own", async () => {
    const where = folders()
    writeFileSync(
      join(where.project, "mono.json"),
      JSON.stringify({ name: "mono", colours: every("ansi:7", []) }),
    )
    const loaded = await load("mono", where)
    expect(loaded.fallback).toBeNull()
    expect(loaded.scheme.colours.quiet.dark).toEqual({ _tag: "Slot", slot: 7 })
    expect(loaded.scheme.from.quiet).toBe("mono")
  })

  test("any other role missing without extends still can't be used", async () => {
    const where = folders()
    writeFileSync(
      join(where.project, "mono.json"),
      JSON.stringify({ name: "mono", colours: every("ansi:7", ["quiet", "live"]) }),
    )
    const loaded = await load("mono", where)
    expect(loaded.scheme).toBe(orchestra)
    expect(loaded.fallback).toBe(
      "colour scheme 'mono' isn't used: 'colours': roles are missing and there's no 'extends': live",
    )
  })
})
