// A narrow pane fits the title line by priority (tutti-u2k): the branch and the time go first, then
// the usage banner shortens, then the states are cut; a hold's word (BLOCKED, MACHINE, USAGE_LIMIT)
// stays whole, where the line used to keep its left and cut the banners on the right.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { resetLabel } from "../src/run/localTime.ts"
import type { Banner, TitleView } from "../src/run/runView.ts"
import { widthOf } from "../src/ui/line.tsx"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const title: TitleView = {
  version: "0.1.0",
  branch: "main",
  scope: null,
  began: 0,
  stopping: true,
  quitting: null,
  solo: null,
  shared: 0,
  keepAwake: false,
  autoAnswer: null,
}

const at = 3_600_000
const resets = resetLabel(at, 0)
const usage: Banner = {
  _tag: "Usage",
  utilization: 0.85,
  resetsAt: at,
  limit: "five-hour",
  overage: true,
}
const blocked: Banner = { _tag: "Hold", word: "BLOCKED", resetsAt: null }
const limited: Banner = { _tag: "Hold", word: "USAGE_LIMIT", resetsAt: at, waiting: true }

/** The title line's text `width` columns wide, at 0. */
const text = (view: TitleView, banners: ReadonlyArray<Banner>, width: number) => {
  const segments = titleSegments(view, banners, 0, theme, width)
  expect(widthOf(segments)).toBeLessThanOrEqual(width)
  return segments.map((segment) => segment.text).join("")
}

describe("the title line in a narrow pane", () => {
  test("shows everything where it fits", () => {
    const line = text(title, [usage, blocked], 140)
    expect(line).toStartWith(" Tutti  0.1.0  · stopping   main · 0s")
    expect(line).toEndWith(`usage 85% of the five-hour limit · resets ${resets} · overage  BLOCKED`)
  })

  test("at 80 columns drops the branch and the time, then shortens the usage", () => {
    const line = text(title, [usage, blocked], 80)
    expect(line).not.toContain("main")
    expect(line).toStartWith(" Tutti  0.1.0  · stopping ")
    expect(line).toEndWith(`usage 85% · resets ${resets}  BLOCKED`)
  })

  test("at 60 columns keeps the states and the hold, the usage at its percentage", () => {
    expect(text(title, [usage, blocked], 60)).toEndWith(`usage 85% · resets ${resets}  BLOCKED`)
    const line = text({ ...title, quitting: "Quitting…" }, [usage, blocked], 60)
    expect(line).toStartWith(" Tutti  0.1.0  · Quitting… ")
    expect(line).toEndWith("usage 85%  BLOCKED")
  })

  test("drops the usage, then cuts the states, before the hold", () => {
    const solo = { ...title, shared: 2, solo: { ticket: "t-1", running: true } }
    const line = text(solo, [usage, blocked], 60)
    expect(line).not.toContain("usage")
    expect(line).toStartWith(" Tutti  0.1.0  · stopping  · solo t-1 running")
    expect(line).toEndWith("…  BLOCKED")
  })

  test("keeps the usage limit's reset and countdown before the states, its word last", () => {
    const line = text(title, [usage, limited], 60)
    expect(line).toEndWith(`USAGE_LIMIT · resets ${resets} · in 1h`)
    expect(text(title, [usage, limited], 30).trimEnd()).toBe(" Tutti  0.1.0  ·…  USAGE_LIMIT")
  })

  test("never cuts a hold's word while the pill and the words fit", () => {
    const banner = fc.oneof(
      fc.constant(usage),
      fc.constant(blocked),
      fc.constant(limited),
      fc.constant<Banner>({ _tag: "Hold", word: "MACHINE", resetsAt: null }),
    )
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 160 }),
        fc.array(banner, { maxLength: 4 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 3 }),
        (width, banners, stopping, shared) => {
          const line = text({ ...title, stopping, shared }, banners, width)
          const words = banners.flatMap((b) => (b._tag === "Hold" ? [b.word] : []))
          const least = " Tutti ".length + words.reduce((sum, word) => sum + word.length + 2, 0)
          if (least <= width) for (const word of words) expect(line).toContain(word)
        },
      ),
    )
  })
})
