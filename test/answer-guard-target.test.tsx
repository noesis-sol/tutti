// The 500 ms answer guard starts again when the target request changes (§ 4.5 "Answering the
// request you read"; tutti-14o5): once the target is answered and the highlight, or the worker
// view's panel, moves on to a request that has been on screen a while, a key meant for the one
// before (a second press, a key held down) answers nothing until the new target has settled.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import type { Answer, AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { emptyTranscript, type TranscriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const entryOf = (ticket: string, worker: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: TicketPhase.Working({ activity: "working" }),
  since: began,
  worker,
  row: worker - 1,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView for workers 1 and 2 on t-1 and t-2, with `requests` open. */
const viewOf = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  project({
    ledger: {
      tickets: new Map([
        ["t-1", entryOf("t-1", 1)],
        ["t-2", entryOf("t-2", 2)],
      ]),
      rows: 2,
      windDown: null,
      bugs: [],
    },
    workers: new Map([
      ["t-1", WS.Idle({ at: began })],
      ["t-2", WS.Idle({ at: began })],
    ]),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 2 },
    actions: new Map(),
  })

/** A Bash call running `command` on `ticket`'s worker, waiting for you. */
const permission = (id: string, ticket: string, command: string): AttentionRequest => ({
  id,
  ticket,
  kind: { _tag: "Permission", tool: "Bash", input: { command }, suggestions: [], summary: command },
  displayName: "Bash",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const r1 = permission("r1", "t-1", "ls build")
const r2 = permission("r2", "t-2", "rm -rf ~/proj")

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const allowed = (requestId: string) =>
  UiCommand.Answer({ requestId, answer: { _tag: "Allow" } satisfies Answer })

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key === "down") setup.mockInput.pressArrow("down")
      else await setup.mockInput.typeText(key)
    }
  })

/** No transcript: the worker view's panel is what these tests answer in. */
const feed: TranscriptFeed = {
  open: () => ({
    state: external(emptyTranscript),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
}

/** Renders `screen` over `requests`, its clock at `began`, and runs `body`. */
const scene = async (
  screen: Screen,
  requests: ReadonlyArray<AttentionRequest>,
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly pass: (millis: number) => void
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(viewOf(requests))
  const commands = Effect.runSync(makeCommands)
  let at = began
  const value = {
    view,
    screen: external<Screen>(screen),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => at,
    transcripts: feed,
  }
  await withRender(<Root value={value} />, { width: 100, height: 40 }, (rendered) =>
    body({ view, commands, pass: (millis) => (at += millis), rendered }),
  )
}

describe("the dashboard", () => {
  test("a key within 500 ms of the highlight moving on to the next request answers nothing", async () => {
    await scene(Screen.Dashboard(), [r1, r2], async ({ view, commands, pass, rendered }) => {
      expect((await rendered.capture()).chars).toContain("rm -rf ~/proj")
      pass(settle)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([allowed("r1")])
      // The run closes r1: t-2's request, on screen all along, is the target now.
      await rendered.input(() => view.set(viewOf([r2])))
      pass(80)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([])
      // A held key repeats: still within the guard, nothing more.
      pass(settle - 81)
      await press(rendered, "a", "a", "a")
      expect(taken(commands)).toEqual([])
      pass(1)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([allowed("r2")])
    })
  })

  test("moving the highlight to another card starts its guard again", async () => {
    await scene(Screen.Dashboard(), [r1, r2], async ({ commands, pass, rendered }) => {
      pass(10 * settle)
      await press(rendered, "down")
      await press(rendered, "a")
      expect(taken(commands)).toEqual([])
      pass(settle)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([allowed("r2")])
    })
  })
})

describe("the worker view's panel", () => {
  test("a key within 500 ms of the panel moving on to its next request answers nothing", async () => {
    const second = { ...r2, ticket: "t-1" }
    await scene(
      Screen.Worker({ ticket: "t-1" }),
      [r1, second],
      async ({ view, commands, pass, rendered }) => {
        expect((await rendered.capture()).chars).toContain("rm -rf ~/proj")
        pass(settle)
        await press(rendered, "a")
        expect(taken(commands)).toEqual([allowed("r1")])
        await rendered.input(() => view.set(viewOf([second])))
        pass(80)
        await press(rendered, "a", "a")
        expect(taken(commands)).toEqual([])
        pass(settle)
        await press(rendered, "a")
        expect(taken(commands)).toEqual([allowed("r2")])
      },
    )
  })
})

describe("a move and a key that arrive together", () => {
  test("on the dashboard, ↓ and a in one read answer nothing", async () => {
    await scene(Screen.Dashboard(), [r1, r2], async ({ commands, pass, rendered }) => {
      pass(10 * settle)
      await press(rendered, "down", "a")
      expect(taken(commands)).toEqual([])
      pass(settle)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([allowed("r2")])
    })
  })

  test("in the worker view's panel, ↓ and a in one read answer nothing", async () => {
    const second = { ...r2, ticket: "t-1" }
    await scene(Screen.Worker({ ticket: "t-1" }), [r1, second], async (at) => {
      const { commands, pass, rendered } = at
      pass(10 * settle)
      await press(rendered, "down", "a")
      expect(taken(commands)).toEqual([])
      pass(settle)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([allowed("r2")])
    })
  })
})
