// The composer in the worker view (§ 7.5, § 7.3, § 4.3, § 7.11): typing, new lines, sending a
// SendMessage with its uuid, the `queued` mark until the transcript says the CLI took the message,
// Esc leaving the composer before the view, Ctrl+X's question and its Interrupt, Ctrl+R and the
// Release button, and the form roles it is drawn in. The scripted host sends a message with the
// uuid the composer drew.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { TextareaRenderable } from "@opentui/core"
import { Effect, Layer, Queue } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { layer as hostLayer, Recording, turn } from "../src/testing/AgentHost.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { composerPlaceholder, interruptWords, takenIn } from "../src/ui/Composer.tsx"
import { fieldTakes } from "../src/ui/keys.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  appended,
  emptyTranscript,
  followed,
  type OpenTranscript,
  scrolledBack,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

// SDK messages with only the fields tutti reads, cast as the SDK's types allow.
const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

const said = (words: string) =>
  sdk({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  })

const lifecycle = (uuid: string, state: string) =>
  sdk({ type: "command_lifecycle", command_uuid: uuid, state })

const resultListing = (uuids: ReadonlyArray<string>) =>
  sdk({ type: "result", subtype: "success", is_error: false, user_message_uuids: uuids })

let seq = 0
/** `messages` as transcript items, numbered on from the last. */
const itemsOf = (messages: ReadonlyArray<SDKMessage>): ReadonlyArray<Item> =>
  messages.map((message) => ({
    v: transcriptVersion,
    seq: ++seq,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message,
  }))

const ledgerEntry = (ticket: string, worker: number, steered: boolean): LedgerEntry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: TicketPhase.Working({ activity: "working" }),
  since: began,
  worker,
  row: worker - 1,
  rechecking: false,
  steered,
  lastMessage: null,
  tallies: emptyTallies,
})

const working = WS.Working({ doing: "working" })
const idle = WS.Idle({ at: began })

/** RunView for worker 1 on ticket t-1, in `state`, steered or not. */
const viewOf = (state: WorkerState, steered = false): RunView =>
  project({
    ledger: {
      tickets: new Map([["t-1", ledgerEntry("t-1", 1, steered)]]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map([["t-1", state]]),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

/** A feed of t-1's transcript, which the tests append to as the worker's session would. */
const liveFeed = () => {
  const state = external<TranscriptState>({ ...emptyTranscript, window: windowOf(itemsOf([])) })
  const feed: TranscriptFeed = {
    open: (): OpenTranscript => ({
      state,
      older: () => {},
      scrolledBack: () => state.set({ ...state.get(), window: scrolledBack(state.get().window) }),
      follow: () => state.set({ ...state.get(), window: followed(state.get().window) }),
      close: () => {},
    }),
  }
  const append = (messages: ReadonlyArray<SDKMessage>) => {
    let window = state.get().window
    for (const item of itemsOf(messages)) window = appended(window, item)
    state.set({ ...state.get(), window })
  }
  return { feed, append }
}

const shellOf = (
  view: Settable<RunView>,
  commands: Commands,
  feed: TranscriptFeed,
): ShellValue => ({
  view,
  screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
  commands,
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => began + 67_000,
  transcripts: feed,
})

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** The frame's last lines with anything on them: the composer's part of the view. */
const footOf = (frame: Frame, count: number): string =>
  `\n${linesOf(frame)
    .filter((line) => line !== "")
    .slice(-count)
    .join("\n")}\n`

/** The commands sent since the last call. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

/**
 * The commands sent once `ready` holds of them, or what came within 2 s: a held Esc can be pressed
 * after the input that sent it, on a loaded machine.
 */
const takenOnce = async (
  commands: Commands,
  ready: (sent: ReadonlyArray<UiCommand>) => boolean,
): Promise<ReadonlyArray<UiCommand>> => {
  const deadline = Date.now() + 2000
  const sent: Array<UiCommand> = []
  for (;;) {
    sent.push(...taken(commands))
    if (ready(sent) || Date.now() > deadline) return sent
    await Bun.sleep(20)
  }
}

/** Whether the composer has the focus, once the keys sent have been taken, within 2 s. */
const composerFocused = async (rendered: Rendered, focused: boolean): Promise<boolean> => {
  const deadline = Date.now() + 2000
  for (;;) {
    const now = rendered.setup.renderer.currentFocusedRenderable instanceof TextareaRenderable
    if (now === focused || Date.now() > deadline) return now
    await Bun.sleep(20)
  }
}

type Key = string | { readonly ctrl: string } | "alt+enter"

const press = (rendered: Rendered, ...keys: ReadonlyArray<Key>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (typeof key !== "string") setup.mockInput.pressKey(key.ctrl, { ctrl: true })
      else if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "alt+enter") setup.mockInput.pressEnter({ meta: true })
      else if (key === "escape") {
        await pressEscape(setup)
      } else await setup.mockInput.typeText(key)
    }
  })

/** Renders worker 1's view, its worker in `state`, and runs `body`. */
const scene = async (
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly rendered: Rendered
    readonly append: (messages: ReadonlyArray<SDKMessage>) => void
  }) => Promise<void>,
  options: { readonly state?: WorkerState; readonly steered?: boolean } = {},
) => {
  const view = external(viewOf(options.state ?? working, options.steered))
  const commands = Effect.runSync(makeCommands)
  const { feed, append } = liveFeed()
  append([said("Working on it.")])
  await withRender(
    <Root value={shellOf(view, commands, feed)} />,
    { width: 80, height: 16 },
    (rendered) => body({ view, commands, rendered, append }),
  )
}

