// The pressure cap (src/run/pressureCap.ts, pressureGate.ts): the workers a run allows fall a step
// after the memory pressure has been at warn or worse for 60 s (two at critical), and rise a step
// after 5 minutes of it normal, however much the machine swaps, up to concurrent; never below 1.
// A lowered cap
// holds dispatch and resuming (HOLD: PRESSURE) without touching a running worker; each step is a log
// line and a pressure_cap record, and the readings go into events.jsonl as load records. The plain
// mode reads the machine too, and the dashboard's load line says the workers allowed.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Fiber, Layer, Schema, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { line } from "../src/core/log.ts"
import { Settings } from "../src/project/settings.ts"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { noHolds, shownHolds, withPressureHold } from "../src/run/holds.ts"
import { make as makeHoldsGate } from "../src/run/holdsGate.ts"
import {
  type Kernel,
  Load,
  type LoadSource,
  pressureLowerAfter,
  pressureRaiseAfter,
  type Reading,
} from "../src/run/load.ts"
import {
  type Cap,
  capAt,
  capEvidence,
  capLine,
  lasted,
  type Strain,
  stepCap,
  strainOf,
} from "../src/run/pressureCap.ts"
import { make as makePressureGate } from "../src/run/pressureGate.ts"
import { run } from "../src/run/run.ts"
import { emptyStatus, emptyView, type Status } from "../src/run/runView.ts"
import { make as makeScheduler } from "../src/run/schedule.ts"
import { shareFile } from "../src/run/share.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { loadSegments } from "../src/ui/LoadLine.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
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

// Whole runs moving the clock on by a quarter of an hour, 5 seconds at a time, take a few seconds.
setDefaultTimeout(60_000)

/** The cap after `strains`, one reading each `every` from 0, out of `concurrent`. */
const after = (
  strains: ReadonlyArray<Strain>,
  concurrent: number,
  every = 5_000,
  from: Cap = capAt(concurrent),
) => {
  let cap = from
  const changes: Array<string> = []
  strains.forEach((strain, i) => {
    const next = stepCap(cap, strain, i * every, concurrent)
    cap = next.cap
    if (next.change !== null) changes.push(`${(i * every) / 1000}s ${capLine(next.change)}`)
  })
  return { cap: cap.cap, changes }
}

/** `n` readings of `strain`. */
const times = (n: number, strain: Strain): ReadonlyArray<Strain> =>
  Array.from({ length: n }, () => strain)

/** Readings a minute's worth and one: from the first to one 60 s on. */
const minute = pressureLowerAfter / 5_000 + 1

