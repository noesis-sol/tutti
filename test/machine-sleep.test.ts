// The machine's sleep (§ 3.3 "Time limits", tutti-dhyy): the live Wake notices one, tutti's time
// limits count only the time awake (a check's, bd's, a ticket's), and the run says so with its
// SLEPT line and `slept` record, and once how to keep the machine awake.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Clock, Duration, Effect, Exit, Fiber, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { addRecord, figuresLines, noFigures } from "../src/run/figures.ts"
import { clock } from "../src/run/localTime.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { keepAwakeHint, sleptFor, sleptLine, watchSleeps } from "../src/run/slept.ts"
import { Beads } from "../src/services/Beads.ts"
import { Checks } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import {
  makeWake,
  type Sleep,
  sleepAwake,
  sleptBetween,
  timeoutAwake,
  Wake,
} from "../src/services/Wake.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import * as TestEvents from "../src/testing/EventStream.ts"
import * as TestLog from "../src/testing/Log.ts"
import { Asleep, layer as asleepLayer } from "../src/testing/Wake.ts"
import { backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const minutes = (n: number) => n * 60_000

/** Runs `effect` under TestClock, with the test Wake. */
const underTestClock = <A, E>(effect: Effect.Effect<A, E, Asleep>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(TestClock.layer(), asleepLayer))))

/** Lets the fibers forked so far run. */
const settle = Effect.promise(() => Bun.sleep(5))

describe("how long the machine slept", () => {
  test("counts each sleep's part between the two instants", () => {
    const sleeps: ReadonlyArray<Sleep> = [
      { from: 100, to: 200 },
      { from: 300, to: 450 },
    ]
    expect(sleptBetween(sleeps, 0, 1000)).toBe(250)
    expect(sleptBetween(sleeps, 150, 350)).toBe(100)
    expect(sleptBetween(sleeps, 200, 300)).toBe(0)
    expect(sleptBetween([], 0, 1000)).toBe(0)
  })

  test("is never below 0, nor more than the time between the instants", () => {
    // Sleeps one after another, each `gap` after the last ended and `length` long.
    const sleepsArb = fc
      .array(fc.tuple(fc.nat(1000), fc.nat(10_000)), { maxLength: 6 })
      .map((spans) => {
        let end = 0
        return spans.map(([gap, length]): Sleep => {
          const from = end + gap
          end = from + length
          return { from, to: end }
        })
      })
    fc.assert(
      fc.property(sleepsArb, fc.nat(80_000), fc.nat(80_000), (sleeps, a, b) => {
        const from = Math.min(a, b)
        const to = Math.max(a, b)
        const slept = sleptBetween(sleeps, from, to)
        expect(slept).toBeGreaterThanOrEqual(0)
        expect(slept).toBeLessThanOrEqual(to - from)
      }),
    )
  })
})

describe("the live Wake", () => {
  /** TestClock's clock, its wall time `by.ms` on: as the machine reads it after a sleep. */
  const ahead = (base: Clock.Clock, by: { ms: number }): Clock.Clock => ({
    ...base,
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() + by.ms,
    currentTimeMillis: Effect.sync(() => base.currentTimeMillisUnsafe() + by.ms),
  })

  /** Runs `f` with the live Wake, under TestClock, the wall clock moved on by what `f` adds. */
  const live = <A>(f: (by: { ms: number }) => Effect.Effect<A>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const by = { ms: 0 }
          const clocked = ahead(yield* Clock.Clock, by)
          return yield* Effect.gen(function* () {
            const wake = yield* makeWake
            return yield* f(by).pipe(Effect.provideService(Wake, wake))
          }).pipe(Effect.provideService(Clock.Clock, clocked))
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

  test("its beat takes a long gap in the wall clock for a sleep, and a short one for none", async () => {
    const slept = await live((by) =>
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis
        yield* TestClock.adjust("5 seconds")
        by.ms += 10_000
        yield* TestClock.adjust("2 seconds")
        const none = yield* (yield* Wake).sleptSince(start)
        by.ms += minutes(20)
        yield* TestClock.adjust("2 seconds")
        return { none, some: yield* (yield* Wake).sleptSince(start) }
      }),
    )
    expect(slept.none).toBe(0)
    // The gap, less the beat it waited anyway.
    expect(slept.some).toBe(minutes(20))
  })

  test("whoever asks first, before the beat, finds the sleep", async () => {
    const slept = await live((by) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("3 seconds")
        const start = yield* Clock.currentTimeMillis
        by.ms += minutes(33)
        return yield* (yield* Wake).sleptSince(start)
      }),
    )
    expect(slept).toBe(minutes(33) - 1000)
  })

  test("its stream gives each sleep once, those noticed before it was read too", async () => {
    const seen = await live((by) =>
      Effect.gen(function* () {
        const wake = yield* Wake
        by.ms += minutes(5)
        yield* TestClock.adjust("1 second")
        const seen = yield* Ref.make<ReadonlyArray<Sleep>>([])
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(wake.sleeps, (each) => Ref.update(seen, (all) => [...all, each])),
        )
        yield* settle
        by.ms += minutes(7)
        yield* TestClock.adjust("1 second")
        yield* settle
        yield* Fiber.interrupt(fiber)
        return yield* Ref.get(seen)
      }),
    )
    expect(seen.map((each) => each.to - each.from)).toEqual([minutes(5), minutes(7)])
  })
})

