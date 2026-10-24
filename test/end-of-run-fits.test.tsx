// The end-of-run box keeps to its room (D19, § 7.2): the tickets table gives up rows for it first,
// then the box names fewer workers, the rest as `+N more`, and what `q` does is always drawn.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Outcome, TicketPhase } from "../src/run/phase.ts"
import { conflictWaits, emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { endOfRunLines, endOfRunText } from "../src/ui/EndOfRunBox.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + 67_000

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

const permission = (ticket: string, summary: string): AttentionRequest => ({
  id: `r-${ticket}`,
  ticket,
  kind: { _tag: "Permission", tool: "Bash", input: { command: summary }, suggestions: [], summary },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const waiters = ["tut-9a1", "tut-7k2", "tut-3fx", "tut-5qe", "tut-8mw"]
const done = ["tut-dwv", "tut-a01", "tut-a02", "tut-a03", "tut-a04", "tut-a05"]

/** Six tickets merged and five workers waiting on permissions with long summaries. */
const viewOf = (): RunView =>
  project({
    ledger: {
      tickets: new Map([
        ...done.map((ticket, row): [string, Entry] => [
          ticket,
          entryOf(
            ticket,
            null,
            TicketPhase.Done({ outcome: Outcome.Merged({ commit: "ffd6ce4" }) }),
            row,
          ),
        ]),
        ...waiters.map((ticket, i): [string, Entry] => [
          ticket,
          entryOf(ticket, i + 1, TicketPhase.Working({ activity: "working" }), done.length + i),
        ]),
      ]),
      rows: done.length + waiters.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: waiters.map((ticket) =>
      permission(ticket, `bun test test/${ticket}.test.ts --timeout 60000 --rerun-each 3`),
    ),
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch/2026-10-20",
      began,
      concurrency: 5,
      endOfRun: waiters,
    },
  })

const value = (view: RunView): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => now,
})

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** The box's lines in a frame: from its top corner to its bottom one. */
const boxIn = (frame: Frame): ReadonlyArray<string> => {
  const lines = linesOf(frame)
  const from = lines.findLastIndex((line) => line.startsWith("╭"))
  const to = lines.findIndex((line, i) => i > from && line.startsWith("╰"))
  return lines.slice(from, to + 1)
}

const waiting = (count: number, summary: string) =>
  Array.from({ length: count }, (_, i) => ({
    ticket: `tut-${i}`,
    asks: [`Allow Bash(${summary})?`],
  }))

describe("the end-of-run box in its room", () => {
  test("names fewer workers, the rest as +N more", () => {
    const five = waiting(5, "ls")
    expect(endOfRunText(five, 2)).toBe(
      "Everything else is done. 5 workers wait for you: tut-0 (Allow Bash(ls)?), tut-1 (Allow Bash(ls)?), +3 more",
    )
    expect(endOfRunText(five, 0)).toBe("Everything else is done. 5 workers wait for you.")
    expect(endOfRunText(five)).toBe(endOfRunText(five, 5))
  })

  test("keeps to its lines and always says what q does", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ticket: fc.string({ maxLength: 40 }),
            asks: fc.array(fc.oneof(fc.string({ maxLength: 200 }), fc.constant(conflictWaits)), {
              maxLength: 3,
            }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 60, max: 160 }),
        fc.integer({ min: 1, max: 30 }),
        (waiting, width, height) => {
          const lines = endOfRunLines(waiting, theme, width, height)
          return (
            lines.length <= height &&
            lines.length >= 1 &&
            lines.every((line) => widthOf(line) === width) &&
            lines.some((line) =>
              line
                .map((each) => each.text)
                .join("")
                .includes("q ends the run"),
            )
          )
        },
      ),
    )
  })

  test("drawn whole where it fits, as before", () => {
    const five = waiting(5, "ls")
    expect(endOfRunLines(five, theme, 80, 100)).toEqual(endOfRunLines(five, theme, 80))
  })
})

