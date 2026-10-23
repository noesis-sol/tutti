// --machine-workers (src/run/machine.ts, run.ts; orchestra 0.8.5's orchestra-3vy1): a run sharing
// its folder of runs with another holds a free slot while the workers across them are at the cap,
// saying HOLD: MACHINE once, and fills it within seconds of one of the other run's finishing. A
// run with none of its own running never waits, and a registration whose run is gone counts no
// workers.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Option, Result } from "effect"
import { defaultSettings, defaultUserConfig, resolve } from "../src/cli/AppConfig.ts"
import { noFlags, type RunFlagName } from "../src/cli/flags.ts"
import { line } from "../src/run/log.ts"
import { type ProcessCheck, Processes } from "../src/run/machine.ts"
import { run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Backlog } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-machine-workers-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket and, after `takes`, commits and closes it, as a worker does. */
const works = (world: World, root: string, id: string, takes: Duration.Input): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(takes),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(
          world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: `${id}\n` }),
        ),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** Waits, in real time, until the run has written no log line or record for 30 ms. */
const caughtUp = Effect.gen(function* () {
  const captured = yield* Captured
  let said = -1
  for (let i = 0, still = 0; i < 1000 && still < 6; i++) {
    const now = (yield* texts).length + (yield* captured.records).length
    still = now === said ? still + 1 : 0
    said = now
    yield* Effect.promise(() => Bun.sleep(5))
  }
})

/**
 * Waits, in real time, until `ids` are claimed, their workers at work, and the run has recorded
 * `kinds`: the run's start writes nothing for longer than `caughtUp`'s 30 ms on a loaded machine,
 * and its first dispatch is due at the clock's start.
 */
const started = (ids: ReadonlyArray<string>, kinds: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const backlog = yield* Backlog
    const captured = yield* Captured
    for (let i = 0; i < 2000; i++) {
      const claimed = new Set(
        (yield* backlog.issues).flatMap((issue) =>
          issue.status === "in_progress" ? [issue.id] : [],
        ),
      )
      const recorded = new Set((yield* captured.records).map((record) => record.kind))
      if (ids.every((id) => claimed.has(id)) && kinds.every((kind) => recorded.has(kind))) return
      yield* Effect.promise(() => Bun.sleep(5))
    }
    return yield* Effect.die(new Error(`the run didn't start ${ids.join(", ")}`))
  })

/**
 * Moves TestClock on a second at a time, once the run has caught up each time, until `ticket` is
 * dispatched, for at most `total`. The run looks at the other runs 2 seconds after its last look
 * ended: on a loaded machine one can outlast `caughtUp`, and a second more would make the dispatch
 * late. So once a look has asked after PID 4242 since `since` looks, the clock waits for up to 2
 * seconds of real time for the dispatch; a look under way as the registration changed may have read
 * it before, and dispatch nothing.
 */
const untilDispatched = (ticket: string, since: number, total: Duration.Input) =>
  Effect.gen(function* () {
    const captured = yield* Captured
    const dispatched = Effect.map(captured.records, (records) =>
      records.some((record) => record.kind === "dispatch" && record.ticket === ticket),
    )
    let seen = since
    for (let i = 0; i < Duration.toSeconds(Duration.fromInputUnsafe(total)); i++) {
      yield* caughtUp
      for (let j = 0; looks > seen && j < 400 && !(yield* dispatched); j++) {
        yield* Effect.promise(() => Bun.sleep(5))
      }
      seen = looks
      if (yield* dispatched) return
      yield* advance("1 second")
    }
  })

/** Moves TestClock on by `total`, `step` at a time, once the run has caught up each time. */
const passes = (total: Duration.Input, step: Duration.Input = "1 second") =>
  Effect.gen(function* () {
    const steps =
      Duration.toMillis(Duration.fromInputUnsafe(total)) /
      Duration.toMillis(Duration.fromInputUnsafe(step))
    for (let i = 0; i < steps; i++) {
      yield* caughtUp
      yield* advance(step)
    }
  })

