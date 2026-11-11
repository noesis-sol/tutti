// A card resolving its conflicts or fixing its check (§ 5.1, § 7.11): its mark is ⟳ in its row's
// tone, as the ticket's row has it, not the spinner, whether its worker works or its turn has ended;
// its frame is still `live` while the worker works. The compact Current lines and the worker view's
// line 1 draw the same mark.

import { describe, expect, test } from "bun:test"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { type Card, emptyStatus, project, type RunView } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { marks } from "../src/text/marks.ts"
import { cardLines, cardMark, compactLines } from "../src/ui/Card.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { lookOf, motionTones } from "../src/ui/tone.ts"
import { lineOneSegments } from "../src/ui/worker/Head.tsx"
import { cardHead, cardOn } from "./screen.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const began = new Date(2026, 10, 3, 13, 0, 0).getTime()
const now = began + 67_000
const spin = "⣽"

const entryOf = (ticket: TicketId, phase: TicketPhase): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker: 1,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView of `ticket` alone in `phase`, its worker in `state`, or none yet. */
const viewOf = (phase: TicketPhase, state?: WorkerState): RunView => {
  const ticket = "t-1" as TicketId
  return project({
    ledger: {
      tickets: new Map([[ticket, entryOf(ticket, phase)]]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map(state === undefined ? [] : [[ticket, state]]),
    requests: [],
    status: { ...emptyStatus, branch: "main", began, concurrency: 2 },
    actions: new Map(),
  })
}

const cardOf = (view: RunView): Card => {
  const card = view.cards[0]
  if (card === undefined) throw new Error("no card")
  return card
}

const textOf = (segments: Segments) => segments.map((each) => each.text).join("")

const working = WorkerState.Working({ doing: "editing" })
const idle = WorkerState.Idle({ at: began })

const reworking = [
  ["resolving", TicketPhase.Resolving({ attempt: 1 })],
  ["fixing", TicketPhase.Fixing({ attempt: 1, afterResolution: false })],
] as const

describe("a card resolving or fixing", () => {
  for (const [word, phase] of reworking) {
    for (const [name, state] of [
      ["its worker working", working],
      ["its worker's turn ended", idle],
      ["its session opening", undefined],
    ] as const) {
      test(`${word}, ${name}: ⟳ in its row's tone, as its row has it`, () => {
        const view = viewOf(phase, state)
        const card = cardOf(view)
        expect(card.motion).toBe("reworking")
        const row = view.rows[0]
        expect(row?.mark).toBe("reworking")
        expect(row?.word).toBe(word)
        const mark = cardMark(card, theme, spin)
        expect(mark.text).toBe("⟳")
        expect(mark.text).toBe(marks[row?.mark ?? "working"])
        expect(motionTones.reworking).toBe(row?.tone ?? "picked")
        expect(mark.look).toEqual(lookOf(row?.tone ?? "picked", theme))
      })
    }

    test(`${word}: the full card's head starts ⟳ and never the spinner`, () => {
      const card = cardOf(viewOf(phase, working))
      const lines = cardLines(card, theme, { now, spin, width: 60, inside: 3, highlighted: false })
      expect(cardOn(lines, "t-1")).toMatchObject({ mark: "⟳", status: card.status })
      expect(lines.map(textOf).join("\n")).not.toContain(spin)
    })

    test(`${word}: the compact line and the worker view's line 1 draw ⟳`, () => {
      const card = cardOf(viewOf(phase, working))
      const compact = compactLines([card], theme, { now, spin, width: 80, highlighted: null })
      expect(cardOn(compact, "t-1")).toMatchObject({ mark: "⟳", compact: true })
      const lineOne = lineOneSegments(
        card,
        {
          status: [{ text: card.status, look: null }],
          spin,
          resources: undefined,
          figures: { usage: null, now },
          badges: false,
        },
        theme,
        200,
      )
      expect(textOf(lineOne).startsWith(`${cardHead("⟳", "t-1")}  ${card.status}`)).toBe(true)
    })

    test(`${word}: framed live while its worker works, plain once its turn has ended`, () => {
      const frameLook = (state: WorkerState) => {
        const card = cardOf(viewOf(phase, state))
        const full = cardLines(card, theme, { now, spin, width: 60, inside: 3, highlighted: false })
        const compact = compactLines([card], theme, { now, spin, width: 80, highlighted: null })
        return [full[0]?.[0]?.look, compact[0]?.[0]?.look]
      }
      expect(frameLook(working)).toEqual([theme.look("live"), theme.look("live")])
      expect(frameLook(idle)).toEqual([theme.look("frame"), theme.look("frame")])
    })
  }

  test("a Working card still spins while its worker works, and shows • once its turn ends", () => {
    expect(cardOf(viewOf(TicketPhase.Working(), working)).motion).toBe("spinner")
    expect(cardOf(viewOf(TicketPhase.Working(), idle)).motion).toBe("idle")
  })
})
