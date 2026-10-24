// The mouse under an open box (§ 7.3, tutti-por): a click beside the box doesn't reach the view
// under it, and a view that leaves with its own box open (the worker view's interrupt question)
// closes it, so that the dashboard after it takes its keys.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { interruptWords } from "../src/ui/Composer.tsx"
import { stopWords } from "../src/ui/StopQuestion.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  followed,
  type OpenTranscript,
  scrolledBack,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const ledgerEntry = (ticket: string, worker: number): LedgerEntry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: TicketPhase.Working(),
  since: began,
  worker,
  row: worker - 1,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** Two workers, on t-1 and t-2. */
const view: RunView = project({
  ledger: {
    tickets: new Map([
      ["t-1", ledgerEntry("t-1", 1)],
      ["t-2", ledgerEntry("t-2", 2)],
    ]),
    rows: 2,
    windDown: null,
    bugs: [],
  },
  workers: new Map([
    ["t-1", WS.Idle({ at: began })],
    ["t-2", WS.Idle({ at: began })],
  ]),
  requests: [],
  status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 2 },
  actions: new Map(),
})

/** Empty transcripts. */
const feed: TranscriptFeed = {
  open: (): OpenTranscript => {
    const state = external<TranscriptState>({ ...emptyTranscript, window: windowOf([]) })
    return {
      state,
      older: () => {},
      scrolledBack: () => state.set({ ...state.get(), window: scrolledBack(state.get().window) }),
      follow: () => state.set({ ...state.get(), window: followed(state.get().window) }),
      close: () => {},
    }
  },
}

const linesOf = (frame: Frame): ReadonlyArray<string> => frame.chars.split("\n")

const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** The commands sent since the last call. */
const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

type Key = string | { readonly ctrl: string }

const press = (rendered: Rendered, ...keys: ReadonlyArray<Key>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (typeof key !== "string") setup.mockInput.pressKey(key.ctrl, { ctrl: true })
      else if (key === "escape") await pressEscape(setup)
      else await setup.mockInput.typeText(key)
    }
  })

const click = (rendered: Rendered, x: number, y: number) =>
  rendered.input((setup) => setup.mockMouse.click(x, y))

/** Renders the shell on `first` and runs `body`. */
const scene = (
  first: Screen,
  body: (at: {
    readonly screen: Settable<Screen>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const screen = external<Screen>(first)
  const commands = Effect.runSync(makeCommands)
  return withRender(
    <Root
      value={{
        view: external(view),
        screen,
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
        transcripts: feed,
      }}
    />,
    { width: 80, height: 30 },
    (rendered) => body({ screen, commands, rendered }),
  )
}

const asked = interruptWords("t-1").ask

describe("a click under an open box", () => {
  test("doesn't reach the worker view under the interrupt question", async () => {
    await scene(Screen.Worker({ ticket: "t-1" }), async ({ commands, rendered }) => {
      await until(rendered, has("← Dashboard"))
      await press(rendered, { ctrl: "x" })
      expect((await until(rendered, has(asked))).chars).toContain(asked)
      // ← Dashboard, then a line of the transcript: the backdrop takes both.
      await click(rendered, 3, 0)
      await click(rendered, 10, 5)
      expect(taken(commands)).toEqual([])
      expect((await rendered.capture()).chars).toContain(asked)
      // Closed, the view takes the click again.
      await press(rendered, "escape")
      expect((await rendered.capture()).chars).not.toContain(asked)
      await click(rendered, 3, 0)
      expect(taken(commands)).toEqual([UiCommand.CloseWorker()])
    })
  })

  test("doesn't open a worker from the dashboard under the quit box", async () => {
    await scene(Screen.Dashboard(), async ({ commands, rendered }) => {
      const frame = await until(rendered, has("Title of t-2"))
      const y = linesOf(frame).findIndex((line) => line.includes("Title of t-2"))
      const x = linesOf(frame)[y]?.indexOf("Title of t-2") ?? 0
      await press(rendered, { ctrl: "c" })
      await click(rendered, x, y)
      expect(taken(commands).filter((each) => each._tag === "OpenWorker")).toEqual([])
      // Closed, the same click opens it.
      await press(rendered, "escape")
      await click(rendered, x, y)
      expect(taken(commands).filter((each) => each._tag === "OpenWorker")).not.toEqual([])
    })
  })
})

describe("a view's own box", () => {
  test("the interrupt question closes as the worker view goes, and the dashboard takes its keys", async () => {
    await scene(Screen.Worker({ ticket: "t-1" }), async ({ screen, commands, rendered }) => {
      await until(rendered, has("← Dashboard"))
      await press(rendered, { ctrl: "x" })
      await until(rendered, has(asked))
      await click(rendered, 3, 0)
      // The run goes back to the dashboard all the same, as it does on CloseWorker.
      await rendered.input(() => screen.set(Screen.Dashboard()))
      const frame = await until(rendered, has("Title of t-2"))
      expect(frame.chars).not.toContain(asked)
      taken(commands)
      await press(rendered, "s")
      const stop = stopWords(false, []).ask
      expect((await until(rendered, has(stop))).chars).toContain(stop)
    })
  })
})
