// The forms' click targets as segments (D9, § 7.3): an init option or the start question's wrapped
// onto two lines is one target on both; the answer form's frame is boxed's, drawn as text, and an option's row is its
// target to the frame, past its text.

import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { type Asking, emptyScreen, InitView } from "../src/ui/InitForm.tsx"
import { TicketCount, Work } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { emptyTranscript, type TranscriptState } from "../src/ui/transcriptItems.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const linesOf = (frame: Frame): ReadonlyArray<string> => frame.chars.split("\n")

describe("init's checklist", () => {
  test("an option wider than the screen wraps, a click on either line ticking it", async () => {
    const said: Array<unknown> = []
    const long = "bun test --coverage --reporter=junit --reporter-outfile=report.xml"
    const asking: Asking = {
      _tag: "Checklist",
      id: 1,
      field: { title: "Checks", description: "", options: ["tsc", long], ticked: [] },
      answer: (ticked) => said.push(ticked),
      cancel: () => {},
    }
    const node = (
      <InitView
        theme={themeOf("dark")}
        repo="/work/shop"
        screen={{ ...emptyScreen, steps: ["Workers", "Checks"], at: 1, asking }}
        now={0}
      />
    )
    await withRender(node, { width: 50, height: 20 }, async (rendered) => {
      const lines = linesOf(await rendered.capture())
      const y = lines.findIndex((line) => line.includes("• bun test"))
      expect(y).toBeGreaterThan(0)
      // Its rest on the line under it, nothing cut.
      expect(lines.slice(y, y + 3).join(" ")).toContain("report.xml")
      await rendered.input((setup) => setup.mockMouse.click(8, y + 1))
      expect((await rendered.capture()).chars).toContain("> ✓ bun test")
      await rendered.input((setup) => setup.mockMouse.click(8, y))
      expect((await rendered.capture()).chars).toContain("> • bun test")
      // tsc, clicked past its text.
      await rendered.input((setup) => setup.mockMouse.click(40, y - 1))
      await rendered.input((setup) => setup.mockInput.pressEnter())
    })
    expect(said).toEqual([[0]])
  })
})

describe("the start question on a narrow screen", () => {
  test("New feature wraps, a click on its second line choosing it; one past an option answers", async () => {
    const said: Array<unknown> = []
    const node = (
      <StartQuestion
        theme={themeOf("dark")}
        count={TicketCount.Ready({ n: 3 })}
        answer={(work) => said.push(work)}
        cancel={() => {}}
      />
    )
    // Tall enough for the select under the description, which a shorter screen leaves out.
    await withRender(node, { width: 40, height: 30 }, async (rendered) => {
      const lines = linesOf(await rendered.capture())
      const y = lines.findIndex((line) => line.includes("New feature"))
      expect(y).toBeGreaterThan(0)
      expect(lines[y + 1]).toContain("through, run its tickets")
      const x = (lines[y + 1] ?? "").indexOf("through")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y + 1))
      expect((await rendered.capture()).chars).toContain("> New feature")
      // A click past an option's text, to the field's edge, lands on it.
      const at = linesOf(await rendered.capture()).findIndex((line) =>
        line.includes("Current tickets"),
      )
      await rendered.input((setup) => setup.mockMouse.click(34, at))
    })
    expect(said).toEqual([Work.Tickets()])
  })
})

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const asked: AttentionRequest = {
  id: "q1",
  ticket: "t-1" as TicketId,
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "Which storage?",
        options: [{ label: "SQLite" }, { label: "Postgres" }],
        multiSelect: false,
      },
      { question: "Which checks?", options: [{ label: "tsc" }], multiSelect: true },
    ],
    input: {},
  },
  displayName: "AskUserQuestion",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
}

const viewOf = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  project({
    ledger: {
      tickets: new Map([
        [
          "t-1" as TicketId,
          {
            ticket: "t-1" as TicketId,
            title: "Title of t-1",
            phase: TicketPhase.Working(),
            since: began,
            worker: 1,
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
    workers: new Map([["t-1", WS.Idle({ at: began })]]),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

describe("the answer form", () => {
  test("its frame drawn as text around the body; a row clicked past its text picks it", async () => {
    let now = began
    const commands = Effect.runSync(makeCommands)
    const root = (
      <Root
        value={{
          view: external(viewOf([asked])),
          screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
          commands,
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => now,
          transcripts: {
            open: () => ({
              state: external<TranscriptState>(emptyTranscript),
              older: () => {},
              scrolledBack: () => {},
              follow: () => {},
              close: () => {},
            }),
          },
        }}
      />
    )
    await withRender(root, { width: 80, height: 40 }, async (rendered) => {
      now += settle
      await rendered.input((setup) => setup.mockInput.pressEnter())
      const lines = linesOf(await rendered.capture())
      const top = lines.findIndex((line) => line.includes("│ t-1 asks")) - 1
      const left = (lines[top + 1] ?? "").indexOf("│ t-1 asks")
      expect(lines[top]?.[left]).toBe("╭")
      const right = (lines[top] ?? "").indexOf("╮", left)
      const bottom = lines.findIndex((line, i) => i > top && line[left] === "╰")
      expect(lines[bottom]?.[right]).toBe("╯")
      // Each row between has the frame's sides, the body's rows too.
      for (const line of lines.slice(top + 1, bottom)) {
        expect(line[left]).toBe("│")
        expect(line[right]).toBe("│")
      }
      expect(lines.slice(top, bottom).join("\n")).toContain("( ) Postgres")
      const y = lines.findIndex((line) => line.includes("( ) Postgres"))
      await rendered.input((setup) => setup.mockMouse.click(right - 3, y))
      expect((await rendered.capture()).chars).toContain("(•) Postgres")
      await rendered.input((setup) => setup.mockMouse.click(right - 3, y + 4))
      expect((await rendered.capture()).chars).toContain("[x] tsc")
      const buttons = lines.findIndex((line) => line.includes("[ Answer ]"))
      const x = (lines[buttons] ?? "").indexOf("[ Answer ]")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, buttons))
    })
    expect(Effect.runSync(Queue.clear(commands))).toEqual([
      UiCommand.Answer({
        requestId: "q1",
        answer: { _tag: "Choose", answers: ["Postgres", "tsc"] },
      }),
    ])
  })
})
