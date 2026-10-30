// The dashboard drawn before the run's first real view has emptyView's title, `began` 0: its title
// line shows the run's time as 0s, not the time since 1970 (tutti-0t8p).
import { describe, expect, test } from "bun:test"
import { emptyView, type TitleView } from "../src/run/runView.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/** Now, in epoch milliseconds: 2026-10-30. */
const now = Date.UTC(2026, 9, 30, 12)

const text = (title: TitleView) =>
  titleSegments(title, [], now, theme, 140)
    .map((segment) => segment.text)
    .join("")

describe("the title line's run time", () => {
  test("is 0s before the run's first view sets when it began", () => {
    const line = text({ ...emptyView.title, version: "0.1.0", branch: "main" })
    expect(line).toContain("main · 0s")
    expect(line).not.toMatch(/\d+h/)
  })

  test("counts from when the run began once it is set", () => {
    const line = text({
      ...emptyView.title,
      version: "0.1.0",
      branch: "main",
      began: now - 125_000,
    })
    expect(line).toContain("main · 2m5s")
  })
})
