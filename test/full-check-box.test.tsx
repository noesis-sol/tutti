// The box with no worker while the end-of-run full check runs (tutti-vxph): Current is titled
// `Completing the run` (`Starting the run` for a spec run's checks gate), the box has no frame, its
// text is in the text's own colour, and the check's bar is as long as its line has room for, up to
// longestBar, the suite before it and the count after it whole. A ticket's card keeps its frame and
// its merge check's 8-cell bar.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type CheckShown, fillOf, fullCheckKey } from "../src/run/checking.ts"
import { makeCommands } from "../src/run/commands.ts"
import type { WindDown } from "../src/run/ledger.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import {
  boxCheckSegments,
  checkSegments,
  currentTitle,
  idleBox,
  idleText,
  longestBar,
  underRoom,
} from "../src/ui/Card.tsx"
import { type Segments, widthOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const text = (segments: Segments) => segments.map((each) => each.text).join("")

const fullCommand = "scripts/check-full.sh"

/** The full check at `done` of 848 tests, as the run's Checking shows it, 72 s in at 85 s. */
const shownAt = (done: number, suite: string | null = "test"): CheckShown => {
  const at = { suite, progress: { done, total: 848 } }
  return {
    name: "full check",
    began: 13_000,
    ...at,
    usual: null,
    fill: fillOf(at, 13_000, null, 85_000),
  }
}

/** `filled` of `cells` cells of a bar, as the box draws it. */
const bar = (filled: number, cells: number) => "━".repeat(filled) + "─".repeat(cells - filled)

/** RunView with no ticket, the run's `windDown` and `status` laid over its own. */
const viewOf = (status: Partial<Status>, windDown: WindDown | null = null): RunView =>
  project({
    ledger: { tickets: new Map(), rows: 0, windDown, bugs: [] },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "main", concurrency: 2, ...status },
  })

/** The full check running, its bar halfway. */
const checking = (gate?: true): Partial<Status> => ({
  fullCheck: {
    step: "check",
    command: fullCommand,
    began: 13_000,
    ...(gate === undefined ? {} : { gate }),
  },
  checking: new Map([[fullCheckKey, shownAt(424)]]),
})

/** The dashboard's lines for `view` `width` wide at 85 s, 72 s into the full check. */
const drawn = async (view: RunView, width: number): Promise<ReadonlyArray<string>> => {
  const value: ShellValue = {
    view: external(view),
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => 85_000,
  }
  const frame = await renderFrame(<Root value={value} />, { width, height: 30 })
  // The spinner's frame, whichever the clock has turned it to.
  return frame.chars.split("\n").map((line) => line.replace(/[⣾⣽⣻⢿⡿⣟⣯⣷]/u, "⣽"))
}

/** The section's label and the box's lines under it: from the line `title` is on, 6 lines. */
const sectionOf = (lines: ReadonlyArray<string>, title: string): ReadonlyArray<string> => {
  const from = lines.findIndex((line) => line.trim() === title)
  expect(from).toBeGreaterThan(-1)
  return lines.slice(from, from + 6)
}

