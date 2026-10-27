// The marks table (src/ui/marks.ts): each glyph a cell wide in every terminal, plain Unicode and
// no emoji, and each meaning its own glyph. Today's glyphs fall short in places, listed here as
// known exceptions until the curated set of the worker-view design (tutti-cxgo D7) replaces them;
// a new mark must not add to them. Not tested: shapes that differ but look alike, ■ and ◼.

import { describe, expect, test } from "bun:test"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { type Entry, emptyTallies, type State } from "../src/run/ledger.ts"
import { type Activity, activities, Finished, TicketPhase, WaitFor } from "../src/run/phase.ts"
import { emptyStatus, project, rowStatus } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { lookOf, type Mark, marks, motionTones } from "../src/ui/marks.ts"
import { makeTheme, orchestra, type StyleName } from "../src/ui/theme.ts"
import { workersDoing } from "./activity.ts"

const all = Object.entries(marks) as ReadonlyArray<readonly [Mark, string]>

/**
 * East Asian Width A: a cell wide in most terminals, two in a CJK locale's. The gauge's ━ and ─
 * (tutti-1l30) are box-drawing lines, as every box's border is, so they risk nothing the borders
 * don't.
 */
const ambiguous: ReadonlyArray<string> = ["▶", "■", "◆", "•", "●", "○", "♪", "━", "─"]

/** Extended_Pictographic: an emoji with a variation selector after it, and in some fonts. */
const pictographic: ReadonlyArray<string> = ["▶", "◼"]

/** The meanings that share a glyph today. */
const shared: ReadonlyArray<ReadonlyArray<Mark>> = [
  ["waitsForYou", "stopped", "windingDown"],
  ["merging", "verdict", "organ"],
  ["review", "caution"],
  ["idle", "kept"],
  ["latest", "selected"],
]

describe("the marks", () => {
  test("each is one glyph a cell wide", () => {
    for (const [meaning, glyph] of all) {
      expect([meaning, [...glyph].length, Bun.stringWidth(glyph)]).toEqual([meaning, 1, 1])
    }
  })

  test("none is ambiguous-width but the known ones", () => {
    const wide = all
      .filter(([, glyph]) => Bun.stringWidth(glyph, { ambiguousIsNarrow: false }) !== 1)
      .map(([, glyph]) => glyph)
    expect([...new Set(wide)].sort()).toEqual([...ambiguous].sort())
  })

  test("none is an emoji but the known ones", () => {
    const emoji = all
      .filter(([, glyph]) => /\p{Extended_Pictographic}/u.test(glyph))
      .map(([, glyph]) => glyph)
    expect([...new Set(emoji)].sort()).toEqual([...pictographic].sort())
  })

  test("each meaning has its own glyph but the known ones", () => {
    const byGlyph = new Map<string, Array<Mark>>()
    for (const [meaning, glyph] of all) byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), meaning])
    const sharing = [...byGlyph.values()].filter((meanings) => meanings.length > 1)
    expect(sharing.map((meanings) => [...meanings].sort()).sort()).toEqual(
      shared.map((meanings) => [...meanings].sort()).sort(),
    )
  })
})

// The look of each row's word before the table (TicketsTable.tsx's rowLooks).
const looksBefore: Readonly<Record<string, readonly [StyleName, boolean]>> = {
  working: ["picked", false],
  editing: ["picked", false],
  reading: ["picked", false],
  subagent: ["picked", false],
  starting: ["picked", false],
  testing: ["testing", false],
  done: ["closed", true],
  deferred: ["deferred", true],
  review: ["deferred", true],
  resolving: ["deferred", false],
  fixing: ["deferred", false],
  retrying: ["deferred", false],
  limit: ["deferred", false],
  stopped: ["stop", false],
  blocked: ["stop", false],
  "for you": ["stop", false],
  "allow?": ["stop", false],
  "answer?": ["stop", false],
  "to merge": ["toMerge", false],
  merging: ["merging", false],
  waiting: ["dim", true],
  queued: ["dim", true],
  "held back": ["dim", true],
}