/** The colour of the first span holding `text`. */
const colourOf = (frame: Frame, text: string) =>
  frame.spans.lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes(text))
    ?.fg.toInts()
    .slice(0, 3)

const rgb = (look: { readonly fg?: { toInts: () => ReadonlyArray<number> } | undefined }) =>
  look.fg?.toInts().slice(0, 3)

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

/** The one SendMessage among `commands`. */
const sentOf = (commands: ReadonlyArray<UiCommand>) => {
  const sends = commands.filter((command) => command._tag === "SendMessage")
  expect(sends.length).toBe(1)
  const [send] = sends
  if (send?._tag !== "SendMessage") throw new Error("no SendMessage")
  return send
}

describe("the composer", () => {
  test("drawn under the rule: the prompt formAccent, the placeholder formPlaceholder", async () => {
    await scene(async ({ rendered }) => {
      const frame = await until(rendered, has("Working on it."))
      expect(footOf(frame, 4)).toMatchInlineSnapshot(`
        "
        ────────────────────────────────────────────────────────────────────────────────
         > i to write to the worker
          Esc dashboard · i write · Ctrl+X interrupt · ↑↓ select · Enter expand · ? keys
          PgUp/PgDn scroll · g/G top/end
        "
      `)
      expect(colourOf(frame, ">")).toEqual(rgb(theme.form.selector))
      expect(colourOf(frame, composerPlaceholder(false))).toEqual(rgb(theme.form.placeholder))
    })
  })

  test("i focuses it, its keys in the hint; what you type goes in it, not to the view", async () => {
    await scene(async ({ rendered, commands }) => {
      await until(rendered, has("Working on it."))
      await press(rendered, "i")
      const focused = rendered.setup.renderer.currentFocusedRenderable
      expect(focused).toBeInstanceOf(TextareaRenderable)
      // The cursor is formSelected.
      expect([...(focused as TextareaRenderable).cursorColor.toInts()].slice(0, 3)).toEqual(
        rgb(theme.form.selected) ?? [],
      )
      let frame = await rendered.capture()
      expect(frame.chars).toContain(composerPlaceholder(true))
      expect(frame.chars).toContain("Enter send · Alt+Enter/Ctrl+J new line · Esc leave")
      // `i` itself isn't typed; keys the view binds (2, d, ?, g) are.
      await press(rendered, "2d?g")
      frame = await rendered.capture()
      expect(frame.chars).toContain(" > 2d?g")
      expect(frame.chars).not.toContain("Esc close")
      expect(taken(commands)).toEqual([])
    })
  })

  test("Enter sends what you typed, with its new lines, as a SendMessage with a uuid", async () => {
    await scene(
      async ({ rendered, commands }) => {
        await until(rendered, has("Working on it."))
        await press(rendered, "i", "Please also", "alt+enter", "add tests", { ctrl: "j" }, "  ")
        let frame = await rendered.capture()
        expect(frame.chars).toContain(" > Please also")
        expect(frame.chars).toContain("   add tests")
        expect(taken(commands)).toEqual([])
        await press(rendered, "enter")
        const send = sentOf(taken(commands))
        expect(send.ticket).toBe("t-1")
        expect(send.text).toBe("Please also\nadd tests")
        expect(send.uuid).toMatch(/^[0-9a-f-]{36}$/)
        // The field is empty again and keeps the focus; an idle worker queues nothing.
        frame = await rendered.capture()
        expect(frame.chars).toContain(composerPlaceholder(true))
        expect(frame.chars).not.toContain("queued")
        // Enter on an empty field, or one of spaces, sends nothing.
        await press(rendered, "enter", "   ", "enter")
        expect(taken(commands)).toEqual([])
      },
      { state: idle },
    )
  })

  test("a click on it focuses it", async () => {
    await scene(async ({ rendered }) => {
      const frame = await until(rendered, has("Working on it."))
      const row = linesOf(frame).findIndex((line) => line.includes(composerPlaceholder(false)))
      await rendered.input((setup) => setup.mockMouse.click(10, row))
      expect(rendered.setup.renderer.currentFocusedRenderable).toBeInstanceOf(TextareaRenderable)
    })
  })

  test("Esc leaves the composer, then the view", async () => {
    await scene(async ({ rendered, commands }) => {
      await until(rendered, has("Working on it."))
      await press(rendered, "i", "draft", "escape")
      expect(await composerFocused(rendered, false)).toBe(false)
      expect(taken(commands)).toEqual([])
      // What you typed stays for when you come back to it.
      expect((await rendered.capture()).chars).toContain(" > draft")
      await press(rendered, "escape")
      const sent = await takenOnce(commands, (all) => all.length > 0)
      expect(sent.map((command) => command._tag)).toEqual(["CloseWorker"])
    })
  })
})