describe("the box's bar", () => {
  test("is as long as the room leaves it, up to longestBar, the suite and count whole", () => {
    expect(text(boxCheckSegments(shownAt(424), theme, underRoom(180)))).toBe(
      `test ${bar(24, longestBar)} 424/848`,
    )
    expect(longestBar).toBeGreaterThanOrEqual(4 * 8)
    // In 30 columns: the suite's 4, the count's 7 and two spaces leave the bar 17.
    expect(text(boxCheckSegments(shownAt(424), theme, 30))).toBe(`test ${bar(9, 17)} 424/848`)
    // Too little room for a bar: the suite and the count alone.
    expect(text(boxCheckSegments(shownAt(424), theme, 14))).toBe("test 424/848")
    expect(text(boxCheckSegments(shownAt(424, null), theme, 30))).toBe(`${bar(11, 22)} 424/848`)
  })

  test("its text and filled cells are in the text's colour, its empty cells faint", () => {
    const segments = boxCheckSegments(shownAt(424), theme, 60)
    const lookOf = (glyph: string) => segments.find((each) => each.text.startsWith(glyph))?.look
    expect(lookOf("test")).toBeNull()
    expect(lookOf("424/848")).toBeNull()
    expect(lookOf("━")).toBeNull()
    expect(lookOf("─")).toBe(theme.styles.dim)
  })

  test("a card's merge check keeps its 8 faint cells", () => {
    const segments = checkSegments({ ...shownAt(424), name: "merge check" }, theme)
    expect(text(segments)).toBe("test ━━━━──── 424/848")
    expect(segments.every((each) => each.text === " " || each.look === theme.styles.dim)).toBe(true)
  })

  test("never runs past its room where the suite and count fit, and keeps the count whole", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 848 }),
        fc.integer({ min: 0, max: 200 }),
        (suite, done, room) => {
          const shown = shownAt(done, suite)
          const drawnText = text(boxCheckSegments(shown, theme, room))
          const count = shown.fill?.count ?? ""
          expect(drawnText.endsWith(` ${count}`)).toBe(true)
          const besides = widthOf(boxCheckSegments(shown, theme, 0))
          expect(widthOf(boxCheckSegments(shown, theme, room))).toBeLessThanOrEqual(
            Math.max(room, besides),
          )
        },
      ),
    )
  })
})

describe("the box with no worker", () => {
  test("has no frame, its lines where a frame's would start, in the text's colour", () => {
    const full = { step: "check" as const, command: fullCommand, began: 13_000 }
    const lines = idleBox(
      idleText(false, full, 85_000),
      theme,
      "⣽",
      60,
      undefined,
      boxCheckSegments(shownAt(424), theme, underRoom(60)),
    ).map(text)
    expect(lines).toEqual([
      "  ⣽ full check: scripts/check-full.sh · 1m12s",
      `     test ${bar(21, 41)} 424/848`,
      "",
      "",
      "",
    ])
    const [first = []] = idleBox("stopping…", theme, "⣽", 60)
    expect(first.find((each) => each.text === "stopping…")?.look).toBeNull()
  })

  test("its title says the run is completing, or starting for the checks gate", () => {
    const idle = { _tag: "Idle" } as const
    const full = { step: "check" as const, command: fullCommand, began: 0 }
    expect(currentTitle(idle, null)).toBe("Current")
    expect(currentTitle(idle, full)).toBe("Completing the run")
    expect(currentTitle(idle, { ...full, gate: true })).toBe("Starting the run")
    expect(currentTitle({ _tag: "Compact" }, full)).toBe("Current")
  })
})

describe("the dashboard while the full check runs", () => {
  test("at 180 columns: titled Completing the run, no frame, a long bar", async () => {
    const section = sectionOf(await drawn(viewOf(checking()), 180), "Completing the run")
    expect(section.map((line) => line.trimEnd())).toEqual([
      "  Completing the run",
      "  ⣽ full check: scripts/check-full.sh · 1m12s",
      `     test ${bar(24, longestBar)} 424/848`,
      "",
      "",
      "",
    ])
  })

  test("in a narrow pane the bar shrinks and the count stays whole", async () => {
    const section = sectionOf(await drawn(viewOf(checking()), 60), "Completing the run")
    // 60 columns less the indents' 5 and a column at the right edge, less the suite and the count.
    expect(section[2]?.trimEnd()).toBe(`     test ${bar(21, 41)} 424/848`)
  })

  test("a drained run shows the same", async () => {
    const drained: WindDown = { since: 0, tickets: [] }
    const lines = await drawn(viewOf(checking(), drained), 180)
    expect(sectionOf(lines, "Completing the run")[2]?.trimEnd()).toBe(
      `     test ${bar(24, longestBar)} 424/848`,
    )
    expect(lines.some((line) => line.trim() === "Current")).toBe(false)
  })

  test("a spec run's checks gate is titled Starting the run", async () => {
    const section = sectionOf(await drawn(viewOf(checking(true)), 120), "Starting the run")
    expect(section[1]?.trim()).toBe("⣽ checks gate: scripts/check-full.sh · 1m12s")
  })
})