const atStart = (phase: TicketPhase) => [phase, "starting"] as const

/** Each phase, a Working ticket's by each of its worker's activities; the others' is `starting`. */
const phases: ReadonlyArray<readonly [TicketPhase, Activity]> = [
  ...[TicketPhase.Queued(), TicketPhase.HeldBack({ why: "overlap" })].map(atStart),
  ...activities.map((activity) => [TicketPhase.Working(), activity] as const),
  ...[
    TicketPhase.ToMerge({ place: 1 }),
    TicketPhase.Merging({ step: "check" }),
    TicketPhase.Resolving({ attempt: 1 }),
    TicketPhase.Fixing({ attempt: 1, afterResolution: false }),
    TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc1234" }) }),
    TicketPhase.Asked({ question: "q-1" }),
    TicketPhase.Waiting({ for: WaitFor.Blockers({ ids: ["t-0" as TicketId] }) }),
    TicketPhase.Deferred({ why: "gave up" }),
    TicketPhase.Review({ why: "CHECKS_FAILED" }),
    TicketPhase.Blocked({ why: "MERGE_CONFLICT" }),
    TicketPhase.Stopped({ why: "PAUSED" }),
  ].map(atStart),
]

const entry = (ticket: TicketId, phase: TicketPhase, row: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase,
  since: 0,
  worker: row + 1,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const ledgerOf = (entries: ReadonlyArray<Entry>): State => ({
  tickets: new Map(entries.map((each) => [each.ticket, each])),
  rows: entries.length,
  windDown: null,
  bugs: [],
})

describe("a row's status", () => {
  test("each phase's tone and faintness are the look its word had before the table", () => {
    for (const [phase, activity] of phases) {
      const { word, tone, faint } = rowStatus(phase, activity)
      expect([word, tone, faint]).toEqual([word, ...(looksBefore[word] ?? ["none", false])])
    }
  })

  test("is the table's own, worked out as RunView is projected and kept while unchanged", () => {
    const entries = phases.map(([phase], i) => entry(`t-${i}` as TicketId, phase, i))
    const { workers, requests } = workersDoing(
      phases.flatMap(([phase, activity], i) =>
        phase._tag === "Working" ? [[`t-${i}`, activity] as const] : [],
      ),
    )
    const view = project({
      ledger: ledgerOf(entries),
      workers: new Map(workers),
      requests,
      status: emptyStatus,
    })
    for (const [i, [phase, activity]] of phases.entries()) {
      const row = view.rows.find((each) => each.ticket === `t-${i}`)
      const { mark, word, tone, faint } = rowStatus(phase, activity)
      expect(row && { mark: row.mark, word: row.word, tone: row.tone, faint: row.faint }).toEqual({
        mark,
        word,
        tone,
        faint,
      })
    }
    // Another ticket's change leaves the others' rows as they were.
    const moved = entries.map((each, i) =>
      i === 0 ? { ...each, phase: TicketPhase.Working() } : each,
    )
    const testing = new Map([
      ...workers,
      ["t-0", WorkerState.Working({ doing: "testing" })] as const,
    ])
    const next = project(
      { ledger: ledgerOf(moved), workers: testing, requests, status: emptyStatus },
      view,
    )
    expect(next.rows.slice(1).every((row, i) => row === view.rows[i + 1])).toBe(true)
    expect(next.rows[0]?.tone).toBe("testing")
  })

  test("every tone is a look of the theme's", () => {
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
    const tones = [
      ...phases.map(([phase, activity]) => rowStatus(phase, activity).tone),
      ...Object.values(motionTones),
    ]
    for (const tone of tones) expect(lookOf(tone, theme)).toBeDefined()
    expect(lookOf("failed", theme)).toBe(theme.look("needsYou"))
  })
})
