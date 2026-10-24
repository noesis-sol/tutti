// The totals strip (§ 7.2, § 7.11): each count beside its label on one line in a rounded frame,
// the first three cells lined up and the queue's the widest, giving up width as the pane narrows,
// and the totals on one line below the width the strip needs.
import { describe, expect, test } from "bun:test"
import { emptyView, type Totals } from "../src/run/runView.ts"
import type { Segments } from "../src/ui/line.tsx"
import { totalsLines, totalsStrip } from "../src/ui/Totals.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const totals = (over: Partial<Totals>): Totals => ({ ...emptyView.totals, slots: 3, ...over })

const textOf = (line: Segments) => line.map((each) => each.text).join("")

/** The strip's lines as text, or null where the pane is too narrow for it. */
const strip = (t: Totals, width: number) => totalsStrip(t, theme, width)?.map(textOf) ?? null

/** Each cell's width inside its padding, from the strip's line of counts. */
const cellWidths = (t: Totals, width: number) =>
  (strip(t, width)?.[1] ?? "")
    .split("│")
    .slice(1, -1)
    .map((cell) => Bun.stringWidth(cell) - 2)

// `✓ 20 Completed`, 14 columns, and `0 of 9 In queue · 8 held back`, 29.
const typical = totals({ completed: 20, unclosed: 9, heldBack: 8 })
// `↷ 1 Set aside`, 13, `1 Needs you`, 11, and `10 of 16 In queue · 2 held back`, 31.
const tight = totals({ completed: 20, deferred: 1, needsYou: 1, queued: 10, unclosed: 16 })

describe("the totals strip", () => {
  test("puts each count beside its label, on one line between the frame's", () => {
    expect(strip(typical, 100)).toEqual([
      "╭───────────────────┬───────────────────┬───────────────────┬──────────────────────────────────────╮",
      "│ ✓ 20 Completed    │ 0 Set aside       │ 0 Needs you       │ 0 of 9 In queue · 8 held back        │",
      "╰───────────────────┴───────────────────┴───────────────────┴──────────────────────────────────────╯",
    ])
  })

  test("a fifth of a wide strip for each of the first three, the rest for the queue", () => {
    // 107 columns inside the frame: a fifth is 21.
    expect(cellWidths(typical, 120)).toEqual([21, 21, 21, 44])
    expect(strip(typical, 120)?.every((line) => Bun.stringWidth(line) === 120)).toBe(true)
  })

  test("the first three line up at the widest's where a fifth is too narrow", () => {
    expect(cellWidths(typical, 85)).toEqual([14, 14, 14, 30])
  })

  test("then each gives up width down to its own before the queue's goes under its own", () => {
    const at = { ...tight, heldBack: 2 }
    expect(cellWidths(at, 86)).toEqual([14, 14, 14, 31])
    expect(cellWidths(at, 84)).toEqual([14, 13, 13, 31])
    expect(cellWidths(at, 83)).toEqual([14, 13, 12, 31])
    expect(cellWidths(at, 82)).toEqual([14, 13, 11, 31])
    expect(strip(at, 81)).toBeNull()
  })

  test("below the width it needs, the totals on one line", () => {
    const at = { ...tight, heldBack: 2 }
    expect(totalsLines(at, theme, 81, false).map(textOf)).toEqual([
      " ✓ 20 · ↷ 1 · ? 1 · queue 10 of 16 · 2 held back",
    ])
    expect(totalsLines(at, theme, 82, false)).toHaveLength(3)
  })

  test("Set aside's triaged and the queue's notes after their labels", () => {
    const t = totals({
      deferred: 2,
      review: 1,
      triaged: 2,
      queued: 4,
      unclosed: 9,
      heldBack: 1,
      setupFailed: 1,
      queueHeld: true,
    })
    const line = strip(t, 140)?.[1] ?? ""
    expect(line).toContain("│ ↷ 3 Set aside · ◆ 2 triaged ")
    expect(line).toContain("│ 4 of 9 In queue · 1 held back · 1 setup failed · held ")
  })

  test("each count in its style, its label faint, a zero faint whole", () => {
    const t = totals({ completed: 2, needsYou: 1, unclosed: 3 })
    const cells = totalsStrip(t, theme, 100)?.[1] ?? []
    const lookOf = (text: string) => cells.find((each) => each.text === text)?.look
    expect(lookOf("✓ 2")).toBe(theme.styles.closed)
    expect(lookOf(" Completed")).toBe(theme.styles.dim)
    expect(lookOf("0 Set aside")).toBe(theme.styles.dim)
    expect(lookOf("1")).toBe(theme.styles.stop)
    expect(lookOf(" Needs you")).toBe(theme.styles.dim)
    expect(lookOf("0 of 3")).toBe(theme.styles.dim)
    expect(lookOf(" In queue")).toBe(theme.styles.dim)
  })
})
