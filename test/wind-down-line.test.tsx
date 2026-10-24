// The wind-down line's fallbacks (§ 7.2, orchestra's windDownLine): with nothing left running it
// says `nothing running, ending now`, and a narrow pane drops `, no new tickets`, then the count,
// then the words, keeping the squares, so the line is never cut mid-word.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies, type WindDown } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type WindDownView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { windDownSegments } from "../src/ui/WindDown.tsx"
import { renderFrame, type Size } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + 67_000

const working = TicketPhase.Working({ activity: "working" })
const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc1234" }) })

const entryOf = (ticket: string, phase: TicketPhase, row: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker: phase._tag === "Working" ? row + 1 : null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView of `tickets` winding down since `from` began it. */
const viewOf = (
  tickets: ReadonlyArray<readonly [string, TicketPhase]>,
  from: ReadonlyArray<string>,
): RunView => {
  const windDown: WindDown = { since: began, tickets: from }
  return project({
    ledger: {
      tickets: new Map(tickets.map(([ticket, phase], i) => [ticket, entryOf(ticket, phase, i)])),
      rows: tickets.length,
      windDown,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch/2026-10-20",
      began,
      concurrency: 3,
      stopping: false,
    },
    actions: new Map(),
  })
}

const windDownOf = (view: RunView): WindDownView => {
  if (view.windDown === null) throw new Error("no wind-down")
  return view.windDown
}

const textAt = (view: WindDownView, width: number): string =>
  windDownSegments(view, theme, width)
    .map((s) => s.text)
    .join("")

const three = viewOf(
  [
    ["a", working],
    ["b", working],
    ["c", merged],
  ],
  ["a", "b", "c"],
)

describe("the wind-down line in a narrow pane", () => {
  test("drops ', no new tickets', then the count, then the words, keeping the squares", () => {
    const view = windDownOf(three)
    expect([80, 49, 48, 33, 32, 21, 20, 7, 6, 5, 4, 3, 2, 0].map((w) => textAt(view, w))).toEqual([
      "  ■ ■ ■  Winding down · 2 running, no new tickets",
      "  ■ ■ ■  Winding down · 2 running, no new tickets",
      "  ■ ■ ■  Winding down · 2 running",
      "  ■ ■ ■  Winding down · 2 running",
      "  ■ ■ ■  Winding down",
      "  ■ ■ ■  Winding down",
      "  ■ ■ ■",
      "  ■ ■ ■",
      "  ■ ■",
      "  ■ ■",
      "  ■",
      "  ■",
      "",
      "",
    ])
  })

  test("the squares keep their colours when the words are dropped", () => {
    const line = windDownSegments(windDownOf(three), theme, 8)
    const marks = line.filter((s) => s.text === "■").map((s) => s.look)
    expect(marks).toEqual([theme.styles.windDown, theme.styles.windDown, theme.styles.done])
  })

  test("is never wider than the pane, and never cut mid-word", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(working, merged), { maxLength: 12 }),
        fc.integer({ min: 0, max: 120 }),
        (phases, width) => {
          const ids = phases.map((_, i) => `t-${i}`)
          const view = windDownOf(
            viewOf(
              phases.map((phase, i) => [`t-${i}`, phase] as const),
              ids,
            ),
          )
          const line = windDownSegments(view, theme, width)
          const text = line.map((s) => s.text).join("")
          const rest = text.replace(/^ {2}(■( ■)*)?/u, "")
          return (
            widthOf(line) <= width &&
            !text.includes("…") &&
            [
              "",
              "  Winding down",
              "  Winding down · nothing running, ending now",
              `  Winding down · ${view.running} running`,
              `  Winding down · ${view.running} running, no new tickets`,
            ].includes(rest)
          )
        },
      ),
    )
  })
})

describe("the wind-down line with nothing running", () => {
  test("says the run ends now once every ticket has finished", () => {
    const view = windDownOf(
      viewOf(
        [
          ["a", merged],
          ["b", merged],
        ],
        ["a", "b"],
      ),
    )
    expect(view.running).toBe(0)
    expect([80, 49, 48, 19, 18, 5, 4].map((w) => textAt(view, w))).toEqual([
      "  ■ ■  Winding down · nothing running, ending now",
      "  ■ ■  Winding down · nothing running, ending now",
      "  ■ ■  Winding down",
      "  ■ ■  Winding down",
      "  ■ ■",
      "  ■ ■",
      "  ■",
    ])
  })

  test("with no ticket running when it began, one windingDown ■", () => {
    const line = windDownSegments(windDownOf(viewOf([], [])), theme, 80)
    expect(line.map((s) => s.text).join("")).toBe("  ■  Winding down · nothing running, ending now")
    expect(line.find((s) => s.text === "■")?.look).toEqual(theme.styles.windDown)
  })

  test("drawn on the dashboard, whole at 100 columns and without its rest at 60", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t-${i}`)
    const view = viewOf(
      ids.map((id) => [id, merged] as const),
      ids,
    )
    const draw = (size: Size) =>
      renderFrame(
        <Root
          value={{
            view: external(view),
            screen: external<Screen>(Screen.Dashboard()),
            commands: Effect.runSync(makeCommands),
            appearance: external<Appearance>("dark"),
            themeOf,
            now: () => now,
          }}
        />,
        size,
      )
    const lines = async (size: Size) =>
      (await draw(size)).chars.split("\n").map((line) => line.trimEnd())
    const squares = `  ${ids.map(() => "■").join(" ")}  Winding down`
    expect(await lines({ width: 100, height: 40 })).toContain(
      `${squares} · nothing running, ending now`,
    )
    const narrow = await lines({ width: 60, height: 40 })
    expect(narrow).toContain(squares)
    expect(narrow.some((line) => line.includes("nothing"))).toBe(false)
  })
})
