// The account's usage windows (§ 4.12, § 7.2): read from every rate_limit_event's unifiedWindows,
// a field the SDK's types don't name, kept at their latest figure, shown on the title line all the
// time and recorded as usage_window events as they change.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import {
  make as makeUsageLimits,
  rateLimitOf,
  reportOf,
  windowsOf,
  withFigures,
} from "../src/agent/UsageLimits.ts"
import { emptyState } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import {
  type Banner,
  emptyStatus,
  emptyView,
  project,
  type RunView,
  type TitleView,
} from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses, emit, type SessionScript } from "../src/testing/AgentHost.ts"
import { widthOf } from "../src/ui/line.tsx"
import { gauge, titleSegments, windowLabel } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { advance, backlog, expectExitCode, expectPhases, scenario } from "./harness.ts"

setDefaultTimeout(30_000)

/** The two allowed rate_limit_events of test/fixtures/usage-limit/allowed.jsonl. */
const allowed = readFileSync(resolve(import.meta.dir, "fixtures/usage-limit/allowed.jsonl"), "utf8")
  .split("\n")
  .filter((text) => text !== "")
  .map((text) => JSON.parse(text) as { readonly rate_limit_info: SDKRateLimitInfo })

const fiveHourResets = 1_792_754_400_000
const weekResets = 1_792_929_600_000

describe("unifiedWindows, read defensively", () => {
  test("a real allowed event gives each window's utilization and reset, in milliseconds", () => {
    const info = allowed[0]?.rate_limit_info
    expect([...windowsOf(info)]).toEqual([
      ["five_hour", { utilization: 0.22, resetsAt: fiveHourResets }],
      ["seven_day", { utilization: 0.42, resetsAt: weekResets }],
    ])
    // The top-level figure is absent on an allowed event: only the windows have it.
    expect(rateLimitOf(info)).toMatchObject({ status: "allowed", utilization: null })
  })

  test("a missing or unreadable field gives no windows", () => {
    for (const info of [
      undefined,
      null,
      "allowed",
      { status: "allowed" },
      { unifiedWindows: null },
      { unifiedWindows: [{ utilization: 0.5 }] },
      { unifiedWindows: "five_hour" },
    ]) {
      expect(windowsOf(info).size).toBe(0)
    }
  })

  test("any window's name, each part only where it is a number at or above 0", () => {
    const read = windowsOf({
      unifiedWindows: {
        seven_day_opus: { utilization: 0.3 },
        five_hour: { resetsAt: 1_792_754_400_000, utilization: "17%" },
        seven_day: { utilization: -1, resetsAt: Number.NaN },
        overage: null,
        "": { utilization: 0.1 },
      },
    })
    expect([...read]).toEqual([
      ["seven_day_opus", { utilization: 0.3 }],
      ["five_hour", { resetsAt: fiveHourResets }],
    ])
  })

  test("never throws, and gives only finite figures at or above 0, whatever the CLI sends", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record({
            unifiedWindows: fc.dictionary(
              fc.string(),
              fc.oneof(
                fc.anything(),
                fc.record({ utilization: fc.anything(), resetsAt: fc.anything() }),
              ),
            ),
          }),
        ),
        (info) => {
          for (const figure of windowsOf(info).values()) {
            for (const part of [figure.utilization, figure.resetsAt]) {
              if (part !== undefined) expect(Number.isFinite(part) && part >= 0).toBe(true)
            }
            expect(figure.utilization !== undefined || figure.resetsAt !== undefined).toBe(true)
          }
        },
      ),
    )
  })

  test("a part an event leaves out keeps the window's earlier figure", () => {
    const first = withFigures(new Map(), new Map([["five_hour", { utilization: 0.1 }]]), 5)
    const next = withFigures(first, new Map([["five_hour", { resetsAt: 9 }]]), 7)
    expect(next.get("five_hour")).toEqual({ utilization: 0.1, resetsAt: 9, at: 7 })
    expect(withFigures(next, new Map(), 8)).toBe(next)
  })
})

