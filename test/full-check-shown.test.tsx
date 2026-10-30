// The end-of-run full check on the dashboard (§ 7.2, § 5 item 12): Current's box says what it runs,
// the setup, then the check, with its command and time, in place of `picking the next ticket…`; the
// load line names what tutti runs besides its workers `full check` meanwhile; a quit during it says
// `stopping…`; a run that skips it never shows it.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Deferred, Duration, Effect, Fiber, Queue, SubscriptionRef } from "effect"
import { makeCommands } from "../src/run/commands.ts"
import { EventStream } from "../src/run/eventstream.ts"
import type { FullCheckRun } from "../src/run/fullcheck.ts"
import { Load, type LoadSource, parseProcesses } from "../src/run/load.ts"
import { line } from "../src/run/log.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { run } from "../src/run/run.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { type Dashboard, Screen, type ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Script, type Scripted } from "../src/testing/Checks.ts"
import { Root } from "../src/ui/App.tsx"
import { idleText } from "../src/ui/Card.tsx"
import { loadSegments } from "../src/ui/LoadLine.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { advance, expectExitCode, expectLog, scenario, type World } from "./harness.ts"
import { renderFrame } from "./render.ts"

const fullCommand = "scripts/check-full.sh"
const setupCommand = "bun install --frozen-lockfile"
const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")
const gb = 1024 ** 3

