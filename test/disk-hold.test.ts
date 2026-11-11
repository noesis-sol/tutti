// The disk hold (src/run/disk.ts, diskGate.ts): the free disk where the worktrees go, read with each
// reading of the machine's load and afresh for each ticket about to start, under 5 GB holds the run
// (HOLD: DISK, its title-line banner and disk_hold record), no ticket starting or resuming, the
// workers running going on; the hold lifts once 7 GB are free. Held with nothing running, the run
// waits for the disk rather than end.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Ref, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { type Log, line } from "../src/core/log.ts"
import { diskLow, gigabytes, holdLine, liftedLine } from "../src/run/disk.ts"
import { make as makeDiskGate } from "../src/run/diskGate.ts"
import { noHolds, shownHolds, withDiskHold } from "../src/run/holds.ts"
import { make as makeHoldsGate } from "../src/run/holdsGate.ts"
import {
  type DiskFree,
  diskClear,
  diskFloor,
  Load,
  type LoadSource,
  newSampler,
  type Reading,
  sample,
} from "../src/run/load.ts"
import { gb } from "../src/run/processes.ts"
import { run } from "../src/run/run.ts"
import { type Look, whatsLeft } from "../src/run/runEnd.ts"
import { emptyStatus, type Status } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Backlog } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
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

// Whole runs moving the clock on by minutes, 5 seconds at a time, take a few seconds.
setDefaultTimeout(60_000)

describe("the disk's thresholds", () => {
  test("hold under 5 GB, and lift only at 7 GB", () => {
    expect(diskFloor).toBe(5 * gb)
    expect(diskClear).toBe(7 * gb)
    expect(diskLow(false, 4.9 * gb)).toBe(true)
    expect(diskLow(false, 5 * gb)).toBe(false)
    expect(diskLow(true, 6.9 * gb)).toBe(true)
    expect(diskLow(true, 7 * gb)).toBe(false)
  })

  test("the hold's lines say the free disk, where it was read, and the thresholds", () => {
    const disk = { free: 4.25 * gb, where: "/work" }
    expect(gigabytes(4.25 * gb)).toBe("4.2 GB")
    expect(gigabytes(0)).toBe("0.0 GB")
    expect(holdLine(disk)).toBe(
      line`HOLD: DISK: 4.2 GB free in /work, where the worktrees go, under 5.0 GB: no ticket starts until 7.0 GB are free`,
    )
    expect(liftedLine({ free: 7.3 * gb, where: "/work" })).toBe(
      line`disk hold lifted: 7.3 GB free in /work, where the worktrees go`,
    )
  })

  test("the title line's banner", () => {
    expect(shownHolds(withDiskHold(noHolds, true)).holds).toEqual([
      { word: "DISK", resetsAt: null },
    ])
    expect(shownHolds(withDiskHold(noHolds, false)).holds).toEqual([])
    expect(withDiskHold(noHolds, false)).toBe(noHolds)
  })

  test("a reading keeps the free disk read with it, and leaves it out where none was", () => {
    const options = {
      sampler: newSampler,
      now: 0,
      processes: undefined,
      kernel: undefined,
      roots: new Map(),
      self: 1,
    }
    const disk = { free: 3 * gb, where: "/work" }
    expect(sample({ ...options, disk }).reading.disk).toEqual(disk)
    expect("disk" in sample(options).reading).toBe(false)
  })
})

describe("the run's end", () => {
  const look: Look = {
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
  }

  test("waits while the disk hold is on, rather than end on the tickets it held back", () => {
    expect(whatsLeft(look).done).toBe(true)
    expect(whatsLeft({ ...look, diskHeld: true }).done).toBe(false)
    // A stop or the run's wind-down takes no ticket anyway: the hold keeps it no longer.
    expect(whatsLeft({ ...look, diskHeld: true, canTake: false }).done).toBe(true)
  })
})

/** A reading of nothing but the free disk `disk`. */
const reading = (disk: DiskFree | undefined): Reading => ({
  at: 0,
  workers: new Map(),
  check: 0,
  kernel: { pressure: "normal", swaps: 0, load1: 1, cores: 10, available: -1 },
  swapping: 0,
  levels: { cpu: "green", pressure: "green", swapping: "green" },
  ...(disk === undefined ? {} : { disk }),
})

