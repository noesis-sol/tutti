// Toasts sit above what you write or are about to send (§ 7.11; tutti-fknd): in the worker view the
// first is drawn on the rule over the held line, the finished or steered line, the queued messages
// and the composer, a second and a third over the transcript's last lines, so none hides what you
// type or the message it is about. The lines counted are those viewLayout gave: a composer that
// grows moves the toasts up with it. The dashboard's toasts stay above its hint.

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import { type MessageUuid, userMessage } from "../src/agent/AgentHost.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { finishedWords } from "../src/ui/Composer.tsx"
import { suspendToast } from "../src/ui/Toasts.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  appended,
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

const began = new Date(2026, 9, 25, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

const said = (words: string) =>
  sdk({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  })

const sent = (text: string, uuid: string) =>
  userMessage(
    { text, from: "human" },
    { uuid: uuid as MessageUuid, session },
  ) as unknown as SDKMessage

const lifecycle = (uuid: string, state: string) =>
  sdk({ type: "command_lifecycle", command_uuid: uuid, state })

/** RunView with worker 1 on t-1, `steered` or not, or, once `merged`, with no ticket. */
const viewOf = ({ steered = false, merged = false } = {}): RunView =>
  project({
    ledger: {
      tickets: new Map(
        merged
          ? []
          : [
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
                  steered,
                  lastMessage: null,
                  tallies: emptyTallies,
                },
              ],
            ],
      ),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map(merged ? [] : [["t-1", WS.Working({ doing: "working" })]]),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

/** A feed of t-1's transcript, which the test appends to as the host would. */
const liveFeed = () => {
  let seq = 0
  const state = external<TranscriptState>({ ...emptyTranscript, window: windowOf([]) })
  const feed: TranscriptFeed = {
    open: (): OpenTranscript => ({
      state,
      older: () => {},
      scrolledBack: () => {},
      follow: () => {},
      close: () => {},
    }),
  }
  const append = (messages: ReadonlyArray<SDKMessage>) => {
    let window = state.get().window
    for (const message of messages) {
      const item: Item = {
        v: transcriptVersion,
        seq: ++seq,
        session,
        time: "2026-10-25T13:00:00.000Z",
        message,
      }
      window = appended(window, item)
    }
    state.set({ ...state.get(), window })
  }
  return { feed, append }
}

interface Scene {
  readonly view: Settable<RunView>
  readonly commands: Commands
  readonly rendered: Rendered
  readonly append: (messages: ReadonlyArray<SDKMessage>) => void
}

/** The worker view of t-1 in a pane `width` × `height`, its transcript a line of text. */
const scene = async (
  size: { readonly width: number; readonly height: number },
  body: (at: Scene) => Promise<void>,
  options: { readonly steered?: boolean } = {},
) => {
  const view = external(viewOf(options))
  const commands = Effect.runSync(makeCommands)
  const { feed, append } = liveFeed()
  append([said("Working on it.")])
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
    size,
    (rendered) => body({ view, commands, rendered, append }),
  )
}

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** Captures frames until one shows `text`. */
const until = async (rendered: Rendered, text: string): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (frame.chars.includes(text) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

/** The row of the first line that starts with `start`. */
const rowOf = (lines: ReadonlyArray<string>, start: string): number =>
  lines.findIndex((line) => line.startsWith(start))

/** Shows `count` of Ctrl+Z's toasts. */
const suspend = (rendered: Rendered, count: number) =>
  rendered.input((setup) => {
    for (let i = 0; i < count; i++) setup.mockInput.pressKey("z", { ctrl: true })
  })

/** Writes `text` in the composer, its lines joined by Ctrl+J. */
const write = (rendered: Rendered, text: string) =>
  rendered.input(async (setup) => {
    await setup.mockInput.typeText("i")
    const [first = "", ...rest] = text.split("\n")
    await setup.mockInput.typeText(first)
    for (const line of rest) {
      setup.mockInput.pressKey("j", { ctrl: true })
      await setup.mockInput.typeText(line)
    }
  })

/** The uuid of the message the composer sent. */
const sentUuid = (commands: Commands): string => {
  const taken: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(commands))
  const send = taken.find((command) => command._tag === "SendMessage")
  if (send?._tag !== "SendMessage") throw new Error("no SendMessage")
  return send.uuid
}

describe("a toast over the worker view", () => {
  test("with text in the composer it sits on the rule, the text whole under it", async () => {
    await scene({ width: 80, height: 24 }, async ({ rendered }) => {
      await until(rendered, "Working on it.")
      await write(rendered, "Please also cover the empty case")
      await suspend(rendered, 1)
      const lines = linesOf(await until(rendered, suspendToast))
      const composerAt = rowOf(lines, " > Please also cover the empty case")
      expect(lines[composerAt]).toBe(" > Please also cover the empty case")
      expect(lines[composerAt - 1]).toBe(`──── ${suspendToast} ─`)
      expect(lines[composerAt + 1]).toStartWith("  Enter send")
    })
  })

  test("with a message queued it sits on the rule over it, the queued line shown", async () => {
    await scene({ width: 80, height: 24 }, async ({ rendered, commands, append }) => {
      await until(rendered, "Working on it.")
      await write(rendered, "Please add tests")
      await rendered.input((setup) => setup.mockInput.pressEnter())
      const uuid = sentUuid(commands)
      await rendered.input(() =>
        append([sent("Please add tests", uuid), lifecycle(uuid, "queued")]),
      )
      await until(rendered, "queued")
      await suspend(rendered, 1)
      const lines = linesOf(await until(rendered, suspendToast))
      const queuedAt = lines.findIndex((line) => line.includes("› Please add tests"))
      expect(lines[queuedAt]).toContain("queued")
      expect(lines[queuedAt]).not.toContain(suspendToast)
      expect(lines[queuedAt - 1]).toBe(`──── ${suspendToast} ─`)
    })
  })

  test("with the steered line it sits on the rule over it, the line shown", async () => {
    await scene(
      { width: 80, height: 24 },
      async ({ rendered }) => {
        await until(rendered, "Release")
        await suspend(rendered, 1)
        const lines = linesOf(await until(rendered, suspendToast))
        const steeredAt = lines.findIndex((line) => line.includes("[ Release ]"))
        expect(lines[steeredAt]).not.toContain(suspendToast)
        expect(lines[steeredAt - 1]).toBe(`──── ${suspendToast} ─`)
        expect(lines[steeredAt + 1]).toStartWith(" > ")
      },
      { steered: true },
    )
  })

  test("with the finished line it sits on the rule over it, the line and the text shown", async () => {
    await scene({ width: 80, height: 24 }, async ({ rendered, view }) => {
      await until(rendered, "Working on it.")
      await write(rendered, "Please also cover the empty case")
      await rendered.input(() => view.set(viewOf({ merged: true })))
      await until(rendered, finishedWords("t-1").finished)
      await rendered.input((setup) => setup.mockInput.pressEnter())
      const lines = linesOf(await until(rendered, finishedWords("t-1").toast))
      const composerAt = rowOf(lines, " > Please also cover the empty case")
      expect(lines[composerAt]).toBe(" > Please also cover the empty case")
      expect(lines[composerAt - 1]).toContain(finishedWords("t-1").finished)
      expect(lines[composerAt - 2]).toStartWith("─")
      expect(lines[composerAt - 2]).toEndWith(` ${finishedWords("t-1").toast} ─`)
    })
  })

  test("over a composer of several lines it moves up with them", async () => {
    await scene({ width: 80, height: 24 }, async ({ rendered }) => {
      await until(rendered, "Working on it.")
      await write(rendered, "first line\nsecond line\nthird line")
      await suspend(rendered, 1)
      const lines = linesOf(await until(rendered, suspendToast))
      const firstAt = rowOf(lines, " > first line")
      expect(lines.slice(firstAt, firstAt + 3)).toEqual([
        " > first line",
        "   second line",
        "   third line",
      ])
      expect(lines[firstAt - 1]).toBe(`──── ${suspendToast} ─`)
    })
  })

  test("three at 80×24: the first on the rule, the others over the transcript", async () => {
    await scene({ width: 80, height: 24 }, async ({ rendered }) => {
      await until(rendered, "Working on it.")
      await suspend(rendered, 3)
      const lines = linesOf(await until(rendered, suspendToast))
      const composerAt = rowOf(lines, " > i to write to the worker")
      expect(lines[composerAt - 1]).toBe(`──── ${suspendToast} ─`)
      expect(lines[composerAt - 2]).toBe(`     ${suspendToast}`)
      expect(lines[composerAt - 3]).toBe(`     ${suspendToast}`)
      expect(lines[composerAt + 1]).toStartWith("  Esc dashboard")
      expect(lines.filter((line) => line.includes(suspendToast))).toHaveLength(3)
    })
  })

  test("three at the minimum size, 60×16, none over the composer or the hint", async () => {
    await scene({ width: 60, height: 16 }, async ({ rendered }) => {
      await until(rendered, "Working on it.")
      await suspend(rendered, 3)
      const lines = linesOf(await until(rendered, "can't be suspended"))
      const composerAt = rowOf(lines, " > i to write to the worker")
      const toasts = lines.flatMap((line, row) =>
        line.includes("can't be suspended") ? [row] : [],
      )
      expect(toasts).toEqual([composerAt - 3, composerAt - 2, composerAt - 1])
      expect(lines[composerAt - 1]).toStartWith("─")
      expect(rowOf(lines, "  Esc dashboard")).toBe(composerAt + 1)
    })
  })
})
