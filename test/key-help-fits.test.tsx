// The key help fits the pane (§ 7.3, § 7.7; tutti-bnhb): taller than the pane, as the dashboard's
// is at the smallest size (16 rows) and the worker view's below 24, it leaves out its blank lines,
// then shows its keys a window at a time, with `Esc close` always drawn under them. ↑↓, PgUp/PgDn,
// g/G and the wheel scroll the window.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { makeCommands } from "../src/run/commands.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { dashboardCommands } from "../src/ui/Dashboard.tsx"
import { keyHelpLines, keyHelpRoom, screenHelp } from "../src/ui/KeyHelp.tsx"
import { helpOf } from "../src/ui/keyCommands.ts"
import { type Segments, widthOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { workerViewCommands } from "../src/ui/WorkerView.tsx"
import { type Frame, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const textOf = (lines: ReadonlyArray<Segments>): ReadonlyArray<string> =>
  lines.map((line) =>
    line
      .map((s) => s.text)
      .join("")
      .trimEnd(),
  )

const empty: RunView = project({
  ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
  workers: new Map(),
  requests: [],
  status: { ...emptyStatus, version: "0.1.0", branch: "batch/2026-10-20", began, concurrency: 3 },
  actions: new Map(),
})

const value = (): ShellValue => ({
  view: external(empty),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => began,
})

/** The key help of the dashboard and the worker view, as their commands give it. */
const dashboardKeys = screenHelp(
  helpOf(dashboardCommands(empty, { buttons: true, highlighted: () => undefined })),
)
const workerViewKeys = screenHelp(
  helpOf(
    workerViewCommands({ requests: false, composing: false, steered: false, finished: false }),
  ),
)

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

describe("the key help's height", () => {
  test("is the natural one where the pane has room for it", () => {
    const lines = textOf(keyHelpLines(theme, 100, dashboardKeys, 40))
    expect(lines).toHaveLength(dashboardKeys.length + 6)
    expect(lines[2]).toMatch(/^│ +│$/)
  })

  test("leaves out the blank lines at the smallest size, then shows the dashboard's keys a window at a time", () => {
    const lines = textOf(keyHelpLines(theme, 60, dashboardKeys, 16))
    expect(lines).toHaveLength(16)
    expect(lines[1]).toMatch(/^│ Keys {2}1–12 of 13 +│$/)
    expect(lines[2]).toContain("Tab, Shift+Tab, arrows")
    expect(lines.at(-3)).toContain("Ctrl+Z")
    expect(lines.at(-2)).toMatch(/^│ Esc close · ↑↓ PgUp PgDn scroll +│$/)
  })

  test("shows the worker view's keys a window at a time, saying which", () => {
    expect(textOf(keyHelpLines(theme, 60, workerViewKeys, 16))).toMatchInlineSnapshot(`
      [
        "╭──────────────────────────────────────────────────────────╮",
        "│ Keys  1–12 of 20                                         │",
        "│ i, a click on the composer  write to the worker; Enter … │",
        "│ Esc, ← Dashboard            leave the composer; close t… │",
        "│ Esc, Tab, Enter             switch workers, by way of t… │",
        "│ t, ▾ whole ticket           the whole ticket; t, ▴ less… │",
        "│ d, Shift+D                  deny the request; deny with… │",
        "│ a                           allow the request, unless i… │",
        "│ r                           allow for this run           │",
        "│ Ctrl+X                      interrupt the worker's turn… │",
        "│ Ctrl+R, Release             release a steered worker     │",
        "│ Ctrl+T, File as ticket      once the worker has finishe… │",
        "│ Tab, Shift+Tab, arrows      move between items; between… │",
        "│ Enter, a click              expand or collapse the item… │",
        "│ Esc close · ↑↓ PgUp PgDn scroll                          │",
        "╰──────────────────────────────────────────────────────────╯",
      ]
    `)
  })

  test("scrolled past the end, shows the last window", () => {
    const lines = textOf(keyHelpLines(theme, 60, workerViewKeys, 16, 100))
    expect(lines[1]).toContain("9–20 of 20")
    expect(lines.at(-3)).toContain("a drag")
  })

  test("never takes more rows than the pane, nor more columns, and always says Esc", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 5, max: 40 }),
        fc.integer({ min: 20, max: 120 }),
        fc.nat(40),
        (count, height, width, top) => {
          const keys = Array.from({ length: count }, (_, i) => [`k${i}`, `does ${i}`] as const)
          const lines = keyHelpLines(theme, width, keys, height, top)
          const { shown } = keyHelpRoom(count, height)
          expect(lines.length).toBeLessThanOrEqual(height)
          expect(Math.max(...lines.map(widthOf))).toBeLessThanOrEqual(width)
          expect(textOf(lines).at(-2)).toContain("Esc")
          const from = Math.min(top, count - shown)
          expect(textOf(lines).some((line) => line.includes(`k${from} `))).toBe(true)
        },
      ),
    )
  })
})

describe("the key help over a short pane", () => {
  test("draws Esc close at the smallest size", async () => {
    await withRender(<Root value={value()} />, { width: 60, height: 16 }, async (rendered) => {
      await rendered.input((setup) => setup.mockInput.typeText("?"))
      const lines = linesOf(await rendered.capture())
      expect(lines.some((line) => line.includes("these keys"))).toBe(true)
      expect(lines.some((line) => line.includes("Esc close"))).toBe(true)
    })
  })

  test("scrolls with ↓, G, g, PgDn, ↑ and the wheel", async () => {
    await withRender(<Root value={value()} />, { width: 60, height: 12 }, async (rendered) => {
      const title = async () =>
        linesOf(await rendered.capture()).find((line) => line.includes("Keys")) ?? ""
      await rendered.input((setup) => setup.mockInput.typeText("?"))
      expect(await title()).toContain("1–8 of 13")
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      expect(await title()).toContain("2–9 of 13")
      await rendered.input((setup) => setup.mockInput.typeText("G"))
      expect(await title()).toContain("6–13 of 13")
      const lines = linesOf(await rendered.capture())
      expect(lines.some((line) => line.includes("a drag"))).toBe(true)
      expect(lines.some((line) => line.includes("Esc close"))).toBe(true)
      await rendered.input((setup) => setup.mockInput.typeText("g"))
      expect(await title()).toContain("1–8 of 13")
      await rendered.input((setup) => setup.mockInput.pressKey("\x1b[6~"))
      expect(await title()).toContain("6–13 of 13")
      await rendered.input((setup) => setup.mockInput.pressArrow("up"))
      expect(await title()).toContain("5–12 of 13")
      await rendered.input((setup) => setup.mockMouse.scroll(30, 5, "up"))
      expect(await title()).toContain("4–11 of 13")
    })
  })
})
