// `h` and the worker view's button for a ticket left Blocked on its merge conflict (§ 4.3): in Needs
// you beside the tickets table, in its worker view, opened though its session has closed.

import { describe, expect, test } from "bun:test"
import { Effect, Queue, Result } from "effect"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type Commands, makeCommands, resolve, UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, isConflict, Need, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { dashboardCommands } from "../src/ui/Dashboard.tsx"
import { commandFor, hintOf } from "../src/ui/keyCommands.ts"
import { needsLines } from "../src/ui/SidePanel.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  followed,
  type OpenTranscript,
  scrolledBack,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external } from "../src/ui/useRunView.ts"
import { workerViewCommands } from "../src/ui/WorkerView.tsx"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })
const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const t1 = "t-1" as TicketId

const entry = (why: string): LedgerEntry => ({
  ticket: t1,
  title: "Title of t-1",
  phase: TicketPhase.Blocked({ why }),
  since: began,
  worker: null,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const viewOf = (why: string): RunView =>
  project({
    ledger: { tickets: new Map([[t1, entry(why)]]), rows: 1, windDown: null, bugs: [] },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

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

const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const scene = (
  first: Screen,
  why: string,
  size: { readonly width: number; readonly height: number },
  body: (at: { readonly commands: Commands; readonly rendered: Rendered }) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  return withRender(
    <Root
      value={{
        view: external(viewOf(why)),
        screen: external<Screen>(first),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
        transcripts: feed,
      }}
    />,
    size,
    (rendered) => body({ commands, rendered }),
  )
}

const wide = { width: 160, height: 40 }
const blockedFields = {
  ticket: t1,
  label: "t-1",
  title: "T",
  base: "main",
  about: null,
  handBack: false,
  run: "on" as const,
  mergesOver: false,
}
const button = "[ Hand it back once more ]"

describe("the worker view of a ticket left Blocked on its merge conflict", () => {
  const view = Screen.Worker({ ticket: t1 })

  test("opens though its session has closed; one with no ticket stays stale", () => {
    const current = { ledger: viewless(), requests: [] }
    expect(Result.isSuccess(resolve(UiCommand.OpenWorker({ ticket: t1 }), current))).toBe(true)
    const none = resolve(UiCommand.OpenWorker({ ticket: "no" as TicketId }), current)
    expect(Result.isFailure(none)).toBe(true)
  })

  test("has the notice, whose button hands it back", async () => {
    await scene(
      view,
      "MERGE_CONFLICT",
      { width: 100, height: 34 },
      async ({ commands, rendered }) => {
        const frame = await until(rendered, (now) => now.chars.includes(button))
        expect(frame.chars).toContain("Its merge conflict is set aside")
        expect(frame.chars).toContain("t-1")
        const lines = frame.chars.split("\n")
        const y = lines.findIndex((line) => line.includes(button))
        const x = (lines[y] ?? "").indexOf(button)
        await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
        expect(taken(commands)).toEqual([UiCommand.HandBackNow({ ticket: t1 })])
      },
    )
  })

  test("Tab reaches the button, its words kept as it is selected, and Enter presses it", async () => {
    await scene(
      view,
      "MERGE_CONFLICT",
      { width: 100, height: 34 },
      async ({ commands, rendered }) => {
        await until(rendered, (now) => now.chars.includes(button))
        await rendered.input((setup) => setup.mockInput.pressTab())
        expect((await rendered.capture()).chars).toContain(button)
        expect((await rendered.capture()).chars).not.toContain("[ Hand it the conflict now ]")
        await rendered.input((setup) => setup.mockInput.pressEnter())
        expect(taken(commands)).toEqual([UiCommand.HandBackNow({ ticket: t1 })])
      },
    )
  })

  test("`h` hands it back", async () => {
    await scene(
      view,
      "MERGE_CONFLICT",
      { width: 100, height: 34 },
      async ({ commands, rendered }) => {
        await until(rendered, (now) => now.chars.includes(button))
        await rendered.input((setup) => setup.mockInput.typeText("h"))
        expect(taken(commands)).toEqual([UiCommand.HandBackNow({ ticket: t1 })])
      },
    )
  })

  test("a hand-back waiting for its steered worker keeps its own words and button", async () => {
    const commands = Effect.runSync(makeCommands)
    const waiting = project({
      ledger: {
        tickets: new Map([
          [t1, { ...entry("MERGE_CONFLICT"), worker: 1, handBack: true, steered: true }],
        ]),
        rows: 1,
        windDown: null,
        bugs: [],
      },
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
      actions: new Map(),
    })
    await withRender(
      <Root
        value={{
          view: external(waiting),
          screen: external<Screen>(view),
          commands,
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => began + 67_000,
          transcripts: feed,
          handBacks: external<ReadonlyArray<string>>([t1]),
        }}
      />,
      { width: 100, height: 34 },
      async (rendered) => {
        const frame = await until(rendered, (now) => now.chars.includes("[ Hand it"))
        expect(frame.chars).toContain("[ Hand it the conflict now ]")
        expect(frame.chars).toContain("A merge conflict waits for this worker")
        expect(frame.chars).not.toContain(button)
        await rendered.input((setup) => setup.mockInput.typeText("h"))
        expect(taken(commands)).toEqual([UiCommand.HandBackNow({ ticket: t1 })])
      },
    )
  })

  test("blocked on anything else, has no notice", async () => {
    await scene(view, "DIRTY_TREE", { width: 100, height: 34 }, async ({ commands, rendered }) => {
      const frame = await until(rendered, (now) => now.chars.includes("← Dashboard"))
      expect(frame.chars).not.toContain(button)
      await rendered.input((setup) => setup.mockInput.typeText("h"))
      expect(taken(commands)).toEqual([])
    })
  })

  test("names `h` only while the conflict is yours and you aren't writing", () => {
    const at = { requests: false, composing: false, steered: false, finished: true }
    const names = (more: { readonly composing?: boolean; readonly conflict?: boolean }) =>
      hintOf(workerViewCommands({ ...at, ...more })).map((key) => key.keys)
    expect(names({ conflict: true })).toContain("h")
    expect(names({ conflict: false })).not.toContain("h")
    expect(names({ conflict: true, composing: true })).not.toContain("h")
  })
})

describe("Needs you beside the tickets table", () => {
  test("Tab to the panel, then `h`, hands it back", async () => {
    await scene(Screen.Dashboard(), "MERGE_CONFLICT", wide, async ({ commands, rendered }) => {
      await until(rendered, (now) => now.chars.includes("Needs you"))
      await rendered.input((setup) => setup.mockInput.pressTab())
      const frame = await until(rendered, (now) => now.chars.includes("h hands it back"))
      expect(frame.chars).toContain("h hands it back")
      await Bun.sleep(settle + 50)
      await rendered.input((setup) => setup.mockInput.typeText("h"))
      expect(taken(commands)).toEqual([UiCommand.HandBackNow({ ticket: t1 })])
    })
  })

  test("`h` is there only on a conflict", () => {
    const view = viewOf("MERGE_CONFLICT")
    const at = (conflict: boolean) => ({
      buttons: true,
      highlighted: () => undefined,
      panel: { conflict: () => conflict },
    })
    expect(commandFor(dashboardCommands(view, at(true)), "h")).toBeDefined()
    expect(commandFor(dashboardCommands(view, at(false)), "h")).toBeUndefined()
  })

  test("the panel names `h` for a conflict alone", () => {
    const theme = themeOf("dark")
    const drawn = (why: string) =>
      needsLines(
        Need.Blocked({ ...blockedFields, title: "Title", why }),
        1,
        { focused: true, inside: true, choice: 0 },
        theme,
        60,
        12,
      )
        .flatMap((line) => line.map((each) => each.text))
        .join("")
    expect(drawn("MERGE_CONFLICT")).toContain("h hands it back")
    expect(drawn("DIRTY_TREE")).not.toContain("h hands it back")
  })

  test("a conflict is a Blocked need on MERGE_CONFLICT", () => {
    const need = (why: string) => Need.Blocked({ ...blockedFields, why })
    expect(isConflict(need("MERGE_CONFLICT"))).toBe(true)
    expect(isConflict(need("DIRTY_TREE"))).toBe(false)
    expect(isConflict(undefined)).toBe(false)
  })
})

describe("the box Needs you's list opens, on a pane with no panel", () => {
  const narrow = { width: 100, height: 34 }
  const open = async (rendered: Rendered, line: string) => {
    await until(rendered, (now) => now.chars.includes("Needs you"))
    await rendered.input((setup) => {
      setup.mockInput.pressTab()
      setup.mockInput.pressEnter()
    })
    await until(rendered, (now) => now.chars.includes(line))
    await rendered.input((setup) => setup.mockInput.pressEnter())
    return until(rendered, (now) => now.chars.includes("open its worker view"))
  }

  test("`h` hands back a ticket blocked on its merge conflict", async () => {
    await scene(Screen.Dashboard(), "MERGE_CONFLICT", narrow, async ({ commands, rendered }) => {
      const frame = await open(rendered, "■ t-1 blocked: MERGE_CONFLICT")
      expect(frame.chars).toContain("h hand it back")
      taken(commands)
      await rendered.input((setup) => setup.mockInput.typeText("h"))
      expect(taken(commands)).toEqual([UiCommand.HandBackNow({ ticket: t1 })])
      // The box closes, back at the list, the ticket leaving Blocked.
      const list = await until(rendered, (now) => !now.chars.includes("open its worker view"))
      expect(list.chars).not.toContain("open its worker view")
    })
  })

  test("blocked on anything else, it has no `h`", async () => {
    await scene(Screen.Dashboard(), "DIRTY_TREE", narrow, async ({ commands, rendered }) => {
      const frame = await open(rendered, "■ t-1 blocked: DIRTY_TREE")
      expect(frame.chars).not.toContain("hand it back")
      taken(commands)
      await rendered.input((setup) => setup.mockInput.typeText("h"))
      expect(taken(commands)).toEqual([])
    })
  })
})

function viewless() {
  return { tickets: new Map([[t1, entry("MERGE_CONFLICT")]]), rows: 1, windDown: null, bugs: [] }
}
