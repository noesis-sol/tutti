// A question answered, its ticket waiting for a slot (tutti-luwa, § 5.1, § 7.2): it stays Asked until
// a slot frees, but no longer needs you. Needs you and the panel leave it out and say the same
// number; its row says `↻ answered`, and Up next that it waits for a free slot.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { tuttiScheme } from "../src/project/scheme.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { marks } from "../src/text/marks.ts"
import { Root } from "../src/ui/App.tsx"
import { dashboardLayout, questionsWaiting } from "../src/ui/Dashboard.tsx"
import type { Segments } from "../src/ui/line.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { upNextLines } from "../src/ui/SidePanel.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { withRender } from "./render.ts"
import { insideOf } from "./screen.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 10, 4, 8, 14, 0).getTime()

const entry = (ticket: string, phase: TicketPhase, row: number): Entry => ({
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

const asked = (ticket: string, question: string, row: number) =>
  entry(ticket, TicketPhase.Asked({ question }), row)

/** The run the ticket was filed from: four Asked and one Blocked. */
const fabrica: ReadonlyArray<Entry> = [
  asked("fab-a", "q-a", 0),
  asked("fab-b", "q-b", 1),
  asked("fab-c", "q-c", 2),
  asked("fab-d", "q-d", 3),
  entry("fab-e", TicketPhase.Blocked({ why: "MERGE_CONFLICT" }), 4),
]

const question = (id: string): OpenQuestion => ({
  id: id as TicketId,
  title: `Question ${id}`,
  description: "",
  options: undefined,
  maintainerOnly: false,
  waiting: [],
})

const viewOf = (
  entries: ReadonlyArray<Entry>,
  status: Partial<Status>,
  previous?: RunView,
): RunView =>
  project(
    {
      ledger: {
        tickets: new Map(entries.map((each) => [each.ticket, each])),
        rows: entries.length,
        windDown: null,
        bugs: [],
      },
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, version: "0.1.0", branch: "main", began, ...status },
      actions: new Map(),
    },
    previous,
  )

const rowOf = (view: RunView, ticket: string) => view.rows.find((row) => row.ticket === ticket)

const text = (segments: Segments): string => segments.map((each) => each.text).join("")

describe("a question answered, its ticket with no slot yet", () => {
  test("leaves Needs you and the panel, which say the same number", () => {
    const view = viewOf(fabrica, {
      answered: new Set(["q-a", "q-b", "q-c", "q-d"]),
    })
    expect(view.totals.needsYou).toBe(1)
    expect(view.totals.asked).toBe(0)
    expect(view.needs.map((need) => need.ticket)).toEqual(["fab-e" as TicketId])
    expect(questionsWaiting(view)).toBe(false)
  })

  test("those not answered yet still need you", () => {
    const view = viewOf(fabrica, {
      questions: new Map([["q-b", question("q-b")]]),
      answered: new Set(["q-a"]),
    })
    expect(view.totals.needsYou).toBe(4)
    expect(view.totals.asked).toBe(3)
    expect(view.needs.map((need) => need.ticket)).toEqual([
      "fab-b",
      "fab-c",
      "fab-d",
      "fab-e",
    ] as Array<TicketId>)
    expect(questionsWaiting(view)).toBe(true)
  })

  test("a question the look hasn't read isn't taken for answered", () => {
    const view = viewOf([asked("fab-a", "q-a", 0)], {})
    expect(view.totals.needsYou).toBe(1)
    expect(rowOf(view, "fab-a")).toMatchObject({ mark: "asked", word: "for you", tone: "stop" })
  })

  test("a new question of the same ticket needs you again", () => {
    const view = viewOf([asked("fab-a", "q-2", 0)], { answered: new Set(["q-1"]) })
    expect(view.totals.needsYou).toBe(1)
    expect(view.needs).toHaveLength(1)
  })

  test("its row says `↻ answered`, faint, and that it waits for a slot", () => {
    const view = viewOf(fabrica, { answered: new Set(["q-a"]) })
    expect(marks.answered).toBe("↻")
    expect(rowOf(view, "fab-a")).toMatchObject({
      mark: "answered",
      word: "answered",
      faint: true,
      note: "(resumes at the next free slot) Title of fab-a",
    })
  })

  test("Up next lists it first, waiting for a free slot, without counting it In queue", () => {
    const view = viewOf(
      [
        entry("fab-q", TicketPhase.Queued(), 1),
        asked("fab-a", "q-a", 0),
        entry("fab-m", TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc1234" }) }), 2),
      ],
      { answered: new Set(["q-a"]) },
    )
    expect(view.queue.map((each) => each.ticket)).toEqual(["fab-a", "fab-q"] as Array<TicketId>)
    expect(view.totals.queued).toBe(1)
    const lines = upNextLines(view.queue, view.totals, theme, 50, 7).map(text)
    expect(lines.slice(3, 5).map(insideOf)).toEqual([
      "fab-a  answered · the next free slot",
      "fab-q  ready",
    ])
  })

  test("under a stop, the next run takes it back, unless the stop lifts", () => {
    const stopped = viewOf([asked("fab-a", "q-a", 0)], {
      answered: new Set(["q-a"]),
      stopping: true,
    })
    expect(rowOf(stopped, "fab-a")?.note).toBe("(resumes at the next run) Title of fab-a")
    expect(stopped.queue[0]?.answered).toBe("the next run")
    const lifted = viewOf([asked("fab-a", "q-a", 0)], { answered: new Set(["q-a"]) })
    expect(rowOf(lifted, "fab-a")?.note).toBe("(resumes at the next free slot) Title of fab-a")
  })

  test("in a run winding down, the next run takes it back: its row and Up next say so", () => {
    const view = project({
      ledger: {
        tickets: new Map([["fab-a" as TicketId, asked("fab-a", "q-a", 0)]]),
        rows: 1,
        windDown: { since: began, tickets: [] },
        bugs: [],
      },
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, answered: new Set(["q-a"]) },
      actions: new Map(),
    })
    expect(rowOf(view, "fab-a")?.note).toBe("(resumes at the next run) Title of fab-a")
    expect(text(upNextLines(view.queue, view.totals, theme, 50, 7)[3] ?? [])).toContain(
      "answered · the next run",
    )
  })
})

/** Needs you's count in the totals strip, as the layout draws it. */
const needsCount = (laid: ReturnType<typeof dashboardLayout>): string | undefined =>
  laid.totals
    .map(text)
    .join("\n")
    .match(/(\d+) Needs you/)?.[1]

describe("the strip and the panel", () => {
  const view = viewOf(fabrica, { questions: new Map([["q-a", question("q-a")]]) })

  test("a question answered on the panel leaves both, before the next look", () => {
    const answeredHere = view.needs.filter((need) => need.ticket !== ("fab-a" as TicketId))
    const at = { focused: false, inside: false, choice: 0 }
    expect(needsCount(dashboardLayout(view, theme, 155, 36))).toBe("5")
    const laid = dashboardLayout(view, theme, 155, 36, null, { needs: answeredHere, at })
    expect(needsCount(laid)).toBe(String(answeredHere.length))
    expect(view.totals.needsYou).toBe(5)
  })

  test("drawn: 1 Needs you and `Needs you · 1`, the row saying `↻ answered`", async () => {
    await withRender(
      <Root
        value={{
          view: external(viewOf(fabrica, { answered: new Set(["q-a", "q-b", "q-c", "q-d"]) })),
          screen: external<Screen>(Screen.Dashboard()),
          commands: Effect.runSync(makeCommands),
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => began + 60_000,
        }}
      />,
      { width: 155, height: 36 },
      async (rendered) => {
        const { chars } = await rendered.capture()
        expect(chars).toContain("1 Needs you")
        expect(chars).toContain("Needs you · 1")
        expect(chars).toContain("fab-e blocked: MERGE_CONFLICT")
        expect(chars).toContain("↻ answered")
        expect(chars).not.toContain("? for you")
      },
    )
  })
})
