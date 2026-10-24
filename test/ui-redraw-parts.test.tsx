// What a RunView change and a tick draw anew (tutti-rvzn.1): a component reads the part of RunView
// it draws, so another worker's card changing doesn't draw a worker's view, and a closed box draws
// nothing; a card is drawn anew whole only when it changes, and a spinner's tick draws its head's
// line alone; one ticker each for the clock and the spinner, on the shell's clock and interval,
// runs while anything draws them.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Profiler } from "react"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, type Inputs, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { App, Root } from "../src/ui/App.tsx"
import { SelectionLook, selectionLookOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  external,
  type Interval,
  type Settable,
  type ShellValue,
  spinnerAt,
  spinnerTick,
  tick,
  ticker,
} from "../src/ui/useRunView.ts"
import { withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

/** Workers 1 and 2 on t-1 and t-2, titled `titles`, each in `state`. */
const inputsOf = (titles: readonly [string, string], state: WorkerState): Inputs => ({
  ledger: {
    tickets: new Map(
      titles.map((title, i) => [
        `t-${i + 1}`,
        {
          ticket: `t-${i + 1}`,
          title,
          phase: TicketPhase.Working({ activity: "working" }),
          since: began,
          worker: i + 1,
          row: i,
          rechecking: false,
          steered: false,
          lastMessage: null,
          tallies: emptyTallies,
        },
      ]),
    ),
    rows: 2,
    windDown: null,
    bugs: [],
  },
  workers: new Map([
    ["t-1", state],
    ["t-2", state],
  ]),
  requests: [],
  status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 2 },
  actions: new Map(),
})

/** The shell's intervals, which a test fires by hand: none fires by itself. */
const fakeIntervals = () => {
  const running = new Set<{ readonly run: () => void; readonly ms: number }>()
  const interval: Interval = (run, ms) => {
    const timer = { run, ms }
    running.add(timer)
    return () => {
      running.delete(timer)
    }
  }
  return {
    interval,
    /** How many intervals of `ms` run. */
    count: (ms: number) => [...running].filter((timer) => timer.ms === ms).length,
    /** Fires every interval of `ms`. */
    fire: (ms: number) => {
      for (const timer of [...running]) if (timer.ms === ms) timer.run()
    },
  }
}

/** The shell over `view` on `screen`, its clock `clock.at`, its intervals `intervals`'. */
const shellOf = (
  view: Settable<RunView>,
  screen: Screen,
  clock: { at: number },
  intervals: ReturnType<typeof fakeIntervals>,
): ShellValue => ({
  view,
  screen: external(screen),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => clock.at,
  interval: intervals.interval,
})

/**
 * The selection colours, counting the lines drawn: every Line spreads them into its <text>, reading
 * them once each time it is drawn.
 */
const countingLook = () => {
  const look = selectionLookOf(themeOf("dark"))
  const drawn = { lines: 0 }
  const value = {}
  Object.defineProperty(value, "selectionBg", {
    enumerable: true,
    get: () => {
      drawn.lines++
      return look.selectionBg
    },
  })
  Object.defineProperty(value, "selectionFg", { enumerable: true, value: look.selectionFg })
  return { value, drawn }
}

describe("a worker's view", () => {
  test("isn't drawn anew when another worker's card changes, only when its own does", async () => {
    const first = project(inputsOf(["Title of t-1", "Title of t-2"], WS.Idle({ at: began })))
    const view = external(first)
    const intervals = fakeIntervals()
    const shell = shellOf(view, Screen.Worker({ ticket: "t-1" }), { at: began }, intervals)
    let commits = 0
    await withRender(
      <Profiler id="view" onRender={() => commits++}>
        <Root value={shell} />
      </Profiler>,
      { width: 80, height: 20 },
      async (rendered) => {
        expect((await rendered.capture()).chars).toContain("Title of t-1")
        const before = commits
        const other = project(
          inputsOf(["Title of t-1", "Another title"], WS.Idle({ at: began })),
          first,
        )
        expect(other.cards[0]).toBe(first.cards[0] as NonNullable<(typeof first.cards)[0]>)
        await rendered.input(() => view.set(other))
        // Nothing under the root is drawn: not the view, nor the boxes, closed.
        expect(commits).toBe(before)
        const own = project(
          inputsOf(["A new title", "Another title"], WS.Idle({ at: began })),
          other,
        )
        await rendered.input(() => view.set(own))
        expect(commits).toBeGreaterThan(before)
        expect((await rendered.capture()).chars).toContain("A new title")
      },
    )
  })
})

