// Up next's reasons, `ready`, `nothing queued` and `+N more` in `quiet` (§ 7.11, tutti-dzbv): the
// grey a step above faint the title line's account windows take; faint under NO_COLOR. The IDs and
// the label keep their styles.

import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import type { QueueRow, Totals } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { upNextLines } from "../src/ui/SidePanel.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"

const themeOf = (appearance: Appearance, noColor = false) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor })

const row = (label: string, held: string | null): QueueRow => ({
  ticket: label as TicketId,
  label,
  title: label,
  held,
})

const queue: ReadonlyArray<QueueRow> = [
  row("t-1", null),
  row("t-2", "touches scripts/check.sh, like running t-9"),
  row("t-3", "t-1 not merged yet"),
  row("t-4", "t-2 not merged yet"),
  row("t-5", "t-3 not merged yet"),
]

const totals: Totals = {
  completed: 0,
  deferred: 0,
  review: 0,
  triaged: 0,
  needsYou: 0,
  asked: 0,
  workers: 0,
  slots: 4,
  queued: 5,
  unclosed: null,
  heldBack: 4,
  setupFailed: 0,
  queueHeld: false,
}

/** The segment drawn as `text` in Up next's lines. */
const segmentOf = (lines: ReturnType<typeof upNextLines>, text: string) =>
  lines.flat().find((segment) => segment.text === text)

describe("Up next's quiet parts", () => {
  test("the reasons, ready and +N more take the quiet style; the IDs and the label keep theirs", () => {
    for (const appearance of ["dark", "light"] as const) {
      const theme = themeOf(appearance)
      const { styles } = theme
      const lines = upNextLines(queue, totals, theme, 50, 8)
      expect(segmentOf(lines, "ready")?.look).toBe(styles.quiet)
      expect(segmentOf(lines, "touches scripts/check.sh, like running")?.look).toBe(styles.quiet)
      expect(segmentOf(lines, "t-9")?.look).toBe(styles.quiet)
      expect(segmentOf(lines, "t-1 not merged yet")?.look).toBe(styles.quiet)
      expect(segmentOf(lines, "+2 more")?.look).toBe(styles.quiet)
      expect(segmentOf(lines, "t-1")?.look).toBeNull()
      expect(segmentOf(lines, "t-2")?.look).toBe(styles.heldBack)
      expect(segmentOf(lines, "Up next")?.look).toBe(styles.tickets)
      expect(segmentOf(lines, " · 4 held back")?.look).toBe(styles.heldBack)
      // The quiet colour, not faint.
      expect(styles.quiet.fg).toBeDefined()
      expect(styles.quiet.attributes & TextAttributes.DIM).toBe(0)
    }
  })

  test("nothing queued takes the quiet style", () => {
    const theme = themeOf("dark")
    const lines = upNextLines([], { ...totals, queued: 0, heldBack: 0 }, theme, 50, 6)
    expect(segmentOf(lines, "nothing queued")?.look).toBe(theme.styles.quiet)
  })

  test("is faint, in the text's colour, under NO_COLOR", () => {
    const theme = themeOf("dark", true)
    const lines = upNextLines(queue, totals, theme, 50, 8)
    for (const text of ["ready", "t-1 not merged yet", "+2 more"]) {
      const look = segmentOf(lines, text)?.look
      expect(look?.fg).toBeUndefined()
      expect(look?.attributes).toBe(TextAttributes.DIM)
    }
    const none = upNextLines([], { ...totals, queued: 0, heldBack: 0 }, theme, 50, 6)
    expect(segmentOf(none, "nothing queued")?.look?.attributes).toBe(TextAttributes.DIM)
  })
})
