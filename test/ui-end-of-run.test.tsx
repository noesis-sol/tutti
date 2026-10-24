// The end-of-run box (D19, § 5 item 14, § 7.2): its words as § 5 item 14 gives them, the box in
// place of the Current cards, its frame in `needsYou`, the hint's `q`, and `q` ending the run.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Outcome, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { endOfRunLines, endOfRunText } from "../src/ui/EndOfRunBox.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, renderFrame, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + 67_000

const working = TicketPhase.Working({ activity: "working" })

const entryOf = (
  ticket: string,
  worker: number | null,
  phase: TicketPhase,
  row: number,
): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const permission = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
    summary: "rm -rf build",
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const question = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket,
  kind: { _tag: "Question", questions: [], input: {} },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began + 1,
})

/** § 5 item 14's run: one ticket merged, tut-9a1 and tut-7k2 waiting on you; the box or not. */
const viewOf = (endOfRun: ReadonlyArray<string> | null): RunView =>
  project({
    ledger: {
      tickets: new Map([
        [
          "tut-dwv",
          entryOf(
            "tut-dwv",
            null,
            TicketPhase.Done({ outcome: Outcome.Merged({ commit: "ffd6ce4" }) }),
            0,
          ),
        ],
        ["tut-9a1", entryOf("tut-9a1", 1, working, 1)],
        ["tut-7k2", entryOf("tut-7k2", 2, working, 2)],
      ]),
      rows: 3,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [permission("r1", "tut-9a1"), question("r2", "tut-7k2")],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch/2026-10-20",
      began,
      concurrency: 3,
      endOfRun,
    },
  })

const value = (view: RunView, commands?: Commands): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: commands ?? Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => now,
})

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** The lines from the tickets table's foot to the hint, the blank ones left out. */
const belowTable = (frame: Frame): string => {
  const lines = linesOf(frame)
  const from = lines.findLastIndex((line) => line.startsWith("╰"), lines.length)
  const table = lines.findIndex((line) => line.trim() === "Tickets")
  const foot = lines.findIndex((line, i) => i > table && line.startsWith("╰"))
  void from
  return `\n${lines
    .slice(foot + 1)
    .filter((line) => line !== "")
    .join("\n")}\n`
}

/** RunView's inputs but its status: tut-9a1 and tut-7k2 at work, `ticket`'s request answered. */
const inputsWithout = (ticket: string) => ({
  ledger: {
    tickets: new Map([
      ["tut-9a1", entryOf("tut-9a1", 1, working, 0)],
      ["tut-7k2", entryOf("tut-7k2", 2, working, 1)],
    ]),
    rows: 2,
    windDown: null,
    bugs: [],
  },
  workers: new Map(),
  requests: [permission("r1", "tut-9a1"), question("r2", "tut-7k2")].filter(
    (request) => request.ticket !== ticket,
  ),
})

const statusOf = (endOfRun: ReadonlyArray<string>) => ({
  ...emptyStatus,
  branch: "main",
  concurrency: 3,
  endOfRun,
})

describe("the end-of-run box's words", () => {
  test("as § 5 item 14 words them", () => {
    expect(viewOf(["tut-9a1", "tut-7k2"]).endOfRun).toEqual([
      { ticket: "tut-9a1", asks: ["Allow Bash(rm -rf build)?"] },
      { ticket: "tut-7k2", asks: ["a question"] },
    ])
    const waiting = viewOf(["tut-9a1", "tut-7k2"]).endOfRun ?? []
    expect(endOfRunText(waiting)).toBe(
      "Everything else is done. 2 workers wait for you: tut-9a1 (Allow Bash(rm -rf build)?), tut-7k2 (a question)",
    )
    expect(endOfRunText(waiting.slice(0, 1))).toBe(
      "Everything else is done. 1 worker waits for you: tut-9a1 (Allow Bash(rm -rf build)?)",
    )
  })

  test("a worker answered meanwhile isn't named; with none left, there is no box", () => {
    const view = project({ ...inputsWithout("tut-7k2"), status: statusOf(["tut-9a1", "tut-7k2"]) })
    expect(view.endOfRun).toEqual([{ ticket: "tut-9a1", asks: ["Allow Bash(rm -rf build)?"] }])
    expect(viewOf(null).endOfRun).toBeNull()
    expect(viewOf([]).endOfRun).toBeNull()
  })

  test("every line is as wide as the box, whatever the workers asked", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ ticket: fc.string(), asks: fc.array(fc.string(), { maxLength: 3 }) }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.integer({ min: 10, max: 160 }),
        (waiting, width) =>
          endOfRunLines(waiting, theme, width).every((line) => widthOf(line) === width),
      ),
    )
  })
})

describe("the end-of-run box on the dashboard", () => {
  test("replaces the Current cards; the hint names q", async () => {
    const frame = await renderFrame(<Root value={value(viewOf(["tut-9a1", "tut-7k2"]))} />, {
      width: 80,
      height: 30,
    })
    expect(belowTable(frame)).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ Everything else is done. 2 workers wait for you: tut-9a1 (Allow Bash(rm -rf  │
      │ build)?), tut-7k2 (a question)                                               │
      │ Answering lets them carry on. q ends the run, suspending them: the next run  │
      │ resumes them.                                                                │
      ╰──────────────────────────────────────────────────────────────────────────────╯
        Tab select · Enter open · q end the run · ? keys
      "
    `)
    expect(linesOf(frame).some((line) => line.trim() === "Current")).toBe(false)
  })

  test("at 120 columns, § 5 item 14's sentence on one line", async () => {
    const frame = await renderFrame(<Root value={value(viewOf(["tut-9a1", "tut-7k2"]))} />, {
      width: 120,
      height: 30,
    })
    expect(belowTable(frame)).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
      │ Everything else is done. 2 workers wait for you: tut-9a1 (Allow Bash(rm -rf build)?), tut-7k2 (a question)           │
      │ Answering lets them carry on. q ends the run, suspending them: the next run resumes them.                            │
      ╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
        Tab select · Enter open · q end the run · ? keys
      "
    `)
  })

  test("its frame is drawn in needsYou", () => {
    const lines = endOfRunLines(viewOf(["tut-9a1"]).endOfRun ?? [], theme, 60)
    const corner = lines[0]?.[0]
    expect(corner?.text.startsWith("╭")).toBe(true)
    expect(corner?.look?.fg?.toInts()).toEqual(theme.look("needsYou").fg?.toInts())
  })

  test("q ends the run with the box shown, and does nothing without it", async () => {
    const taken = (commands: Commands) => Effect.runSync(Queue.takeAll(commands))
    const commands = Effect.runSync(makeCommands)
    await withRender(
      <Root value={value(viewOf(["tut-9a1", "tut-7k2"]), commands)} />,
      { width: 80, height: 30 },
      async (rendered) => {
        await rendered.input((setup) => setup.mockInput.pressKey("q"))
        expect(taken(commands)).toEqual([UiCommand.EndRun()])
      },
    )
    const without = Effect.runSync(makeCommands)
    await withRender(
      <Root value={value(viewOf(null), without)} />,
      { width: 80, height: 30 },
      async (rendered) => {
        await rendered.input((setup) => setup.mockInput.pressKey("q"))
        expect(Effect.runSync(Queue.size(without))).toBe(0)
      },
    )
  })
})