describe("UsageLimits keeps the account's windows", () => {
  test("each at its latest figure, with when it was reported, an unreadable status or not", async () => {
    const windows = await Effect.gen(function* () {
      const usage = yield* makeUsageLimits
      yield* TestClock.setTime(1_000)
      yield* usage.report(reportOf(allowed[0]?.rate_limit_info))
      yield* TestClock.setTime(2_000)
      // A status this SDK doesn't name: the event isn't read, its windows are.
      yield* usage.report(
        reportOf({ status: "allowed_soon", unifiedWindows: { five_hour: { utilization: 0.3 } } }),
      )
      return yield* Stream.runHead(usage.windows)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
    expect(windows._tag === "Some" ? [...windows.value] : []).toEqual([
      ["five_hour", { utilization: 0.3, resetsAt: fiveHourResets, at: 2_000 }],
      ["seven_day", { utilization: 0.42, resetsAt: weekResets, at: 1_000 }],
    ])
  })
})

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
}

const windows: Banner = {
  _tag: "Windows",
  windows: [
    { name: "five_hour", utilization: 0.17, resetsAt: 3_600_000 },
    { name: "seven_day", utilization: 0.41, resetsAt: 7 * 86_400_000 },
  ],
}

/** The title line's text `width` columns wide at `now`. */
const text = (banners: ReadonlyArray<Banner>, width: number, now = 0) => {
  const segments = titleSegments(title, banners, now, theme, width)
  expect(widthOf(segments)).toBeLessThanOrEqual(width)
  return segments.map((segment) => segment.text).join("")
}

describe("the account's windows on the title line", () => {
  test("show in full, the first with its gauge and two spaces before its figure", () => {
    expect(text([windows], 120)).toEndWith("   Current usage ▰▰▱▱▱▱▱▱▱▱  17% · This week 41%")
    const segments = titleSegments(title, [windows], 0, theme, 120).map((s) => s.text)
    // The gauge, the gap and the figure are segments of their own, so a cut never joins them.
    expect(segments).toContain("▰▰▱▱▱▱▱▱▱▱")
    expect(segments[segments.indexOf("▰▰▱▱▱▱▱▱▱▱") + 1]).toBe("  ")
  })

  test("a narrow pane puts the tighter window first, then shows it alone", () => {
    expect(text([windows], 50)).toEndWith("  This week 41% · Current usage 17%")
    expect(text([windows], 30)).toEndWith("  This week 41%")
    expect(text([windows], 18)).toBe(" Tutti  0.1.0")
  })

  test("beside a hold, before which it is dropped", () => {
    const blocked: Banner = { _tag: "Hold", word: "BLOCKED", resetsAt: null }
    expect(text([windows, blocked], 120)).toEndWith(
      "Current usage ▰▰▱▱▱▱▱▱▱▱  17% · This week 41%  BLOCKED",
    )
    expect(text([windows, blocked], 24)).toEndWith("  BLOCKED")
  })

  test("a window whose reset has passed is left out", () => {
    expect(text([windows], 120, 3_600_000)).toEndWith("   This week ▰▰▰▰▱▱▱▱▱▱  41%")
    expect(text([windows], 120, 8 * 86_400_000)).toBe(" Tutti  0.1.0   main · 192h")
  })

  test("names and gauges", () => {
    expect(
      [
        "five_hour",
        "seven_day",
        "seven_day_opus",
        "seven_day_sonnet",
        "seven_day_oauth_apps",
        "monthly",
      ].map(windowLabel),
    ).toEqual([
      "Current usage",
      "This week",
      "This week (Opus)",
      "This week (Sonnet)",
      "This week (Oauth apps)",
      "monthly",
    ])
    expect([0, 0.04, 0.17, 0.5, 1, 1.3].map(gauge)).toEqual([
      "▱▱▱▱▱▱▱▱▱▱",
      "▱▱▱▱▱▱▱▱▱▱",
      "▰▰▱▱▱▱▱▱▱▱",
      "▰▰▰▰▰▱▱▱▱▱",
      "▰▰▰▰▰▰▰▰▰▰",
      "▰▰▰▰▰▰▰▰▰▰",
    ])
  })
})

describe("RunView's banners", () => {
  const view = (status: Partial<typeof emptyStatus>): RunView =>
    project(
      {
        ledger: emptyState,
        workers: new Map(),
        requests: [],
        status: { ...emptyStatus, ...status },
      },
      emptyView,
    )
  const shown = [{ name: "five_hour", utilization: 0.17, resetsAt: null }]

  test("the windows, while no usage banner is", () => {
    expect(view({ windows: shown }).banners).toEqual([{ _tag: "Windows", windows: shown }])
    expect(view({}).banners).toEqual([])
  })

  test("near a limit, the usage banner in their place", () => {
    const usage = { utilization: 0.85, resetsAt: null, limit: "five-hour" }
    expect(view({ windows: shown, usage }).banners).toEqual([{ _tag: "Usage", ...usage }])
  })
})

describe("a run", () => {
  test("shows the account's windows and records each figure as it changes", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-windows-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-windows-worktrees-")))
    let shown: ScreenInputs | undefined
    const ran = await scenario(
      {
        config: { repo },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => {
          const [taken, init, running, ...rest] = claimsAndCloses("t-1", {
            claim: Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
            commit: Effect.asVoid(
              Effect.orDie(
                world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
              ),
            ),
            close: Effect.asVoid(Effect.orDie(world.beads.close("t-1", "done"))),
          })
          const script: SessionScript = [
            ...[taken, init, running].flatMap((step) => (step === undefined ? [] : [step])),
            ...allowed.map((event) => emit(event)),
            // The same figures again: no record.
            ...allowed.slice(1).map((event) => emit(event)),
            ...rest,
          ]
          return { "t-1": [script] }
        },
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti`], dashboard }),
        )
        const outcome = yield* Fiber.join(fiber)
        yield* advance("100 millis")
        return outcome
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    const records = ran.events.flatMap((record) =>
      record.kind === "usage_window"
        ? [{ window: record.window, utilization: record.utilization, at: record.resets_at }]
        : [],
    )
    expect(records.map(({ window, utilization }) => [window, utilization])).toEqual([
      ["five_hour", 0.22],
      ["seven_day", 0.42],
      ["five_hour", 0.23],
    ])
    expect(records.every((record) => record.at !== undefined)).toBe(true)
    const view =
      shown === undefined ? undefined : await Effect.runPromise(SubscriptionRef.get(shown.view))
    expect(view?.banners).toEqual([
      {
        _tag: "Windows",
        windows: [
          { name: "five_hour", utilization: 0.23, resetsAt: fiveHourResets },
          { name: "seven_day", utilization: 0.42, resetsAt: weekResets },
        ],
      },
    ])
  })
})