/** The other run, orchestra's, as its registration says, with `running` workers. */
const other = (running: number) =>
  JSON.stringify({
    pid: 4242,
    repo: "/work/other",
    concurrent: 3,
    started: new Date().toISOString(),
    running,
  })

/** Every process runs, its start unknown: the two runs in this process are both going. */
const everyoneAlive: ProcessCheck = { alive: () => true, start: () => Effect.succeed(null) }

/** The looks at the other runs that have read PID 4242's registration so far. */
let looks = 0

/** PID 4242 runs, 4343 is gone: neither's start can be read. Each look asks after 4242. */
const processes: ProcessCheck = {
  alive: (pid) => {
    if (pid === 4242) looks++
    return pid !== 4343
  },
  start: () => Effect.succeed(null),
}

/** The tickets dispatched, in order, with when: the second since the run began. */
const dispatches = (ran: Ran<unknown>) =>
  ran.events.flatMap((record) =>
    record.kind === "dispatch"
      ? [{ ticket: record.ticket, at: Math.floor(Date.parse(record.time) / 1000) }]
      : [],
  )

/** From the machine's hold on: the records' kinds, with the queue's count and `machine_full`. */
const holding = (ran: Ran<unknown>): ReadonlyArray<string> => {
  const from = ran.events.findIndex((record) => record.kind === "machine_hold")
  return ran.events
    .slice(from)
    .flatMap((record) =>
      record.kind === "machine_hold"
        ? ["machine_hold"]
        : record.kind === "queue" || record.kind === "dispatch"
          ? [`${record.kind} ${record.queued}${record.machine_full ? " machine_full" : ""}`]
          : [],
    )
}

/** Whether the run's log has a line `pattern` matches. */
const said = (pattern: RegExp) =>
  Effect.map(texts, (lines) => lines.some((text) => pattern.test(text)))

/** The registrations in `runs` whose run has `running` workers, waited for in real time. */
const registered = async (runs: string, running: number): Promise<string> => {
  for (let i = 0; i < 1000; i++) {
    for (const name of readdirSync(runs)) {
      if (!name.endsWith(".json")) continue
      const text = readFileSync(join(runs, name), "utf8")
      if (JSON.parse(text).running === running) return name
    }
    await Bun.sleep(10)
  }
  throw new Error(`no run in ${runs} has ${running} running`)
}

/** Waits, in real time, until the registration `name` is gone from `runs`. */
const gone = async (runs: string, name: string): Promise<void> => {
  for (let i = 0; i < 1000 && existsSync(join(runs, name)); i++) await Bun.sleep(10)
  if (existsSync(join(runs, name))) throw new Error(`${name} is still in ${runs}`)
}

/**
 * A whole tutti run of its own, with 2 slots and a cap of 2 across the machine, registering in
 * `runs`: each ticket's worker takes as long as `tickets` says, and `drive` moves its clock.
 */
const loop = async <A>(
  runs: string,
  tickets: Readonly<Record<string, Duration.Input>>,
  drive: (repo: string) => Effect.Effect<A, never, Env>,
) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const ids = Object.keys(tickets)
  const seeds = ids.reduce((built, id, i) => built.ticket(id, { priority: i }), backlog()).seeds
  const ran = await scenario(
    {
      config: {
        repo,
        worktrees: root,
        runs,
        machineWorkers: 2,
        settings: { ...appConfig().settings, concurrent: 2 },
      },
      backlog: seeds,
      git: { dir: repo, files: { "README.md": "tutti\n" } },
      worktrees: { root },
      scripts: (world: World) =>
        Object.fromEntries(ids.map((id) => [id, [works(world, root, id, tickets[id] ?? 0)]])),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ids) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }).pipe(
          Effect.provideService(Processes, everyoneAlive),
        ),
      )
      yield* drive(repo)
      return yield* Fiber.join(fiber)
    }),
  )
  return { ran, repo }
}