describe("the disk gate", () => {
  test("begins the hold as a ticket asks for room, lifts it with a margin, and wakes the run", async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>(emptyStatus)
        const holds = yield* makeHoldsGate({ status, notices: [], wakeUp: Effect.void })
        const free = yield* Ref.make<DiskFree | undefined>({ free: 3 * gb, where: "/work" })
        const woken = yield* Ref.make(0)
        const gate = yield* makeDiskGate({
          holds,
          measure: Ref.get(free),
          wakeUp: Ref.update(woken, (n) => n + 1),
        })
        const rooms: Array<string> = [yield* gate.room, yield* gate.room]
        const held = yield* gate.held
        // Back over the floor, short of the margin: still held, by a reading and by room.
        yield* Ref.set(free, { free: 6 * gb, where: "/work" })
        yield* gate.read(reading({ free: 6 * gb, where: "/work" }))
        rooms.push(yield* gate.room)
        // A disk that can't be read changes nothing.
        yield* Ref.set(free, undefined)
        yield* gate.read(reading(undefined))
        rooms.push(yield* gate.room)
        const before = yield* Ref.get(woken)
        yield* gate.read(reading({ free: 8 * gb, where: "/work" }))
        const after = { held: yield* gate.held, woken: (yield* Ref.get(woken)) - before }
        // Unreadable, room goes by the last reading: 8 GB, room.
        rooms.push(yield* gate.room)
        return { rooms, held, after, banner: shownHolds(yield* holds.now).holds }
      }).pipe(
        Effect.scoped,
        Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
      ),
    )
    expect(seen).toEqual({
      rooms: ["began", "held", "held", "held", "room"],
      held: true,
      after: { held: false, woken: 1 },
      banner: [],
    })
  })

  test("with the disk lifted by room itself, says so", async () => {
    const rooms = await Effect.runPromise(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>(emptyStatus)
        const holds = yield* makeHoldsGate({ status, notices: [], wakeUp: Effect.void })
        const free = yield* Ref.make<DiskFree | undefined>(undefined)
        const gate = yield* makeDiskGate({ holds, measure: Ref.get(free), wakeUp: Effect.void })
        // Nothing read yet: room.
        const all: Array<string> = [yield* gate.room]
        yield* Ref.set(free, { free: 1 * gb, where: "/work" })
        all.push(yield* gate.room)
        yield* Ref.set(free, { free: 9 * gb, where: "/work" })
        all.push(yield* gate.room, yield* gate.room)
        return all
      }).pipe(
        Effect.scoped,
        Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
      ),
    )
    expect(rooms).toEqual(["room", "began", "lifted", "room"])
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-disk-hold-${name}-`)))

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

/** Waits, in real time, until `ids` are claimed: the run has dispatched them. */
const started = (ids: ReadonlyArray<TicketId>) =>
  Effect.gen(function* () {
    const issues = yield* Backlog
    for (let i = 0; i < 2000; i++) {
      const claimed = new Set(
        (yield* issues.issues).flatMap((issue) =>
          issue.status === "in_progress" ? [issue.id] : [],
        ),
      )
      if (ids.every((id) => claimed.has(id))) return
      yield* Effect.promise(() => Bun.sleep(5))
    }
    return yield* Effect.die(new Error(`the run didn't start ${ids.join(", ")}`))
  })

/** Moves TestClock on by `total`, 5 seconds (a reading) at a time, once the run has caught up. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const steps = Duration.toMillis(Duration.fromInputUnsafe(total)) / 5_000
    for (let i = 0; i < steps; i++) {
      yield* caughtUp
      yield* advance("5 seconds")
    }
  })

/** The machine, calm, with `free()` bytes free on its disk at each read. */
const machine = (free: () => number): LoadSource => ({
  processes: Effect.succeed(undefined),
  kernel: Effect.succeed({ pressure: "normal", swaps: 0, load1: 1, cores: 10, available: -1 }),
  disk: () => Effect.sync(() => ({ free: free(), where: "/work" })),
})