describe("the cap's steps", () => {
  test("fall by one after 60 s of warn, and again after each further 60 s", () => {
    expect(after(times(minute - 1, "warn"), 4)).toEqual({ cap: 4, changes: [] })
    expect(after(times(minute, "warn"), 4)).toEqual({
      cap: 3,
      changes: ["60s HOLD: PRESSURE: workers allowed 4 → 3: memory pressure warn for 60 s"],
    })
    expect(after(times(2 * minute - 1, "warn"), 4).changes).toEqual([
      "60s HOLD: PRESSURE: workers allowed 4 → 3: memory pressure warn for 60 s",
      "120s HOLD: PRESSURE: workers allowed 3 → 2: memory pressure warn for 60 s",
    ])
  })

  test("fall by two at critical", () => {
    expect(after(times(minute, "critical"), 4).changes).toEqual([
      "60s HOLD: PRESSURE: workers allowed 4 → 2: memory pressure critical for 60 s",
    ])
    // A stretch is pressed whichever level: warn, then critical, lowers at 60 s.
    const mixed = [...times(4, "warn"), ...times(minute - 4, "critical")]
    expect(after(mixed, 4).cap).toBe(2)
  })

  test("never fall below 1", () => {
    expect(after(times(10 * minute, "critical"), 4).cap).toBe(1)
    expect(after(times(10 * minute, "warn"), 1)).toEqual({ cap: 1, changes: [] })
  })

  test("rise by one after 5 minutes of calm, and again after each further 5, up to concurrent", () => {
    const calm = pressureRaiseAfter / 5_000
    const low = { cap: 1, pressedSince: null, calmSince: null }
    expect(after(times(calm, "calm"), 3, 5_000, low).cap).toBe(1)
    expect(after(times(calm + 1, "calm"), 3, 5_000, low)).toEqual({
      cap: 2,
      changes: ["300s workers allowed 1 → 2: memory pressure normal for 5 min"],
    })
    expect(after(times(3 * calm + 1, "calm"), 3, 5_000, low)).toEqual({
      cap: 3,
      changes: [
        "300s workers allowed 1 → 2: memory pressure normal for 5 min",
        "600s workers allowed 2 → 3: memory pressure normal for 5 min",
      ],
    })
  })

  test("a pressed reading starts the calm over, and a calm one the pressed stretch", () => {
    const calm = pressureRaiseAfter / 5_000
    const low = { cap: 2, pressedSince: null, calmSince: null }
    // 4 minutes 55 calm, one reading pressed, then calm again: 5 minutes from the last pressed one.
    const broken = [...times(calm, "calm"), "warn" as const, ...times(calm, "calm")]
    expect(after(broken, 3, 5_000, low).cap).toBe(2)
    expect(after([...broken, "calm"], 3, 5_000, low).cap).toBe(3)
    // Pressed for 55 s, calm for one reading, pressed again: no step until 60 s from there.
    const flicker = [...times(minute - 1, "warn"), "calm" as const, ...times(minute - 1, "warn")]
    expect(after(flicker, 4).cap).toBe(4)
    expect(after([...flicker, "warn"], 4).cap).toBe(3)
  })

  test("an unknown reading moves it neither way, and starts each stretch over", () => {
    expect(after(times(10 * minute, "unknown"), 4).cap).toBe(4)
    const low = { cap: 2, pressedSince: null, calmSince: null }
    expect(after(times(100, "unknown"), 4, 5_000, low).cap).toBe(2)
    const gap = [...times(minute - 1, "warn"), "unknown" as const, ...times(minute - 1, "warn")]
    expect(after(gap, 4).cap).toBe(4)
  })

  test("the times are said as the log says them", () => {
    expect(lasted(60_000)).toBe("60 s")
    expect(lasted(300_000)).toBe("5 min")
    expect(lasted(90_000)).toBe("90 s")
  })
})

const reading = (kernel: Partial<Kernel>, swapping = 0): Reading => ({
  at: 0,
  workers: new Map(),
  check: 0,
  kernel: { pressure: "normal", swaps: 0, load1: 1, cores: 10, available: -1, ...kernel },
  swapping,
  levels: { cpu: "green", pressure: "green", swapping: "green" },
})

describe("a reading's strain", () => {
  test("is the memory pressure alone, never swapping nor the load average", () => {
    expect(strainOf(reading({ pressure: "critical" }))).toBe("critical")
    expect(strainOf(reading({ pressure: "warn" }, 5000))).toBe("warn")
    expect(strainOf(reading({ pressure: "normal" }, 599))).toBe("calm")
    expect(strainOf(reading({ pressure: "normal", load1: 238.6 }))).toBe("calm")
    expect(strainOf(reading({ pressure: "unknown" }))).toBe("unknown")
    // Gigabytes in swap: touching old pages swaps them in long after the pressure has passed.
    expect(strainOf(reading({ pressure: "normal" }, 144_056))).toBe("calm")
    expect(strainOf(reading({ pressure: "unknown" }, 900))).toBe("unknown")
  })

  test("normal with heavy swapping raises the cap, and lowers it never", () => {
    const calm = pressureRaiseAfter / 5_000
    const low = { cap: 1, pressedSince: null, calmSince: null }
    const swapping = Array.from({ length: calm + 1 }, () =>
      strainOf(reading({ pressure: "normal" }, 320_000)),
    )
    expect(after(swapping, 2, 5_000, low)).toEqual({
      cap: 2,
      changes: ["300s workers allowed 1 → 2: memory pressure normal for 5 min"],
    })
    expect(after(swapping, 4).cap).toBe(4)
  })

  test("normal with heavy swapping holds no optional check", async () => {
    const pressed = await Effect.runPromise(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>(emptyStatus)
        const holds = yield* makeHoldsGate({ status, notices: [], wakeUp: Effect.void })
        const gate = yield* makePressureGate({
          concurrent: 2,
          on: true,
          holds,
          status,
          wakeUp: Effect.void,
        })
        yield* gate.read({ ...reading({ pressure: "normal" }, 320_000), at: 0 })
        const swapping = yield* gate.pressed
        yield* gate.read({ ...reading({ pressure: "warn" }, 320_000), at: 5_000 })
        return { swapping, warn: yield* gate.pressed }
      }).pipe(
        Effect.scoped,
        Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
      ),
    )
    expect(pressed).toEqual({ swapping: false, warn: true })
  })
})

