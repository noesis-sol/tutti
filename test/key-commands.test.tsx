// Key commands as data (§ 7.3, tutti-rvzn.8): a screen's hint, its key help and its bindings come
// from one list of commands, so that every key a screen binds has a row in its key help, and the
// hint names only keys the screen has.
import { describe, expect, test } from "bun:test"
import { Effect, Option, Queue } from "effect"
import fc from "fast-check"
import { makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyView, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { dashboardCommands } from "../src/ui/Dashboard.tsx"
import { interviewCommands } from "../src/ui/InterviewView.tsx"
import {
  type Command,
  commandFor,
  globalCommands,
  globalHelp,
  helpOf,
  hintOf,
  keysOf,
} from "../src/ui/keyCommands.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { workerViewCommands } from "../src/ui/WorkerView.tsx"
import { withRender } from "./render.ts"

const ran: Array<string> = []
const command = (name: string, over: Partial<Command> = {}): Command => ({
  keys: [name],
  run: () => ran.push(name),
  ...over,
})

describe("a list of commands", () => {
  test("runs, for a key, the first command with it that is there now", () => {
    const off = command("off", { keys: ["x"], when: () => false })
    const on = command("on", { keys: ["x", "y"] })
    const later = command("later", { keys: ["x"] })
    expect(commandFor([off, on, later], "x")).toBe(on)
    expect(commandFor([off, on, later], "y")).toBe(on)
    expect(commandFor([off], "x")).toBeUndefined()
    expect(commandFor([on], "z")).toBeUndefined()
  })

  test("binds each key once, in the list's order", () => {
    const commands = [command("a", { keys: ["x", "y"] }), command("b", { keys: ["y", "z"] })]
    expect(keysOf(commands)).toEqual(["x", "y", "z"])
  })

  test("names in the hint the commands there now that it names, in order", () => {
    const commands = [
      command("a", { hint: { keys: "A", does: "first" } }),
      command("b", { hint: { keys: "B", does: "off" }, when: () => false }),
      command("c"),
      command("d", { keys: [], hint: { keys: "D", does: "a field's" } }),
    ]
    expect(hintOf(commands)).toEqual([
      { keys: "A", does: "first" },
      { keys: "D", does: "a field's" },
    ])
  })

  test("gives the key help every command's row, there now or not, each once", () => {
    const row = ["x, y", "move"] as const
    const commands = [
      command("x", { help: row }),
      command("off", { help: ["o", "off"], when: () => false }),
      command("y", { help: row }),
      command("none"),
    ]
    expect(helpOf(commands)).toEqual([row, ["o", "off"]])
  })
})

/** The commands a screen binds that have no row in its key help. */
const unlisted = (commands: ReadonlyArray<Command>): ReadonlyArray<string> =>
  commands.filter((each) => each.keys.length > 0 && each.help === undefined).flatMap((c) => c.keys)

const card = {
  ticket: "t-1",
  requests: [{ kind: { _tag: "Permission" }, defaultToNo: false }],
} as unknown as RunView["cards"][number]

const views: ReadonlyArray<RunView> = [
  emptyView,
  { ...emptyView, cards: [card] },
  { ...emptyView, cards: [card], endOfRun: [] },
  { ...emptyView, windDown: { marks: [], running: 0 } },
]

describe("every key a screen binds has a row in its key help", () => {
  test("the dashboard's", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...views),
        fc.boolean(),
        fc.boolean(),
        (view, buttons, highlighted) => {
          const commands = dashboardCommands(view, {
            buttons,
            highlighted: () => (highlighted ? view.cards[0] : undefined),
          })
          expect(unlisted(commands)).toEqual([])
          // The hint names only keys the dashboard binds.
          const hinted = commands.filter((each) => each.hint !== undefined)
          expect(hinted.every((each) => each.keys.length > 0)).toBe(true)
        },
      ),
    )
  })

  test("the worker view's and the Interview view's", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (a, b, c, d) => {
        const at = { requests: a, composing: b, steered: c, finished: d }
        expect(unlisted(workerViewCommands(at))).toEqual([])
        expect(unlisted(interviewCommands({ question: a, composing: b }))).toEqual([])
      }),
    )
  })

  test("the global keys', which end every view's key help", () => {
    const commands = globalCommands({ quit: () => {}, suspend: () => {} })
    expect(unlisted(commands)).toEqual([])
    expect(globalHelp.map(([keys]) => keys)).toEqual(["Ctrl+C", "Ctrl+Z", "a drag"])
  })

  test("the dashboard's help names q and Ctrl+Z (tutti-jqf5)", () => {
    const rows = helpOf(
      dashboardCommands(emptyView, { buttons: true, highlighted: () => undefined }),
    )
    expect(rows.map(([keys]) => keys)).toContain("q")
    expect(rows.map(([keys]) => keys)).toContain("?")
  })
})

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const shellOf = (view: RunView): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => 0,
})

const sent = (value: ShellValue): ReadonlyArray<UiCommand> => {
  const out: Array<UiCommand> = []
  for (;;) {
    const next = Effect.runSync(Queue.poll(value.commands))
    if (Option.isNone(next)) return out
    out.push(next.value)
  }
}

describe("the dashboard's keys, as bound", () => {
  test("its key help, drawn over it, lists the keys the list gives, the global ones last", async () => {
    await withRender(<Root value={shellOf(emptyView)} />, { width: 100, height: 40 }, async (r) => {
      await r.input((setup) => setup.mockInput.typeText("?"))
      const frame = (await r.capture()).chars
      for (const words of ["end the run", "Ctrl+Z", "these keys", "a drag"]) {
        expect(frame).toContain(words)
      }
      expect(frame.indexOf("these keys")).toBeLessThan(frame.indexOf("Ctrl+C"))
    })
  })

  test("q does nothing until the end-of-run box is shown", async () => {
    const view = external(emptyView)
    const value = { ...shellOf(emptyView), view }
    await withRender(<Root value={value} />, { width: 100, height: 40 }, async (r) => {
      await r.input((setup) => setup.mockInput.typeText("q"))
      expect(sent(value)).toEqual([])
      await r.input(() => view.set({ ...emptyView, endOfRun: [] }))
      await r.input((setup) => setup.mockInput.typeText("q"))
      expect(sent(value).map((each) => each._tag)).toEqual(["EndRun"])
    })
  })
})