describe("the keys a focused field takes", () => {
  test("printable keys, Enter, Tab and the arrows; not Esc, PgUp/PgDn, Ctrl+X or Ctrl+R", () => {
    for (const key of ["i", "?", "shift+d", "return", "enter", "tab", "shift+tab", "up", "left"]) {
      expect(fieldTakes(key)).toBe(true)
    }
    for (const key of ["escape", "pageup", "pagedown", "ctrl+x", "ctrl+r", "ctrl+c"]) {
      expect(fieldTakes(key)).toBe(false)
    }
  })
})

describe("queued messages", () => {
  test("a message sent while a turn is under way is queued until the CLI starts it", async () => {
    await scene(async ({ rendered, commands, append }) => {
      await until(rendered, has("Working on it."))
      await press(rendered, "i", "Use the new API", "alt+enter", "please", "enter")
      const { uuid } = sentOf(taken(commands))
      let frame = await rendered.capture()
      expect(footOf(frame, 4)).toMatchInlineSnapshot(`
        "
        ────────────────────────────────────────────────────────────────────────────────
          › Use the new API …                                                     queued
         > your message to the worker
          Enter send · Alt+Enter/Ctrl+J new line · Esc leave · Ctrl+X interrupt
        "
      `)
      // Its `queued` lifecycle and other messages keep it queued; `started` takes it.
      await rendered.input(() => append([lifecycle(uuid, "queued"), said("Still going.")]))
      expect((await rendered.capture()).chars).toContain("queued")
      await rendered.input(() => append([lifecycle(uuid, "started")]))
      frame = await rendered.capture()
      expect(frame.chars).not.toContain("queued")
    })
  })

  test("a result listing it, or its cancellation, takes the mark away too", async () => {
    await scene(async ({ rendered, commands, append }) => {
      await until(rendered, has("Working on it."))
      await press(rendered, "i", "first", "enter", "second", "enter")
      const [first, second] = taken(commands).map((command) =>
        command._tag === "SendMessage" ? command.uuid : "",
      )
      let frame = await rendered.capture()
      expect(frame.chars).toContain("› first")
      expect(frame.chars).toContain("› second")
      await rendered.input(() => append([resultListing([first ?? ""])]))
      frame = await rendered.capture()
      expect(frame.chars).not.toContain("› first")
      expect(frame.chars).toContain("› second")
      await rendered.input(() => append([lifecycle(second ?? "", "cancelled")]))
      expect((await rendered.capture()).chars).not.toContain("queued")
    })
  })

  test("the marks go once the worker settles", async () => {
    await scene(async ({ rendered, view }) => {
      await until(rendered, has("Working on it."))
      await press(rendered, "i", "one more thing", "enter")
      expect((await rendered.capture()).chars).toContain("queued")
      await rendered.input(() => view.set(viewOf(idle)))
      expect((await rendered.capture()).chars).not.toContain("queued")
      // Working again, the message the worker took isn't queued again.
      await rendered.input(() => view.set(viewOf(working)))
      expect((await rendered.capture()).chars).not.toContain("queued")
    })
  })

  test("only the first three are shown, the rest counted", async () => {
    await scene(async ({ rendered }) => {
      await until(rendered, has("Working on it."))
      await press(
        rendered,
        "i",
        "a",
        "enter",
        "b",
        "enter",
        "c",
        "enter",
        "d",
        "enter",
        "e",
        "enter",
      )
      const frame = await rendered.capture()
      expect(frame.chars).toContain("› c")
      expect(frame.chars).not.toContain("› d")
      expect(frame.chars).toContain("+2 more queued")
    })
  })
})