describe("the boxes", () => {
  test("closed, aren't drawn anew as the run view changes", async () => {
    const first = project(inputsOf(["Title of t-1", "Title of t-2"], WS.Idle({ at: began })))
    const view = external(first)
    const shell = shellOf(view, Screen.Dashboard(), { at: began }, fakeIntervals())
    let commits = 0
    await withRender(
      <Profiler id="boxes" onRender={() => commits++}>
        <Root value={shell}>
          <text>no screen</text>
        </Root>
      </Profiler>,
      { width: 80, height: 20 },
      async (rendered) => {
        const before = commits
        for (const title of ["One", "Two", "Three"]) {
          await rendered.input(() =>
            view.set(
              project(inputsOf([title, "Title of t-2"], WS.Idle({ at: began })), view.get()),
            ),
          )
        }
        expect(commits).toBe(before)
      },
    )
  })
})

describe("the dashboard's cards", () => {
  test("a spinner's tick draws one line a card, every spinner in step", async () => {
    const view = external(
      project(inputsOf(["Title of t-1", "Title of t-2"], WS.Working({ doing: "editing" }))),
    )
    const clock = { at: began }
    const intervals = fakeIntervals()
    const shell = shellOf(view, Screen.Dashboard(), clock, intervals)
    const look = countingLook()
    await withRender(
      <Root value={shell}>
        <SelectionLook.Provider value={look.value}>
          <App />
        </SelectionLook.Provider>
      </Root>,
      { width: 80, height: 40 },
      async (rendered) => {
        const shown = (await rendered.capture()).chars
        expect(shown).toContain(`╭`)
        expect(shown.split(`${spinnerAt(began)} t-`).length - 1).toBe(2)
        // One interval for both cards' spinners, and one for every time on screen.
        expect(intervals.count(spinnerTick)).toBe(1)
        expect(intervals.count(tick)).toBe(1)
        for (let turn = 1; turn <= 3; turn++) {
          const before = look.drawn.lines
          await rendered.input(() => {
            clock.at += spinnerTick
            intervals.fire(spinnerTick)
          })
          expect(look.drawn.lines - before).toBe(2)
          const turned = (await rendered.capture()).chars
          expect(turned.split(`${spinnerAt(clock.at)} t-`).length - 1).toBe(2)
        }
      },
    )
  })

  test("a card that doesn't change isn't drawn anew as another does", async () => {
    const first = project(inputsOf(["Title of t-1", "Title of t-2"], WS.Idle({ at: began })))
    // The lines drawn as the cards' titles become `titles`.
    const drawnFor = async (titles: readonly [string, string]) => {
      const view = external(first)
      const look = countingLook()
      return withRender(
        <Root value={shellOf(view, Screen.Dashboard(), { at: began }, fakeIntervals())}>
          <SelectionLook.Provider value={look.value}>
            <App />
          </SelectionLook.Provider>
        </Root>,
        { width: 80, height: 40 },
        async (rendered) => {
          const before = look.drawn.lines
          const next = project(inputsOf(titles, WS.Idle({ at: began })), first)
          await rendered.input(() => view.set(next))
          expect((await rendered.capture()).chars).toContain(titles[1])
          return look.drawn.lines - before
        },
      )
    }
    const one = await drawnFor(["Title of t-1", "Another title"])
    const both = await drawnFor(["A new title", "Another title"])
    // Both cards changing draws the first card's four lines (its frame, head and title) besides.
    expect(both - one).toBe(4)
  })
})

describe("a ticker", () => {
  test("runs one interval while anything listens, from the first listener to the last", () => {
    const intervals = fakeIntervals()
    let at = 1000
    const time = ticker(() => at, 100, intervals.interval)
    expect(time.get()).toBe(1000)
    expect(intervals.count(100)).toBe(0)
    const heard: Array<string> = []
    at = 1050
    const leaveA = time.subscribe(() => heard.push(`a ${time.get()}`))
    // The first listener reads the clock afresh, and starts the interval.
    expect(time.get()).toBe(1050)
    expect(intervals.count(100)).toBe(1)
    const leaveB = time.subscribe(() => heard.push(`b ${time.get()}`))
    expect(intervals.count(100)).toBe(1)
    at = 1150
    intervals.fire(100)
    expect(heard.slice(-2)).toEqual(["a 1150", "b 1150"])
    leaveA()
    leaveA()
    expect(intervals.count(100)).toBe(1)
    leaveB()
    expect(intervals.count(100)).toBe(0)
    // A listener joining again starts it again, at the time then.
    at = 5000
    const leaveC = time.subscribe(() => {})
    expect(time.get()).toBe(5000)
    expect(intervals.count(100)).toBe(1)
    leaveC()
    expect(intervals.count(100)).toBe(0)
  })
})
