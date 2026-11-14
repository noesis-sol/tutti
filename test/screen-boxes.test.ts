// test/screen.ts' boxes, read back from what src/ui/line.tsx draws: a box cut out of the screen by
// its corners, its border's words, the lines inside it without its padding, the innermost box that
// says a text, and the totals strip's cells. A box's padding is checked here, once, for every test
// that reads a box.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { tuttiScheme } from "../src/project/scheme.ts"
import { emptyView, type Totals } from "../src/run/runView.ts"
import { boxed, boxSides, framed, frameEdge, type Segments, seg } from "../src/ui/line.tsx"
import { boxPad } from "../src/ui/spacing.ts"
import { totalsLines, totalsStrip } from "../src/ui/Totals.tsx"
import { makeTheme } from "../src/ui/theme.ts"
import { boxesIn, boxLine, boxWith, insideOf, screenLines, tableCells, totalsIn } from "./screen.ts"

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: false })
const frame = theme.look("frame")

const words = (...lines: ReadonlyArray<string>): ReadonlyArray<Segments> =>
  lines.map((line) => (line === "" ? [] : [seg(line)]))

/** A box `width` wide around `lines`, `head` and `foot` in its borders, as the Ticket box is. */
const named = (head: string, foot: string, width: number, ...lines: ReadonlyArray<string>) => [
  frameEdge("top", width, frame, "rounded", [seg(head)]),
  ...boxSides(words(...lines), width, frame),
  frameEdge("bottom", width, frame, "rounded", foot === "" ? [] : [seg(foot)]),
]

describe("a box's padding", () => {
  test("is a space each side of boxed's lines and of framed's cells", () => {
    expect(screenLines(boxed(words("x"), 8, frame))).toEqual(["╭──────╮", "│ x    │", "╰──────╯"])
    expect(screenLines(framed([words("a", "b")], [1, 2], frame))).toEqual([
      "╭───┬────╮",
      "│ a │ b  │",
      "╰───┴────╯",
    ])
  })

  test("boxLine writes a box's line up to its text, as boxed draws it", () => {
    expect(screenLines(boxed(words("text"), 20, frame))[1]).toStartWith(boxLine("text"))
    expect(screenLines(boxed(words("text"), 20, frame, "heavy"))[1]).toStartWith(
      boxLine("text", "┃"),
    )
    expect(insideOf(`${boxLine("text")}   │`)).toBe("text")
  })
})

describe("boxesIn and boxWith", () => {
  test("read a box by its corners: its borders' words and its lines, its padding left out", () => {
    const lines = named("Ticket", "▾ whole ticket  t", 40, "The title", "", "  indented", "last")
    expect(boxWith(lines, "Ticket")).toEqual({
      top: 0,
      bottom: 5,
      left: 0,
      right: 39,
      head: ["Ticket"],
      foot: ["▾ whole ticket  t"],
      lines: ["The title", "", "  indented", "last"],
      heavy: false,
    })
  })

  test("read boxes side by side, a heavy one, and one inside another", () => {
    const left = boxed(words("one"), 12, frame)
    const right = boxed(words("two"), 10, frame, "heavy")
    const inner = boxed(words("deep"), 10, frame)
    const outer = boxed([[], ...inner, []], 20, frame)
    // The inner box starts inside the outer's side and padding, two columns in.
    const inset = 2 + 1 + boxPad.length
    const screen = [
      ...left.map((line, i) => [...line, ...(right[i] ?? [])]),
      ...outer.map((line) => [seg("  "), ...line]),
    ]
    expect(boxesIn(screen).map((box) => [box.top, box.left, box.right, box.heavy])).toEqual([
      [0, 0, 11, false],
      [0, 12, 21, true],
      [3, 2, 21, false],
      [5, inset, inset + 9, false],
    ])
    // The innermost box that says it, whichever holds it too.
    expect(boxWith(screen, "deep")).toMatchObject({ top: 5, left: inset, lines: ["deep"] })
    expect(boxWith(screen, "two").lines).toEqual(["two"])
  })

  test("read a box the screen cuts, with no bottom; throw where no box says the text", () => {
    const cut = boxed(words("a", "b", "c"), 10, frame).slice(0, 3)
    expect(boxWith(cut, "a")).toMatchObject({ bottom: null, lines: ["a", "b"], foot: [] })
    expect(() => boxWith(cut, "z")).toThrow("no box says z")
    expect(boxesIn(["│ a │", "╰───╯"])).toEqual([])
  })

  test("read back any line boxed draws", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ -~]{0,30}$/),
        fc.integer({ min: 34, max: 60 }),
        (text, width) => {
          const [box] = boxesIn(boxed(words(text), width, frame))
          expect(box?.lines).toEqual([text.trimEnd()])
          expect(box?.right).toBe(width - 1)
        },
      ),
    )
  })
})

describe("the totals strip's cells", () => {
  const totals = (over: Partial<Totals>): Totals => ({ ...emptyView.totals, slots: 3, ...over })

  test("totalsIn reads them, and none where the totals are on one line", () => {
    const t = totals({ completed: 20, unclosed: 9, heldBack: 8 })
    expect(totalsIn(totalsStrip(t, theme, 100) ?? [])).toEqual([
      "✓ 20 Completed",
      "0 Set aside",
      "0 Needs you",
      "0 of 9 In queue · 8 held back",
    ])
    expect(totalsIn(totalsLines(t, theme, 40, true))).toEqual([])
  })

  test("tableCells splits a table's line inside its box", () => {
    const [box] = boxesIn(framed([words("a", "bb", "c")], [3, 3, 3], frame))
    expect(tableCells(box?.lines[0] ?? "")).toEqual(["a", "bb", "c"])
  })
})
