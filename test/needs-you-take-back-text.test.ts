// What Needs you says of a conflict once `h` hands it back (tutti-vx09) and the run takes back a
// branch fixed by hand (tutti-w4ds): the key where it does something, what it does, and the take-back
// only while the run takes anything back.
import { describe, expect, test } from "bun:test"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, type Need, project, runGoes } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { clearsOf, needsLines } from "../src/ui/SidePanel.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const began = new Date(2026, 10, 4, 3, 0, 0).getTime()
const about = { worktree: "/wt/a", files: ["a.ts"], reason: "2 hand-backs used" }

const windDown = { since: began, tickets: [] }

const needOf = (
  fields: Partial<LedgerEntry> = {},
  run: { readonly stopping?: boolean; readonly windingDown?: boolean } = {},
) => {
  const entry: LedgerEntry = {
    ticket: "a" as TicketId,
    title: "Merge the loop",
    phase: TicketPhase.Blocked({ why: "MERGE_CONFLICT" }),
    since: began,
    worker: null,
    row: 0,
    rechecking: false,
    steered: false,
    lastMessage: null,
    tallies: emptyTallies,
    about,
    ...fields,
  }
  const view = project({
    ledger: {
      tickets: new Map([[entry.ticket, entry]]),
      rows: 1,
      windDown: run.windingDown === true ? windDown : null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.6.7",
      branch: "trunk",
      began,
      concurrency: 4,
      stopping: run.stopping === true,
    },
    actions: new Map(),
  })
  const need = view.needs[0]
  if (need?._tag !== "Blocked") throw new Error("no Blocked need")
  return need
}

const textOf = (need: Extract<Need, { _tag: "Blocked" }>) => clearsOf(need).join("\n")

/** The panel's foot, focused, tall enough to show it all. */
const footOf = (need: Need) =>
  needsLines([need], { index: 0, focused: true, choice: 0 }, theme, 60, 40)
    .map((line) => line.map((segment) => segment.text).join(""))
    .join("\n")

const takesBack = "The run takes it back once its branch has moved on"

describe("a conflict left on the run's hands", () => {
  test("in a run going on: the key, and the take-back with what it asks of the branch", () => {
    const text = textOf(needOf())
    expect(text).toContain("Press h to hand it back to its worker, with one more hand-back.")
    expect(text).toContain(`${takesBack}, its worktree is clean and it rebases cleanly.`)
    expect(text).toContain("the next run checks and merges it once it rebases cleanly")
    expect(footOf(needOf())).toContain("h hands it back")
  })

  test("winding down: the key still, and no take-back, as the run takes nothing back", () => {
    const need = needOf({}, { windingDown: true })
    const text = textOf(need)
    expect(text).toContain("Press h to hand it back")
    expect(text).not.toContain(takesBack)
    expect(text).toContain("The run is winding down, so it takes nothing back.")
    expect(text).toContain("the next run checks and merges it")
    expect(footOf(need)).toContain("h hands it back")
  })

  test("stopping: neither the key, whose merge may not come, nor the take-back", () => {
    const need = needOf({}, { stopping: true })
    const text = textOf(need)
    expect(text).not.toMatch(/press h/i)
    expect(text).not.toContain(takesBack)
    expect(text).toContain("The run is stopping, so it takes nothing back.")
    expect(text).toContain("the next run checks and merges it")
    expect(footOf(need)).not.toContain("h hands it back")
  })

  test("a stop that lifts says the key and the take-back again", () => {
    expect(needOf({}, { stopping: true }).run).toBe("stopping")
    expect(textOf(needOf({}, { stopping: false }))).toContain(takesBack)
  })

  test("a stop outranks winding down, as both take nothing back and the merges may be over", () => {
    expect(runGoes({ windDown }, { stopping: true })).toBe("stopping")
    expect(runGoes({ windDown }, { stopping: false })).toBe("windingDown")
    expect(runGoes({ windDown: null }, { stopping: false })).toBe("on")
  })
})

describe("with hand-backs off", () => {
  const off = { about: { ...about, handBacksOff: true } }

  test("the key says what it does: its merge again, with no worker", () => {
    const text = textOf(needOf(off))
    expect(text).toContain("Press h to try its merge again: hand-backs are off")
    expect(text).not.toContain("Press h to hand it back")
    expect(text).toContain(takesBack)
    const foot = footOf(needOf(off))
    expect(foot).toContain("h tries its merge again")
    expect(foot).not.toContain("h hands it back")
  })

  test("stopping: no key either", () => {
    const need = needOf(off, { stopping: true })
    expect(textOf(need)).not.toMatch(/press h/i)
    expect(footOf(need)).not.toContain("h tries its merge again")
  })
})

describe("a steered worker's hand-back waiting", () => {
  const waiting = { handBack: true }

  test("names the key and the button, and promises no take-back, as the run leaves it to you", () => {
    const text = textOf(needOf(waiting))
    expect(text).toContain("Press h, or 'Hand it the conflict now' in its worker view")
    expect(text).toContain(
      "to take it up yourself, then press h: it merges once it rebases cleanly",
    )
    expect(text).not.toContain(takesBack)
    expect(footOf(needOf(waiting))).toContain("h hands it back")
  })

  test("keeps the key under a stop, as its hand-over is what the run's end waits for", () => {
    const need = needOf(waiting, { stopping: true })
    expect(textOf(need)).toContain("Press h, or 'Hand it the conflict now'")
    expect(footOf(need)).toContain("h hands it back")
  })
})

describe("the merges' other stops", () => {
  test("offer no key and no take-back", () => {
    for (const why of ["DIRTY_TREE", "MERGE_FAILED", "GIT_FAILED"]) {
      const need = needOf({ phase: TicketPhase.Blocked({ why }) })
      expect(textOf(need)).not.toMatch(/press h/i)
      expect(textOf(need)).not.toContain(takesBack)
      expect(footOf(need)).not.toContain(" h ")
    }
  })
})
