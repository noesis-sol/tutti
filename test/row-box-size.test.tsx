// The row's box's size (§ 7.2, tutti-9g4c): four fifths of the pane wide, at most 110 columns and at
// least the 72 it had, and as tall as the pane allows within a margin of the dashboard's lines above
// and below, two from 30 lines, one from 20, none under.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { orchestra } from "../src/project/scheme.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies, newAccount } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { boxMargin, boxWidth } from "../src/ui/line.tsx"
import { boxBaseWidth, boxWidest, rowBoxMargin, rowBoxWidth } from "../src/ui/RowBox.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "0c1a9e7ffff" }) })

const issueOf = (description: string): Issue => ({
  id: "d-1" as TicketId,
  title: "Title of d-1",
  description,
  design: "",
  acceptance: "",
  notes: "",
  status: "closed",
  priority: 2,
  type: "feature",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "",
  closeReason: "",
})

const entryOf = (issue: Issue): Entry => ({
  ticket: "d-1" as TicketId,
  title: "Title of d-1",
  phase: merged,
  since: began,
  worker: null,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
  account: { ...newAccount(), took: began - 30 * 60_000 },
  issue,
})

const projected = (issue: Issue): RunView =>
  project({
    ledger: {
      tickets: new Map([["d-1" as TicketId, entryOf(issue)]]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 4 },
    actions: new Map(),
  })

const longTicket = issueOf(Array.from({ length: 80 }, (_, i) => `paragraph line ${i}`).join("\n\n"))

const shortTicket = issueOf("Short.")

type Size = { readonly width: number; readonly height: number }

/**
 * Opens the box on the one done row with Enter twice (into Tickets, then the row), in a pane
 * `size`, or in one `from` and then resized to `size`: the table has no room at the minimum size,
 * so the box comes to it from a pane that was larger.
 */
const opened = async (issue: Issue, size: Size, from: Size = size): Promise<Frame> =>
  withRender(
    <Root
      value={{
        view: external(projected(issue)),
        screen: external(Screen.Dashboard()),
        commands: Effect.runSync(makeCommands),
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 3_600_000,
      }}
    />,
    from,
    async (rendered: Rendered) => {
      await rendered.input((setup) => {
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      if (from !== size) await rendered.input((setup) => setup.resize(size.width, size.height))
      return rendered.capture()
    },
  )

/** Where the box's frame is in a frame of the pane: its first and last line, and its columns. */
const frameOf = (frame: Frame) => {
  const lines = frame.chars.split("\n")
  const top = lines.findIndex((line) => line.includes("╭─ Ticket"))
  const bottom = lines.findLastIndex((line) => line.includes("╯"))
  const border = /╭─ Ticket[^╮]*╮/.exec(lines[top] ?? "")?.[0] ?? ""
  return { top, bottom, width: Bun.stringWidth(border), lines }
}

describe("the box's width", () => {
  test("is four fifths of the pane up to 110 columns, and at least the 72 it had", () => {
    expect(rowBoxWidth(182)).toBe(110)
    expect(rowBoxWidth(200)).toBe(110)
    expect(rowBoxWidth(120)).toBe(96)
    expect(rowBoxWidth(100)).toBe(80)
    expect(rowBoxWidth(90)).toBe(72)
    expect(rowBoxWidth(80)).toBe(72)
    expect(rowBoxWidth(60)).toBe(60 - 2 * boxMargin)
  })

  test("is never wider than 110, nor narrower than the box was, and grows with the pane", () => {
    const asItWas = (width: number) => boxWidth(width, { max: boxBaseWidth, least: 8 })
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), (width) => {
        const wide = rowBoxWidth(width)
        expect(wide).toBeLessThanOrEqual(boxWidest)
        expect(wide).toBeGreaterThanOrEqual(asItWas(width))
        expect(wide).toBeLessThanOrEqual(Math.max(width - 2 * boxMargin, asItWas(width)))
        expect(rowBoxWidth(width + 1)).toBeGreaterThanOrEqual(wide)
      }),
    )
  })
})

describe("the box's margins", () => {
  test("are two lines from 30, one from 20, none under", () => {
    expect(rowBoxMargin(60)).toBe(2)
    expect(rowBoxMargin(40)).toBe(2)
    expect(rowBoxMargin(30)).toBe(2)
    expect(rowBoxMargin(29)).toBe(1)
    expect(rowBoxMargin(24)).toBe(1)
    expect(rowBoxMargin(20)).toBe(1)
    expect(rowBoxMargin(19)).toBe(0)
    expect(rowBoxMargin(16)).toBe(0)
  })
})

describe("the box as drawn", () => {
  const cases: ReadonlyArray<{
    readonly size: Size
    readonly from?: Size
    readonly width: number
    readonly top: number
    readonly bottom: number
  }> = [
    { size: { width: 182, height: 40 }, width: 110, top: 2, bottom: 37 },
    { size: { width: 120, height: 30 }, width: 96, top: 2, bottom: 27 },
    { size: { width: 100, height: 24 }, width: 80, top: 1, bottom: 22 },
    // No margin, and the width it had: as wide as boxMargin leaves of 80 columns is more than 72.
    {
      size: { width: 80, height: 18 },
      from: { width: 100, height: 40 },
      width: 72,
      top: 0,
      bottom: 17,
    },
  ]

  for (const { size, from, width, top, bottom } of cases) {
    test(`at ${size.width}×${size.height} it is ${width} wide, on lines ${top} to ${bottom}`, async () => {
      const frame = await opened(longTicket, size, from)
      const box = frameOf(frame)
      expect(box.top).toBe(top)
      expect(box.bottom).toBe(bottom)
      expect(box.width).toBe(width)
      expect(box.lines[bottom]).toMatch(/↓ \d+ more lines ─╯/)
      // Centred, within the pane.
      const left = box.lines[top]?.indexOf("╭") ?? -1
      expect(left).toBe(Math.floor((size.width - width) / 2))
      expect(left + width).toBeLessThanOrEqual(size.width)
    })
  }

  test("a short ticket keeps the same height, so the box doesn't jump as bd answers", async () => {
    const frame = await opened(shortTicket, { width: 182, height: 40 })
    const box = frameOf(frame)
    expect(box.top).toBe(2)
    expect(box.bottom).toBe(37)
    expect(frame.chars).toContain("Short.")
    expect(frame.chars).not.toContain("more line")
  })
})