/** The second each ticket was dispatched at, from the run's first record. */
const dispatched = (ran: Ran<unknown>): Readonly<Record<string, number>> => {
  const start = Date.parse(ran.events[0]?.time ?? "")
  return Object.fromEntries(
    ran.events.flatMap((record) =>
      record.kind === "dispatch"
        ? [[record.ticket, Math.round((Date.parse(record.time) - start) / 1000)]]
        : [],
    ),
  )
}

/** The disk_hold records, `held` or `lifted` each. */
const diskHolds = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "disk_hold" ? [record.held ? "held" : "lifted"] : [],
  )

/**
 * A whole run with plain output, `concurrent` slots, tickets a and b taking `takes` each, the disk
 * as `during` sets it, the run going on until `during` ends.
 */
const diskRun = (options: {
  readonly concurrent: number
  readonly takes: { readonly a: Duration.Input; readonly b: Duration.Input }
  readonly during: (disk: {
    free: number
  }) => Effect.Effect<void, unknown, Backlog | Captured | Log>
  readonly startFree: number
}) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const disk = { free: options.startFree }
  return scenario(
    {
      config: {
        repo,
        worktrees: root,
        runs: null,
        settings: { ...defaults, concurrent: options.concurrent },
      },
      backlog: backlog().ticket("a", { priority: 0 }).ticket("b", { priority: 1 }).seeds,
      git: { dir: repo, files: { "README.md": "tutti\n" } },
      worktrees: { root },
      scripts: (world: World) => ({
        a: [works(world, root, "a" as TicketId, options.takes.a)],
        b: [works(world, root, "b" as TicketId, options.takes.b)],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["a", "b"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }).pipe(
          Effect.provideService(
            Load,
            machine(() => disk.free),
          ),
        ),
      )
      yield* options.during(disk)
      return yield* Fiber.join(fiber)
    }),
  )
}

describe("a run on a disk running low", () => {
  test("starts nothing and waits while the disk is low, then runs the tickets once it is freed", async () => {
    const ran = await diskRun({
      concurrent: 2,
      takes: { a: "1 minute", b: "1 minute" },
      startFree: 3 * gb,
      during: (disk) =>
        Effect.gen(function* () {
          yield* passes("2 minutes")
          // Over the floor, short of the margin: still held.
          disk.free = 6 * gb
          yield* passes("1 minute")
          disk.free = 8 * gb
          yield* passes("3 minutes")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(ran.leaks).toEqual({ fibers: [], processes: [] })
    // Held from the start for 3 minutes, the run didn't end: both start once 8 GB are free.
    const at = dispatched(ran)
    expect(at.a).toBeGreaterThanOrEqual(180)
    expect(at.a).toBeLessThanOrEqual(190)
    expect(at.b).toBe(at.a)
    expectLog(ran, [
      "HOLD: DISK: 3.0 GB free in /work, where the worktrees go, under 5.0 GB: no ticket starts until 7.0 GB are free",
      "disk hold lifted: 8.0 GB free in /work, where the worktrees go",
    ])
    expect(diskHolds(ran)).toEqual(["held", "lifted"])
  })

  test("lets the running worker finish and merge, and holds the next ticket until the disk frees", async () => {
    const ran = await diskRun({
      concurrent: 1,
      takes: { a: "3 minutes", b: "1 minute" },
      startFree: 20 * gb,
      during: (disk) =>
        Effect.gen(function* () {
          yield* started(["a"] as Array<TicketId>)
          yield* passes("1 minute")
          disk.free = 2 * gb
          yield* passes("5 minutes")
          disk.free = 10 * gb
          yield* passes("2 minutes")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(ran.events.some((record) => record.kind === "suspended")).toBe(false)
    // a finished at 3 minutes and merged while held; b waited until the disk was freed at 6.
    const at = dispatched(ran)
    expect(at.b).toBeGreaterThanOrEqual(360)
    expect(at.b).toBeLessThanOrEqual(370)
    const merged = ran.events.findIndex((record) => record.kind === "closed")
    const lifted = ran.events.findIndex((record) => record.kind === "disk_hold" && !record.held)
    expect(merged).toBeGreaterThanOrEqual(0)
    expect(merged).toBeLessThan(lifted)
    expect(diskHolds(ran)).toEqual(["held", "lifted"])
  })
})