describe("a limit counted awake", () => {
  test("sleepAwake is put off by a sleep, and ends once the machine has been awake as long", async () => {
    const ended = await underTestClock(
      Effect.gen(function* () {
        const { asleep } = yield* Asleep
        const done = yield* Ref.make(false)
        yield* Effect.forkChild(Effect.andThen(sleepAwake("30 minutes"), Ref.set(done, true)))
        yield* TestClock.adjust("1 minute")
        yield* asleep("33 minutes")
        const atWake = yield* Ref.get(done)
        yield* TestClock.adjust("28 minutes")
        const before = yield* Ref.get(done)
        yield* TestClock.adjust("1 minute")
        return { atWake, before, after: yield* Ref.get(done) }
      }),
    )
    expect(ended).toEqual({ atWake: false, before: false, after: true })
  })

  test("without a sleep it is Effect.sleep", async () => {
    const done = await Effect.runPromise(
      Effect.gen(function* () {
        const done = yield* Ref.make(false)
        yield* Effect.forkChild(Effect.andThen(sleepAwake("30 minutes"), Ref.set(done, true)))
        yield* TestClock.adjust("30 minutes")
        return yield* Ref.get(done)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(done).toBe(true)
  })

  test("timeoutAwake doesn't time out across a sleep", async () => {
    const outcome = await underTestClock(
      Effect.gen(function* () {
        const { asleep } = yield* Asleep
        const fiber = yield* Effect.forkChild(
          Effect.as(Effect.sleep("40 minutes"), "finished").pipe(
            timeoutAwake({ duration: "10 minutes", orElse: () => Effect.succeed("timed out") }),
          ),
        )
        yield* TestClock.adjust("5 minutes")
        yield* asleep("35 minutes")
        return yield* Fiber.join(fiber)
      }),
    )
    expect(outcome).toBe("finished")
  })
})

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-sleep-${name}-`)))

describe("commands across a sleep", () => {
  // The live clock: a sleep noted from now for 10 s, which the command's second falls in.
  const asleepFromNow = Effect.flatMap(Asleep, ({ noted }) => {
    const now = Date.now()
    return noted({ from: now, to: now + 10_000 })
  })

  test("a check whose limit passes while the machine sleeps isn't failed", async () => {
    const cwd = folder("check")
    const settings = {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        fast: { command: "sleep 1; echo passed", timeout: Duration.millis(300) },
      },
    }
    const layer = Checks.layer.pipe(
      Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
      Layer.provideMerge(asleepLayer),
      Layer.provideMerge(BunServices.layer),
    )
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          yield* asleepFromNow
          return yield* (yield* Checks).fast({ cwd, outputFile: join(cwd, "check.log") })
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ _tag: "CheckPassed" })
    expect(readFileSync(join(cwd, "check.log"), "utf8")).toBe("passed\n")
  }, 15_000)

  test("a bd call whose limit passes while the machine sleeps isn't failed", async () => {
    const dir = folder("bd")
    const bin = join(dir, "bd")
    const shown = join(import.meta.dir, "fixtures/bd/close.json")
    writeFileSync(bin, `#!/bin/sh\nsleep 1; cat '${shown}'\n`)
    chmodSync(bin, 0o755)
    const layer = Beads.layer({
      cwd: dir,
      command: bin,
      timeLimits: { read: "300 millis", write: "300 millis" },
    }).pipe(Layer.provideMerge(asleepLayer), Layer.provideMerge(BunServices.layer))
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          yield* asleepFromNow
          return yield* (yield* Beads).show("demo-813")
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  }, 15_000)
})

