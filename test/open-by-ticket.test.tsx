// Workers are opened by their card, never by a number (§ 7.2, § 7.3): the cards show no worker
// number, `1`–`9` open nothing, the hint says `Tab select · Enter open`, and the highlight names a
// ticket, so it stays on its card as other cards come and go and a new worker takes a finished
// one's place in the order.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, spinnerAt } from "../src/ui/useRunView.ts"
import { type Frame, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 22, 13, 0, 0).getTime()
const now = began + 67_000
const working = TicketPhase.Working()
const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc1234" }) })

/** RunView for tickets, each `[ticket, its worker's number or null, its phase]`. */
const viewOf = (
  tickets: ReadonlyArray<readonly [string, number | null, TicketPhase?]>,
  concurrency = 3,
): RunView =>
  project({
    ledger: {
      tickets: new Map(
        tickets.map(([ticket, worker, phase], row): [string, Entry] => [
          ticket,
          {
            ticket,
            title: `Title of ${ticket}`,
            phase: phase ?? working,
            since: began,
            worker,
            row,
            rechecking: false,
            steered: false,
            lastMessage: null,
            tallies: emptyTallies,
          },
        ]),
      ),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    // A Working ticket's worker is at work.
    workers: new Map(
      tickets.flatMap(([ticket, , phase]) =>
        phase === undefined ? [[ticket, WorkerState.Working({ doing: "working" })] as const] : [],
      ),
    ),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "main", began, concurrency },
    actions: new Map(),
  })

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** The commands the dashboard has sent since last asked, none when there are none. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.size(commands)) === 0 ? [] : Effect.runSync(Queue.takeAll(commands))

/** Draws `first` on the dashboard and runs `body` with the store it reads from. */
const dashboard = (
  first: RunView,
  body: (args: {
    readonly view: ReturnType<typeof external<RunView>>
    readonly commands: Commands
    readonly rendered: Parameters<Parameters<typeof withRender>[2]>[0]
  }) => Promise<void>,
  size = { width: 80, height: 40 },
) => {
  const view = external(first)
  const commands = Effect.runSync(makeCommands)
  return withRender(
    <Root
      value={{
        view,
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => now,
      }}
    />,
    size,
    (rendered) => body({ view, commands, rendered }),
  )
}

const turned = spinnerAt(now)

describe("opening a worker without its number", () => {
  test("the cards show no number, in either layout, and the hint says Tab select · Enter open", async () => {
    const tickets = [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const
    await dashboard(viewOf(tickets), async ({ rendered }) => {
      const lines = linesOf(await rendered.capture())
      expect(lines.filter((line) => /^│ \S [abc] {2}/.test(line))).toHaveLength(3)
      expect(lines.some((line) => /[│┃] \d \S {2}[abc]/.test(line))).toBe(false)
      expect(lines.at(-2)).toBe("  Tab select · Enter open · s stop after current · ? keys")
    })
    // Too short for a card each: one line each, the IDs straight after the mark.
    await dashboard(
      viewOf(tickets),
      async ({ rendered }) => {
        const lines = linesOf(await rendered.capture())
        const compact = lines
          .filter((line) => line.startsWith(`│ ${turned} `))
          .map((line) => line.replace(/ *│$/, ""))
        expect(compact).toEqual([
          `│ ${turned} a  working  1m07s  Title of a`,
          `│ ${turned} b  working  1m07s  Title of b`,
          `│ ${turned} c  working  1m07s  Title of c`,
        ])
      },
      { width: 80, height: 18 },
    )
  })

  test("1–9 open nothing; Tab then Enter, or a click, opens a card", async () => {
    await dashboard(
      viewOf([
        ["a", 1],
        ["b", 2],
      ]),
      async ({ rendered, commands }) => {
        await rendered.input((setup) => {
          for (const key of "123456789") setup.mockInput.pressKey(key)
        })
        expect(taken(commands)).toEqual([])
        await rendered.input((setup) => {
          setup.mockInput.pressTab()
          setup.mockInput.pressTab()
          setup.mockInput.pressEnter()
        })
        expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "b" })])
        const y = linesOf(await rendered.capture()).findIndex((line) => line.includes(" a  "))
        await rendered.input((setup) => setup.mockMouse.click(10, y))
        expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "a" })])
      },
    )
  })

  test("the highlight stays on its ticket as other cards come and go", async () => {
    await dashboard(
      viewOf([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]),
      async ({ view, rendered, commands }) => {
        await rendered.input((setup) => {
          setup.mockInput.pressTab()
          setup.mockInput.pressTab()
        })
        // a finishes, and d takes its worker's number: first in the order, where a was.
        await rendered.input(() =>
          view.set(
            viewOf([
              ["a", null, merged],
              ["b", 2],
              ["c", 3],
              ["d", 1],
            ]),
          ),
        )
        const lines = linesOf(await rendered.capture())
        expect(lines.some((line) => line.startsWith(`┃ ${turned} b  `))).toBe(true)
        await rendered.input((setup) => setup.mockInput.pressEnter())
        expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "b" })])
        // b finishes and e takes its worker's number, b's place in the order: the highlight goes
        // with b's card and doesn't pass to e, so Enter opens nothing; Tab starts from the first.
        await rendered.input(() =>
          view.set(
            viewOf([
              ["b", null, merged],
              ["c", 3],
              ["d", 1],
              ["e", 2],
            ]),
          ),
        )
        expect(linesOf(await rendered.capture()).some((line) => line.startsWith("┃"))).toBe(false)
        await rendered.input((setup) => setup.mockInput.pressEnter())
        expect(taken(commands)).toEqual([])
        await rendered.input((setup) => {
          setup.mockInput.pressTab()
          setup.mockInput.pressEnter()
        })
        expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "d" })])
      },
    )
  })
})
