// The machine's cap counts the run's slots (§ 8.2; run.ts's ownWorkers, schedule.ts's slots, as
// orchestra 0.9.4): tickets waiting to merge or merging take no slot up to `concurrent` of them, so
// they hold the run at no cap, keep the merge train checking ahead, and count in no registration.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type ProcessCheck, Processes } from "../src/run/machine.ts"
import { run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Backlog } from "../src/testing/Beads.ts"
import { passed } from "../src/testing/Checks.ts"
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
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-machine-cap-slots-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket and, after `takes`, commits and closes it, as a worker does. */
const works = (world: World, root: string, id: TicketId, takes: Duration.Input): SessionScript =>
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

/** A merge check that passes after `takes`. */
const slowCheck = (takes: Duration.Input) => Effect.as(Effect.sleep(takes), passed("fast"))

/** Every process runs, its start unknown: the run in this process is going. */
const everyoneAlive: ProcessCheck = { alive: () => true, start: () => Effect.succeed(null) }

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
 * Waits, in real time, until `ids` are claimed, their workers at work, before the clock moves on:
 * the run's start, and a settle, can write nothing for longer than `caughtUp`'s 30 ms on a loaded
 * machine, and a dispatch is due at the moment the clock stands at.
 */
const started = (ids: ReadonlyArray<TicketId>) =>
  Effect.gen(function* () {
    const backlog = yield* Backlog
    for (let i = 0; i < 2000; i++) {
      const claimed = new Set(
        (yield* backlog.issues).flatMap((issue) =>
          issue.status === "in_progress" ? [issue.id] : [],
        ),
      )
      if (ids.every((id) => claimed.has(id))) return
      yield* Effect.promise(() => Bun.sleep(5))
    }
    return yield* Effect.die(new Error(`the run didn't start ${ids.join(", ")}`))
  })

/** Moves TestClock on by `total`, a ready poll at a time, once the run has caught up each time. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const polls = Duration.toMillis(Duration.fromInputUnsafe(total)) / Duration.toMillis(readyPoll)
    for (let i = 0; i < polls; i++) {
      yield* caughtUp
      yield* advance(readyPoll)
    }
  })

/** The workers the run's registration in `runs` says it has running, read once. */
const registeredRunning = (runs: string): ReadonlyArray<number> =>
  readdirSync(runs)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(runs, name), "utf8")).running)

/** The tickets dispatched, in order, with when: the minute since the run began. */
const dispatches = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "dispatch"
      ? [`${record.ticket} ${Math.floor(Date.parse(record.time) / 60_000)}m`]
      : [],
  )

describe("the machine's cap", () => {
  test("counts slots: tickets waiting to merge don't hold the run, and the train checks ahead", async () => {
    // concurrent 4, a cap of 5, the run alone on the machine. m1, m2, w1 and w2 start at once. m1
    // settles at 1m, its check in its turn taking 5m, and w3 takes its slot. m2 settles at 2m: with
    // 3 working and 2 waiting to merge (5 tickets, 3 slots) w4 starts, with no HOLD: MACHINE, and m2
    // is checked ahead of its turn beside m1. At 3m the run's registration says the 4 slots taken,
    // not the 6 tickets going.
    const repo = folder("repo")
    const root = folder("worktrees")
    const runs = folder("runs")
    const defaults = appConfig().settings
    const ids = [
      "m1" as TicketId,
      "m2" as TicketId,
      "w1" as TicketId,
      "w2" as TicketId,
      "w3" as TicketId,
      "w4" as TicketId,
    ]
    const takes: Readonly<Record<string, Duration.Input>> = {
      m1: "1 minute",
      m2: "2 minutes",
      w1: "10 minutes",
      w2: "10 minutes",
      w3: "10 minutes",
      w4: "10 minutes",
    }
    let atThree: ReadonlyArray<number> = []
    const ran = await scenario(
      {
        config: {
          repo,
          worktrees: root,
          runs,
          machineWorkers: 5,
          settings: {
            ...defaults,
            concurrent: 4,
            checks: {
              ...defaults.checks,
              fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
            },
            merge: { ...defaults.merge, train: 1 },
          },
        },
        backlog: ids.reduce((built, id, i) => built.ticket(id, { priority: i }), backlog()).seeds,
        git: { dir: repo, files: { "README.md": "tutti\n" } },
        worktrees: { root },
        checks: { fast: [slowCheck("5 minutes"), slowCheck("5 minutes")] },
        scripts: (world: World) =>
          Object.fromEntries(ids.map((id) => [id, [works(world, root, id, takes[id] ?? 0)]])),
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
        yield* started(["m1" as TicketId, "m2" as TicketId, "w1" as TicketId, "w2" as TicketId])
        yield* passes("1 minute")
        yield* started(["w3" as TicketId])
        yield* passes("1 minute")
        yield* started(["w4" as TicketId])
        yield* passes("1 minute")
        yield* caughtUp
        atThree = registeredRunning(runs)
        yield* passes("11 minutes")
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { m1: "Done", m2: "Done", w1: "Done", w2: "Done", w3: "Done", w4: "Done" })
    expect(dispatches(ran)).toEqual(["m1 0m", "m2 0m", "w1 0m", "w2 0m", "w3 1m", "w4 2m"])
    expect(ran.log.filter((text) => text.startsWith("HOLD: MACHINE"))).toEqual([])
    expect(ran.events.filter((record) => record.kind === "machine_hold")).toEqual([])
    expect(atThree).toEqual([4])
    expectLog(ran, [
      "[5] w3 dispatching: w3",
      "  m2 settled: its worker is idle",
      "[6] w4 dispatching: w4",
      "  'scripted fast' passes on tutti/m1 on top of main",
    ])
    expectLog(ran, [
      "  m2 settled: its worker is idle",
      "  checking tutti/m2 ahead of its turn to merge, rebased onto tutti/m1 as it is checked",
      "  'scripted fast' passes on tutti/m2 ahead of its turn, on top of tutti/m1",
    ])
  }, 30_000)
})