const text = (segments: Segments) => segments.map((each) => each.text).join("")

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-full-check-shown-${name}-`)))

/** The machine as a reading finds it: no worker's process, a command of tutti's own of 0.3 GB. */
const source: LoadSource = {
  processes: Effect.succeed(
    parseProcesses(
      [`${process.pid} 1 ${process.pid} 100000`, `9100 ${process.pid} 9100 314573`].join("\n"),
    ),
  ),
  kernel: Effect.succeed({ pressure: "normal", swaps: 0, load1: 9.7, cores: 10, available: -1 }),
}

/** RunView with no ticket and the machine read, `status` laid over the run's. */
const viewOf = (status: Partial<Status>): RunView =>
  project({
    ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
    workers: new Map(),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "main",
      concurrency: 2,
      load: {
        at: 0,
        workers: new Map(),
        check: 4.2 * gb,
        kernel: { pressure: "normal", swaps: 0, load1: 9.7, cores: 10, available: -1 },
        swapping: -1,
        levels: { cpu: "green", pressure: "green", swapping: "green" },
      },
      ...status,
    },
  })

/** The dashboard's lines for `view`, at `now`. */
const drawn = async (view: RunView, now: number): Promise<ReadonlyArray<string>> => {
  const value: ShellValue = {
    view: external(view),
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => now,
  }
  const frame = await renderFrame(<Root value={value} />, { width: 110, height: 30 })
  return frame.chars.split("\n").map((each) => each.trimEnd())
}

const setup: FullCheckRun = { step: "setup", command: setupCommand, began: 1_000 }
const check: FullCheckRun = { step: "check", command: fullCommand, began: 13_000 }

describe("Current's box with no worker in it", () => {
  test("says the full check's setup, then the check, with its command and time", () => {
    expect(idleText(false, setup, 13_000)).toBe(
      "setting up the full check: bun install --frozen-lockfile · 12s",
    )
    expect(idleText(false, check, 85_000)).toBe("full check: scripts/check-full.sh · 1m12s")
  })

  test("says stopping… over it, and picking the next ticket… without it", () => {
    expect(idleText(true, check, 85_000)).toBe("stopping…")
    expect(idleText(false, null, 85_000)).toBe("picking the next ticket…")
  })

  test("the dashboard draws it in Current, the load line naming the full check", async () => {
    const lines = await drawn(viewOf({ fullCheck: check }), 85_000)
    expect(lines.some((each) => each.includes("full check: scripts/check-full.sh · 1m12s"))).toBe(
      true,
    )
    expect(lines.join("\n")).not.toContain("picking the next ticket…")
    expect(lines[3]).toBe(
      " ▶ 0 of 2 workers · memory 4.2 GB (workers 0.0, full check 4.2) · pressure normal · load 9.7/10 cores",
    )
  })

  test("a quit meanwhile draws stopping…", async () => {
    const lines = await drawn(viewOf({ fullCheck: check, quitting: "Quitting…" }), 85_000)
    expect(lines.some((each) => each.includes("stopping…"))).toBe(true)
    expect(lines.join("\n")).not.toContain("full check: ")
  })
})

describe("RunView", () => {
  test("names the check's memory the merge check's without a full check running", () => {
    const view = viewOf({})
    expect(view.fullCheck).toBeNull()
    expect(view.load?.checkName).toBe("merge check")
    expect(text(loadSegments(view.totals, view.load, theme, 120))).toContain("merge check 4.2")
  })

  test("sanitises the full check's command", () => {
    const view = viewOf({ fullCheck: { ...check, command: "scripts/check\u001b[2J-full.sh" } })
    expect(view.fullCheck?.command).not.toContain("\u001b")
    expect(view.load?.checkName).toBe("full check")
  })
})

interface Seen {
  readonly at: number
  readonly view: RunView
}

interface Plan {
  readonly checks: Script
  /** The run has t-1, which merges; an empty backlog without. */
  readonly merges: boolean
  /** Holds the run's end record, written after the full check, until it opens. */
  readonly ending?: Deferred.Deferred<void>
  /** Runs beside the run, before it is joined; `view` reads the dashboard's RunView at a time. */
  readonly during?: (
    view: Effect.Effect<Seen>,
    quits: Queue.Queue<QuitRequest>,
  ) => Effect.Effect<void, unknown, never>
}

/** A whole run on main of t-1, with a setup and a full check, showing a dashboard. */
const runs = (plan: Plan) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const { settings } = appConfig()
  const quits = Effect.runSync(Queue.unbounded<QuitRequest>())
  return scenario(
    {
      config: {
        repo,
        settings: {
          ...settings,
          checks: {
            ...settings.checks,
            full: { command: fullCommand, timeout: Duration.minutes(60) },
            setup: { ...settings.checks.setup, command: setupCommand },
          },
        },
      },
      backlog: plan.merges ? [{ id: "t-1" }] : [],
      git: { dir: repo },
      worktrees: { root },
      checks: plan.checks,
      scripts: (world: World) => ({
        "t-1": [
          claimsAndCloses("t-1" as TicketId, {
            claim: Effect.asVoid(
              Effect.orDie(world.beads.update("t-1" as TicketId, { claim: true })),
            ),
            commit: Effect.asVoid(
              Effect.orDie(
                world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
              ),
            ),
            close: Effect.asVoid(Effect.orDie(world.beads.close("t-1" as TicketId, "done"))),
          }),
        ],
      }),
    },
    Effect.gen(function* () {
      yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
        branch: "tutti/t-1",
        base: "main",
      })
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      const views: Array<RunView> = []
      // RunView is written at most 30 times a second, on the Clock: move it on to see the latest.
      const view = Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          yield* advance("100 millis")
          yield* Effect.promise(() => Bun.sleep(10))
        }
        if (shown === undefined) throw new Error("the run showed no dashboard")
        const seen = yield* SubscriptionRef.get(shown.view)
        views.push(seen)
        return { at: yield* Clock.currentTimeMillis, view: seen }
      })
      const events = yield* EventStream
      const { ending } = plan
      const held: EventStream["Service"] = {
        ...events,
        emit: (event) =>
          event.kind === "end" && ending !== undefined
            ? Effect.andThen(Deferred.await(ending), events.emit(event))
            : events.emit(event),
      }
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
          quits,
        }).pipe(Effect.provideService(Load, source), Effect.provideService(EventStream, held)),
      )
      if (plan.during !== undefined) yield* plan.during(view, quits)
      const outcome = yield* Fiber.join(fiber)
      return { ...outcome, views }
    }),
  )
}

/** Reads the view until `ready` holds of it. */
const until = (view: Effect.Effect<Seen>, ready: (seen: Seen) => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const seen = yield* view
      if (ready(seen)) return seen
    }
    throw new Error("the view never got there")
  })

/** A check that passes once `gate` opens. */
const waits = (gate: Deferred.Deferred<void>, kind: "setup" | "full"): Scripted =>
  Effect.as(Deferred.await(gate), passed(kind))

/** The setups: the full check's waits for `gate`; a ticket's worktree's passes at once. */
const setups = (gate: Deferred.Deferred<void>): ReadonlyArray<Scripted> =>
  Array.from(
    { length: 5 },
    () => (ran: CheckRun) =>
      Effect.as(ran.before === "full" ? Deferred.await(gate) : Effect.void, passed("setup")),
  )

describe("a whole run's full check on the dashboard", () => {
  test("shows the setup's then the check's command and time, full check on the load line, then neither", async () => {
    const setupGate = Deferred.makeUnsafe<void>()
    const fullGate = Deferred.makeUnsafe<void>()
    const ending = Deferred.makeUnsafe<void>()
    const said: Array<string> = []
    let ended: RunView | undefined
    const ran = await runs({
      merges: true,
      ending,
      checks: { setup: setups(setupGate), full: [waits(fullGate, "full")] },
      during: (view) =>
        Effect.gen(function* () {
          yield* until(view, (seen) => seen.view.fullCheck?.step === "setup")
          yield* advance("12 seconds")
          const setting = yield* view
          said.push(idleText(false, setting.view.fullCheck, setting.at))
          said.push(text(loadSegments(setting.view.totals, setting.view.load, theme, 120)))
          yield* Deferred.succeed(setupGate, undefined)
          yield* until(view, (seen) => seen.view.fullCheck?.step === "check")
          yield* advance("72 seconds")
          const checking = yield* view
          said.push(idleText(false, checking.view.fullCheck, checking.at))
          yield* Deferred.succeed(fullGate, undefined)
          ended = (yield* until(view, (seen) => seen.view.fullCheck === null)).view
          yield* Deferred.succeed(ending, undefined)
        }),
    })
    expectExitCode(ran, 0)
    expectLog(ran, ["READY_EMPTY after 1 tickets", /^ {2}FULL_CHECK passed: /])
    expect(said[0]).toBe("setting up the full check: bun install --frozen-lockfile · 12s")
    expect(said[1]).toContain("(workers 0.0, full check 0.3)")
    expect(said[2]).toBe("full check: scripts/check-full.sh · 1m12s")
    expect(ended?.load?.checkName).toBe("merge check")
    expect(idleText(false, ended?.fullCheck ?? null, 0)).toBe("picking the next ticket…")
  })

  test("a run that merged nothing skips it and never shows it", async () => {
    const ran = await runs({
      merges: false,
      checks: {},
      during: (view) =>
        Effect.gen(function* () {
          for (let i = 0; i < 10; i++) yield* view
        }),
    })
    expectExitCode(ran, 0)
    expectLog(ran, ["READY_EMPTY after 0 tickets"])
    if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
    const { views } = ran.exit.value
    expect(ran.checkRuns.filter((each) => each.check === "full")).toEqual([])
    expect(views.length).toBeGreaterThan(0)
    expect(views.every((each) => each.fullCheck === null)).toBe(true)
    expect(views.every((each) => each.load?.checkName !== "full check")).toBe(true)
  })

  test("a quit during it: stopping…, the run INTERRUPTED", async () => {
    const released = Deferred.makeUnsafe<void>()
    // The check, interrupted, ends once the test has read the view.
    const hanging: Scripted = Effect.onInterrupt(Effect.never, () => Deferred.await(released))
    let stopping: RunView | undefined
    const ran = await runs({
      merges: true,
      checks: { full: [hanging] },
      during: (view, quits) =>
        Effect.gen(function* () {
          yield* until(view, (seen) => seen.view.fullCheck?.step === "check")
          yield* Queue.offer(quits, quitBy("SIGINT"))
          stopping = (yield* until(view, (seen) => seen.view.title.quitting !== null)).view
          yield* Deferred.succeed(released, undefined)
        }),
    })
    expectExitCode(ran, 130)
    expectLog(ran, [
      /^ {2}FULL_CHECK_SKIPPED: /,
      "INTERRUPTED: quit with Ctrl+C during the full check",
    ])
    if (stopping === undefined) throw new Error("no view while stopping")
    expect(stopping.fullCheck).toBeNull()
    const lines = await drawn(stopping, 0)
    expect(lines.some((each) => each.includes("stopping…"))).toBe(true)
  })
})
