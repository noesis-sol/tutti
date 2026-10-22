// A hand-back's time limit on a loaded machine (handback.ts's clock), as orchestra 0.9.0 has it:
// the time the machine is loaded, its kernel's memory pressure, swapping or CPU pressing it
// (load.ts's pressing), or the run holding at --machine-workers, is left out of resolve_timeout, up
// to resolve_timeout again; the line ending a hand-back past it says how much more it was given.
// Whole runs under TestClock: the dashboard shown for the run to read the machine's load, or plain
// output with the run holding at --machine-workers.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { type Kernel, type Levels, Load, type LoadSource, pressing } from "../src/run/load.ts"
import { line } from "../src/run/log.ts"
import { type ProcessCheck, Processes } from "../src/run/machine.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import {
  awaitInterrupt,
  bash,
  init,
  interruptedResult,
  result,
  type SessionScript,
  type Step,
  sessionState,
  sleep,
  run as step,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

// Whole runs moving the clock on by the better part of an hour take a few seconds.
setDefaultTimeout(60_000)

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const green: Levels = { cpu: "green", pressure: "green", swapping: "green" }

describe("pressing", () => {
  test("is the memory pressure red, swapping under way or the CPU red", () => {
    expect(pressing(green)).toBe(false)
    expect(pressing({ ...green, pressure: "red" })).toBe(true)
    expect(pressing({ ...green, swapping: "amber" })).toBe(true)
    expect(pressing({ ...green, cpu: "red" })).toBe(true)
  })

  test("is not a CPU in amber alone, as a run's workers keep it", () => {
    expect(pressing({ ...green, cpu: "amber" })).toBe(false)
  })
})

