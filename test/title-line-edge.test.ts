// The title line leaves a column empty at the pane's right edge after its banners (tutti-3j79), as
// the load line under it keeps one at its left (` ▶ …`), in every form it falls back to.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { orchestra } from "../src/project/scheme.ts"
import type { Banner, TitleView } from "../src/run/runView.ts"
import { widthOf } from "../src/ui/line.tsx"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const title: TitleView = {
  version: "0.1.0",
  branch: "main",
  scope: null,
  began: 0,
  stopping: false,
  quitting: null,
  solo: null,
  shared: 0,
  keepAwake: false,
  autoAnswer: null,
}

const windows: Banner = {
  _tag: "Windows",
  windows: [
    { name: "five_hour", utilization: 0.17, resetsAt: null },
    { name: "seven_day", utilization: 0.05, resetsAt: null },
  ],
}
const usage: Banner = { _tag: "Usage", utilization: 0.85, resetsAt: null, limit: "five-hour" }
const pressure: Banner = { _tag: "Hold", word: "PRESSURE", resetsAt: null }

/** The title line's text `width` columns wide, at 0, with its trailing spaces. */
const text = (view: TitleView, banners: ReadonlyArray<Banner>, width: number) =>
  titleSegments(view, banners, 0, theme, width)
    .map((segment) => segment.text)
    .join("")

describe("the title line's right edge", () => {
  test("the account's windows end a column short of the pane's edge", () => {
    const line = text(title, [windows], 100)
    expect(line).toEndWith("This week 5%")
    expect(line).toHaveLength(99)
  })

  test("a hold ends a column short of the edge too", () => {
    const line = text(title, [windows, pressure], 100)
    expect(line).toEndWith("This week 5%  PRESSURE")
    expect(line).toHaveLength(99)
  })

  test("a line without banners may still fill the pane", () => {
    const line = text({ ...title, branch: "b".repeat(200) }, [], 60)
    expect(line).toHaveLength(60)
    expect(line).toEndWith("…")
  })

  test("at any width, with any banners shown, the last column stays empty", () => {
    const banner = fc.oneof(
      fc.constant(windows),
      fc.constant(usage),
      fc.constant(pressure),
      fc.constant<Banner>({ _tag: "Hold", word: "BLOCKED", resetsAt: null }),
    )
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 160 }),
        fc.array(banner, { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        fc.boolean(),
        (width, banners, stopping, keepAwake) => {
          const view = { ...title, stopping, keepAwake }
          const segments = titleSegments(view, banners, 0, theme, width)
          // The holds always show, in some form; the usage and the windows may be dropped.
          const shown =
            banners.some((b) => b._tag === "Hold") ||
            segments.some((segment) => segment.text.includes("%"))
          if (shown) expect(widthOf(segments)).toBeLessThan(width)
        },
      ),
    )
  })
})