describe("what the run says of a sleep", () => {
  const at = (h: number, m: number, s = 0) => new Date(2026, 9, 23, h, m, s).getTime()
  const sleep33: Sleep = { from: at(14, 3, 5), to: at(14, 37, 24) }

  test("the SLEPT line says how long and when", () => {
    expect<string>(sleptLine(sleep33)).toBe(
      "SLEPT: the machine slept 34m (14:03-14:37); checks and limits don't count it",
    )
    expect(sleptFor(20_000)).toBe("20s")
    expect(sleptFor(minutes(90) + 20_000)).toBe("1h30m")
    const overnight = { from: at(23, 50), to: at(23, 50) + minutes(30) }
    expect(sleptLine(overnight)).toContain(`(23:50-2026-10-24 ${clock(overnight.to)})`)
  })

  /** The lines and records watchSleeps writes for `sleeps`, the run kept awake or not. */
  const said = (keepAwake: boolean, sleeps: ReadonlyArray<Sleep>) =>
    underTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(watchSleeps({ keepAwake }))
        yield* settle
        for (const each of sleeps) {
          yield* (yield* Asleep).noted(each)
          yield* settle
        }
        yield* Fiber.interrupt(fiber)
        return {
          log: yield* TestLog.texts,
          records: yield* (yield* TestEvents.Captured).records,
        }
      }).pipe(Effect.provide(Layer.merge(TestLog.layer(), TestEvents.layer()))),
    )

  const later: Sleep = { from: at(16, 0), to: at(16, 20) }

  test("each sleep has its line and record; the hint comes once, without --keep-awake", async () => {
    const { log, records } = await said(false, [sleep33, later])
    expect(log).toEqual([sleptLine(sleep33), keepAwakeHint, sleptLine(later)])
    expect<string>(keepAwakeHint).toBe("  run with --keep-awake to keep the machine awake")
    expect(records).toEqual([
      expect.objectContaining({ kind: "slept", seconds: 2059, text: sleptLine(sleep33) }),
      expect.objectContaining({ kind: "slept", seconds: 1200, text: sleptLine(later) }),
    ])
    expect(new Date((records[0] as { from: string }).from).getTime()).toBe(sleep33.from)
  })

  test("with --keep-awake there is no hint", async () => {
    const { log } = await said(true, [sleep33, later])
    expect(log).toEqual([sleptLine(sleep33), sleptLine(later)])
  })

  test("the figures' Time line says how long the machine slept", () => {
    const figures = addRecord(
      noFigures,
      { kind: "slept", from: "", to: "", seconds: 2059.4, text: "" },
      0,
    )
    expect(figuresLines(figures, { subscription: false, label: (w) => w })).toEqual([
      { label: "Time", parts: [{ text: "machine asleep 34m19s" }] },
    ])
  })
})

describe("a run across a sleep", () => {
  /** A worker that takes `takes` to commit and close its ticket. */
  const takes = (world: World, root: string, id: string, takes: Duration.Input): SessionScript =>
    turn(
      [
        ...bash(
          `bd update ${id} --claim`,
          Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
        ),
        sleep(takes),
        ...bash(
          `git commit -am "Change (${id})"`,
          Effect.asVoid(
            Effect.orDie(
              world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
            ),
          ),
        ),
        ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
      ],
      result(`Closed ${id}.`),
    )

  /** Moves TestClock on by `total`, a minute at a time, letting the run catch up after each. */
  const passes = (total: number) =>
    Effect.gen(function* () {
      for (let i = 0; i < total; i++) {
        yield* TestClock.adjust("1 minute")
        yield* Effect.promise(() => Bun.sleep(3))
      }
    })

  test("a ticket's limit doesn't count the sleep; the run says SLEPT and how to prevent it", async () => {
    // 90 minutes of work with a 1h limit, 45 of them asleep: 45 awake, under the limit.
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = TestAppConfig.appConfig().settings
    const settings = {
      ...defaults,
      concurrent: 1,
      workers: { ...defaults.workers, ticket_limit: Duration.hours(1) },
    }
    const ran = await scenario(
      {
        config: { repo, settings },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World) => ({ "t-1": [takes(world, root, "t-1", "90 minutes")] }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        yield* passes(10)
        yield* (yield* Asleep).asleep("45 minutes")
        yield* Effect.promise(() => Bun.sleep(3))
        yield* passes(60)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(asleepLayer)),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(ran.log.some((text) => text.includes("TICKET_LIMIT"))).toBe(false)
    const slept = ran.log.filter((text) => text.startsWith("SLEPT: "))
    expect(slept).toEqual([
      expect.stringMatching(
        /^SLEPT: the machine slept 45m \(\d\d:\d\d-.*\); checks and limits don't count it$/,
      ),
    ])
    expect(ran.log[ran.log.indexOf(slept[0] ?? "") + 1]).toBe(keepAwakeHint)
    expect(ran.events.filter((record) => record.kind === "slept")).toEqual([
      expect.objectContaining({ seconds: 2700 }),
    ])
  }, 30_000)
})
