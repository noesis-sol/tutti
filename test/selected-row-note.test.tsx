// The note of the tickets table's selected row stands out (§ 7.3, § 7.11, tutti-149z.8): lifted to
// the pointer's look, `emphasis` bold, whether it is faint, plain or a verdict, in the light
// variant too, with no fill; a verdict's mark keeps `organ`. Under NO_COLOR a faint note is no
// longer faint.
import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { Effect } from "effect"
import fc from "fast-check"
import { orchestra } from "../src/project/scheme.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type Row, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { marks } from "../src/text/marks.ts"
import { Root } from "../src/ui/App.tsx"
import { type Segments, widthOf } from "../src/ui/line.tsx"
import { ticketsLines } from "../src/ui/TicketsTable.tsx"
import { type Appearance, makeTheme, type Theme } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"
import { rowsIn } from "./screen.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 6, 13, 0, 0).getTime()

const entryOf = (ticket: string, row: number, phase: TicketPhase): Entry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** The table's three kinds of note, as `byAttention` lists them: plain, a verdict, faint. */
const view: RunView = project({
  ledger: {
    tickets: new Map(
      [
        entryOf("d-1", 0, TicketPhase.Done({ outcome: Finished.Merged({ commit: "55ea1b1" }) })),
        entryOf("s-1", 1, TicketPhase.Deferred({ why: "gave up" })),
        entryOf("b-1", 2, TicketPhase.Blocked({ why: "DIRTY_TREE" })),
      ].map((each) => [each.ticket, each]),
    ),
    rows: 3,
    windDown: null,
    bugs: [],
  },
  workers: new Map(),
  requests: [],
  status: {
    ...emptyStatus,
    version: "0.1.0",
    branch: "batch",
    began,
    concurrency: 1,
    verdicts: new Map([["s-1", "environment · high"]]),
  },
  actions: new Map(),
})

const size = { width: 100, height: 40 }

const scene = (appearance: Appearance, body: (rendered: Rendered) => Promise<void>) => {
  const value = {
    view: external(view),
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>(appearance),
    themeOf,
    now: () => began,
  }
  return withRender(<Root value={value} />, size, body)
}

/** The span of `frame`'s table saying `text`, on the row of `ticket`. */
const spanOf = (frame: Frame, ticket: string, text: string) => {
  const y = rowsIn(frame).find((row) => row.ticket === ticket)?.line ?? -1
  const span = frame.spans.lines[y]?.spans.find((each) => each.text.includes(text))
  if (span === undefined) throw new Error(`no span says ${text} on the row of ${ticket}`)
  return span
}

const dim = (span: { readonly attributes: number }) => (span.attributes & TextAttributes.DIM) !== 0
const bold = (span: { readonly attributes: number }) =>
  (span.attributes & TextAttributes.BOLD) !== 0

/** The frame with the keys inside the table, the rows selected in turn: b-1, s-1, then d-1. */
const framesOf = async (rendered: Rendered) => {
  const out = await rendered.capture()
  await rendered.input((setup) => setup.mockInput.pressEnter())
  const plain = await rendered.capture()
  await rendered.input((setup) => setup.mockInput.pressArrow("down"))
  const verdict = await rendered.capture()
  await rendered.input((setup) => setup.mockInput.pressArrow("down"))
  return { out, plain, verdict, faint: await rendered.capture() }
}

describe.each<Appearance>(["dark", "light"])("the selected row's note, %s", (appearance) => {
  const theme = themeOf(appearance)
  const emphasis = theme.rgba("emphasis").toInts()

  test("a faint note leaves dim for emphasis bold, more than bold alone, with no fill", async () => {
    await scene(appearance, async (rendered) => {
      const { out, faint } = await framesOf(rendered)
      const note = "55ea1b1"
      const before = spanOf(out, "d-1", note)
      expect(dim(before)).toBe(true)
      expect(bold(before)).toBe(false)
      const after = spanOf(faint, "d-1", note)
      expect(dim(after)).toBe(false)
      expect(bold(after)).toBe(true)
      expect(after.fg.toInts()).toEqual(emphasis)
      expect(after.bg.toInts()).toEqual(before.bg.toInts())
    })
  })

  test("a plain note goes emphasis bold, with no fill", async () => {
    await scene(appearance, async (rendered) => {
      const { out, plain } = await framesOf(rendered)
      const before = spanOf(out, "b-1", "Title of b-1")
      expect(bold(before)).toBe(false)
      const after = spanOf(plain, "b-1", "Title of b-1")
      expect(bold(after)).toBe(true)
      expect(after.fg.toInts()).toEqual(emphasis)
      expect(after.bg.toInts()).toEqual(before.bg.toInts())
    })
  })

  test("a verdict, already bold, changes colour too, and its mark keeps organ", async () => {
    await scene(appearance, async (rendered) => {
      const { out, verdict } = await framesOf(rendered)
      const organ = theme.rgba("organ").toInts()
      const before = spanOf(out, "s-1", "environment · high")
      expect(before.fg.toInts()).toEqual(organ)
      const after = spanOf(verdict, "s-1", "environment · high")
      expect(after.fg.toInts()).toEqual(emphasis)
      expect(bold(after)).toBe(true)
      expect(after.bg.toInts()).toEqual(before.bg.toInts())
      expect(spanOf(verdict, "s-1", marks.verdict).fg.toInts()).toEqual(organ)
    })
  })

  test("the state and the ID keep their colours", async () => {
    await scene(appearance, async (rendered) => {
      const { out, faint } = await framesOf(rendered)
      const before = spanOf(out, "d-1", "d-1")
      const after = spanOf(faint, "d-1", "d-1")
      expect(after.fg.toInts()).toEqual(before.fg.toInts())
      expect(bold(after)).toBe(true)
    })
  })
})

describe("the note's cell", () => {
  const linesOf = (theme: Theme, rows: ReadonlyArray<Row>, width: number, highlighted: TicketId) =>
    ticketsLines(
      rows,
      theme,
      width,
      { fill: false },
      { highlighted, target: () => undefined, idTarget: () => 1, copied: null },
    )

  test("under NO_COLOR a faint note is bold and no longer faint, the row's cue no colour", () => {
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
    const line = linesOf(theme, view.rows, 80, "d-1" as TicketId).find((each) =>
      each.some((part) => part.text.includes("55ea1b1")),
    )
    const look = line?.find((part) => part.text.includes("55ea1b1"))?.look
    expect(look).toBe(theme.styles.key)
    expect(dim({ attributes: look?.attributes ?? 0 })).toBe(false)
    expect(bold({ attributes: look?.attributes ?? 0 })).toBe(true)
  })

  test("says what the row says, in its width, selected or not, whatever the text", () => {
    const theme = themeOf("dark")
    const [first] = view.rows
    if (first === undefined) throw new Error("no row")
    const textOf = (lines: ReadonlyArray<Segments>) =>
      lines.map((line) => line.map((part) => part.text).join(""))
    fc.assert(
      fc.property(
        fc.option(fc.string()),
        fc.string(),
        fc.integer({ min: 34, max: 90 }),
        (verdict, note, width) => {
          const rows = [{ ...first, verdict, note }]
          const plain = linesOf(theme, rows, width, "other" as TicketId)
          const selected = linesOf(theme, rows, width, first.ticket)
          // Only the pointer's gutter differs, and the cell stays as wide as the table gives it.
          expect(textOf(selected).map((line) => line.replace(marks.selected, " "))).toEqual(
            textOf(plain),
          )
          expect(selected.map(widthOf)).toEqual(plain.map(widthOf))
        },
      ),
      { numRuns: 40 },
    )
  })
})
