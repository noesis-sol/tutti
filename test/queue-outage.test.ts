// bd failing to read the queue for a while (queueOutage.ts, run.ts's fill): a failed fill skips
// that look's dispatch and a later look reads the queue again, backing off; the run doesn't end on
// the tickets it couldn't see, and stops with BEADS_FAILED only once bd has failed every read for
// beadsOutage. Runs under the scenario's TestClock, moved on a few seconds at a time.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import {
  backoff,
  failedRead,
  lasted,
  readBackoffMax,
  readDue,
  sustained,
} from "../src/run/queueOutage.ts"
import { run } from "../src/run/run.ts"
import { decide, type Snapshot } from "../src/run/runEnd.ts"
import { beadsOutage, readyPoll } from "../src/run/schedule.ts"
import { Beads, BeadsFailed, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses, type SessionScript } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import {
  advance,
  expectExitCode,
  expectLog,
  expectPhases,
  scenario,
  type World,
} from "./harness.ts"

const minute = Duration.toMillis(Duration.minutes(1))

describe("an outage of the queue's reads", () => {
  test("reads again at the next look, then a poll later, doubling to readBackoffMax", () => {
    expect([1, 2, 3, 4, 5, 9].map((failed) => Duration.toMillis(backoff(failed)))).toEqual([
      0,
      Duration.toMillis(readyPoll),
      2 * Duration.toMillis(readyPoll),
      Duration.toMillis(readBackoffMax),
      Duration.toMillis(readBackoffMax),
      Duration.toMillis(readBackoffMax),
    ])
  })

  test("counts from its first failure, and is due only once its backoff has passed", () => {
    const first = failedRead(null, 1000)
    expect(first).toEqual({ since: 1000, failed: 1, next: 1000 })
    expect(readDue(null, 0)).toBe(true)
    expect(readDue(first, 1000)).toBe(true)
    const second = failedRead(first, 31_000)
    expect(second).toEqual({
      since: 1000,
      failed: 2,
      next: 31_000 + Duration.toMillis(readyPoll),
    })
    expect(readDue(second, 31_000)).toBe(false)
    expect(readDue(second, second.next)).toBe(true)
  })

  test("is sustained once it has lasted beadsOutage, said to the second", () => {
    const outage = failedRead(null, 0)
    const limit = Duration.toMillis(beadsOutage)
    expect(sustained(outage, limit - 1)).toBe(false)
    expect(sustained(outage, limit)).toBe(true)
    expect(lasted(outage, minute + 30_400)).toBe("1m30s")
  })
})

const snapshot = (fields: Partial<Snapshot>): Snapshot => ({
  mergedBefore: true,
  running: new Set(),
  tickets: new Map(),
  overLimit: new Set(),
  asking: [],
  canTake: true,
  resuming: false,
  answering: false,
  settled: true,
  triagePending: 0,
  dashboard: false,
  held: false,
  usageHeld: false,
  endAsked: false,
  ...fields,
})

describe("the run's end with the queue unread", () => {
  test("isn't reached while the run would take tickets: it reads the queue again", () => {
    expect(decide(snapshot({ unread: true }))._tag).toBe("Busy")
    expect(decide(snapshot({ unread: false }))._tag).toBe("Done")
  })

  test("is reached once a stop holds the run, which takes no ticket", () => {
    expect(decide(snapshot({ unread: true, canTake: false, held: true }))._tag).toBe("Done")
  })
})

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-qo-${name}-`)))

/** How bd fails in the run: bd ready for a time from its start, bd show t-1 as its worker closes it. */
interface Faults {
  readonly ready?: Duration.Duration
  /** How many of bd show t-1's calls fail once the worker has closed it. */
  readonly show?: number
}

/**
 * Claims, commits and closes its ticket, as a worker does; then bd show of it fails, database is
 * locked, `show` times.
 */
const finishes = (world: World, root: string, id: TicketId, show: number): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.andThen(
      Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
      show === 0
        ? Effect.void
        : world.backlog.fail("show", { id, times: show, stderr: "database is locked" }),
    ),
  })

/**
 * A run of one ticket, t-1, bd failing as `faults` say, database is locked, the clock moved on 3
 * seconds at a time until the run ends.
 */
const runs = (faults: Faults) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
      backlog: [{ id: "t-1" }],
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => ({
        "t-1": [finishes(world, root, "t-1" as TicketId, faults.show ?? 0)],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
      const beads = yield* Beads
      const until =
        (yield* Clock.currentTimeMillis) + Duration.toMillis(faults.ready ?? Duration.zero)
      const locked = new BeadsFailed({
        command: "bd ready",
        exitCode: 1,
        stderr: "database is locked",
        noSuchIssue: false,
      })
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }).pipe(
          Effect.provideService(Beads, {
            ...beads,
            ready: (options) =>
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                now < until ? Effect.fail(locked) : beads.ready(options),
              ),
          }),
        ),
      )
      for (let i = 0; i < 400 && fiber.pollUnsafe() === undefined; i++) {
        for (let j = 0; j < 200; j++) yield* Effect.yieldNow
        yield* advance("3 seconds")
      }
      return yield* Fiber.join(fiber)
    }),
  )
}

describe("a run whose bd ready fails", () => {
  test("for a minute: nothing starts meanwhile, then the ticket runs and the run ends as ever", async () => {
    const ran = await runs({ ready: Duration.minutes(1) })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      "could not read the queue (try 1 of 3), reading it again: database is locked",
      "could not read the queue: database is locked; nothing new starts until it is read, again at the next look, and the run stops if bd fails for 10m",
      /^could not read the queue: database is locked; nothing new starts until it is read, again in 30s, /,
      "[1] t-1 dispatching: t-1",
      /^read the queue again, after 1m\d*s? of bd failing$/,
      "READY_EMPTY after 1 tickets",
    ])
    expect(ran.log.some((text) => text.startsWith("BEADS_FAILED"))).toBe(false)
  })

  test("for longer than beadsOutage: BEADS_FAILED, exit 4, with nothing started", async () => {
    const ran = await runs({ ready: Duration.minutes(20) })
    expectExitCode(ran, 4)
    expectPhases(ran, {})
    expectLog(ran, [
      "could not read the queue: database is locked; nothing new starts until it is read, again at the next look, and the run stops if bd fails for 10m",
      /^ {2}Completed 0 · Set aside 0 · Needs you 0$/,
      /^BEADS_FAILED: could not read the queue for 10m\d*s?: database is locked$/,
    ])
  })
})

describe("bd show failing as a ticket's worker ends", () => {
  test("for a minute: read again a poll apart, the ticket merged and the run going on", async () => {
    // readAgain's 3 tries, twice, then the third read: over a minute of bd failing.
    const ran = await runs({ show: 6 })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      "  bd could not read t-1 as its worker ended, reading it again in 30s: database is locked",
      "  bd could not read t-1 as its worker ended, reading it again in 30s: database is locked",
      /^ {2}t-1 closed \(.*\); merged into main/,
      "READY_EMPTY after 1 tickets",
    ])
  })

  test("for longer than beadsOutage: BEADS_FAILED on the ticket, exit 4", async () => {
    const ran = await runs({ show: Number.POSITIVE_INFINITY })
    expectExitCode(ran, 4)
    expectLog(ran, [
      "  bd could not read t-1 as its worker ended, reading it again in 30s: database is locked",
      "BEADS_FAILED: bd failed on t-1: database is locked",
    ])
  })
})
