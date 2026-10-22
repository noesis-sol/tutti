// What a transcript's view draws anew, and what it works out once (tutti-k2n1): the spinner and the
// clock tick in the view's head, a leaf, so that the view under it isn't drawn ten times a second
// while its worker works; an edit's change is worked out once for each tool call's input.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  editOf,
  emptyTranscript,
  type OpenTranscript,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { usePanel, useSelection, useTranscriptWindow } from "../src/ui/transcriptView.ts"
import {
  external,
  type Settable,
  type ShellValue,
  spinnerTick,
  useRunView,
} from "../src/ui/useRunView.ts"
import { withRender } from "./render.ts"

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

const edit = {
  file_path: "src/a.ts",
  old_string: "const a = 1\n",
  new_string: "const a = 2\nconst b = 3\n",
}

const items: ReadonlyArray<Item> = [
  sdk({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "e-1", name: "Edit", input: edit }],
    },
    parent_tool_use_id: null,
  }),
  sdk({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "e-1", content: "updated", is_error: false }],
    },
    parent_tool_use_id: null,
  }),
].map((message, i) => ({
  v: transcriptVersion,
  seq: i + 1,
  session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
  time: "2026-10-20T13:00:00.000Z",
  message,
}))

/** Worker 1 on t-1 in `state`. */
const viewOf = (state: WorkerState): RunView =>
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
    workers: new Map([["t-1", state]]),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

/** Worker 1 at work, so that its view's head spins, and after a turn, its head still. */
const working = viewOf(WS.Working({ doing: "editing" }))
const idle = viewOf(WS.Idle({ at: began }))

/** The run view, counting its reads: the worker view reads it each time it is drawn. */
const counted = (view: RunView) => {
  const store = external(view)
  let reads = 0
  const counting: Settable<RunView> = {
    ...store,
    get: () => {
      reads++
      return store.get()
    },
  }
  return { view: counting, reads: () => reads }
}

/**
 * The shell over `view` and worker 1's transcript `items`, its clock a spinner's frame on at each
 * read while it `turns`, counting those reads, and still otherwise.
 */
const shellOf = (view: Settable<RunView>, clock = { turns: false, reads: 0 }): ShellValue => {
  let at = began
  return {
    view,
    screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf: (appearance) =>
      makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false }),
    now: () => {
      if (clock.turns) {
        clock.reads++
        at += spinnerTick
      }
      return at
    },
    transcripts: {
      open: (): OpenTranscript => ({
        state: external<TranscriptState>({ ...emptyTranscript, window: windowOf(items) }),
        older: () => {},
        scrolledBack: () => {},
        follow: () => {},
        close: () => {},
      }),
    },
  }
}

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

describe("the worker view while its worker works", () => {
  test("the head's spinner turns, and the view under it isn't drawn anew each turn", async () => {
    const { view, reads } = counted(idle)
    const clock = { turns: false, reads: 0 }
    await withRender(
      <Root value={shellOf(view, clock)} />,
      { width: 80, height: 20 },
      async (rendered) => {
        expect((await rendered.capture()).chars).toContain("• t-1")
        await rendered.input(() => view.set(working))
        const before = reads()
        // Ten turns outside act(), as the terminal draws them: act() would draw them once.
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
        clock.turns = true
        try {
          await Bun.sleep(spinnerTick * 10)
        } finally {
          clock.turns = false
          actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
        }
        // The spinner turned, reading the clock at each turn; the view, drawn at each turn, would
        // have read the run view as often.
        expect(clock.reads).toBeGreaterThan(3)
        expect(reads() - before).toBeLessThan(3)
        await rendered.input(() => view.set(idle))
        expect((await rendered.capture()).chars).toContain("+2 −1")
      },
    )
  })
})

describe("a click on an entry", () => {
  test("is the same function from one drawing to the next, and selects and expands as it did", async () => {
    const view = external(working)
    const clicks: Array<(key: string) => void> = []
    const drawn: Array<{ readonly selected: string | null; readonly open: boolean }> = []
    const Probe = () => {
      const card = useRunView().cards.find((each) => each.ticket === "t-1")
      const transcript = useTranscriptWindow("t-1", true)
      const selection = useSelection(transcript, usePanel(card))
      clicks.push(selection.click)
      drawn.push({ selected: selection.selected, open: transcript.expanded.has("e-1") })
      return null
    }
    await withRender(
      <Root value={shellOf(view)}>
        <Probe />
      </Root>,
      { width: 80, height: 20 },
      async (rendered) => {
        await rendered.input(() => {
          // A new run view: the view is drawn anew with the same entries.
          view.set({ ...working, cards: [...working.cards] })
        })
        await rendered.input(() => clicks.at(-1)?.("e-1"))
        await rendered.input(() => clicks.at(-1)?.("e-1"))
        expect(new Set(clicks).size).toBe(1)
        expect(clicks.length).toBeGreaterThan(3)
        expect(drawn.at(-2)).toEqual({ selected: "e-1", open: true })
        expect(drawn.at(-1)).toEqual({ selected: "e-1", open: false })
      },
    )
  })
})

describe("an edit's change", () => {
  test("is worked out once for each input, by its tool's name", () => {
    const input = { ...edit }
    const change = editOf("Edit", input)
    expect(change).toMatchObject({ added: 2, removed: 1 })
    expect(editOf("Edit", input)).toBe(change as NonNullable<typeof change>)
    expect(editOf("Bash", input)).toBeUndefined()
    expect(editOf("Write", { file_path: "a.ts", content: "a\n" })).toMatchObject({ added: 1 })
    // An equal input of another call is its own.
    expect(editOf("Edit", { ...edit })).not.toBe(change as NonNullable<typeof change>)
    expect(editOf("Edit", { ...edit })).toEqual(change)
  })
})
