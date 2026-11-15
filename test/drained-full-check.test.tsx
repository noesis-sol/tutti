// The end-of-run full check of a run drained from the dashboard, or stopping after its current
// tickets (tutti-l8wp): Current's box says what the check runs and draws its bar as in a run that
// ended undrained, and says `stopping…` only with no check running or for a quit. A full check
// that passes keeps its time under its own kind, so the next run's has an estimate to draw before
// its first PROGRESS: line.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect } from "effect"
import { tuttiScheme } from "../src/project/scheme.ts"
import { Checking, type CheckShown, fillOf, fullCheckKey } from "../src/run/checking.ts"
import { makeCommands } from "../src/run/commands.ts"
import { fullCheck } from "../src/run/fullcheck.ts"
import type { WindDown } from "../src/run/ledger.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { emptyState, Store } from "../src/services/Store.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed } from "../src/testing/Checks.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { advance, backlog, scenario } from "./harness.ts"
import { renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-drained-full-check-${name}-`)))

const fullCommand = "scripts/check-full.sh"

/** The full check halfway through its tests, as the run's Checking shows it. */
const halfway = ((): CheckShown => {
  const at = { suite: "test", progress: { done: 424, total: 848 } }
  return {
    name: "full check",
    began: 13_000,
    ...at,
    usual: null,
    fill: fillOf(at, 13_000, null, 85_000),
  }
})()

/** The bar halfway, as long as Current's box draws it at 110 columns: longestBar's 48 cells. */
const halfBar = `test ${"━".repeat(24)}${"─".repeat(24)} 424/848`

/** A drain from the dashboard: no new tickets, none left running. */
const drained: WindDown = { since: 0, tickets: [] }

/** RunView with no ticket, the run's `windDown` and `status` laid over its own. */
const viewOf = (windDown: WindDown | null, status: Partial<Status>): RunView =>
  project({
    ledger: { tickets: new Map(), rows: 0, windDown, bugs: [] },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "main", concurrency: 2, ...status },
  })

/** The full check running, its bar halfway. */
const checking: Partial<Status> = {
  fullCheck: { step: "check", command: fullCommand, began: 13_000 },
  checking: new Map([[fullCheckKey, halfway]]),
}

/** The dashboard's lines for `view` at 85 s, 72 s into the full check. */
const drawn = async (view: RunView): Promise<string> => {
  const value: ShellValue = {
    view: external(view),
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => 85_000,
  }
  return (await renderFrame(<Root value={value} />, { width: 110, height: 30 })).chars
}

describe("Current's box while a stopping run's full check runs", () => {
  test("a drained run shows its step, command and time and its bar", async () => {
    const frame = await drawn(viewOf(drained, checking))
    expect(frame).toContain("full check: scripts/check-full.sh · 1m12s")
    expect(frame).toContain(halfBar)
    expect(frame).not.toContain("stopping…")
  })

  test("a run stopping after its current tickets shows them too", async () => {
    const frame = await drawn(viewOf(null, { ...checking, stopping: true }))
    expect(frame).toContain("full check: scripts/check-full.sh · 1m12s")
    expect(frame).toContain(halfBar)
    expect(frame).not.toContain("stopping…")
  })

  test("a drained run with no check running says stopping…", async () => {
    const frame = await drawn(viewOf(drained, {}))
    expect(frame).toContain("stopping…")
    expect(frame).not.toContain("full check: ")
  })

  test("a quit says stopping… over the check, and no bar", async () => {
    const frame = await drawn(viewOf(drained, { ...checking, quitting: "Quitting…" }))
    expect(frame).toContain("stopping…")
    expect(frame).not.toContain("full check: ")
    expect(frame).not.toContain("424/848")
  })
})

/**
 * The full check alone, no setup, in a scenario starting from `passes` in state.json: it runs
 * `during` with the run's Checking as it starts, then passes after `seconds`. What state.json's
 * passes are once it has ended.
 */
const fullCheckFrom = (
  name: string,
  passes: Record<string, ReadonlyArray<number>>,
  seconds: number,
  during: (checking: Checking["Service"]) => Effect.Effect<void> = () => Effect.void,
) => {
  const repo = folder(`${name}-repo`)
  const defaults = appConfig().settings
  // The run's Checking, as the check that runs reads it.
  let checking: Checking["Service"] | undefined
  const checked = (_: CheckRun) =>
    Effect.gen(function* () {
      if (checking !== undefined) yield* during(checking)
      yield* advance(Duration.seconds(seconds))
      return passed("full")
    })
  return scenario(
    {
      config: {
        repo,
        settings: {
          ...defaults,
          checks: {
            ...defaults.checks,
            full: { command: fullCommand, timeout: Duration.minutes(60) },
            setup: { ...defaults.checks.setup, command: null },
          },
        },
      },
      state: { ...emptyState, passes },
      git: { dir: repo },
      worktrees: { root: folder(`${name}-worktrees`) },
      backlog: backlog().seeds,
      checks: { full: [checked] },
    },
    Effect.gen(function* () {
      checking = yield* Checking
      yield* fullCheck({ base: "main", started: 0 })
      return (yield* (yield* Store).state).passes
    }).pipe(Effect.provide(Checking.layer)),
  )
}

describe("a full check's pass kept for the next run", () => {
  test("is written to state.json under the full check's kind", async () => {
    const ran = await fullCheckFrom("kept", { setup: [0.5], fast: [500] }, 776.7)
    expect(ran.exit._tag).toBe("Success")
    const passes = ran.exit._tag === "Success" ? ran.exit.value : undefined
    expect(passes).toEqual({ setup: [0.5], fast: [500], full: [776.7] })
  })

  test("the next run's full check shows the estimate before its first PROGRESS: line", async () => {
    let shown: CheckShown | undefined
    const ran = await fullCheckFrom("estimated", { full: [600] }, 10, (checking) =>
      Effect.gen(function* () {
        yield* advance(Duration.seconds(300))
        shown = (yield* checking.now).get(fullCheckKey)
      }),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(shown?.progress).toBeNull()
    expect(shown?.usual).toBe(600)
    expect(shown?.fill).toEqual({ filled: 0.5, count: "≈50%", estimate: true })
  })
})