describe("the cap and the folder of runs", () => {
  const resolved = (flags: Partial<Record<RunFlagName, string>>, env: Record<string, string>) => {
    const config = resolve({
      repo: "/work/project",
      flags: {
        ...noFlags,
        ...Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, Option.some(v)])),
      },
      env: (name) => env[name],
      user: defaultUserConfig,
      settings: defaultSettings,
    })
    if (Result.isFailure(config)) throw new Error(config.failure.join("\n"))
    return config.success
  }

  test("--machine-workers, else TUTTI_MACHINE_WORKERS, else a cap", () => {
    expect(resolved({}, {}).machineWorkers).toBeGreaterThanOrEqual(2)
    expect(resolved({ machineWorkers: "0" }, {}).machineWorkers).toBe(0)
    expect(resolved({}, { TUTTI_MACHINE_WORKERS: "4" }).machineWorkers).toBe(4)
    expect(resolved({ machineWorkers: "3" }, { TUTTI_MACHINE_WORKERS: "4" }).machineWorkers).toBe(3)
    const bad = resolve({
      repo: "/work/project",
      flags: { ...noFlags, machineWorkers: Option.some("many") },
      env: () => undefined,
      user: defaultUserConfig,
      settings: defaultSettings,
    })
    expect(Result.isFailure(bad)).toBe(true)
  })

  test("the folder is ORCHESTRA_RUNS_DIR, else orchestra's, else none without a home", () => {
    expect(resolved({}, { ORCHESTRA_RUNS_DIR: "/runs", HOME: "/home/me" }).runs).toBe("/runs")
    expect(resolved({}, { ORCHESTRA_RUNS_DIR: "off", HOME: "/home/me" }).runs).toBeNull()
    expect(resolved({}, { HOME: "/home/me" }).runs).toMatch(/^\/home\/me\/.*orchestra\/runs$/)
    expect(resolved({}, {}).runs).toBeNull()
  })
})