describe("interrupting", () => {
  test("Ctrl+X asks first; n or Esc leave the turn be", async () => {
    await scene(async ({ rendered, commands }) => {
      await until(rendered, has("Working on it."))
      await press(rendered, { ctrl: "x" })
      const frame = await rendered.capture()
      const words = interruptWords("t-1")
      expect(frame.chars).toContain(words.ask)
      expect(frame.chars).toContain("y interrupt · n keep going")
      expect(colourOf(frame, words.ask)).toEqual(theme.rgba("notice").toInts().slice(0, 3))
      await press(rendered, "n")
      expect((await rendered.capture()).chars).not.toContain(words.ask)
      await press(rendered, { ctrl: "x" }, "escape")
      // A held Esc can be pressed after the input that sent it, on a loaded machine.
      const closed = await until(rendered, (frame) => !frame.chars.includes(words.ask))
      expect(closed.chars).not.toContain(words.ask)
      expect(taken(commands)).toEqual([])
    })
  })

  test("y sends Interrupt, and the messages queued lose their marks", async () => {
    await scene(async ({ rendered, commands }) => {
      await until(rendered, has("Working on it."))
      await press(rendered, "i", "stop that", "enter")
      expect((await rendered.capture()).chars).toContain("queued")
      taken(commands)
      // From the composer: the question takes y, not the field.
      await press(rendered, { ctrl: "x" }, "y")
      // Back in the composer once the question is gone, and the field took no `y`.
      expect(rendered.setup.renderer.currentFocusedRenderable).toBeInstanceOf(TextareaRenderable)
      expect(taken(commands)).toEqual([{ _tag: "Interrupt", ticket: "t-1" }] as Array<UiCommand>)
      const frame = await rendered.capture()
      expect(frame.chars).not.toContain("queued")
      expect(frame.chars).not.toContain(interruptWords("t-1").ask)
      expect(
        (rendered.setup.renderer.currentFocusedRenderable as TextareaRenderable).plainText,
      ).toBe("")
    })
  })
})

