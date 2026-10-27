// The title line's usage gauge as the terminal draws it (§ 7.2): ten faint cells in one span, each
// a box-drawing line one column wide, which terminals draw to the cell (tutti-1l30).

import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { Effect } from "effect"
import { makeCommands } from "../src/run/commands.ts"
import { emptyState } from "../src/run/ledger.ts"
import { emptyStatus, project } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

/** The dashboard of a run whose account has used 41% of its five-hour window. */
const value: ShellValue = {
  view: external(
    project({
      ledger: emptyState,
      workers: new Map(),
      requests: [],
      status: {
        ...emptyStatus,
        version: "0.1.0",
        branch: "main",
        windows: [
          { name: "five_hour", utilization: 0.41, resetsAt: null },
          { name: "seven_day", utilization: 0.12, resetsAt: null },
        ],
      },
    }),
  ),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => 0,
}

describe("the title line's usage gauge", () => {
  test("is one faint span of ten cells, ━ for each filled tenth and ─ for each empty one, one column each", async () => {
    const frame = await renderFrame(<Root value={value} />, { width: 120, height: 30 })
    const line = frame.chars.split("\n").find((each) => each.includes("Current usage"))
    expect(line).toContain("Current usage ━━━━──────  41% · This week 12%")
    // The capture joins neighbouring cells of one look: the gauge is whole in the span of its label,
    // faint as it is, and no other span holds a cell of it.
    const spans = frame.spans.lines
      .flatMap((each) => each.spans)
      .filter((span) => span.text.includes("━"))
    expect(spans.map((span) => span.text)).toEqual(["Current usage ━━━━──────"])
    const [gauge] = spans
    expect((gauge?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM)
    // Each cell one column: the span is as wide as it has characters.
    expect(gauge?.width).toBe([...(gauge?.text ?? "")].length)
    const at = line?.indexOf("━━━━──────") ?? -1
    expect(line?.slice(at + 10, at + 15)).toBe("  41%")
  })
})
