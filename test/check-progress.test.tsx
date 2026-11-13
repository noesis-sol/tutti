// A check's PROGRESS: lines and the bar they fill (§ 3.3, § 7.2): what tutti reads of them, the
// checks running it keeps (checking.ts), the estimate from a check's recent passes where a suite
// counts nothing, the bar on the dashboard, the count a plain run says instead, and the lines
// scripts/test.ts prints as each test file ends.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { fileOfHeader, filesPicked, progressCounter, tee, testFilesUnder } from "../scripts/test.ts"
import { Log } from "../src/core/log.ts"
import { fastScript, fullScript } from "../src/project/runners.ts"
import { orchestra } from "../src/project/scheme.ts"
import { checkOnce } from "../src/run/check.ts"
import {
  Checking,
  type CheckShown,
  checkingLine,
  checkWords,
  estimateCap,
  fillOf,
  fullCheckKey,
  makeChecking,
  recentPasses,
  sayChecking,
  sayEvery,
  watchCheck,
} from "../src/run/checking.ts"
import { makeCommands } from "../src/run/commands.ts"
import { fullCheck } from "../src/run/fullcheck.ts"
import { run } from "../src/run/run.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import {
  type CheckAt,
  CheckOutput,
  noCheckAt,
  progressMarker,
  progressOf,
} from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed } from "../src/testing/Checks.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { Root } from "../src/ui/App.tsx"
import { actionLine, checkSegments, idleBox, idleText } from "../src/ui/Card.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { advance, backlog, scenario, type World } from "./harness.ts"
import { renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const text = (segments: Segments) => segments.map((each) => each.text).join("")

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-check-progress-${name}-`)))

/**
 * A check running, as the service shows it, `shown` laid over one of the full check's, its bar
 * filled as the service fills it, at `now`.
 */
const shownCheck = (shown: Partial<CheckShown> = {}, now = 0): CheckShown => {
  const all: CheckShown = {
    name: "full check",
    began: 0,
    suite: "test",
    progress: { done: 312, total: 848 },
    usual: null,
    fill: null,
    ...shown,
  }
  return { ...all, fill: fillOf(all, all.began, all.usual, now) }
}

/** What a check's output says of where it is, taken a chunk at a time. */
const takes = (output: string): { readonly at: CheckAt; readonly told: ReadonlyArray<CheckAt> } => {
  const told: Array<CheckAt> = []
  const taken = new CheckOutput((at) => told.push(at))
  taken.write(new TextEncoder().encode(output))
  taken.end()
  return { at: taken.at(), told }
}

describe("a PROGRESS: line", () => {
  test("is two whole numbers, done no more than total", () => {
    expect(progressOf("PROGRESS: 3/10")).toEqual({ done: 3, total: 10 })
    expect(progressOf("PROGRESS:7/10")).toEqual({ done: 7, total: 10 })
    expect(progressOf("  PROGRESS: 0 / 848  ")).toEqual({ done: 0, total: 848 })
    expect(progressOf("PROGRESS: 848/848")).toEqual({ done: 848, total: 848 })
  })

  test("is an ordinary line when it doesn't read as one", () => {
    for (const line of [
      "PROGRESS: 11/10",
      "PROGRESS: 3",
      "PROGRESS: 3/",
      "PROGRESS: -1/10",
      "PROGRESS: 3.5/10",
      "PROGRESS: 3/10 files",
      "PROGRESS: three/ten",
      "PROGRESS:",
      "PROGRESS: 1/2/3",
      "progress: 1/2",
      "running tests PROGRESS: 1/2",
    ]) {
      expect(progressOf(line)).toBeNull()
    }
  })

  test("every pair of whole numbers reads back, and nothing else is one", () => {
    fc.assert(
      fc.property(fc.nat(1_000_000), fc.nat(1_000_000), (a, b) => {
        const [done, total] = a <= b ? [a, b] : [b, a]
        expect(progressOf(`${progressMarker} ${done}/${total}`)).toEqual({ done, total })
      }),
    )
    // Whatever a check prints, reading it never throws and never gives done over total.
    fc.assert(
      fc.property(fc.string(), (line) => {
        const read = progressOf(line)
        expect(read === null || (read.done <= read.total && Number.isSafeInteger(read.done))).toBe(
          true,
        )
      }),
    )
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (rest) => {
        const read = progressOf(`${progressMarker} ${rest}`)
        if (read === null) return
        expect(`${read.done}/${read.total}`.replace(/\s/g, "")).toBe(rest.trim().replace(/\s/g, ""))
      }),
    )
  })
})

describe("what a check's output says of where it is", () => {
  test("keeps the latest PROGRESS: line of the suite running", () => {
    const { at, told } = takes("SUITE: test\nPROGRESS: 3/10\nok\nPROGRESS: 7/10\n")
    expect(at).toEqual({ suite: "test", progress: { done: 7, total: 10 } })
    expect(told).toEqual([
      { suite: "test", progress: null },
      { suite: "test", progress: { done: 3, total: 10 } },
      { suite: "test", progress: { done: 7, total: 10 } },
    ])
  })

  test("forgets it at the next SUITE: line", () => {
    const { at } = takes("SUITE: tsc\nPROGRESS: 3/10\nSUITE: test\n")
    expect(at).toEqual({ suite: "test", progress: null })
  })

  test("a malformed PROGRESS: line changes nothing, and is an ordinary line", () => {
    const { at, told } = takes("SUITE: test\nPROGRESS: 3/10\nPROGRESS: 11/10\n")
    expect(at).toEqual({ suite: "test", progress: { done: 3, total: 10 } })
    expect(told).toHaveLength(2)
    const taken = new CheckOutput()
    taken.write(new TextEncoder().encode("PROGRESS: 11/10\n"))
    taken.end()
    expect(taken.summary().lastLines).toEqual(["PROGRESS: 11/10"])
    expect(taken.at()).toEqual(noCheckAt)
  })

  test("a line split across chunks is read once it is whole", () => {
    const told: Array<CheckAt> = []
    const taken = new CheckOutput((at) => told.push(at))
    const encode = (part: string) => taken.write(new TextEncoder().encode(part))
    encode("SUITE: test\nPROG")
    expect(taken.at().progress).toBeNull()
    encode("RESS: 4/9\n")
    expect(taken.at()).toEqual({ suite: "test", progress: { done: 4, total: 9 } })
    expect(told).toHaveLength(2)
  })
})

describe("how full the bar is", () => {
  test("done over total where the suite counts", () => {
    expect(fillOf({ suite: "test", progress: { done: 3, total: 10 } }, 0, null, 60_000)).toEqual({
      filled: 0.3,
      count: "3/10",
      estimate: false,
    })
  })

  test("the time it has run against the median of its recent passes, marked as an estimate", () => {
    const fill = fillOf(noCheckAt, 10_000, 200, 60_000)
    expect(fill).toEqual({ filled: 0.25, count: "≈25%", estimate: true })
  })

  test("the estimate stops short of full until the check ends", () => {
    const fill = fillOf(noCheckAt, 0, 100, 1_000_000)
    expect(fill).toEqual({ filled: estimateCap, count: `≈${estimateCap * 100}%`, estimate: true })
  })

  test("no bar with no pass to go by", () => {
    expect(fillOf(noCheckAt, 0, null, 60_000)).toBeNull()
    expect(fillOf({ suite: "tsc", progress: null }, 0, 0, 60_000)).toBeNull()
  })
})

describe("the checks running", () => {
  test("a check watched shows while it runs and goes when it ends", async () => {
    const checking = makeChecking()
    const ran = await Effect.runPromise(
      Effect.gen(function* () {
        const seen: Array<ReadonlyArray<string>> = []
        yield* Effect.scoped(
          Effect.gen(function* () {
            const watched = yield* checking.watch("t-1", {
              name: "merge check",
              kind: "fast",
              began: 0,
              at: noCheckAt,
            })
            seen.push([...(yield* checking.now).keys()])
            watched.onAt({ suite: "test", progress: { done: 2, total: 4 } })
            const shown = (yield* checking.now).get("t-1")
            expect(shown?.suite).toBe("test")
            expect(shown?.fill).toEqual({ filled: 0.5, count: "2/4", estimate: false })
          }),
        )
        seen.push([...(yield* checking.now).keys()])
        return seen
      }),
    )
    expect(ran).toEqual([["t-1"], []])
  })

  test("the estimate is the median of the last passes of that check's kind", async () => {
    const checking = makeChecking()
    const shown = await Effect.runPromise(
      Effect.gen(function* () {
        for (const seconds of [10, 100, 200, 300, 400, 500]) {
          yield* checking.passed("fast", seconds)
        }
        // The full check's passes are its own: a merge check's don't estimate it.
        yield* checking.passed("full", 3_000)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* checking.watch("t-1", {
              name: "merge check",
              kind: "fast",
              began: 0,
              at: noCheckAt,
            })
            return (yield* checking.now).get("t-1")
          }),
        )
      }),
    )
    // The last recentPasses of the fast check's: 100…500, whose median is 300.
    expect(recentPasses).toBe(5)
    expect(shown?.usual).toBe(300)
  })

  test("an estimate read again is the same map until the percent it shows changes", async () => {
    const checking = makeChecking()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // A kind whose passes take 600 s: a percent of the bar is 6 s.
          yield* checking.passed("full", 600)
          yield* checking.watch(fullCheckKey, {
            name: "full check",
            kind: "full",
            began: yield* Clock.currentTimeMillis,
            at: noCheckAt,
          })
          const first = yield* checking.now
          expect(first.get(fullCheckKey)?.fill).toEqual({
            filled: 0,
            count: "≈0%",
            estimate: true,
          })
          yield* advance("1 second")
          expect(yield* checking.now).toBe(first)
          yield* advance("5 seconds")
          const later = yield* checking.now
          expect(later).not.toBe(first)
          expect(later.get(fullCheckKey)?.fill).toEqual({
            filled: 0.01,
            count: "≈1%",
            estimate: true,
          })
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test("the map read is the one read before while nothing drawn has changed", async () => {
    const checking = makeChecking()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watched = yield* checking.watch(fullCheckKey, {
            name: "full check",
            kind: "full",
            began: 0,
            at: noCheckAt,
          })
          watched.onAt({ suite: "test", progress: { done: 1, total: 4 } })
          const first = yield* checking.now
          expect(yield* checking.now).toBe(first)
          watched.onAt({ suite: "test", progress: { done: 2, total: 4 } })
          expect(yield* checking.now).not.toBe(first)
        }),
      ),
    )
  })
})

describe("the bar on the dashboard", () => {
  test("the suite, the bar and the count beside it", () => {
    expect(text(checkSegments(shownCheck({ progress: { done: 4, total: 8 } }), theme))).toBe(
      "test ━━━━──── 4/8",
    )
    expect(
      text(checkSegments(shownCheck({ suite: null, progress: { done: 1, total: 4 } }), theme)),
    ).toBe("━━────── 1/4")
  })

  test("the estimate is marked, and a suite with no bar is its name alone", () => {
    const estimated = shownCheck({ suite: "tsc", progress: null, usual: 100 }, 50_000)
    expect(text(checkSegments(estimated, theme))).toBe("tsc ━━━━──── ≈50%")
    expect(
      text(checkSegments(shownCheck({ suite: "tsc", progress: null, usual: null }), theme)),
    ).toBe("tsc")
  })

  test("Current's box draws it under the full check's line", () => {
    const check = { step: "check" as const, command: "scripts/check-full.sh", began: 13_000 }
    const lines = idleBox(
      idleText(false, { ...check, at: shownCheck() }, 85_000),
      theme,
      "⠋",
      60,
      undefined,
      undefined,
      checkSegments(shownCheck({ progress: { done: 424, total: 848 } }), theme),
    ).map((line) => text(line).trimEnd())
    expect(lines[1]).toContain("full check: scripts/check-full.sh · 1m12s")
    expect(lines[2]).toContain("test ━━━━──── 424/848")
  })

  test("a card draws it beside the action of the check running", () => {
    const card = {
      ticket: "t-1" as TicketId,
      label: "t-1",
      title: "Fix it",
      worker: 1,
      phase: { _tag: "Merging" as const, step: "check" as const },
      state: null,
      status: "merging",
      tone: "merging" as const,
      motion: "merging" as const,
      since: 0,
      action: "running the check on main",
      latest: null,
      steered: false,
      requests: [],
      check: shownCheck({ name: "merge check", progress: { done: 212, total: 848 } }),
    }
    expect(text(actionLine(card, theme) ?? [])).toBe(
      "   running the check on main · test ━━────── 212/848",
    )
    // With nothing said of it yet, the action line is as it was.
    expect(
      text(
        actionLine({ ...card, check: shownCheck({ suite: null, progress: null }) }, theme) ?? [],
      ),
    ).toBe("   running the check on main")
  })

  test("a suite's name is sanitised: a project's script wrote it", () => {
    const nasty = shownCheck({ suite: "test\u001b[31m\tfast", progress: { done: 1, total: 2 } })
    const view = project({
      ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
      workers: new Map(),
      requests: [],
      status: {
        ...emptyStatus,
        fullCheck: { step: "check", command: "scripts/check-full.sh", began: 0 },
        checking: new Map([[fullCheckKey, nasty]]),
      },
    })
    expect(view.fullCheck?.at?.suite).toBe("test fast")
  })

  test("the dashboard draws the full check's bar in Current", async () => {
    const view: RunView = project({
      ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
      workers: new Map(),
      requests: [],
      status: {
        ...emptyStatus,
        version: "0.1.0",
        branch: "main",
        concurrency: 2,
        fullCheck: { step: "check", command: "scripts/check-full.sh", began: 13_000 },
        checking: new Map([[fullCheckKey, shownCheck({ progress: { done: 424, total: 848 } })]]),
      } satisfies Status,
    })
    const value: ShellValue = {
      view: external(view),
      screen: external<Screen>(Screen.Dashboard()),
      commands: Effect.runSync(makeCommands),
      appearance: external<Appearance>("dark"),
      themeOf,
      now: () => 85_000,
    }
    const frame = await renderFrame(<Root value={value} />, { width: 110, height: 30 })
    expect(frame.chars).toContain("full check: scripts/check-full.sh · 1m12s")
    expect(frame.chars).toContain("test ━━━━──── 424/848")
  })
})

describe("a plain run, with no bar to draw", () => {
  test("says the count of each check running", () => {
    expect(checkingLine(fullCheckKey, shownCheck())).toBe("the full check: test 312/848")
    expect(
      checkingLine("t-1", shownCheck({ name: "merge check", suite: "tsc", progress: null })),
    ).toBe("t-1's merge check: tsc")
    expect(checkWords(shownCheck({ suite: null, progress: null, usual: null }))).toBeNull()
  })
})

describe("a run with no dashboard", () => {
  test("says how far each check running has got at intervals", async () => {
    const checking = makeChecking()
    const said = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watched = yield* checking.watch("t-1", {
            name: "merge check",
            kind: "fast",
            began: 0,
            at: noCheckAt,
          })
          const logs = yield* Log
          const saying = yield* Effect.forkChild(sayChecking(checking, logs))
          watched.onAt({ suite: "test", progress: { done: 3, total: 9 } })
          yield* advance(sayEvery)
          // Nothing new to say at the next interval; the line isn't said twice.
          yield* advance(sayEvery)
          watched.onAt({ suite: "test", progress: { done: 9, total: 9 } })
          yield* advance(sayEvery)
          const lines = yield* texts
          yield* Fiber.interrupt(saying)
          return lines
        }),
      ).pipe(Effect.provide(logLayer()), Effect.provide(TestClock.layer())),
    )
    expect(said).toEqual(["  t-1's merge check: test 3/9", "  t-1's merge check: test 9/9"])
  })
})

describe("the checks that show it", () => {
  test("a ticket's merge check is watched while it runs", async () => {
    const repo = folder("repo")
    const checking = makeChecking()
    const seen: Array<string | null> = []
    // The check prints its lines, as the live one does, and says where it is while it still runs.
    const checked = (run: CheckRun) =>
      Effect.gen(function* () {
        const taken = new CheckOutput(run.onAt)
        taken.write(new TextEncoder().encode("SUITE: test\nPROGRESS: 2/8\n"))
        const shown = (yield* checking.now).get("t-1")
        seen.push(shown === undefined ? null : (checkWords(shown) ?? null))
        return passed("fast")
      })
    const ran = await scenario(
      { config: { repo }, checks: { fast: [checked] } },
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const id = "t-1" as TicketId
        const worktree = (yield* worktrees.prepare(id)).path
        return yield* checkOnce({ id, worktree })
      }).pipe(Effect.provideService(Checking, checking)),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(seen).toEqual(["test 2/8"])
    expect(ran.checkRuns.every((each) => each.onAt !== undefined)).toBe(true)
    // Its pass is kept, for the estimate of the next check of its kind.
    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* checking.watch("t-2", {
            name: "merge check",
            kind: "fast",
            began: 0,
            at: noCheckAt,
          })
          return (yield* checking.now).get("t-2")
        }),
      ),
    )
    expect(after?.usual).not.toBeNull()
  })

  test("without a Checking, a check runs as ever and is told nothing", async () => {
    const repo = folder("repo")
    const ran = await scenario(
      { config: { repo } },
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const id = "t-1" as TicketId
        const worktree = (yield* worktrees.prepare(id)).path
        return yield* checkOnce({ id, worktree })
      }),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(ran.checkRuns.map((each) => each.onAt)).toEqual([undefined])
  })

  test("the full check is watched while it runs", async () => {
    const repo = folder("full-repo")
    const checking = makeChecking()
    const seen: Array<string | null> = []
    const checked = (run: CheckRun) =>
      Effect.gen(function* () {
        const taken = new CheckOutput(run.onAt)
        taken.write(new TextEncoder().encode("SUITE: e2e\nPROGRESS: 1/2\n"))
        const shown = (yield* checking.now).get(fullCheckKey)
        seen.push(shown === undefined ? null : (checkingLine(fullCheckKey, shown) ?? null))
        return passed("full")
      })
    const ran = await scenario(
      {
        config: {
          repo,
          settings: {
            ...appConfig().settings,
            checks: {
              ...appConfig().settings.checks,
              full: { command: "scripts/check-full.sh", timeout: Duration.minutes(60) },
              setup: { ...appConfig().settings.checks.setup, command: null },
            },
          },
        },
        git: { dir: repo },
        worktrees: { root: folder("full-worktrees") },
        backlog: backlog().seeds,
        checks: { full: [checked] },
      },
      fullCheck({ base: "main", started: 0 }).pipe(Effect.provideService(Checking, checking)),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(seen).toEqual(["the full check: e2e 1/2"])
    expect(ran.checkRuns.every((each) => each.check !== "full" || each.onAt !== undefined)).toBe(
      true,
    )
  })

  test("a spec run's checks gate runs its checks watched too", async () => {
    const repo = folder("gate-repo")
    const root = folder("gate-worktrees")
    const defaults = appConfig().settings
    const fast = "scripts/check-fast.sh"
    const full = "scripts/check-full.sh"
    const spec = "shop.md"
    const commits = (world: World, id: string, files: Record<string, string>) =>
      claimsAndCloses(id as TicketId, {
        claim: Effect.asVoid(Effect.orDie(world.beads.update(id as TicketId, { claim: true }))),
        commit: Effect.asVoid(
          Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
        ),
        close: Effect.asVoid(Effect.orDie(world.beads.close(id as TicketId, "done"))),
      })
    const ran = await scenario(
      {
        config: {
          repo,
          ticket: "s-1" as TicketId,
          specPath: spec,
          settings: {
            ...defaults,
            concurrent: 1,
            checks: {
              ...defaults.checks,
              setup: { ...defaults.checks.setup, command: null },
              fast: { command: fast, timeout: Duration.minutes(10) },
              full: { command: full, timeout: Duration.minutes(60) },
            },
          },
        },
        git: { dir: repo },
        worktrees: { root },
        backlog: backlog()
          .ticket("s-1", { type: "epic", metadata: { spec } })
          .ticket("s-1.1", { parent: "s-1", priority: 0, labels: ["solo"], metadata: { spec } })
          .ticket("s-1.2", { parent: "s-1", blockedBy: ["s-1.1"], metadata: { spec } }).seeds,
        scripts: (world) => ({
          "s-1.1": [
            commits(world, "s-1.1", {
              [fast]: fastScript([
                { name: "unit", command: "bun test", foundIn: "", serial: false },
              ]),
              [full]: fullScript(
                [{ name: "e2e", command: "bun run e2e", foundIn: "", serial: false }],
                false,
              ),
            }),
          ],
          "s-1.2": [commits(world, "s-1.2", { "shop.ts": "export {}\n" })],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["s-1.1", "s-1.2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        return yield* run({ version: "0.1.0-test", base: "main" })
      }),
    )
    // The gate's two check-fast runs and its check-full, the merge checks and the full check at the
    // run's end: every check the run runs says where it is, the setups before them aside.
    expect(ran.checkRuns.length).toBeGreaterThanOrEqual(5)
    expect(
      ran.checkRuns
        .filter((each) => each.check !== "setup")
        .every((each) => each.onAt !== undefined),
    ).toBe(true)
  })

  test("watchCheck gives the check nothing where the run keeps none", async () => {
    const given = await Effect.runPromise(Effect.scoped(watchCheck("t-1", "merge check", "fast")))
    expect(given).toEqual({})
  })
})

describe("this repository's tests", () => {
  test("a PROGRESS: line as each test file ends, ending at total over total", () => {
    const said: Array<string> = []
    // One process: bun test names the next file as the one before it ends.
    const counting = progressCounter(3, (line) => said.push(line))
    counting.take("test/a.test.ts:")
    counting.take("(pass) a > one [0.59ms]")
    expect(said).toEqual([])
    counting.take("test/b.test.ts:")
    // A rerun of a failed test names its file again; it isn't counted twice.
    counting.take("test/b.test.ts:")
    counting.take("test/c.test.ts:")
    counting.end()
    expect(said).toEqual(["PROGRESS: 1/3", "PROGRESS: 2/3", "PROGRESS: 3/3"])
    expect(said.map(progressOf)).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ])
  })

  test("with several processes it lags by the files in flight, never reading ahead of them", () => {
    const said: Array<string> = []
    const counting = progressCounter(4, (line) => said.push(line), 3)
    for (const file of ["a", "b", "c"]) counting.take(`test/${file}.test.ts:`)
    // Three processes have three files in flight: none of them has ended.
    expect(said).toEqual([])
    counting.take("test/d.test.ts:")
    expect(said).toEqual(["PROGRESS: 1/4"])
    counting.end()
    expect(said).toEqual(["PROGRESS: 1/4", "PROGRESS: 4/4"])
  })

  test("the last line isn't printed twice when every file was counted", () => {
    const said: Array<string> = []
    const counting = progressCounter(1, (line) => said.push(line))
    counting.take("test/a.test.ts:")
    counting.take("test/b.test.ts:")
    counting.end()
    expect(said).toEqual(["PROGRESS: 1/1"])
  })

  test("reads the file bun test names as it runs it, coloured or not", () => {
    expect(fileOfHeader("test/marks.test.ts:")).toBe("test/marks.test.ts")
    expect(fileOfHeader("\u001b[2mtest/a_test.tsx:\u001b[0m")).toBe("test/a_test.tsx")
    expect(fileOfHeader("(pass) the marks > each is one glyph")).toBeUndefined()
    expect(fileOfHeader("src/main.ts:")).toBeUndefined()
    expect(fileOfHeader("Ran 7 tests across 1 file.")).toBeUndefined()
  })

  test("counts the files the arguments name, else every one bun test would find", () => {
    const dir = folder("picked")
    mkdirSync(join(dir, "test", "deep"), { recursive: true })
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(dir, "test", "a.test.ts"), "")
    writeFileSync(join(dir, "test", "b.spec.tsx"), "")
    writeFileSync(join(dir, "test", "deep", "c_test.ts"), "")
    writeFileSync(join(dir, "test", "helper.ts"), "")
    writeFileSync(join(dir, "node_modules", "pkg", "d.test.ts"), "")
    expect(testFilesUnder(dir).length).toBe(3)
    expect(filesPicked([], dir)).toBe(3)
    expect(filesPicked(["--parallel=2", "test/a.test.ts"], dir)).toBe(1)
    // A folder given names the test files under it.
    expect(filesPicked(["test/deep"], dir)).toBe(1)
  })

  test("a PROGRESS: line starts a line of its own, whatever the chunks held", async () => {
    const written: Array<string> = []
    const to = {
      write: (what: Uint8Array | string) =>
        written.push(typeof what === "string" ? what : new TextDecoder().decode(what)),
    } as unknown as NodeJS.WriteStream
    const chunks = ["test/a.test.ts:\n(pass) a > one", " [0.59ms]\ntest/b.test.ts:\n", "(pass) b"]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    const counting = progressCounter(1, (line) => written.push(`${line}\n`))
    const all = await tee(stream, to, counting.take)
    expect(all).toBe(chunks.join(""))
    // Every PROGRESS: line is a line of its own: none is spliced onto a line still being printed.
    const lines = written.join("").split("\n")
    expect(lines.filter((line) => line.includes("PROGRESS:"))).toEqual(["PROGRESS: 1/1"])
  })
})