describe("the end-of-run box on a short dashboard", () => {
  test("at 80×24 with five long requests, its q line is drawn and the hint is under it", async () => {
    const frame = await renderFrame(<Root value={value(viewOf())} />, { width: 80, height: 24 })
    const box = boxIn(frame)
    expect(box.length).toBeGreaterThan(2)
    expect(box.some((line) => line.includes("q ends the run"))).toBe(true)
    const lines = linesOf(frame)
    const bottom = lines.findIndex((line) => line === box[box.length - 1])
    expect(lines.slice(bottom + 1).some((line) => line.includes("q end the run"))).toBe(true)
    expect(`\n${linesOf(frame).join("\n")}\n`).toMatchInlineSnapshot(`
      "

       Tutti  0.1.0   batch/2026-10-20 · 1m7s

       ▶ 5 of 5 workers
      ╭───────────────┬───────────────┬───────────────┬──────────────────────────────╮
      │ ✓ 6 Completed │ 0 Set aside   │ 5 Needs you   │ 0 In queue                   │
      ╰───────────────┴───────────────┴───────────────┴──────────────────────────────╯
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ Everything else is done. 5 workers wait for you: tut-9a1 (Allow Bash(bun     │
      │ test test/tut-9a1.test.ts --timeout 60000 --rerun-each 3)?), tut-7k2 (Allow  │
      │ Bash(bun test test/tut-7k2.test.ts --timeout 60000 --rerun-each 3)?),        │
      │ tut-3fx (Allow Bash(bun test test/tut-3fx.test.ts --timeout 60000            │
      │ --rerun-each 3)?), tut-5qe (Allow Bash(bun test test/tut-5qe.test.ts         │
      │ --timeout 60000 --rerun-each 3)?), tut-8mw (Allow Bash(bun test              │
      │ test/tut-8mw.test.ts --timeout 60000 --rerun-each 3)?)                       │
      │ Answering lets them carry on. q ends the run, suspending them: the next run  │
      │ resumes them.                                                                │
      ╰──────────────────────────────────────────────────────────────────────────────╯





        Tab select · Enter open · q end the run · ? keys

      "
    `)
  })

  test("at 80×18, it names the workers that fit and counts the rest", async () => {
    const frame = await renderFrame(<Root value={value(viewOf())} />, { width: 80, height: 18 })
    const box = boxIn(frame)
    expect(box.some((line) => line.includes("more"))).toBe(true)
    expect(box.some((line) => line.includes("q ends the run"))).toBe(true)
    expect(`\n${box.join("\n")}\n`).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ Everything else is done. 5 workers wait for you: tut-9a1 (Allow Bash(bun     │
      │ test test/tut-9a1.test.ts --timeout 60000 --rerun-each 3)?), tut-7k2 (Allow  │
      │ Bash(bun test test/tut-7k2.test.ts --timeout 60000 --rerun-each 3)?),        │
      │ tut-3fx (Allow Bash(bun test test/tut-3fx.test.ts --timeout 60000            │
      │ --rerun-each 3)?), tut-5qe (Allow Bash(bun test test/tut-5qe.test.ts         │
      │ --timeout 60000 --rerun-each 3)?), +1 more                                   │
      │ Answering lets them carry on. q ends the run, suspending them: the next run  │
      │ resumes them.                                                                │
      ╰──────────────────────────────────────────────────────────────────────────────╯
      "
    `)
  })

  test("the tickets table gives up rows before the box names fewer workers", async () => {
    const frame = await renderFrame(<Root value={value(viewOf())} />, { width: 80, height: 40 })
    const box = boxIn(frame)
    expect(box.some((line) => line.includes("more"))).toBe(false)
    expect(box.some((line) => line.includes("q ends the run"))).toBe(true)
    expect(linesOf(frame).some((line) => line.trim() === "Tickets")).toBe(true)
  })
})
