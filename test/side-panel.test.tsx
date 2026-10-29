// The panel beside the tickets table (§ 7.2, tutti-h2o9; src/ui/SidePanel.tsx): in a pane at least
// 130 columns wide it takes the table's right side, under the strip's In queue cell, the table's
// height; while nothing needs you it shows Up next, the ready tickets first, then each held back or
// waiting with why, as the log says it, and `+N more` for those that don't fit. A narrower pane has
// none.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { panelWidth, upNextLines } from "../src/ui/SidePanel.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 27, 13, 0, 0).getTime()

const entry = (
  ticket: string,
  title: string,
  phase: TicketPhase,
  row: number | null,
): LedgerEntry => ({
  ticket: ticket as TicketId,
  title,
  phase,
  since: began,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const merged = (ticket: string, commit: string, row: number) =>
  entry(
    ticket,
    `Title of ${ticket}`,
    TicketPhase.Done({ outcome: Finished.Merged({ commit }) }),
    row,
  )

/** Five merged, then the queue: two ready, three held back for an overlap, a merge and a solo. */
const entries: ReadonlyArray<LedgerEntry> = [
  merged("tutti-gr4z.1", "d06bd5a1", 0),
  merged("tutti-gr4z.3", "e5b090a1", 1),
  merged("tutti-gr4z.4", "de30b701", 2),
  merged("tutti-gr4z.5", "853627c1", 3),
  merged("tutti-gr4z.8", "daa352e1", 4),
  entry("tutti-gr4z.11", "check-own: skip tests that passed", TicketPhase.Queued(), null),
  entry("tutti-h2o9", "A panel beside the tickets table", TicketPhase.Queued(), null),
  entry("tutti-gr4z.9", "Run loop wakes", TicketPhase.HeldBack({ why: "overlap" }), null),
  entry("tutti-07nj", "Needs you in the panel", TicketPhase.HeldBack({ why: "merge" }), null),
  entry("tutti-fdv1", "Narrow panes", TicketPhase.HeldBack({ why: "solo" }), null),
]

const status: Status = {
  ...emptyStatus,
  version: "0.4.0",
  branch: "main",
  began,
  concurrency: 4,
  holdTexts: {
    waits: { "tutti-07nj": "tutti-h2o9 not merged yet" },
    skips: { "tutti-gr4z.9": "touches scripts/check.sh, like running tutti-gr4z.7" },
  },
  solo: { ticket: "tutti-kkb.28", running: true },
}

const viewOf = (list: ReadonlyArray<LedgerEntry> = entries): RunView =>
  project({
    ledger: {
      tickets: new Map(list.map((each) => [each.ticket, each])),
      rows: 5,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status,
    actions: new Map(),
  })

const drawn = async (width: number, height: number, view: RunView = viewOf()): Promise<Frame> => {
  let frame: Frame | undefined
  await withRender(
    <Root
      value={{
        view: external(view),
        screen: external<Screen>(Screen.Dashboard()),
        commands: Effect.runSync(makeCommands),
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
      }}
    />,
    { width, height },
    async (rendered) => {
      frame = await rendered.capture()
    },
  )
  if (frame === undefined) throw new Error("no frame")
  return frame
}

/** tutti-kkb.28 waits on tutti-t6dv, and tutti-125 is blocked: the panel shows what needs you. */
const needing: ReadonlyArray<LedgerEntry> = [
  ...entries.slice(0, 5),
  entry(
    "tutti-kkb.28",
    "Spec runs: break a spec down into tickets and run them",
    TicketPhase.Asked({ question: "tutti-t6dv" }),
    5,
  ),
  entry(
    "tutti-125",
    "Carry the worker's last message",
    TicketPhase.Blocked({ why: "DIRTY_TREE" }),
    6,
  ),
]

const t6dv = {
  id: "tutti-t6dv" as TicketId,
  title: "Does a spec run's START note print? (verifier rounds differ)",
  description:
    "tutti-kkb.28's verifier rounds disagree on one minor point. Round 1 (at 8f6a824) said the START block's note never prints in a real spec run, as it needs config.ticket !== null and --spec can't be combined with --ticket. Round 2 (at 758dbc7, PASS) disagrees: main.ts's start() builds the block from { ...config, ticket: scope }, so the note prints.",
  options: [
    {
      label: "Round 2 holds: the note prints",
      description: "Close tutti-kkb.28 as it is.",
    },
    { label: "Round 1 holds: fix the note", description: "Change startBlock, then verify again." },
  ],
  maintainerOnly: false,
  waiting: ["tutti-kkb.28" as TicketId],
}

const needingView = (): RunView =>
  project({
    ledger: {
      tickets: new Map(needing.map((each) => [each.ticket, each])),
      rows: 7,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...status, questions: new Map([["tutti-t6dv", t6dv]]) },
    actions: new Map(),
  })

/** The panel's lines of a frame: what is right of the table. */
const panelOf = (frame: Frame, from: number): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.slice(from).trimEnd())

describe("the panel beside the tickets table", () => {
  test("is drawn from 130 columns, not at 129", async () => {
    expect(panelWidth(129)).toBe(0)
    expect(panelWidth(130)).toBe(52)
    expect(panelWidth(155)).toBe(62)
    expect(panelWidth(250)).toBe(100)
    expect((await drawn(129, 36)).chars).not.toContain("Up next")
    expect((await drawn(130, 36)).chars).toContain("Up next")
  })

  test("Up next: the ready tickets first, then each held back with why, as the log says it", async () => {
    const panel = panelOf(await drawn(155, 36), 155 - 62).filter((line) => line.startsWith("│"))
    // The strip's In queue cell is over the panel, its bars over the panel's (tutti-ebra).
    expect(panel.slice(0, 7)).toEqual([
      "│ 2 In queue · 3 held back                                   │",
      "│ tutti-gr4z.11  ready                                       │",
      "│ tutti-h2o9     ready                                       │",
      "│ tutti-gr4z.9   touches scripts/check.sh, like running      │",
      "│                tutti-gr4z.7                                │",
      "│ tutti-07nj     tutti-h2o9 not merged yet                   │",
      "│ tutti-fdv1     waits for solo tutti-kkb.28, running        │",
    ])
  })

  test("Up next says how many don't fit", () => {
    const view = viewOf()
    const lines = upNextLines(view.queue, view.totals, theme, 50, 6).map((line) =>
      line.map((each) => each.text).join(""),
    )
    expect(lines[0]?.trim()).toBe("Up next · 3 held back")
    expect(lines.slice(2, 5).map((line) => line.replace(/^│ | *│$/g, "").trimEnd())).toEqual([
      "tutti-gr4z.11  ready",
      "tutti-h2o9     ready",
      "+3 more",
    ])
  })

  test("Needs you: the question, the ticket waiting on it and its options", async () => {
    const chars = (await drawn(155, 36, needingView())).chars
    expect(chars).toContain("Needs you · 1 of 2")
    expect(chars).toContain("Does a spec run's START note print?")
    expect(chars).toContain("tutti-t6dv · tutti-kkb.28 waits on it")
    expect(chars).toContain("1 Round 2 holds: the note prints  recommended")
    expect(chars).toContain("2 Round 1 holds: fix the note")
    expect(chars).toContain("Other…")
  })
})

/** The commands sent since the last call. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

describe("answering on the panel", () => {
  test("Tab reaches the panel; after the guard, 1 answers with the recommended option", async () => {
    const commands = Effect.runSync(makeCommands)
    await withRender(
      <Root
        value={{
          view: external(needingView()),
          screen: external<Screen>(Screen.Dashboard()),
          commands,
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => began + 67_000,
        }}
      />,
      { width: 155, height: 36 },
      async (rendered) => {
        await rendered.input((setup) => setup.mockInput.pressTab())
        const focused = await rendered.capture()
        expect(focused.chars).toContain("> 1 Round 2 holds")
        expect(focused.chars).toContain("┏")
        // Too soon after the question was drawn, 1 answers nothing.
        await rendered.input((setup) => setup.mockInput.pressKey("1"))
        expect(taken(commands)).toEqual([])
        await Bun.sleep(550)
        await rendered.input((setup) => setup.mockInput.pressKey("1"))
        const after = await rendered.capture()
        const sent = taken(commands).filter((command) => command._tag === "AnswerQuestion")
        expect(sent).toMatchObject([
          { question: "tutti-t6dv", answer: "Round 2 holds: the note prints" },
        ])
        // The answered question leaves the panel: the blocked ticket is next.
        expect(after.chars).toContain("tutti-125 blocked: DIRTY_TREE")
        expect(after.chars).toContain("Needs you · 1 of 1")
      },
    )
  })
})

describe("moving between needs", () => {
  test("] shows the next, [ the previous", async () => {
    await withRender(
      <Root
        value={{
          view: external(needingView()),
          screen: external<Screen>(Screen.Dashboard()),
          commands: Effect.runSync(makeCommands),
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => began + 67_000,
        }}
      />,
      { width: 155, height: 36 },
      async (rendered) => {
        await rendered.input((setup) => setup.mockInput.pressKey("]"))
        expect((await rendered.capture()).chars).toContain("Needs you · 2 of 2")
        await rendered.input((setup) => setup.mockInput.pressKey("["))
        expect((await rendered.capture()).chars).toContain("Needs you · 1 of 2")
      },
    )
  })
})