describe("what the run says of the cap", () => {
  test("the title line's hold, and the report's time below concurrent and lowest cap", () => {
    expect(shownHolds(withPressureHold(noHolds, { rises: null })).holds).toEqual([
      { word: "PRESSURE", resetsAt: null },
    ])
    expect(shownHolds(withPressureHold(noHolds, null)).holds).toEqual([])
    expect(capEvidence({ below: 0, lowest: 4, concurrent: 4 })).toBeNull()
    expect(capEvidence({ below: 754_000, lowest: 2, concurrent: 4 })).toBe(
      "The workers allowed fell below concurrent (4) under memory pressure for 13 min in all; the lowest was 2.",
    )
  })

  test("pressure_cap is on by default, and can be turned off", () => {
    const decode = Schema.decodeUnknownSync(Settings)
    expect(decode({}).pressure_cap).toBe(true)
    expect(decode({ pressure_cap: false }).pressure_cap).toBe(false)
  })
})

describe("the load line", () => {
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
  const text = (segments: Segments) => segments.map((each) => each.text).join("")
  const totals = { ...emptyView.totals, workers: 3, slots: 4 }

  test("says concurrent as the workers allowed while the cap is concurrent", () => {
    const segments = loadSegments(totals, null, theme, 120)
    expect(text(segments)).toBe(" ▶ 3 of 4 workers")
    expect(segments.some((each) => each.look === theme.styles.deferred)).toBe(false)
  })

  test("says the workers allowed, in the notice colour, while the cap holds them lower", () => {
    const segments = loadSegments({ ...totals, allowed: 2 }, null, theme, 120)
    expect(text(segments)).toBe(" ▶ 3 of 2 workers")
    expect(segments.find((each) => each.text === "2")?.look).toBe(theme.styles.deferred)
    const one = loadSegments({ ...totals, workers: 0, allowed: 1 }, null, theme, 120)
    expect(text(one)).toBe(" ▶ 0 of 1 worker")
    expect(one.find((each) => each.text === "1")?.look).toBe(theme.styles.deferred)
  })
})