describe("--machine-workers", () => {
  test("holds a free slot at the cap, and fills it once the other run's worker finishes", async () => {
    // A cap of 3, two slots. The other run has 2 workers running, and a registration whose run is
    // gone says 5 more, which count for nothing. a starts at once; b would make 4, and waits. At
    // 45 s one of the other run's workers finishes: b starts within 2 seconds, at the next look,
    // long before a's slot frees at 10 minutes.
    const repo = folder("repo")
    const root = folder("worktrees")
    const runs = folder("runs")
    writeFileSync(join(runs, "run-4242-1.json"), other(2))
    writeFileSync(
      join(runs, "run-4343-1.json"),
      JSON.stringify({
        pid: 4343,
        repo: "/work/gone",
        started: "2026-10-21T09:00:00Z",
        running: 5,
      }),
    )
    const defaults = appConfig().settings
    const ran = await scenario(
      {
        config: {
          repo,
          worktrees: root,
          runs,
          machineWorkers: 3,
          settings: { ...defaults, concurrent: 2 },
        },
        backlog: backlog().ticket("a", { priority: 0 }).ticket("b", { priority: 1 }).seeds,
        git: { dir: repo, files: { "README.md": "tutti\n" } },
        worktrees: { root },
        scripts: (world: World) => ({
          a: [works(world, root, "a", "10 minutes")],
          b: [works(world, root, "b", "1 minute")],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["a", "b"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }).pipe(
            Effect.provideService(Processes, processes),
          ),
        )
        yield* started(["a"], ["machine_hold"])
        yield* passes("45 seconds")
        const since = looks
        writeFileSync(join(runs, "run-4242-1.json"), other(1))
        yield* untilDispatched("b", since, "15 seconds")
        yield* passes("11 minutes", "30 seconds")
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    const [a, b] = dispatches(ran)
    expect(a).toEqual({ ticket: "a", at: 0 })
    expect(b?.ticket).toBe("b")
    expect(b?.at).toBeGreaterThanOrEqual(45)
    expect(b?.at).toBeLessThanOrEqual(47)
    const holds = ran.log.filter((text) => text.startsWith("HOLD: MACHINE"))
    expect(holds).toEqual([
      "HOLD: MACHINE: the machine's tutti and orchestra runs have 3 workers running, 1 of them this run's, at the cap of 3 (--machine-workers); the next ticket starts once one of them finishes",
    ])
    expect(ran.events.filter((record) => record.kind === "machine_hold")).toHaveLength(1)
    expect(ran.events.filter((record) => record.kind === "shared_machine")).toEqual([
      expect.objectContaining({
        shared: 1,
        text: "SHARED_MACHINE: another orchestra run is going in /work/other with 3 workers; their checks slow each other down",
      }),
    ])
    expectLog(ran, [
      /^SHARED_MACHINE: another orchestra run/,
      "[1] a dispatching: a",
      /^HOLD: MACHINE: /,
      "[2] b dispatching: b",
    ])
    // The queue says the hold as it begins and as it ends, and no record after it.
    expect(holding(ran)).toEqual(["machine_hold", "queue 1 machine_full", "queue 1", "dispatch 0"])
    // The gone run's registration was removed; the run removed its own as it ended.
    expect(readdirSync(runs)).toEqual(["run-4242-1.json"])
  }, 30_000)

  test("two tutti runs sharing a folder hold each other to the cap", async () => {
    // A cap of 2 across two runs. The first runs f, for 10 minutes on its own clock; once it has
    // registered with f running, the second starts s and holds t: 1 of its own and 1 of the
    // first's. Once the first run has ended, its file gone, t starts within 2 seconds.
    const runs = folder("runs")
    const firstEnds = Promise.withResolvers<void>()
    const firstRun = loop(runs, { f: "10 minutes" }, (repo) =>
      Effect.gen(function* () {
        yield* passes("5 seconds")
        // Waits, in real time, until the second run holds, then finishes f.
        yield* Effect.promise(() => firstEnds.promise)
        yield* passes("11 minutes", "30 seconds")
        return repo
      }),
    )
    const first = await registered(runs, 1)
    const secondRun = loop(runs, { s: "20 minutes", t: "1 minute" }, () =>
      Effect.gen(function* () {
        for (let i = 0; i < 300 && !(yield* said(/^HOLD: MACHINE/)); i++) yield* passes("1 second")
        firstEnds.resolve()
        yield* Effect.promise(() => gone(runs, first))
        yield* passes("15 seconds")
        yield* passes("21 minutes", "30 seconds")
      }),
    )
    const [ranFirst, ranSecond] = await Promise.all([firstRun, secondRun])
    expectExitCode(ranFirst.ran, 0)
    expectExitCode(ranSecond.ran, 0)
    expectPhases(ranSecond.ran, { s: "Done", t: "Done" })
    expectLog(ranSecond.ran, [
      new RegExp(`^SHARED_MACHINE: another tutti run is going in ${ranFirst.repo} with 2 workers`),
      "[1] s dispatching: s",
      "HOLD: MACHINE: the machine's tutti and orchestra runs have 2 workers running, 1 of them this run's, at the cap of 2 (--machine-workers); the next ticket starts once one of them finishes",
      `  the other tutti run in ${ranFirst.repo} has ended`,
      "[2] t dispatching: t",
    ])
    expect(holding(ranSecond.ran)).toEqual([
      "machine_hold",
      "queue 1 machine_full",
      "queue 1",
      "dispatch 0",
    ])
    // The first run saw the second, and neither left its file behind.
    expectLog(ranFirst.ran, [
      new RegExp(`^SHARED_MACHINE: another tutti run is going in ${ranSecond.repo} with 2 workers`),
    ])
    expect(readdirSync(runs)).toEqual([])
  }, 60_000)
})
