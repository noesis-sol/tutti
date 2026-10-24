// The totals strip's Set aside cell with its triage note (§ 7.2): the note doesn't set the other
// cells' width, so Completed and Needs you line up at a fifth of the strip while Set aside goes past
// them, and the queue keeps the room the note would have taken from it (tutti-iolm).
import { describe, expect, test } from "bun:test"
import { emptyView, type Totals } from "../src/run/runView.ts"
import type { Segments } from "../src/ui/line.tsx"
import { totalsStrip } from "../src/ui/Totals.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const textOf = (line: Segments) => line.map((each) => each.text).join("")

/** Each cell's width inside its padding, from the strip's line of counts. */
const cellWidths = (t: Totals, width: number) =>
  textOf(totalsStrip(t, theme, width)?.[1] ?? [])
    .split("│")
    .slice(1, -1)
    .map((cell) => Bun.stringWidth(cell) - 2)

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

describe("the totals strip's Set aside cell with its triage note", () => {
  test("goes past the others, which keep a fifth, and the queue keeps the rest", () => {
    // 107 columns inside the frame: a fifth is 21.
    expect(cellWidths(illustrated, 120)).toEqual([21, 27, 21, 38])
    // 127: a fifth is 25.
    expect(cellWidths(illustrated, 140)).toEqual([25, 27, 25, 50])
  })

  test("the others give up their width to the queue as before as the pane narrows", () => {
    expect(cellWidths(illustrated, 100)).toEqual([15, 27, 15, 30])
    expect(cellWidths(illustrated, 94)).toEqual([13, 27, 11, 30])
  })

  test("without the note, all three still line up at the widest's", () => {
    const wide = { ...illustrated, triaged: 0, completed: 2000 }
    // `✓ 2000 Completed` 16 is wider than a fifth of the 78 columns inside the frame, 15.
    expect(cellWidths(wide, 91)).toEqual([16, 16, 16, 30])
  })

  test("the strip fills its width", () => {
    for (const width of [94, 100, 120, 140]) {
      const lines = totalsStrip(illustrated, theme, width) ?? []
      expect(lines.map((line) => Bun.stringWidth(textOf(line)))).toEqual([width, width, width])
    }
  })
})
