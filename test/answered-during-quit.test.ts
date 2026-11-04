// A question answered, its ticket with no slot, as the run quits (tutti-0ucl, § 5.1): a quit takes
// nothing back, so its row and Up next say the next run, not the next free slot.
import { describe, expect, test } from "bun:test"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, resumesAt } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import type { Segments } from "../src/ui/line.tsx"
import { upNextLines } from "../src/ui/SidePanel.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const quitting = "Quitting… waiting for t-1's worker"

const viewOf = (status: { readonly quitting: string | null }): RunView =>
  project({
    ledger: {
      tickets: new Map([
        [
          "fab-a" as TicketId,
          {
            ticket: "fab-a" as TicketId,
            title: "Title of fab-a",
            phase: TicketPhase.Asked({ question: "q-a" }),
            since: 0,
            worker: null,
            row: 0,
            rechecking: false,
            steered: false,
            lastMessage: null,
            tallies: emptyTallies,
          },
        ],
      ]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, answered: new Set(["q-a"]), ...status },
    actions: new Map(),
  })

const text = (segments: Segments): string => segments.map((each) => each.text).join("")

describe("an answered ticket as the run quits", () => {
  test("its row says the next run takes it back", () => {
    const view = viewOf({ quitting })
    expect(view.rows.find((row) => row.ticket === "fab-a")?.note).toBe(
      "(resumes at the next run) Title of fab-a",
    )
  })

  test("Up next says so too", () => {
    const view = viewOf({ quitting })
    expect(view.queue[0]?.answered).toBe("the next run")
    expect(text(upNextLines(view.queue, view.totals, theme, 50, 6)[2] ?? [])).toContain(
      "answered · the next run",
    )
  })

  test("not quitting, it says the next free slot", () => {
    const view = viewOf({ quitting: null })
    expect(view.queue[0]?.answered).toBe("the next free slot")
  })

  test("each of the run's ways of ending says the next run", () => {
    const running = { windDown: null }
    const on = { stopping: false, quitting: null }
    expect(resumesAt(running, on)).toBe("the next free slot")
    expect(resumesAt(running, { ...on, quitting })).toBe("the next run")
    expect(resumesAt(running, { ...on, stopping: true })).toBe("the next run")
    expect(resumesAt({ windDown: { since: 0, tickets: [] } }, on)).toBe("the next run")
  })
})
