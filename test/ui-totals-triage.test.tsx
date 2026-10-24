// The totals strip's triage note (§ 7.2): ` · ◆ n triaged` after Set aside's label where the strip
// has room for it, ` · ◆ n` where it hasn't, then none, before the totals go on one line.
import { describe, expect, test } from "bun:test"
import { emptyView, type Totals } from "../src/run/runView.ts"
import type { Segments } from "../src/ui/line.tsx"
import { totalsLines, totalsStrip } from "../src/ui/Totals.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const textOf = (line: Segments) => line.map((each) => each.text).join("")

/** Set aside's cell at `width`, trimmed, or null where the pane is too narrow for the strip. */
const setAside = (t: Totals, width: number) => {
  const line = totalsStrip(t, theme, width)?.[1]
  return line === undefined ? null : (textOf(line).split("│")[2]?.trim() ?? null)
}

// The spec's illustrated state: `✓ 2 Completed` 13, `↷ 1 Set aside · ◆ 1 triaged` 27, `1 Needs
// you` 11 and `9 of 16 In queue · 2 held back` 30, with 13 for the frame and the padding.
const illustrated: Totals = {
  ...emptyView.totals,
  slots: 3,
  completed: 2,
  deferred: 1,
  triaged: 1,
  needsYou: 1,
  queued: 9,
  unclosed: 16,
  heldBack: 2,
}

describe("the totals strip's triage note", () => {
  test("whole where the strip has room for it", () => {
    expect(setAside(illustrated, 120)).toBe("↷ 1 Set aside · ◆ 1 triaged")
    expect(setAside(illustrated, 94)).toBe("↷ 1 Set aside · ◆ 1 triaged")
  })

  test("cut to ` · ◆ n` where it hasn't, then left out", () => {
    expect(setAside(illustrated, 93)).toBe("↷ 1 Set aside · ◆ 1")
    expect(setAside(illustrated, 86)).toBe("↷ 1 Set aside · ◆ 1")
    expect(setAside(illustrated, 85)).toBe("↷ 1 Set aside")
    expect(setAside(illustrated, 80)).toBe("↷ 1 Set aside")
  })

  test("in its style, cut or whole", () => {
    for (const [width, note] of [
      [94, " · ◆ 1 triaged"],
      [86, " · ◆ 1"],
    ] as const) {
      const cells = totalsStrip(illustrated, theme, width)?.[1] ?? []
      expect(cells.find((each) => each.text === note)?.look).toBe(theme.styles.organ)
    }
  })

  test("the strip fills its width at each step", () => {
    for (const width of [94, 93, 86, 85, 80]) {
      const lines = totalsStrip(illustrated, theme, width) ?? []
      expect(lines.map((line) => Bun.stringWidth(textOf(line)))).toEqual([width, width, width])
    }
  })

  test("the totals on one line only below the width the strip needs without the note", () => {
    expect(totalsStrip(illustrated, theme, 79)).toBeNull()
    expect(totalsLines(illustrated, theme, 79, false).map(textOf)).toEqual([
      " ✓ 2 · ↷ 1 ◆ 1 · ? 1 · queue 9 of 16 · 2 held back",
    ])
  })
})
