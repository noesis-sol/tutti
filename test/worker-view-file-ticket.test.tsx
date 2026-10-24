// Filing a finished worker's message as a ticket (§ 7.5, tutti-g0wd): once its card has gone, Ctrl+T
// or the File as ticket button on the finished line offers FileTicket with the composer's text; the
// composer keeps the text until the run's filings say bd has it, and keeps it when bd hasn't.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { FileOutcome, type TicketFiling } from "../src/run/fileTicket.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { fileWords, finishedWords } from "../src/ui/Composer.tsx"
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
  ticket: "t-1",
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

/** Where `text` first is in `frame`: its column and line. */
const spot = (frame: Frame, text: string) => {
  const lines = frame.chars.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y < 0) throw new Error(`no ${JSON.stringify(text)} in:\n${frame.chars}`)
  return { x: (lines[y] ?? "").indexOf(text), y }
}

/** The frame's last lines, the composer's hint under the rule. */
const hintOfFrame = (frame: Frame): string => frame.chars.split("\n").slice(-3).join("\n")

const scene = async (
  body: (at: {
    readonly view: Settable<RunView>
    readonly filings: Settable<ReadonlyArray<TicketFiling>>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(viewOf(false))
  const filings = external<ReadonlyArray<TicketFiling>>([])
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view,
        screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
        transcripts: feed,
        filings,
      }}
    />,
    { width: 80, height: 16 },
    (rendered) => body({ view, filings, commands, rendered }),
  )
}

const followUp = "Also cover the empty case"

/** Writes `text` in the composer, then has t-1's ticket merge: its card goes. */
const writeThenFinish = async (
  rendered: Rendered,
  view: Settable<RunView>,
  text: string = followUp,
): Promise<void> => {
  await until(rendered, has("Working on it."))
  await rendered.input(async (setup) => {
    await setup.mockInput.typeText("i")
    if (text !== "") await setup.mockInput.typeText(text)
  })
  await rendered.input(() => view.set(viewOf(true)))
  await until(rendered, has(finishedWords("t-1").finished))
}

/** The FileTicket commands taken from the queue. */
const filed = (commands: Commands) =>
  taken(commands).flatMap((command) => (command._tag === "FileTicket" ? [command] : []))

const pressCtrlT = (rendered: Rendered) =>
  rendered.input((setup) => setup.mockInput.pressKey("t", { ctrl: true }))

describe("filing a finished worker's message as a ticket", () => {
  test("the finished line has File as ticket, and the hint Ctrl+T, composing or not", async () => {
    await scene(async ({ view, rendered }) => {
      let frame = await until(rendered, has("Working on it."))
      expect(frame.chars).not.toContain(fileWords.button)
      expect(hintOfFrame(frame)).not.toContain("Ctrl+T")

      await rendered.input(() => view.set(viewOf(true)))
      frame = await until(rendered, has(finishedWords("t-1").finished))
      expect(frame.chars).toContain("t-1's worker has finished: tutti can't send it messages")
      expect(frame.chars).toContain(fileWords.button)
      expect(hintOfFrame(frame)).toContain("Ctrl+T file as ticket")

      await rendered.input((setup) => setup.mockInput.typeText("i"))
      frame = await until(rendered, has("new line"))
      expect(hintOfFrame(frame)).toContain("Ctrl+T file as ticket")
    })
  })

  test("Ctrl+T files the text; the composer keeps it till it's filed, then empties", async () => {
    await scene(async ({ view, filings, commands, rendered }) => {
      await writeThenFinish(rendered, view)
      await pressCtrlT(rendered)
      let frame = await until(rendered, has(fileWords.filing))
      const asked = filed(commands)
      expect(asked.map(({ from, text }) => ({ from, text }))).toEqual([
        { from: "t-1", text: followUp },
      ])
      expect(frame.chars).toContain(` > ${followUp}`)

      // A second press while it's filed waits for the first.
      await pressCtrlT(rendered)
      await until(rendered, has(fileWords.already))
      expect(filed(commands)).toEqual([])

      const uuid = asked[0]?.uuid ?? ""
      await rendered.input(() =>
        filings.set([
          { uuid, from: "t-1", outcome: FileOutcome.Filed({ id: "t-9", title: followUp }) },
        ]),
      )
      frame = await until(rendered, has(fileWords.filed("t-9", followUp)))
      expect(frame.chars).not.toContain(` > ${followUp}`)
    })
  })

  test("bd refuses it: the composer keeps the text, and a toast says why", async () => {
    await scene(async ({ view, filings, commands, rendered }) => {
      await writeThenFinish(rendered, view)
      await pressCtrlT(rendered)
      const uuid = filed(commands)[0]?.uuid ?? ""
      await rendered.input(() =>
        filings.set([{ uuid, from: "t-1", outcome: FileOutcome.NotFiled({ why: "bd is gone" }) }]),
      )
      const frame = await until(rendered, has(fileWords.notFiled("bd is gone")))
      expect(frame.chars).toContain(` > ${followUp}`)

      // Pressed again, it's filed anew.
      await pressCtrlT(rendered)
      expect(filed(commands).map((command) => command.text)).toEqual([followUp])
    })
  })

  test("text typed after Ctrl+T stays once the filing lands", async () => {
    await scene(async ({ view, filings, commands, rendered }) => {
      await writeThenFinish(rendered, view)
      await pressCtrlT(rendered)
      const uuid = filed(commands)[0]?.uuid ?? ""
      await rendered.input((setup) => setup.mockInput.typeText(" too"))
      await rendered.input(() =>
        filings.set([
          { uuid, from: "t-1", outcome: FileOutcome.Filed({ id: "t-9", title: followUp }) },
        ]),
      )
      const frame = await until(rendered, has(fileWords.filed("t-9", followUp)))
      expect(frame.chars).toContain(` > ${followUp} too`)
    })
  })

  test("a click on File as ticket files it as Ctrl+T does", async () => {
    await scene(async ({ view, commands, rendered }) => {
      await writeThenFinish(rendered, view)
      const { x, y } = spot(await rendered.capture(), fileWords.button)
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      await until(rendered, has(fileWords.filing))
      expect(filed(commands).map((command) => command.text)).toEqual([followUp])
    })
  })

  test("with nothing written, nothing is filed, and a toast says so", async () => {
    await scene(async ({ view, commands, rendered }) => {
      await writeThenFinish(rendered, view, "")
      await pressCtrlT(rendered)
      await until(rendered, has(fileWords.nothing))
      expect(filed(commands)).toEqual([])
    })
  })

  test("while the worker is there, Ctrl+T files nothing", async () => {
    await scene(async ({ commands, rendered }) => {
      await until(rendered, has("Working on it."))
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("i")
        await setup.mockInput.typeText(followUp)
      })
      await pressCtrlT(rendered)
      await Bun.sleep(100)
      expect(filed(commands)).toEqual([])
      expect((await rendered.capture()).chars).toContain(` > ${followUp}`)
    })
  })
})
