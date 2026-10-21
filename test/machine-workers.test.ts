// --machine-workers (src/run/machine.ts, run.ts; orchestra 0.8.5's orchestra-3vy1): a run sharing
// its folder of runs with another holds a free slot while the workers across them are at the cap,
// saying HOLD: MACHINE once, and fills it within seconds of one of the other run's finishing. A
// run with none of its own running never waits, and a registration whose run is gone counts no
// workers.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
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
import { Captured } from "../src/testing/EventStream.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
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

/** PID 4242 runs, 4343 is gone: neither's start can be read. */
const processes: ProcessCheck = {
  alive: (pid) => pid !== 4343,
  start: () => Effect.succeed(null),
}

/** The tickets dispatched, in order, with when: the second since the run began. */
const dispatches = (ran: Ran<unknown>) =>
  ran.events.flatMap((record) =>
    record.kind === "dispatch"
      ? [{ ticket: record.ticket, at: Math.floor(Date.parse(record.time) / 1000) }]
      : [],
  )

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

  test("--machine-workers, else TUTTI_MACHINE_WORKERS, else no cap", () => {
    expect(resolved({}, {}).machineWorkers).toBe(0)
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
        yield* passes("45 seconds")
        writeFileSync(join(runs, "run-4242-1.json"), other(1))
        yield* passes("15 seconds")
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
      "[1/40] a dispatching: a",
      /^HOLD: MACHINE: /,
      "[2/40] b dispatching: b",
    ])
    // The gone run's registration was removed; the run removed its own as it ended.
    expect(readdirSync(runs)).toEqual(["run-4242-1.json"])
  }, 30_000)
})
