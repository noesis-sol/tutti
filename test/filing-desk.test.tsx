// A filing that outlives its view (§ 7.5, tutti-fgr2): leave a finished worker's view before bd
// answers its Ctrl+T, and the toast still says how it went; reopen it, and the composer has the text
// again, and Ctrl+T waits for the filing still under way.

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
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { fileWords, finishedWords } from "../src/ui/Composer.tsx"
import { makeFilingDesk } from "../src/ui/filingDesk.tsx"
import { makeToasts, type ToastStore } from "../src/ui/Toasts.tsx"
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
    readonly filings: Settable<ReadonlyArray<TicketFiling>>
    readonly screen: Settable<Screen>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(viewOf(false))
  const filings = external<ReadonlyArray<TicketFiling>>([])
  const screen = external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId }))
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view,
        screen,
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
        transcripts: feed,
        filings,
      }}
    />,
    { width: 80, height: 16 },
    (rendered) => body({ view, filings, screen, commands, rendered }),
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

/** Leaves the view for the dashboard. */
const leave = (rendered: Rendered, screen: Settable<Screen>) =>
  rendered.input(() => screen.set(Screen.Dashboard()))

/** Opens t-1's view again. */
const reopen = async (rendered: Rendered, screen: Settable<Screen>): Promise<Frame> => {
  await rendered.input(() => screen.set(Screen.Worker({ ticket: "t-1" as TicketId })))
  return until(rendered, has(finishedWords("t-1").finished))
}

/** bd's `outcome` for the filing `uuid`. */
const answer = (
  rendered: Rendered,
  filings: Settable<ReadonlyArray<TicketFiling>>,
  uuid: string,
  outcome: FileOutcome,
) => rendered.input(() => filings.set([{ uuid, from: "t-1" as TicketId, outcome }]))

describe("a filing that outlives its view", () => {
  test("filed after you left: the toast still says so, and the view reopens empty", async () => {
    await scene(async ({ view, filings, screen, commands, rendered }) => {
      await writeThenFinish(rendered, view)
      await pressCtrlT(rendered)
      const uuid = filed(commands)[0]?.uuid ?? ""
      await leave(rendered, screen)
      await answer(
        rendered,
        filings,
        uuid,
        FileOutcome.Filed({ id: "t-9" as TicketId, title: followUp }),
      )
      const away = await until(rendered, has(fileWords.filed("t-9", followUp)))
      expect(away.chars).toContain(fileWords.filed("t-9", followUp))

      const frame = await reopen(rendered, screen)
      expect(frame.chars).not.toContain(` > ${followUp}`)
    })
  })

  test("refused after you left: the toast says why, and the reopened view has the text", async () => {
    await scene(async ({ view, filings, screen, commands, rendered }) => {
      await writeThenFinish(rendered, view)
      await pressCtrlT(rendered)
      const uuid = filed(commands)[0]?.uuid ?? ""
      await leave(rendered, screen)
      await answer(rendered, filings, uuid, FileOutcome.NotFiled({ why: "bd is gone" }))
      const away = await until(rendered, has(fileWords.notFiled("bd is gone")))
      expect(away.chars).toContain(fileWords.notFiled("bd is gone"))

      let frame = await reopen(rendered, screen)
      frame = await until(rendered, has(` > ${followUp}`))
      expect(frame.chars).toContain(` > ${followUp}`)

      // Pressed again, it's filed anew.
      await pressCtrlT(rendered)
      expect(filed(commands).map((command) => command.text)).toEqual([followUp])
    })
  })

  test("reopened while bd files it: the text is back, and Ctrl+T waits for the filing", async () => {
    await scene(async ({ view, filings, screen, commands, rendered }) => {
      await writeThenFinish(rendered, view)
      await pressCtrlT(rendered)
      const uuid = filed(commands)[0]?.uuid ?? ""
      await leave(rendered, screen)
      await reopen(rendered, screen)
      let frame = await until(rendered, has(` > ${followUp}`))
      expect(frame.chars).toContain(` > ${followUp}`)

      await pressCtrlT(rendered)
      await until(rendered, has(fileWords.already))
      expect(filed(commands)).toEqual([])

      await answer(
        rendered,
        filings,
        uuid,
        FileOutcome.Filed({ id: "t-9" as TicketId, title: followUp }),
      )
      frame = await until(rendered, has(fileWords.filed("t-9", followUp)))
      expect(frame.chars).toContain(fileWords.filed("t-9", followUp))
      expect(frame.chars).not.toContain(` > ${followUp}`)
    })
  })
})

describe("makeFilingDesk", () => {
  const toasts = () => {
    const shown: Array<string> = []
    const store = makeToasts(1_000_000)
    return {
      shown,
      store: { ...store, show: (text: string) => void shown.push(text) } as ToastStore,
    }
  }

  test("a filing pends till its uuid is answered, and is settled once", () => {
    const desk = makeFilingDesk()
    const { shown, store } = toasts()
    desk.ask("t-1" as TicketId, { uuid: "u-1", text: "x" })
    desk.settle([], store)
    expect(desk.pending("t-1" as TicketId)).toEqual({ uuid: "u-1", text: "x" })
    expect(desk.opening("t-1" as TicketId)).toBe("x")
    const answered: ReadonlyArray<TicketFiling> = [
      { uuid: "u-1", from: "t-1" as TicketId, outcome: FileOutcome.NotFiled({ why: "no" }) },
    ]
    desk.settle(answered, store)
    desk.settle(answered, store)
    expect(desk.pending("t-1" as TicketId)).toBeUndefined()
    expect(shown).toEqual([fileWords.notFiled("no")])
    // Refused with no view open, its text is given to the next opening only.
    expect(desk.opening("t-1" as TicketId)).toBe("x")
    expect(desk.opening("t-1" as TicketId)).toBe("")
  })

  test("refused with its view open, the text isn't kept for later: the composer has it", () => {
    const desk = makeFilingDesk()
    const { store } = toasts()
    desk.ask("t-1" as TicketId, { uuid: "u-1", text: "x" })
    const detach = desk.attach("t-1" as TicketId, { current: null })
    desk.settle(
      [{ uuid: "u-1", from: "t-1" as TicketId, outcome: FileOutcome.NotFiled({ why: "no" }) }],
      store,
    )
    detach()
    expect(desk.opening("t-1" as TicketId)).toBe("")
  })
})
