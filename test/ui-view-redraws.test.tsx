// What a transcript's view draws anew, and what it works out once (tutti-k2n1): the spinner and the
// clock tick in the view's head, a leaf, so that the view under it isn't drawn ten times a second
// while its worker works; an edit's change is worked out once for each tool call's input.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  editOf,
  emptyTranscript,
  type OpenTranscript,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable, spinnerFrames, spinnerTick } from "../src/ui/useRunView.ts"
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

/** Worker 1 at work on t-1, so that its view's head spins. */
const working: RunView = project({
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
  workers: new Map([["t-1", WS.Working({ doing: "editing" })]]),
  requests: [],
  status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
  actions: new Map(),
})

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

describe("the worker view while its worker works", () => {
  test("the head's spinner turns, and the view under it isn't drawn anew each turn", async () => {
    const { view, reads } = counted(working)
    const feed = {
      open: (): OpenTranscript => ({
        state: external<TranscriptState>({ ...emptyTranscript, window: windowOf(items) }),
        older: () => {},
        scrolledBack: () => {},
        follow: () => {},
        close: () => {},
      }),
    }
    // The shell's clock moves a spinner's frame each time it is read.
    let at = began
    const now = () => (at += spinnerTick)
    await withRender(
      <Root
        value={{
          view,
          screen: external(Screen.Worker({ ticket: "t-1" })),
          commands: Effect.runSync(makeCommands),
          appearance: external("dark" as const),
          themeOf: (appearance) =>
            makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false }),
          now,
          transcripts: feed,
        }}
      />,
      { width: 80, height: 20 },
      async (rendered) => {
        const first = await rendered.capture()
        expect(first.chars).toContain("+2 −1")
        const head = () => (first.chars.split("\n")[0] ?? "").trim()
        expect(spinnerFrames.some((frame) => head().includes(frame))).toBe(true)
        const before = reads()
        // Inside act(), so that each turn is drawn.
        await rendered.input(() => Bun.sleep(spinnerTick * 10))
        const later = await rendered.capture()
        const turned = (later.chars.split("\n")[0] ?? "").trim()
        // The spinner turned some ten times; the view read the run view only as often as the
        // rest of the screen does.
        expect(turned).not.toBe(head())
        expect(reads() - before).toBeLessThan(5)
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
