// The composer once the worker has finished (§ 7.5, tutti-ceo): its ticket merges and its card goes
// while you write, and the view still shows it. The composer says the worker has finished, Enter
// keeps what you typed and sends nothing, and a toast says it wasn't sent.

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { composerPlaceholder, finishedWords } from "../src/ui/Composer.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
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
  ticket: "t-1" as TicketId,
  title: "Title of t-1",
  phase: TicketPhase.Working(),
  since: began,
  worker: 1,
  row: 0,
  rechecking: false,
  steered: true,
  lastMessage: null,
  tallies: emptyTallies,
}

/** RunView with worker 1 on t-1, or, once `merged`, with no ticket: its card has gone. */
const viewOf = (merged: boolean): RunView =>
  project({
    ledger: {
      tickets: new Map(merged ? [] : [["t-1" as TicketId, ledgerEntry]]),
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

/** The commands sent since the last call. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

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

const scene = async (
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(viewOf(false))
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view,
        screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
        transcripts: feed,
      }}
    />,
    { width: 80, height: 16 },
    (rendered) => body({ view, commands, rendered }),
  )
}

describe("the composer of a worker that has finished", () => {
  test("the ticket merges while you write: Enter keeps the text, sends nothing, toasts", async () => {
    await scene(async ({ view, commands, rendered }) => {
      await until(rendered, has("Working on it."))
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("i")
        await setup.mockInput.typeText("Please also cover the empty case")
      })
      expect((await rendered.capture()).chars).toContain(" > Please also cover the empty case")
      expect(taken(commands)).toEqual([])

      // The ticket merges: its card goes, and the view still shows the worker it last saw.
      await rendered.input(() => view.set(viewOf(true)))
      let frame = await until(rendered, has(finishedWords("t-1").finished))
      expect(frame.chars).toContain("t-1's worker has finished: tutti can't send it messages")
      // Its steered line, whose Release can't be sent now, gives way to the finished line.
      expect(frame.chars).not.toContain("[ Release ]")
      expect(frame.chars).toContain(" > Please also cover the empty case")

      await rendered.input((setup) => setup.mockInput.pressEnter())
      frame = await until(rendered, has(finishedWords("t-1").toast))
      // The toast is drawn over the composer's row, opaque: the text under it is still in the
      // field, as backspacing it below shows.
      expect(frame.chars).toContain(` > Please also cover the e ${finishedWords("t-1").toast}`)
      expect(taken(commands)).toEqual([])

      // Emptied by hand, the field's placeholder says the worker has finished.
      await rendered.input(async (setup) => {
        for (const _ of "Please also cover the empty case") setup.mockInput.pressBackspace()
      })
      frame = await until(rendered, has(` > ${finishedWords("t-1").placeholder}`))
      expect(frame.chars).not.toContain(composerPlaceholder(true))
      expect(taken(commands)).toEqual([])
    })
  })

  test("while the card is there, Enter sends and empties the field", async () => {
    await scene(async ({ commands, rendered }) => {
      await until(rendered, has("Working on it."))
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("i")
        await setup.mockInput.typeText("one more thing")
        setup.mockInput.pressEnter()
      })
      const sent = taken(commands)
      expect(sent.map((command) => command._tag)).toEqual(["SendMessage"])
      expect((await rendered.capture()).chars).not.toContain(" > one more thing")
    })
  })
})
