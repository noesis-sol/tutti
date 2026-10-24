// The dashboard answers only a request drawn with its buttons (§ 4.5 "Answering the request you
// read"; tutti-d0d): below the minimum size, in the compact layout and behind the end-of-run box,
// `d`, `Shift+D`, `a` and `r` open the Answer box instead of answering a request never seen, the
// 500 ms guard starts only once the card's buttons are drawn, and the hint offers neither `d` nor
// `a`.
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
import { dashboardHint } from "../src/ui/Dashboard.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, type Size, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const entryOf = (ticket: string, worker: number, row: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: TicketPhase.Working({ activity: "working" }),
  since: began,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView for workers 1 to `workers` on t-1, t-2, …, with `requests` open, the end-of-run box or not. */
const viewOf = (
  requests: ReadonlyArray<AttentionRequest>,
  workers: number,
  endOfRun: ReadonlyArray<string> | null = null,
): RunView =>
  project({
    ledger: {
      tickets: new Map(
        Array.from({ length: workers }, (_, i) => [`t-${i + 1}`, entryOf(`t-${i + 1}`, i + 1, i)]),
      ),
      rows: workers,
      windDown: null,
      bugs: [],
    },
    workers: new Map(
      Array.from({ length: workers }, (_, i) => [`t-${i + 1}`, WS.Idle({ at: began })]),
    ),
    requests,
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch",
      began,
      concurrency: workers,
      endOfRun,
    },
    actions: new Map(),
  })

/** A Bash call on `ticket`'s worker, waiting for you. */
const permission = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }],
        destination: "localSettings",
      },
    ],
    summary: "rm -rf build",
  },
  displayName: "Bash",
  description: "Remove the build cache",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

const shows = (frame: Frame, text: string): boolean =>
  linesOf(frame).some((line) => line.includes(text))

/** The hint: the last line that isn't blank. */
const hintOf = (frame: Frame): string =>
  linesOf(frame)
    .findLast((line) => line.trim() !== "")
    ?.trim() ?? ""

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const answerOf = (requestId: string, answer: Answer) => UiCommand.Answer({ requestId, answer })

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) await setup.mockInput.typeText(key)
  })

/** Renders the dashboard over `view` at `size`, its clock at `began`, and runs `body`. */
const scene = async (
  start: RunView,
  size: Size,
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly pass: (millis: number) => void
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(start)
  const commands = Effect.runSync(makeCommands)
  let at = began
  const value = {
    view,
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => at,
  }
  await withRender(<Root value={value} />, size, (rendered) =>
    body({ view, commands, pass: (millis) => (at += millis), rendered }),
  )
}

/** The three places a request's buttons aren't drawn, each with its pane and its RunView. */
const undrawn: ReadonlyArray<{
  readonly where: string
  readonly size: Size
  readonly view: RunView
}> = [
  {
    where: "below 60×16",
    size: { width: 58, height: 15 },
    view: viewOf([permission("r1", "t-1")], 1),
  },
  {
    where: "in the compact layout",
    size: { width: 80, height: 24 },
    view: viewOf([permission("r1", "t-3")], 4),
  },
  {
    where: "behind the end-of-run box",
    size: { width: 80, height: 30 },
    view: viewOf([permission("r1", "t-1")], 2, ["t-1"]),
  },
]

describe("a request whose buttons aren't drawn", () => {
  for (const { where, size, view } of undrawn) {
    test(`${where}: the hint offers no d or a, and a opens the Answer box, then answers in it`, async () => {
      await scene(view, size, async ({ commands, pass, rendered }) => {
        const frame = await rendered.capture()
        expect(shows(frame, "[ Deny ]")).toBe(false)
        expect(hintOf(frame)).toContain("Enter open")
        expect(hintOf(frame)).not.toContain("a allow")
        expect(hintOf(frame)).not.toContain("d deny")
        // Long past the guard, a allows nothing: it opens the Answer box on the request.
        pass(10 * settle)
        await press(rendered, "a")
        expect(taken(commands)).toEqual([])
        expect(shows(await rendered.capture(), "[ Deny ]")).toBe(true)
        // The box guards the request it has just drawn, then answers it.
        await press(rendered, "a")
        expect(taken(commands)).toEqual([])
        pass(settle)
        await press(rendered, "a")
        expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Allow" })])
      })
    })
  }

  test("d, r and Shift+D open the Answer box too, and answer nothing", async () => {
    const compact = undrawn[1]
    if (compact === undefined) throw new Error("no compact scene")
    for (const key of ["d", "r", "D"]) {
      await scene(compact.view, compact.size, async ({ commands, pass, rendered }) => {
        pass(10 * settle)
        await press(rendered, key)
        expect(taken(commands)).toEqual([])
        const frame = await rendered.capture()
        expect(shows(frame, "[ Deny ]")).toBe(true)
        expect(shows(frame, "saying why")).toBe(false)
      })
    }
  })

  test("the guard starts once the card's buttons are drawn, not while it was a compact line", async () => {
    await scene(viewOf([permission("r1", "t-1")], 2), { width: 80, height: 14 }, async (at) => {
      const { commands, pass, rendered } = at
      expect(shows(await rendered.capture(), "[ Deny ]")).toBe(false)
      pass(10 * settle)
      await rendered.input((setup) => setup.resize(80, 40))
      const frame = await rendered.capture()
      expect(shows(frame, "[ Deny ]")).toBe(true)
      expect(hintOf(frame)).toContain("a allow")
      await press(rendered, "a")
      expect(taken(commands)).toEqual([])
      expect(shows(await rendered.capture(), "saying why")).toBe(false)
      pass(settle)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Allow" })])
    })
  })
})

describe("the dashboard's hint", () => {
  const words = (view: RunView, buttons: boolean, highlighted?: string | null) =>
    dashboardHint(view, buttons, highlighted).map((key) => key.keys)

  test("names d and a with the buttons drawn, and neither without", () => {
    const view = viewOf([permission("r1", "t-1")], 2)
    expect(words(view, true)).toEqual(["Tab", "Enter", "d", "a", "s", "?"])
    expect(words(view, false)).toEqual(["Tab", "Enter", "s", "?"])
  })

  test("names a only where it allows the highlighted card's request", () => {
    const view = viewOf([{ ...permission("r1", "t-1"), defaultToNo: true }], 2)
    expect(words(view, true)).toEqual(["Tab", "Enter", "d", "s", "?"])
  })

  test("names neither on a card with no request highlighted, where they answer nothing", () => {
    const view = viewOf([permission("r1", "t-1")], 2)
    expect(words(view, true, "t-2")).toEqual(["Tab", "Enter", "s", "?"])
  })
})