describe("releasing", () => {
  test("a steered worker: steered beside its status, the steered line, and Ctrl+R", async () => {
    await scene(
      async ({ rendered, commands }) => {
        const frame = await until(rendered, has("Working on it."))
        expect(linesOf(frame)[0]).toContain("working  steered")
        expect(footOf(frame, 5)).toMatchInlineSnapshot(`
          "
          ────────────────────────────────────────────────────────────────────────────────
            steered: tutti sends it nothing until you release it       [ Release ]  Ctrl+R
           > i to write to the worker
            Esc dashboard · i write · Ctrl+X interrupt · Ctrl+R release · ↑↓ select
            Enter expand · ? keys · PgUp/PgDn scroll · g/G top/end
          "
        `)
        expect(colourOf(frame, "steered")).toEqual(rgb(theme.styles.key))
        await press(rendered, { ctrl: "r" })
        expect(taken(commands)).toEqual([{ _tag: "Release", ticket: "t-1" }] as Array<UiCommand>)
      },
      { steered: true },
    )
  })

  test("a click on Release sends it too", async () => {
    await scene(
      async ({ rendered, commands }) => {
        const frame = await until(rendered, has("[ Release ]"))
        const lines = linesOf(frame)
        const row = lines.findIndex((line) => line.includes("[ Release ]"))
        const column = lines[row]?.indexOf("[ Release ]") ?? 0
        await rendered.input((setup) => setup.mockMouse.click(column + 3, row))
        expect(taken(commands)).toEqual([{ _tag: "Release", ticket: "t-1" }] as Array<UiCommand>)
      },
      { steered: true },
    )
  })

  test("a worker not steered has no steered line, and Ctrl+R does nothing", async () => {
    await scene(async ({ rendered, commands }) => {
      const frame = await until(rendered, has("Working on it."))
      expect(frame.chars).not.toContain("steered")
      expect(frame.chars).not.toContain("Release")
      await press(rendered, { ctrl: "r" })
      expect(taken(commands)).toEqual([])
    })
  })
})

describe("what the transcript says was taken", () => {
  const item = (message: unknown): Item => ({
    v: transcriptVersion,
    seq: 1,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message: message as SDKMessage,
  })

  test("started, completed and cancelled sends, and those a result lists", () => {
    const items = [
      lifecycle("a", "queued"),
      lifecycle("b", "started"),
      lifecycle("c", "completed"),
      lifecycle("d", "cancelled"),
      resultListing(["e", "f"]),
    ].map(item)
    expect([...takenIn(items)].sort()).toEqual(["b", "c", "d", "e", "f"])
  })

  test("any message, however it is shaped, is read without throwing", () => {
    fc.assert(
      fc.property(fc.array(fc.anything()), (messages) => {
        for (const uuid of takenIn(messages.map(item))) expect(typeof uuid).toBe("string")
      }),
    )
  })
})

describe("the message's uuid", () => {
  test("a message is sent with the uuid the composer drew", async () => {
    const uuid = "7f3c1e2a-0000-4000-8000-000000000042"
    const sent = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", { sessionId: "s-1", cwd: "/work/t-1" })
        const returned = yield* host.send("t-1", "Please also add tests", "human", uuid)
        return { returned, messages: yield* (yield* Recording).messages("t-1") }
      }).pipe(
        Effect.provide(
          hostLayer({ "t-1": [turn([])] }, { checks: [] }).pipe(
            Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
            Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )
    expect(sent.returned).toBe(uuid)
    expect(sent.messages.map((message) => message.uuid)).toEqual([uuid])
    expect(sent.messages[0]?.origin).toEqual({ kind: "human" })
  })
})
