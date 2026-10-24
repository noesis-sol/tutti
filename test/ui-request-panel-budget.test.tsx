// The worker view's request panel within the pane's height (tutti-7nzv): the panel has the rows
// the view's head, rules, composer and hint leave it, and a few of the transcript's. Where its
// requests don't fit, their inputs' rooms shrink first; then it draws one, and counts the rest.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { seg } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external } from "../src/ui/useRunView.ts"
import { inputLines, type PanelParts, panelRooms } from "../src/ui/WorkerView.tsx"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const said = (words: string): Item => ({
  v: transcriptVersion,
  seq: 1,
  session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
  time: "2026-10-20T13:00:00.000Z",
  message: {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage,
})

/** A run of one worker, on t-1, with `requests` open. */
const viewOf = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  project({
    ledger: {
      tickets: new Map([
        [
          "t-1",
          {
            ticket: "t-1",
            title: "Title of t-1",
            phase: TicketPhase.Working({ activity: "working" }),
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

/** The ticket's scenario: a Bash permission request whose command is `lines` lines long. */
const bash = (id: string, lines: number): AttentionRequest => ({
  id,
  ticket: "t-1",
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: {
      command: Array.from({ length: lines }, (_, i) => `echo ${id} step ${i + 1}`).join("\n"),
    },
    suggestions: [],
    summary: `${id} steps`,
  },
  displayName: "Bash",
  description: `Run the ${id} steps`,
  decisionReason: "Path is outside allowed working directories",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const feedOf = (items: ReadonlyArray<Item>): TranscriptFeed => ({
  open: (): OpenTranscript => {
    const state = external<TranscriptState>({ ...emptyTranscript, window: windowOf(items) })
    return { state, older: () => {}, scrolledBack: () => {}, follow: () => {}, close: () => {} }
  },
})

/** The shell's clock, moved past the panel's guard by the tests that answer. */
let now = began + 67_000

/** Renders the view of t-1's worker, `size`, with `requests` open, and runs `body`. */
const scene = async (
  requests: ReadonlyArray<AttentionRequest>,
  size: { readonly width: number; readonly height: number },
  body: (rendered: Rendered, commands: Commands) => Promise<void>,
) => {
  now = began + 67_000
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: external(viewOf(requests)),
        screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => now,
        transcripts: feedOf([said("Two commands to run.")]),
      }}
    />,
    size,
    (rendered) => body(rendered, commands),
    { treeSitter: "mock" },
  )
}

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

const shownOf = (frame: Frame): string => `\n${linesOf(frame).join("\n")}\n`

describe("the request panel's height", () => {
  test("80x24, two 7-line commands: one request whole, the other counted, the composer in view", async () => {
    await scene([bash("r1", 7), bash("r2", 7)], { width: 80, height: 24 }, async (rendered) => {
      const frame = await rendered.capture()
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   • t-1  permission — waiting for you (2)  1m07s   Title of t-1
          1m07s  0 tokens  $0.00
        ────────────────────────────────────────────────────────────────────────────────
          Two commands to run.




        ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        ┃ Bash: Run the r1 steps                                                     ┃
        ┃ Path is outside allowed working directories                                ┃
        ┃ [ Deny ]  [ Allow ]                                                        ┃
        ┃ echo r1 step 1                                                             ┃
        ┃ echo r1 step 2                                                             ┃
        ┃ echo r1 step 3                                                             ┃
        ┃ echo r1 step 4                                                             ┃
        ┃ echo r1 step 5                                                             ┃
        ┃ echo r1 step 6                                                             ┃
        ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
          +1 more requests
        ────────────────────────────────────────────────────────────────────────────────
         > i to write to the worker
          Esc dashboard · i write · d deny · Ctrl+X interrupt · ↑↓ select · Enter expand
          ? keys · PgUp/PgDn scroll · g/G top/end

        "
      `)
    })
  })

  test("80x30, two 7-line commands: both drawn, their inputs' rooms shrunk", async () => {
    await scene([bash("r1", 7), bash("r2", 7)], { width: 80, height: 30 }, async (rendered) => {
      const frame = await rendered.capture()
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   • t-1  permission — waiting for you (2)  1m07s   Title of t-1
        ────────────────────────────────────────────────────────────────────────────────
          Two commands to run.


        ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        ┃ Bash: Run the r1 steps                                                     ┃
        ┃ Path is outside allowed working directories                                ┃
        ┃ [ Deny ]  [ Allow ]                                                        ┃
        ┃ echo r1 step 1                                                             ┃
        ┃ echo r1 step 2                                                             ┃
        ┃ echo r1 step 3                                                             ┃
        ┃ echo r1 step 4                                                             ┃
        ┃ echo r1 step 5                                                             ┃
        ┃ echo r1 step 6                                                             ┃
        ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
        ╭────────────────────────────────────────────────────────────────────────────╮
        │ Bash: Run the r2 steps                                                     │
        │ Path is outside allowed working directories                                │
        │ [ Deny ]  [ Allow ]                                                        │
        │ echo r2 step 1                                                             │
        │ echo r2 step 2                                                             │
        │ echo r2 step 3                                                             │
        │ echo r2 step 4                                                             │
        │ echo r2 step 5                                                             │
        ╰────────────────────────────────────────────────────────────────────────────╯
        ────────────────────────────────────────────────────────────────────────────────
         > i to write to the worker
          Esc dashboard · i write · d deny · Ctrl+X interrupt · ↑↓ select · Enter expand
          ? keys · PgUp/PgDn scroll · g/G top/end

        "
      `)
    })
  })

  test("80x30, a 6-line message typed: the panel gives the composer its rows", async () => {
    await scene([bash("r1", 7), bash("r2", 7)], { width: 80, height: 30 }, async (rendered) => {
      await rendered.input((setup) => setup.mockInput.typeText("i"))
      await rendered.input(async (setup) => {
        for (let i = 1; i <= 6; i++) {
          await setup.mockInput.typeText(`line ${i}`)
          if (i < 6) setup.mockInput.pressKey("j", { ctrl: true })
        }
      })
      const frame = await rendered.capture()
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   • t-1  permission — waiting for you (2)  1m07s   Title of t-1
        ────────────────────────────────────────────────────────────────────────────────
          Two commands to run.


        ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        ┃ Bash: Run the r1 steps                                                     ┃
        ┃ Path is outside allowed working directories                                ┃
        ┃ [ Deny ]  [ Allow ]                                                        ┃
        ┃ echo r1 step 1                                                             ┃
        ┃ echo r1 step 2                                                             ┃
        ┃ echo r1 step 3                                                             ┃
        ┃ echo r1 step 4                                                             ┃
        ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
        ╭────────────────────────────────────────────────────────────────────────────╮
        │ Bash: Run the r2 steps                                                     │
        │ Path is outside allowed working directories                                │
        │ [ Deny ]  [ Allow ]                                                        │
        │ echo r2 step 1                                                             │
        │ echo r2 step 2                                                             │
        │ echo r2 step 3                                                             │
        ╰────────────────────────────────────────────────────────────────────────────╯
        ────────────────────────────────────────────────────────────────────────────────
         > line 1
           line 2
           line 3
           line 4
           line 5
           line 6
          Enter send · Alt+Enter/Ctrl+J new line · Esc leave · Ctrl+X interrupt

        "
      `)
    })
  })

  test("40x24, the head wrapped: the transcript keeps its rows", async () => {
    await scene([bash("r1", 7), bash("r2", 7)], { width: 40, height: 24 }, async (rendered) => {
      const frame = await rendered.capture()
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   • t-1  permission —
            waiting for you (2)  1m07s   Title
            of t-1
        ────────────────────────────────────────
          Two commands to run.


        ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        ┃ Bash: Run the r1 steps             ┃
        ┃ Path is outside allowed working    ┃
        ┃   directories                      ┃
        ┃ [ Deny ]  [ Allow ]                ┃
        ┃ echo r1 step 1                     ┃
        ┃ echo r1 step 2                     ┃
        ┃ echo r1 step 3                     ┃
        ┃ echo r1 step 4                     ┃
        ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
          +1 more requests
        ────────────────────────────────────────
         > i to write to the worker
          Esc dashboard · i write · d deny
          Ctrl+X interrupt · ↑↓ select
          Enter expand · ? keys
          PgUp/PgDn scroll · g/G top/end

        "
      `)
    })
  })

  test("the request not drawn can't be selected or answered", async () => {
    await scene(
      [bash("r1", 7), bash("r2", 7)],
      { width: 80, height: 24 },
      async (rendered, commands) => {
        now += settle
        await rendered.input(async (setup) => {
          setup.mockInput.pressArrow("down")
          setup.mockInput.pressArrow("down")
        })
        now += settle
        await rendered.input((setup) => setup.mockInput.typeText("a"))
        expect(Effect.runSync(Queue.clear(commands))).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Allow" } }),
        ])
      },
    )
  })
})

/** A request's parts with `head` lines over `input` lines of input. */
const partsOf = (head: number, input: number): PanelParts => ({
  head: Array.from({ length: head }, () => [seg("h")]),
  input: Array.from({ length: input }, () => [seg("i")]),
  sides: (lines) => lines,
  foot: [[seg("f")]],
})

const heightOf = (parts: ReadonlyArray<PanelParts>, rooms: ReadonlyArray<number>, more: number) =>
  rooms.reduce((sum, room, i) => sum + (parts[i]?.head.length ?? 0) + room + 1, 0) +
  (more + parts.length - rooms.length > 0 ? 1 : 0)

describe("panelRooms", () => {
  const cases = fc.record({
    parts: fc.array(
      fc
        .tuple(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 40 }))
        .map(([h, i]) => partsOf(h, i)),
      { minLength: 1, maxLength: 2 },
    ),
    budget: fc.integer({ min: -5, max: 60 }),
    height: fc.integer({ min: 1, max: 80 }),
    more: fc.integer({ min: 0, max: 3 }),
  })

  test("draws one request at least; more only within the budget, at least inputLines each", () => {
    fc.assert(
      fc.property(cases, ({ parts, budget, height, more }) => {
        const rooms = panelRooms(parts, budget, height, more)
        expect(rooms.length).toBeGreaterThanOrEqual(1)
        expect(rooms.length).toBeLessThanOrEqual(parts.length)
        if (rooms.length > 1) {
          expect(heightOf(parts, rooms, more)).toBeLessThanOrEqual(budget)
          rooms.forEach((room, i) => {
            expect(room).toBeGreaterThanOrEqual(Math.min(parts[i]?.input.length ?? 0, inputLines))
          })
        }
      }),
    )
  })

  test("a room is never more than its input, nor a quarter of the pane past inputLines", () => {
    fc.assert(
      fc.property(cases, ({ parts, budget, height, more }) => {
        panelRooms(parts, budget, height, more).forEach((room, i) => {
          const input = parts[i]?.input.length ?? 0
          expect(room).toBeLessThanOrEqual(Math.min(input, Math.max(inputLines, height / 4)))
          expect(room).toBeGreaterThanOrEqual(Math.min(input, 1))
        })
      }),
    )
  })

  test("with room for all, each input has its quarter of the pane", () => {
    const parts = [partsOf(4, 7), partsOf(4, 20)]
    expect(panelRooms(parts, 100, 40, 0)).toEqual([7, 10])
  })

  test("short of room, the longest room shrinks first, then the panel draws one", () => {
    const parts = [partsOf(4, 7), partsOf(4, 20)]
    expect(panelRooms(parts, 26, 40, 0)).toEqual([7, 9])
    expect(panelRooms(parts, 20, 40, 0)).toEqual([5, 5])
    expect(panelRooms(parts, 19, 40, 0)).toEqual([5, 4])
    expect(panelRooms(parts, 16, 40, 0)).toEqual([3, 3])
    expect(panelRooms(parts, 15, 40, 0)).toEqual([7])
    expect(panelRooms(parts, 8, 40, 0)).toEqual([2])
    expect(panelRooms(parts, 2, 40, 0)).toEqual([1])
  })
})