describe("the pressure gate", () => {
  test("holds the resuming of carried-over workers at the cap, leaving those running", async () => {
    // Three slots. c-1 is resumed; 60 s of warn lower the cap to 2: c-2 is resumed beside c-1, c-3
    // waits (HOLD: PRESSURE), and neither running worker is stopped. 5 minutes of calm raise the
    // cap to 3: c-3 is resumed.
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>(emptyStatus)
        const holds = yield* makeHoldsGate({ status, notices: [], wakeUp: Effect.void })
        const gate = yield* makePressureGate({
          concurrent: 3,
          on: true,
          holds,
          status,
          wakeUp: Effect.void,
        })
        const schedule = yield* makeScheduler({
          concurrent: 3,
          limit: null,
          scope: null,
          excludeTypes: [],
          start: { start: () => Effect.void },
          room: gate.room,
        })
        const done = yield* Deferred.make<void>()
        const carry = (id: string) =>
          schedule.carry(id as TicketId, Effect.succeed(Deferred.await(done)))
        const readings = (pressure: Kernel["pressure"], from: number, n: number) =>
          Effect.forEach(
            Array.from({ length: n }, (_, i) => from + i * 5_000),
            (at) => gate.read({ ...reading({ pressure }), at }),
          )
        const took = [yield* carry("c-1")]
        yield* readings("warn", 0, minute)
        took.push(yield* carry("c-2"), yield* carry("c-3"))
        const held = {
          running: [...(yield* schedule.running)].map(String),
          banner: shownHolds(yield* holds.now).holds.map((hold) => hold.word),
          allowed: (yield* SubscriptionRef.get(status)).allowed,
        }
        yield* readings("normal", 65_000, pressureRaiseAfter / 5_000 + 1)
        took.push(yield* carry("c-3"))
        const after = {
          running: [...(yield* schedule.running)].map(String),
          banner: shownHolds(yield* holds.now).holds.map((hold) => hold.word),
          allowed: (yield* SubscriptionRef.get(status)).allowed,
        }
        yield* Deferred.succeed(done, undefined)
        const log = (yield* texts).filter((text) => text.includes("workers allowed"))
        return { took, held, after, log }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(beadsLayer([]), ledgerLayer(), runFibersLayer).pipe(
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )
    expect(seen.took).toEqual([true, true, false, true])
    expect(seen.held).toEqual({ running: ["c-1", "c-2"], banner: ["PRESSURE"], allowed: 2 })
    expect(seen.after).toEqual({ running: ["c-1", "c-2", "c-3"], banner: [], allowed: null })
    expect(seen.log).toEqual([
      "HOLD: PRESSURE: workers allowed 3 → 2: memory pressure warn for 60 s",
      "workers allowed 2 → 3: memory pressure normal for 5 min",
    ])
  })
})

