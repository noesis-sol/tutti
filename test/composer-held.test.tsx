// The composer while its ticket waits to merge or merges (§ 7.5, held.ts): the held line says the
// run holds your messages until the merge is over, a message you send is shown `held`, and once the
// ticket has merged with it still held, `not sent`.

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
import { finishedWords, heldWords } from "../src/ui/Composer.tsx"
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
  phase: TicketPhase.ToMerge({ place: 1 }),
  since: began,
  worker: 1,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
}

/** RunView with worker 1 on t-1 in `phase`, idle, or, with none, no ticket: its card has gone. */
const viewOf = (phase: TicketPhase | null, steered = false): RunView =>
  project({
    ledger: {
      tickets: new Map(
        phase === null
          ? []
          : [["t-1" as TicketId, { ...ledgerEntry, phase, steered, handBack: steered }]],
      ),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map(phase === null ? [] : [["t-1", WS.Idle({ at: began })]]),
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
  const view = external(viewOf(TicketPhase.ToMerge({ place: 1 })))
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

const typed = "Please also cover the empty case"

describe("the composer of a ticket that merges", () => {
  test("says your messages are held; one you send is held, then not sent once it merged", async () => {
    await scene(async ({ view, commands, rendered }) => {
      let frame = await until(rendered, has("Working on it."))
      const waits = heldWords("t-1", false)
      expect(frame.chars).toContain(`${waits.phase}${waits.line}`)
      expect(frame.chars).toContain("t-1 waits to merge: tutti holds your messages until its merge")

      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("i")
        await setup.mockInput.typeText(typed)
        setup.mockInput.pressEnter()
      })
      const sent = taken(commands)
      expect(sent.map((command) => command._tag)).toEqual(["SendMessage"])
      // The run steers the worker as it holds the message.
      await rendered.input(() => view.set(viewOf(TicketPhase.Merging({ step: "check" }), true)))
      frame = await until(rendered, has(heldWords("t-1", true).phase))
      expect(frame.chars).toContain("t-1 is merging: tutti holds your messages")
      expect(frame.chars).toMatch(/› Please also cover the empty case +held/)
      expect(frame.chars).toContain("[ Release ]")
      expect(frame.chars).not.toContain(` > ${typed}`)

      // It merges with the message still held: its card goes, and the message wasn't sent.
      await rendered.input(() => view.set(viewOf(null)))
      frame = await until(rendered, has(finishedWords("t-1").finished))
      expect(frame.chars).toMatch(/› Please also cover the empty case +not sent/)
      expect(frame.chars).not.toContain(heldWords("t-1", true).line)
    })
  })

  test("sent on, once the merge is over: the held mark goes", async () => {
    await scene(async ({ view, rendered }) => {
      await until(rendered, has("Working on it."))
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("i")
        await setup.mockInput.typeText(typed)
        setup.mockInput.pressEnter()
      })
      let frame = await until(rendered, has("held"))
      expect(frame.chars).toMatch(/› Please also cover the empty case +held/)
      // Blocked on its conflict, the hand-back waiting for its steered worker: the run sends it.
      await rendered.input(() =>
        view.set(viewOf(TicketPhase.Blocked({ why: "MERGE_CONFLICT" }), true)),
      )
      frame = await until(rendered, (now) => !now.chars.includes(heldWords("t-1", false).line))
      expect(frame.chars).not.toMatch(/ +held/)
      expect(frame.chars).not.toContain("not sent")
    })
  })
})