interface Places {
  readonly repo: string
  readonly root: string
}

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-handback-load-${name}-`)))

/** Claims its ticket, does `first`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  places: Places,
  id: string,
  files: Files,
  first: ReadonlyArray<Step> = [],
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...first,
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(world.repository.commit(join(places.root, id), `Change (${id})`, files)),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** A turn that works on until tutti interrupts it. */
const interruptedTurn: SessionScript = [
  wait,
  init(),
  sessionState("running"),
  awaitInterrupt,
  interruptedResult,
  sessionState("idle"),
]

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** Whether a log line matches `pattern` after the run has had a moment, in real time. */
const logged = (pattern: RegExp) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => Bun.sleep(50))
    return (yield* texts).some((text) => pattern.test(text))
  })

/** Waits, in real time, until `id` is claimed: the run has dispatched it. */
const untilClaimed = (world: World, id: string) =>
  Effect.orDie(
    Effect.gen(function* () {
      for (let i = 0; i < 2000; i++) {
        if ((yield* world.beads.show(id)).status === "in_progress") return
        yield* Effect.promise(() => Bun.sleep(2))
      }
      throw new Error(`${id} was never claimed`)
    }),
  )

/** Waits, in real time, until main holds `files`. */
const untilOnMain = (world: World, files: Files) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const tree = yield* world.repository.tree("main")
      if (Object.entries(files).every(([path, text]) => tree.get(path) === text)) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`main never held ${Object.keys(files).join(", ")}`)
  }).pipe(Effect.orDie)

/**
 * a and b conflicting in shared.txt: b's rebase onto a's merge stops, and is handed back to b's
 * worker, which works on it until tutti stops it. a does `then` once b is claimed; c and d, when
 * there are, work on a file of their own, c for 30 minutes.
 */
const conflicting = (world: World, places: Places, then: Effect.Effect<void>): Scripts => ({
  a: [
    works(world, places, "a", { "shared.txt": "a\n" }, [
      step(untilClaimed(world, "b")),
      step(then),
    ]),
  ],
  c: [works(world, places, "c", { "c.txt": "c\n" }, [sleep("30 minutes")])],
  d: [works(world, places, "d", { "d.txt": "d\n" })],
  b: [
    [
      ...works(world, places, "b", { "shared.txt": "b\n" }, [
        step(untilOnMain(world, { "shared.txt": "a\n" })),
      ]),
      ...interruptedTurn,
      ...turn([]),
    ],
  ],
})

/** The machine's kernel, its memory pressure as `pressure()` says at each reading. */
const machine = (pressure: () => Kernel["pressure"]): LoadSource => ({
  processes: Effect.succeed(undefined),
  kernel: Effect.sync(() => ({
    pressure: pressure(),
    swaps: 0,
    load1: 1,
    cores: 10,
    available: -1,
  })),
})

/** How a run reads the machine: its load from `source`, with the dashboard shown, or `machine`. */
interface Machine {
  readonly source?: LoadSource
  /**
   * The folder of runs and the most workers across them (--machine-workers), with plain output; and
   * what a's worker does once b is claimed.
   */
  readonly runs?: {
    readonly dir: string
    readonly cap: number
    readonly onceBClaimed: Effect.Effect<void>
  }
  /** The tickets: a and b, and c and d after them. */
  readonly tickets?: ReadonlyArray<string>
  /** The run's slots: 2 unless said. */
  readonly concurrent?: number
}

/**
 * A whole run of a and b on main, two at a time, the machine read as `machine` says; `during` runs
 * beside it, before it is joined.
 */
const runsOn = (
  machine: Machine,
  during: Effect.Effect<void, unknown, Env>,
): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const tickets = machine.tickets ?? ["a", "b"]
  const { source, runs } = machine
  return scenario(
    {
      config: {
        repo: places.repo,
        ...(runs === undefined ? {} : { runs: runs.dir, machineWorkers: runs.cap }),
        settings: {
          ...defaults,
          concurrent: machine.concurrent ?? 2,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: tickets.reduce((built, id, i) => built.ticket(id, { priority: i }), backlog()).seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      scripts: (world: World) => conflicting(world, places, runs?.onceBClaimed ?? Effect.void),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      const start = { version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }
      const fiber = yield* Effect.forkChild(
        (source === undefined
          ? run(start)
          : run({ ...start, dashboard: () => Effect.void }).pipe(
              Effect.provideService(Load, source),
            )
        ).pipe(Effect.provideService(Processes, everyoneAlive)),
      )
      yield* during
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

/** A whole run of a and b with the dashboard shown and the machine's load read from `source`. */
const runs = (source: LoadSource, during: Effect.Effect<void, unknown, Env>) =>
  runsOn({ source }, during)

/** Every process runs, its start unknown: the other run in the folder of runs is going. */
const everyoneAlive: ProcessCheck = { alive: () => true, start: () => Effect.succeed(null) }

/** The other run's registration in the folder of runs, with `running` workers. */
const other = (running: number) =>
  JSON.stringify({
    pid: 4242,
    repo: "/work/other",
    concurrent: 3,
    started: new Date().toISOString(),
    running,
  })

const resolvingLine =
  "  RESOLVING: tutti/b conflicts with main in shared.txt; handed back to its worker to resolve (up to 20m)"

const stoppedLine = /^ {2}b's worker was stopped and told its hand-back is over$/

const expectClean = (ran: Ran<Outcome>) => {
  expectExitCode(ran, 0)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
}

describe("a hand-back on a loaded machine", () => {
  test("is given the time the machine is pressed, up to resolve_timeout again", async () => {
    let stoppedAt20 = true
    let stoppedAt39 = true
    const ran = await runs(
      machine(() => "warn"),
      Effect.gen(function* () {
        yield* untilLogged(/^ {2}RESOLVING: /)
        yield* advance("20 minutes")
        stoppedAt20 = yield* logged(stoppedLine)
        yield* advance("19 minutes")
        stoppedAt39 = yield* logged(stoppedLine)
        yield* advance("1 minute")
      }),
    )
    expect(stoppedAt20).toBe(false)
    expect(stoppedAt39).toBe(false)
    expectClean(ran)
    expectPhases(ran, { a: "Done", b: "Blocked" })
    expectLog(ran, [
      resolvingLine,
      "  b's worker was stopped and told its hand-back is over",
      /^ {2}MERGE_CONFLICT: b closed, .*\(handed back to its worker, but its worker is working after 20m \(and 20m more for the machine's load\), with the hand-back not done; the rebase was aborted\)/,
    ])
  })

  test("counts the time it isn't pressed toward resolve_timeout", async () => {
    let pressure: Kernel["pressure"] = "warn"
    let stoppedAt20 = true
    const ran = await runs(
      machine(() => pressure),
      Effect.gen(function* () {
        yield* untilLogged(/^ {2}RESOLVING: /)
        yield* advance("5 minutes")
        pressure = "normal"
        yield* advance("15 minutes")
        stoppedAt20 = yield* logged(stoppedLine)
        yield* advance("6 minutes")
      }),
    )
    expect(stoppedAt20).toBe(false)
    expectClean(ran)
    expectPhases(ran, { a: "Done", b: "Blocked" })
    // Read every 5 seconds, the machine is seen pressed up to 10 seconds past the 5 minutes.
    expectLog(ran, [
      resolvingLine,
      "  b's worker was stopped and told its hand-back is over",
      /^ {2}MERGE_CONFLICT: b closed, .*\(handed back to its worker, but its worker is working after 20m \(and 5m(?:[0-9]+s)? more for the machine's load\), with the hand-back not done; the rebase was aborted\)/,
    ])
  })

  test("not pressed, ends at resolve_timeout, its line saying nothing of the machine", async () => {
    const ran = await runs(
      machine(() => "normal"),
      Effect.gen(function* () {
        yield* untilLogged(/^ {2}RESOLVING: /)
        yield* advance("20 minutes")
      }),
    )
    expectClean(ran)
    expectPhases(ran, { a: "Done", b: "Blocked" })
    expectLog(ran, [
      resolvingLine,
      "  b's worker was stopped and told its hand-back is over",
      /^ {2}MERGE_CONFLICT: b closed, .*\(handed back to its worker, but its worker is working after 20m, with the hand-back not done; the rebase was aborted\)/,
    ])
  })

  test("is given the time the run holds at --machine-workers, with plain output", async () => {
    // A cap of 3, three slots, the other run with no worker: a, b and c start. Once b is claimed,
    // the other run has 2, so that d waits for the cap (HOLD: MACHINE) all through b's hand-back:
    // b's ticket, handed back, takes no slot (schedule.ts's slotsTaken), but c, working for 30
    // minutes, does.
    const dir = folder("runs")
    writeFileSync(join(dir, "run-4242-1.json"), other(0))
    let stoppedAt20 = true
    let stoppedAt39 = true
    const ran = await runsOn(
      {
        tickets: ["a", "b", "c", "d"],
        concurrent: 3,
        runs: {
          dir,
          cap: 3,
          onceBClaimed: Effect.sync(() => writeFileSync(join(dir, "run-4242-1.json"), other(2))),
        },
      },
      Effect.gen(function* () {
        yield* untilLogged(/^ {2}RESOLVING: /)
        yield* untilLogged(/^HOLD: MACHINE/)
        yield* advance("20 minutes")
        stoppedAt20 = yield* logged(stoppedLine)
        yield* advance("19 minutes")
        stoppedAt39 = yield* logged(stoppedLine)
        yield* advance("1 minute")
      }),
    )
    expect(stoppedAt20).toBe(false)
    expect(stoppedAt39).toBe(false)
    expectClean(ran)
    expectPhases(ran, { a: "Done", b: "Blocked", c: "Done", d: "Done" })
    expectLog(ran, [
      resolvingLine,
      "  b's worker was stopped and told its hand-back is over",
      /^ {2}MERGE_CONFLICT: b closed, .*\(handed back to its worker, but its worker is working after 20m \(and 20m more for the machine's load\), with the hand-back not done; the rebase was aborted\)/,
    ])
  })
})
