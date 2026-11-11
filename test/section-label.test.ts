// One sectionLabel for the dashboard's section labels (tutti-6bwa.6): Tickets, Current, Up next,
// Needs you and the Needs you list's draw theirs through it, and colours' sample does too.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { orchestra } from "../src/project/scheme.ts"
import { separator } from "../src/text/marks.ts"
import { type Segments, sectionLabel, seg } from "../src/ui/line.tsx"
import { needsListLabel } from "../src/ui/NeedsList.tsx"
import { needsLines, upNextLines } from "../src/ui/SidePanel.tsx"
import { labelIndent } from "../src/ui/spacing.ts"
import { ticketsLines } from "../src/ui/TicketsTable.tsx"
import { makeTheme } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const root = resolve(import.meta.dir, "..")

/** The text of `segments`, looks left out. */
const text = (segments: Segments): string => segments.map((each) => each.text).join("")

describe("sectionLabel", () => {
  test("draws the label past labelIndent, lit with the focus and quiet without it", () => {
    expect(sectionLabel("Tickets", theme, { lit: true })).toEqual([
      seg(labelIndent),
      seg("Tickets", theme.styles.tickets),
    ])
    expect(sectionLabel("Current", theme, { lit: false })).toEqual([
      seg(labelIndent),
      seg("Current", theme.styles.quiet),
    ])
  })

  test("draws a label with a look of its own in it, whatever the focus", () => {
    for (const lit of [true, false]) {
      expect(sectionLabel("Needs you", theme, { lit, look: theme.styles.stop })[1]).toEqual(
        seg("Needs you", theme.styles.stop),
      )
    }
  })

  test("puts its count after the faint separator", () => {
    const label = sectionLabel("Needs you", theme, {
      lit: true,
      count: seg("2", theme.styles.stop),
    })
    expect(label).toEqual([
      seg(labelIndent),
      seg("Needs you", theme.styles.tickets),
      seg(separator, theme.styles.dim),
      seg("2", theme.styles.stop),
    ])
    expect(text(label)).toBe(`${labelIndent}Needs you${separator}2`)
  })

  test("leaves out the indent where a box's side sets the label in", () => {
    expect(text(sectionLabel("Needs you", theme, { lit: true, indented: false }))).toBe("Needs you")
  })
})

describe("the dashboard's labels", () => {
  test("are sectionLabel's", () => {
    // A panel's lines are padded to its width: the label is what they start with.
    const startsWith = (line: Segments | undefined, label: Segments) =>
      expect(line?.slice(0, label.length)).toEqual([...label])
    const at = { focused: true, inside: false, choice: 0 }
    startsWith(
      needsLines(undefined, 3, at, theme, 60, 8)[0],
      sectionLabel("Needs you", theme, { lit: true, count: seg("3", theme.styles.stop) }),
    )
    const totals = { heldBack: 0 } as Parameters<typeof upNextLines>[1]
    startsWith(
      upNextLines([], totals, theme, 60, 8)[0],
      sectionLabel("Up next", theme, { lit: false }),
    )
    startsWith(
      ticketsLines([], theme, 80, { lines: 4 })[0],
      sectionLabel("Tickets", theme, { lit: true }),
    )
  })

  test("the Needs you list's is unindented, in the stop style, its place spaced from it", () => {
    expect(needsListLabel(0, 3, 5, 60, theme)).toEqual(
      sectionLabel("Needs you", theme, { lit: true, look: theme.styles.stop, indented: false }),
    )
    const counted = needsListLabel(1, 5, 3, 60, theme)
    // Its place went through fit with the separator once, which lost the space before the `·`.
    expect(text(counted)).toBe(`Needs you${separator}2 of 5`)
    expect(counted.at(-1)).toEqual(seg("2 of 5", theme.styles.dim))
  })

  test("take labelIndent from sectionLabel alone", () => {
    const files = [
      ...[...new Bun.Glob("**/*.{ts,tsx}").scanSync(resolve(root, "src/ui"))].map(
        (file) => `src/ui/${file}`,
      ),
      "src/cli/colours.ts",
    ].filter((file) => file !== "src/ui/line.tsx" && file !== "src/ui/spacing.ts")
    const found = files.filter((file) =>
      readFileSync(resolve(root, file), "utf8").includes("labelIndent"),
    )
    expect(found).toEqual([])
  })
})