describe("the pressure gate, the readings stopped", () => {
  test("goes back to concurrent, saying why, and frees the optional checks", async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>(emptyStatus)
        const holds = yield* makeHoldsGate({ status, notices: [], wakeUp: Effect.void })
        const gate = yield* makePressureGate({
          concurrent: 4,
          on: true,
          holds,
          status,
          wakeUp: Effect.void,
        })
        yield* Effect.forEach(
          Array.from({ length: minute }, (_, i) => i * 5_000),
          (at) => gate.read({ ...reading({ pressure: "critical" }), at }),
        )
        const before = {
          allowed: (yield* SubscriptionRef.get(status)).allowed,
          pressed: yield* gate.pressed,
        }
        yield* gate.unread
        return {
          before,
          allowed: (yield* SubscriptionRef.get(status)).allowed,
          pressed: yield* gate.pressed,
          log: (yield* texts).filter((text) => text.includes("workers allowed")),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
      ),
    )
    expect(seen).toEqual({
      before: { allowed: 2, pressed: true },
      allowed: null,
      pressed: false,
      log: [
        "HOLD: PRESSURE: workers allowed 4 → 2: memory pressure critical for 60 s",
        "workers allowed 2 → 4: the machine's load is no longer read",
      ],
    })
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-pressure-cap-${name}-`)))

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

/** The second each ticket was dispatched at, from the first dispatch. */
const dispatched = (ran: Ran<unknown>): Readonly<Record<string, number>> => {
  const all = ran.events.flatMap((record) =>
    record.kind === "dispatch" ? [[record.ticket, Date.parse(record.time)] as const] : [],
  )
  const first = all[0]?.[1] ?? 0
  return Object.fromEntries(all.map(([ticket, at]) => [ticket, Math.round((at - first) / 1000)]))
}

/**
 * A whole run in `repo` with plain output, two slots, the machine's load read from `source`: a's worker
 * takes 3 minutes, b's 12 and c's 1, c waiting for a slot. The memory is pressed until 4 minutes in.
 */
const pressedRun = (on: boolean, repo = folder("repo")) => {
  const root = folder("worktrees")
  const defaults = appConfig().settings
  let pressure: Kernel["pressure"] = "warn"
  return scenario(
    {
      config: {
        repo,
        worktrees: root,
        runs: null,
        settings: { ...defaults, concurrent: 2, pressure_cap: on },
      },
      backlog: backlog()
        .ticket("a", { priority: 0 })
        .ticket("b", { priority: 1 })
        .ticket("c", { priority: 2 }).seeds,
      git: { dir: repo, files: { "README.md": "tutti\n" } },
      worktrees: { root },
      scripts: (world: World) => ({
        a: [works(world, root, "a" as TicketId, "3 minutes")],
        b: [works(world, root, "b" as TicketId, "12 minutes")],
        c: [works(world, root, "c" as TicketId, "1 minute")],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["a", "b", "c"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }).pipe(
          Effect.provideService(
            Load,
            machine(() => pressure),
          ),
        ),
      )
      yield* started(["a", "b"] as Array<TicketId>)
      yield* passes("4 minutes")
      pressure = "normal"
      yield* passes("11 minutes")
      return yield* Fiber.join(fiber)
    }),
  )
}

describe("a run under memory pressure", () => {
  test("lowers the workers allowed, holds c until it raises them, and stops no worker", async () => {
    const repo = folder("repo")
    const ran = await pressedRun(true, repo)
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expect(ran.leaks).toEqual({ fibers: [], processes: [] })
    // Pressed from the start, the cap falls to 1 at 60 s, and no lower. a's slot frees at 3
    // minutes, but b runs, at the cap: c waits. Calm from 4 minutes, the cap rises at 9, and c
    // starts beside b, which ran on all along.
    const at = dispatched(ran)
    expect(at.a).toBe(0)
    expect(at.b).toBe(0)
    expect(at.c).toBeGreaterThanOrEqual(540)
    expect(at.c).toBeLessThanOrEqual(550)
    expectLog(ran, [
      "HOLD: PRESSURE: workers allowed 2 → 1: memory pressure warn for 60 s",
      "workers allowed 1 → 2: memory pressure normal for 5 min",
    ])
    const caps = ran.events.flatMap((record) =>
      record.kind === "pressure_cap" ? [`${record.from} → ${record.to}: ${record.why}`] : [],
    )
    expect(caps).toEqual([
      "2 → 1: memory pressure warn for 60 s",
      "1 → 2: memory pressure normal for 5 min",
    ])
    // The checks' share followed the cap (share.ts): said at each step, and in the share file.
    const shares = ran.events.flatMap((record) => (record.kind === "share" ? [record.why] : []))
    expect(shares).toEqual(
      availableParallelism() >= 2 ? ["workers allowed 2 → 1", "workers allowed 1 → 2"] : [],
    )
    const kept = JSON.parse(readFileSync(join(repo, shareFile), "utf8"))
    expect(kept.cores).toBe(Math.max(Math.floor(availableParallelism() / 2), 1))
    expect(ran.events.some((record) => record.kind === "suspended")).toBe(false)
    expect(ran.events.some((record) => record.kind === "resumed")).toBe(false)
    // The plain mode read the machine: a load record a minute, and one as the pressure changed.
    const loads = ran.events.flatMap((record) => (record.kind === "load" ? [record] : []))
    expect(loads[0]).toMatchObject({ pressure: "warn", allowed: 2, concurrent: 2, cores: 10 })
    expect(loads.filter((record) => record.pressure === "warn").length).toBeGreaterThanOrEqual(4)
    expect(loads.find((record) => record.pressure === "normal")).toMatchObject({ allowed: 1 })
    expect(loads.at(-1)).toMatchObject({ pressure: "normal", allowed: 2 })
  })

  test("with pressure_cap false, starts c as soon as a's slot frees, still recording the load", async () => {
    const ran = await pressedRun(false)
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    const at = dispatched(ran)
    expect(at.c).toBeGreaterThanOrEqual(180)
    expect(at.c).toBeLessThanOrEqual(190)
    expect(ran.events.some((record) => record.kind === "pressure_cap")).toBe(false)
    expect(ran.log.some((text) => text.includes("PRESSURE"))).toBe(false)
    expect(ran.events.some((record) => record.kind === "load")).toBe(true)
  })
})
