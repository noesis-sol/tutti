// A spec run is named by its spec (§ 4.14): the START line's scope is `spec <path>`, with its root
// epic in a note under it; the dashboard's title line and the summaries say `· spec <path>` where a
// --ticket run says `· ticket <id>`.
import { describe, expect, test } from "bun:test"
import { noServersNote } from "../src/agent/mcp.ts"
import { summary } from "../src/print/summary.ts"
import { summaryLines } from "../src/run/endOfRun.ts"
import { emptyStatus, emptyView, project } from "../src/run/runView.ts"
import type { Spec } from "../src/run/spec.ts"
import { type Started, startBlock } from "../src/run/startup.ts"
import type { TicketId } from "../src/services/Beads.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const spec: Spec = {
  given: "~/specs/shop.md",
  from: "--spec",
  source: "/home/me/specs/shop.md",
  path: ".tutti/specs/shop.md",
  copy: true,
  text: "# Shop\n",
  sha256: "ab".repeat(32),
}

const started = (ticket: TicketId | null, withSpec: boolean): Started => ({
  config: TestAppConfig.appConfig({ ticket }, "/work/shop"),
  base: "build/shop",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  account: TestAccount.accountProbe(),
  organs: { _tag: "AgentSdk" },
  ...(withSpec ? { spec } : {}),
  warnings: [],
})

describe("the START block", () => {
  test("names the spec, and its root epic under the START line", () => {
    const lines = startBlock(started("shop-a1b" as TicketId, true), "0.1.0")
    expect(lines[0] as string).toStartWith(
      "START tutti 0.1.0 in /work/shop on build/shop · spec .tutti/specs/shop.md (limit: none,",
    )
    expect(lines[1] as string).toBe("  spec: epic shop-a1b, broken down from: .tutti/specs/shop.md")
  })

  test("a --ticket run is named by its ticket, as before", () => {
    const lines = startBlock(started("shop-a1b" as TicketId, false), "0.1.0")
    expect(lines[0] as string).toContain(" on build/shop · ticket shop-a1b (")
    expect(lines.some((line) => line.includes("broken down from"))).toBe(false)
  })
})

describe("the title line and the summaries", () => {
  test("say · spec <path> for a spec run", () => {
    const view = project({
      ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
      workers: new Map(),
      requests: [],
      status: {
        ...emptyStatus,
        version: "0.1.0",
        branch: "build/shop",
        scope: "shop-a1b" as TicketId,
        spec: spec.path,
        began: 1_000,
      },
    })
    const title = titleSegments(view.title, view.banners, 66_000, theme, 120)
      .map((segment) => segment.text)
      .join("")
    expect(title).toContain("build/shop · 1m5s · spec .tutti/specs/shop.md")

    const ended = {
      version: "0.1.0",
      branch: "build/shop",
      scope: "shop-a1b",
      spec: spec.path,
      took: 125_000,
      totals: emptyView.totals,
      figures: [],
      rows: [],
    }
    expect(summaryLines({ ...ended, base: "build/shop" })[0] as string).toBe(
      "tutti 0.1.0 on build/shop · spec .tutti/specs/shop.md · 2m5s",
    )
    expect(Bun.stripANSI(summary(ended, theme, 100))).toContain(
      "build/shop · spec .tutti/specs/shop.md · 2m5s",
    )
  })
})
