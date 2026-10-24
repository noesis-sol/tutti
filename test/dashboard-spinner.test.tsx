// The dashboard's spinner (tutti-axpo.5): the cards, the compact box and the idle box run their
// own clock and spinner, so that a turn draws them alone, not the title, the totals and the table
// over them; below the minimum size and behind the end-of-run box, where no spinner is drawn, none
// turns.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Waiting } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable, type ShellValue, spinnerTick } from "../src/ui/useRunView.ts"
import { type Size, withRender } from "./render.ts"

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

/** Worker 1 on t-1 in `state`, and the end-of-run box naming `waiting` when given. */
const viewOf = (state: WorkerState, waiting: ReadonlyArray<Waiting> | null = null): RunView => ({
  ...project({
    ledger: {
      tickets: new Map([
        [
          "t-1",
          {
            ticket: "t-1",
            title: "Title of t-1",
            phase: TicketPhase.Working(),
            since: began,
            worker: 1,
            row: 0,
            rechecking: false,
            steered: false,
            lastMessage: null,
            tallies: emptyTallies,
          },
        ],
      ]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map([["t-1", state]]),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  }),
  ...(waiting === null ? {} : { endOfRun: waiting }),
})

const working = WS.Working({ doing: "editing" })

/** The run view, counting its reads: the dashboard reads it each time it is drawn. */
const counted = (view: RunView) => {
  const store = external(view)
  let reads = 0
  const counting: Settable<RunView> = {
    ...store,
    get: () => {
      reads++
      return store.get()
    },
  }
  return { view: counting, reads: () => reads }
}

/** The shell over `view`, its clock a spinner's frame on at each read while it `turns`. */
const shellOf = (view: Settable<RunView>, clock: { turns: boolean; reads: number }): ShellValue => {
  let at = began
  return {
    view,
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf: (appearance) =>
      makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false }),
    now: () => {
      if (clock.turns) {
        clock.reads++
        at += spinnerTick
      }
      return at
    },
  }
}

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

/** The clock's reads and the run view's over ten of the spinner's turns, the dashboard `size`. */
const turnsOf = async (shown: RunView, size: Size) => {
  const { view, reads } = counted(shown)
  const clock = { turns: false, reads: 0 }
  return withRender(<Root value={shellOf(view, clock)} />, size, async () => {
    const before = reads()
    // Ten turns outside act(), as the terminal draws them: act() would draw them once.
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    clock.turns = true
    try {
      await Bun.sleep(spinnerTick * 10)
    } finally {
      clock.turns = false
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    }
    return { clock: clock.reads, view: reads() - before }
  })
}

describe("the dashboard's spinner", () => {
  test("turns in the working card, and the dashboard over it isn't drawn anew each turn", async () => {
    const turns = await turnsOf(viewOf(working), { width: 80, height: 30 })
    expect(turns.clock).toBeGreaterThan(3)
    expect(turns.view).toBeLessThan(3)
  })

  test("turns in the idle box with no card, the dashboard not drawn anew", async () => {
    const turns = await turnsOf(viewOf(WS.Idle({ at: began })), { width: 80, height: 30 })
    expect(turns.view).toBeLessThan(3)
    const none = await turnsOf({ ...viewOf(working), cards: [] }, { width: 80, height: 30 })
    expect(none.clock).toBeGreaterThan(3)
    expect(none.view).toBeLessThan(3)
  })

  test("doesn't turn below the minimum size", async () => {
    expect(await turnsOf(viewOf(working), { width: 50, height: 30 })).toEqual({ clock: 0, view: 0 })
  })

  test("doesn't turn behind the end-of-run box", async () => {
    const ending = viewOf(working, [{ ticket: "t-1", asks: ["Allow Bash(rm -rf build)?"] }])
    expect(await turnsOf(ending, { width: 80, height: 30 })).toEqual({ clock: 0, view: 0 })
  })
})
