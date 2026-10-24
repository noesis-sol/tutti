// One text model for the dashboard and what is printed outside it: a look is a style of the theme's,
// built once per theme, and a line of segments is drawn by the renderer or painted as ANSI. The
// summary prints the dashboard's own tickets table, every row of it.
import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import fc from "fast-check"
import { initSummary } from "../src/print/initSummary.ts"
import { type Summary, summary } from "../src/print/summary.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyView, type Row, rowStatus } from "../src/run/runView.ts"
import { boxed, paint, type Segments, seg, wrap } from "../src/ui/line.tsx"
import { ticketsLines } from "../src/ui/TicketsTable.tsx"
import { makeTheme, orchestra, roles } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const noColour = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
const unstyled = makeTheme(orchestra, {
  appearance: "dark",
  depth: "truecolor",
  noColor: false,
  styled: false,
})

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is stripped
const sgr = /\x1b\[[0-9;]*m/g

describe("a role's look", () => {
  test("is built once: the same role and weight give the same look", () => {
    for (const role of roles) {
      expect(theme.look(role)).toBe(theme.look(role))
      expect(theme.look(role, "bold")).toBe(theme.look(role, "bold"))
      expect(theme.look(role, "regular")).toBe(theme.look(role))
      expect(theme.look(role, "bold")).not.toBe(theme.look(role))
      expect(theme.rgba(role)).toBe(theme.rgba(role))
    }
  })

  test("is a style's own where that style draws the same", () => {
    expect(theme.look("live", "bold")).toBe(theme.styles.picked)
    expect(theme.look("done")).toBe(theme.styles.done)
    expect(theme.look("notice")).toBe(theme.styles.deferred)
  })

  test("draws the role's colour as the text's, bold where asked", () => {
    const frame = theme.look("frame")
    expect(frame.fg?.toInts()).toEqual(theme.rgba("frame", "fg").toInts())
    expect(frame.bg).toBeUndefined()
    expect(frame.attributes).toBe(0)
    expect(frame.open).toBe(theme.ansi("frame", "fg"))
    expect(theme.look("needsYou", "bold").attributes).toBe(TextAttributes.BOLD)
    expect(theme.look("needsYou", "bold").open).toBe(`\x1b[1m${theme.ansi("needsYou", "fg")}`)
    expect(theme.look(null, "bold").fg).toBeUndefined()
    expect(theme.look(null, "bold").paint("x")).toBe("\x1b[1mx\x1b[0m")
  })

  test("a background role is drawn as the text's colour, as a frame in it is", () => {
    expect(theme.look("pill").open).toBe(theme.ansi("pill", "fg"))
  })

  test("bold() is the bold look, and itself when bold already", () => {
    expect(theme.look("frame").bold()).toBe(theme.look("frame", "bold"))
    expect(theme.styles.picked.bold()).toBe(theme.styles.picked)
    expect(theme.styles.estimate.bold().attributes).toBe(
      TextAttributes.BOLD | TextAttributes.ITALIC,
    )
  })

  test("the estimate style is italic", () => {
    expect(theme.styles.estimate.attributes & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC)
    expect(theme.styles.estimate.open).toContain("\x1b[3m")
  })

  test("NO_COLOR keeps bold and drops the colour; unstyled output writes no ANSI", () => {
    expect(noColour.look("needsYou", "bold").open).toBe("\x1b[1m")
    expect(unstyled.look("needsYou", "bold").open).toBe("")
    expect(unstyled.look(null, "bold").paint("x")).toBe("x")
  })

  test("a line's runs of one role are one run, however many times the look was asked for", () => {
    const [line] = wrap([seg("ab", theme.look("frame")), seg("cd", theme.look("frame"))], 20)
    expect(line).toEqual([{ text: "abcd", look: theme.look("frame") }])
  })

  test("a heavy frame is the frame's look bold", () => {
    const [top] = boxed([[seg("x")]], 10, theme.look("live"), "heavy")
    expect(top?.[0]?.look).toBe(theme.look("live", "bold"))
  })
})

describe("paint", () => {
  test("paints each segment in its look, the terminal's own text as it is", () => {
    const line: Segments = [
      seg("a", theme.styles.closed),
      seg(" b "),
      seg("c", theme.look("frame")),
    ]
    expect(paint(line)).toBe(
      `${theme.styles.closed.paint("a")} b ${theme.look("frame").paint("c")}`,
    )
  })

  test("unstyled, it is the text alone", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.string(), fc.constantFrom(...roles))), (parts) => {
        const line = parts.map(([text, role]) => seg(text, unstyled.look(role)))
        expect(paint(line)).toBe(parts.map(([text]) => text).join(""))
      }),
    )
  })
})

const row = (ticket: string, phase: TicketPhase, note: string): Row => ({
  ticket,
  label: ticket,
  title: note,
  ...rowStatus(phase),
  note,
  verdict: null,
})

const ended = (rows: ReadonlyArray<Row>): Summary => ({
  version: "0.1.0",
  branch: "main",
  scope: null,
  took: 125_000,
  totals: { ...emptyView.totals, slots: 4 },
  figures: [],
  rows,
})

describe("the summary's tickets", () => {
  const rows = [
    row("tut-1", TicketPhase.Done({ outcome: Finished.NoChange() }), "abc1234 merged into main"),
    { ...row("tut-2", TicketPhase.Deferred({ why: "" }), "gave up"), verdict: "retry after tut-1" },
    row("tut-3", TicketPhase.Working(), "Three"),
  ]

  test("are the dashboard's table, every row and no blank one", () => {
    const table = ticketsLines(rows, theme, 80, { fill: false }).map(paint)
    expect(table).toHaveLength(rows.length + 3)
    expect(summary(ended(rows), theme, 80).split("\n").slice(-table.length)).toEqual(table)
  })

  test("a ticket set aside shows triage's verdict, organ bold", () => {
    const out = summary(ended(rows), theme, 80)
    expect(out).toContain(theme.styles.organ.paint("◆ retry after tut-1"))
    expect(out.replace(sgr, "")).not.toContain("gave up")
  })

  test("every row is shown, however many", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      row(`tut-${i}`, TicketPhase.Done({ outcome: Finished.NoChange() }), "merged"),
    )
    const out = summary(ended(many), theme, 80).replace(sgr, "")
    expect(out).not.toContain("earlier tickets")
    for (const each of many) expect(out).toContain(`${each.label} `)
  })
})

describe("init's Next box", () => {
  const box = (width: number) =>
    initSummary(
      { steps: [], next: ["Install bd\nbrew install beads", "Then run it"], ready: false },
      unstyled,
      width,
    )
      .split("\n")
      .slice(1, -1)

  test("is a pill-framed box, its commands on their own lines", () => {
    expect(box(30)).toEqual([
      "╭────────────────────────────╮",
      "│ Next                       │",
      "│ 1. Install bd              │",
      "│    brew install beads      │",
      "│ 2. Then run it             │",
      "╰────────────────────────────╯",
    ])
  })

  test("frames in pill, its title organ bold, its commands emphasis bold", () => {
    const out = initSummary(
      { steps: [], next: ["Install bd\nbrew install beads"], ready: false },
      theme,
      30,
    )
    expect(out).toContain(theme.look("pill").paint(`╭${"─".repeat(28)}╮`))
    expect(out).toContain(theme.styles.organ.paint("Next"))
    expect(out).toContain(theme.styles.key.paint("brew install beads"))
  })
})
