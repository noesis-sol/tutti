// The worker view's head and hint once the worker has finished (§ 7.5, tutti-2n7y): its ticket
// merges and its card goes while the view shows it. The head says finished, without the last card's
// status, steered or spinner, its clock stopped; the hint drops Enter send, Ctrl+X and Ctrl+R, which
// do nothing then.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { finishedWords } from "../src/ui/Composer.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable, tick } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 22, 13, 0, 0).getTime()

const said = (words: string): SDKMessage =>
  ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

const items: ReadonlyArray<Item> = [
  {
    v: transcriptVersion,
    seq: 1,
    session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
    time: "2026-10-22T13:00:00.000Z",
    message: said("Working on it."),
  },
]

const ledgerEntry: LedgerEntry = {
  ticket: "t-1",
  title: "Title of t-1",
  phase: TicketPhase.Working({ activity: "working" }),
  since: began,
  worker: 1,
  row: 0,
  rechecking: false,
  steered: true,
  lastMessage: null,
  tallies: emptyTallies,
}

/** RunView with worker 1 on t-1, steered, or, once `merged`, with no ticket: its card has gone. */
const viewOf = (merged: boolean): RunView =>
  project({
    ledger: {
      tickets: new Map(merged ? [] : [["t-1", ledgerEntry]]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map(merged ? [] : [["t-1", WS.Working({ doing: "working" })]]),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

const feed: TranscriptFeed = {
  open: (): OpenTranscript => ({
    state: external<TranscriptState>({ ...emptyTranscript, window: windowOf(items) }),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** Captures frames until `ready` holds of one. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

/** The frame's first line, the view's head. */
const headOfFrame = (frame: Frame): string => frame.chars.split("\n")[0] ?? ""

/** The frame's last lines, the composer's hint under the rule. */
const hintOfFrame = (frame: Frame): string => frame.chars.split("\n").slice(-3).join("\n")

const scene = async (
  body: (at: {
    readonly view: Settable<RunView>
    readonly rendered: Rendered
    readonly advance: (millis: number) => void
  }) => Promise<void>,
) => {
  const view = external(viewOf(false))
  const commands = Effect.runSync(makeCommands)
  let clock = began + 67_000
  await withRender(
    <Root
      value={{
        view,
        screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => clock,
        transcripts: feed,
      }}
    />,
    { width: 80, height: 16 },
    (rendered) =>
      body({
        view,
        rendered,
        advance: (millis) => {
          clock += millis
        },
      }),
  )
}

describe("the worker view of a worker that has finished", () => {
  test("composing: the hint drops Enter send, Ctrl+X and Ctrl+R; the head says finished", async () => {
    await scene(async ({ view, rendered }) => {
      await until(rendered, has("Working on it."))
      await rendered.input((setup) => setup.mockInput.typeText("i"))
      let frame = await until(rendered, has("new line"))
      expect(headOfFrame(frame)).toContain("working")
      expect(headOfFrame(frame)).toContain("steered")
      expect(hintOfFrame(frame)).toContain("Enter send")
      expect(hintOfFrame(frame)).toContain("Ctrl+X interrupt")
      expect(hintOfFrame(frame)).toContain("Ctrl+R release")

      await rendered.input(() => view.set(viewOf(true)))
      frame = await until(rendered, has(finishedWords("t-1").finished))
      const head = headOfFrame(frame)
      expect(head).toContain(`• t-1  ${finishedWords("t-1").status}`)
      expect(head).toContain("Title of t-1")
      expect(head).not.toContain("working")
      expect(head).not.toContain("steered")
      const hint = hintOfFrame(frame)
      expect(hint).toContain("Alt+Enter/Ctrl+J new line")
      expect(hint).toContain("Esc leave")
      expect(hint).not.toContain("Enter send")
      expect(hint).not.toContain("interrupt")
      expect(hint).not.toContain("release")
    })
  })

  test("not composing: the hint drops Ctrl+X and Ctrl+R, and keeps the view's keys", async () => {
    await scene(async ({ view, rendered }) => {
      let frame = await until(rendered, has("Working on it."))
      expect(hintOfFrame(frame)).toContain("Ctrl+X interrupt")

      await rendered.input(() => view.set(viewOf(true)))
      frame = await until(rendered, has(finishedWords("t-1").finished))
      const hint = hintOfFrame(frame)
      expect(hint).toContain("Esc dashboard")
      expect(hint).toContain("i write")
      expect(hint).not.toContain("interrupt")
      expect(hint).not.toContain("release")
    })
  })

  test("the head's clock stops where the view first drew the worker finished", async () => {
    await scene(async ({ view, rendered, advance }) => {
      await until(rendered, has("Working on it."))
      await rendered.input(() => view.set(viewOf(true)))
      const frame = await until(rendered, has(finishedWords("t-1").finished))
      expect(headOfFrame(frame)).toContain("1m07s")

      // A minute on, past the head's next tick, its time hasn't moved.
      advance(60_000)
      await rendered.input(() => Bun.sleep(tick + 300))
      const later = await rendered.capture()
      expect(headOfFrame(later)).toContain("1m07s")
      expect(headOfFrame(later)).not.toContain("2m07s")
    })
  })
})
