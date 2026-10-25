// The battery notice (§ 5 item 16, tutti-yhjt): pmset's and /sys's answers read as the battery's
// level and whether the machine draws on it; the START block says when a run starts on battery; and
// while the run goes, a battery falling to 20% and to 10% says so once each per discharge, with its
// BATTERY line, its `battery` record, a notification at 10% and the dashboard's warning line.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Duration, Effect, Fiber, Layer, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import {
  Battery,
  type BatteryReading,
  batteryEvery,
  batteryLine,
  batteryNote,
  parsePmset,
  parseSys,
  type Said,
  step,
  watchBattery,
} from "../src/run/battery.ts"
import { withBattery } from "../src/run/holds.ts"
import { make as makeHoldsGate } from "../src/run/holdsGate.ts"
import { line } from "../src/run/log.ts"
import { notice } from "../src/run/notices.ts"
import { run } from "../src/run/run.ts"
import { emptyStatus, type Status } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { layer as batteryLayer, Charge } from "../src/testing/Battery.ts"
import * as TestEvents from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import * as TestLog from "../src/testing/Log.ts"
import { backlog, expectExitCode, scenario, type World } from "./harness.ts"

const on = (level: number): BatteryReading => ({ level, discharging: true })
const plugged = (level: number): BatteryReading => ({ level, discharging: false })

describe("pmset's answer", () => {
  test("on battery, discharging", () => {
    expect(
      parsePmset(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=37224547)\t86%; discharging; 1:10 remaining present: true\n",
      ),
    ).toEqual(on(86))
  })

  test("on AC power: charging, charged, or attached and not charging", () => {
    for (const state of [
      "charging; 1:20 remaining",
      "charged; 0:00 remaining",
      "AC attached; not charging",
    ]) {
      expect(
        parsePmset(
          `Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t45%; ${state} present: true\n`,
        ),
      ).toEqual(plugged(45))
    }
  })

  test("without its source line, the battery's state says", () => {
    expect(
      parsePmset(" -InternalBattery-0 (id=1)\t19%; discharging; (no estimate) present: true"),
    ).toEqual(on(19))
    expect(
      parsePmset(" -InternalBattery-0 (id=1)\t19%; charging; 2:00 remaining present: true"),
    ).toEqual(plugged(19))
  })

  test("a Mac without a battery, and what isn't pmset's, read as none", () => {
    expect(parsePmset("Now drawing from 'AC Power'\n")).toBeNull()
    expect(parsePmset("")).toBeNull()
    expect(parsePmset("pmset: unknown option\n")).toBeNull()
    expect(parsePmset(" -InternalBattery-0 (id=1)\t150%; discharging;")).toBeNull()
  })

  test("never throws, and any level it gives is 0 to 100", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const reading = parsePmset(text)
        if (reading !== null) expect(reading.level).toBeWithin(0, 101)
      }),
    )
  })
})

describe("/sys/class/power_supply", () => {
  test("a battery's capacity and status", () => {
    expect(parseSys([{ capacity: "62\n", status: "Discharging\n" }])).toEqual(on(62))
    expect(parseSys([{ capacity: "62\n", status: "Charging\n" }])).toEqual(plugged(62))
    expect(parseSys([{ capacity: "100\n", status: "Full\n" }])).toEqual(plugged(100))
    expect(parseSys([{ capacity: "80\n", status: "Not charging\n" }])).toEqual(plugged(80))
  })

  test("two batteries: their mean, discharging when one is", () => {
    expect(
      parseSys([
        { capacity: "30\n", status: "Discharging\n" },
        { capacity: "15\n", status: "Unknown\n" },
      ]),
    ).toEqual(on(23))
  })

  test("none, or none whose capacity reads, is no battery", () => {
    expect(parseSys([])).toBeNull()
    expect(parseSys([{ capacity: "", status: "Discharging" }])).toBeNull()
    expect(parseSys([{ capacity: "lots", status: "Discharging" }])).toBeNull()
  })

  test("never throws, and any level it gives is 0 to 100", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ capacity: fc.string(), status: fc.string() })), (all) => {
        const reading = parseSys(all)
        if (reading !== null) expect(reading.level).toBeWithin(0, 101)
      }),
    )
  })
})

describe("the START block's note", () => {
  test("on battery, it says so; plugged in or without one, nothing", () => {
    expect(batteryNote(on(62))).toBe("on battery (62%): plug in to keep the run going")
    expect(batteryNote(plugged(62))).toBeNull()
    expect(batteryNote(null)).toBeNull()
    expect(batteryNote(undefined)).toBeNull()
  })
})

describe("the thresholds", () => {
  /** What each reading says, in turn, from nothing said. */
  const says = (readings: ReadonlyArray<BatteryReading | null>) => {
    let said: Said = new Set()
    return readings.map((reading) => {
      const next = step(said, reading)
      said = next.said
      return [next.say, next.low] as const
    })
  }

  test("discharging across 20% and 10%: each once", () => {
    expect(says([on(25), on(20), on(19), on(11), on(10), on(9), on(1)])).toEqual([
      [null, false],
      [20, true],
      [null, true],
      [null, true],
      [10, true],
      [null, true],
      [null, true],
    ])
  })

  test("straight past both: 10% alone", () => {
    expect(says([on(30), on(8), on(7)])).toEqual([
      [null, false],
      [10, true],
      [null, true],
    ])
  })

  test("plugged in again, the notice goes, and the next discharge says them again", () => {
    expect(says([on(15), plugged(15), on(16), on(9), plugged(30), on(19)])).toEqual([
      [20, true],
      [null, false],
      [20, true],
      [10, true],
      [null, false],
      [20, true],
    ])
  })

  test("charging or without a battery, nothing", () => {
    expect(says([plugged(5), null, plugged(50)])).toEqual([
      [null, false],
      [null, false],
      [null, false],
    ])
  })
})

describe("the battery's notification", () => {
  test("at 10% it notifies; at 20% it doesn't", () => {
    const text = batteryLine(9, "darwin")
    expect<string>(text).toBe("BATTERY: 9% left, not charging: plug in or the Mac will sleep")
    expect(notice({ kind: "battery", level: 9, threshold: 10, text })).toBe(
      "Battery 9% left · plug in to keep the run going",
    )
    expect(notice({ kind: "battery", level: 19, threshold: 20, text })).toBeNull()
    expect<string>(batteryLine(19, "linux")).toBe(
      "BATTERY: 19% left, not charging: plug in or the machine will sleep",
    )
  })
})

/** Lets the fibers forked so far run. */
const settle = Effect.promise(() => Bun.sleep(5))

describe("watching the battery", () => {
  /**
   * What watchBattery says over `readings`, one a minute: its log lines, its records, and each
   * notice it shows.
   */
  const watched = (readings: ReadonlyArray<BatteryReading | null | undefined>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const charge = yield* Charge
        const shown: Array<string | null> = []
        const [first, ...rest] = readings
        yield* charge.set(first)
        const source = yield* Battery
        if (source === null) return yield* Effect.die("no battery source")
        const fiber = yield* Effect.forkChild(
          watchBattery({
            source,
            platform: "darwin",
            show: (notice) => Effect.sync(() => shown.push(notice)),
          }),
        )
        yield* settle
        for (const reading of rest) {
          yield* charge.set(reading)
          yield* TestClock.adjust(batteryEvery)
          yield* settle
        }
        const reads = yield* charge.reads
        yield* Fiber.interrupt(fiber)
        return {
          log: yield* TestLog.texts,
          records: yield* (yield* TestEvents.Captured).records,
          shown,
          reads,
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestLog.layer(),
            TestEvents.layer(),
            batteryLayer,
            TestClock.layer(),
            BunServices.layer,
          ),
        ),
      ),
    )

  test("without a battery, or charging, it says nothing; it reads once a minute", async () => {
    const none = await watched([null, null, plugged(5), plugged(4)])
    expect(none.log).toEqual([])
    expect(none.records).toEqual([])
    expect(none.shown).toEqual([])
    expect(none.reads).toBe(4)
  })

  test("discharging across 20% and 10%: a line and record each, the notice while low", async () => {
    const ran = await watched([on(22), on(19), on(15), on(9), on(8)])
    expect(ran.log).toEqual([batteryLine(19, "darwin"), batteryLine(9, "darwin")])
    expect(ran.records).toEqual([
      expect.objectContaining({ kind: "battery", level: 19, threshold: 20 }),
      expect.objectContaining({ kind: "battery", level: 9, threshold: 10 }),
    ])
    expect(ran.shown).toEqual([
      batteryLine(19, "darwin"),
      batteryLine(15, "darwin"),
      batteryLine(9, "darwin"),
      batteryLine(8, "darwin"),
    ])
  })

  test("plugged in, the notice goes; the next discharge says it again", async () => {
    const ran = await watched([on(18), plugged(18), on(17)])
    expect(ran.log).toEqual([batteryLine(18, "darwin"), batteryLine(17, "darwin")])
    expect(ran.shown).toEqual([batteryLine(18, "darwin"), null, batteryLine(17, "darwin")])
  })

  test("a reading that fails changes nothing", async () => {
    const ran = await watched([on(18), undefined, on(17)])
    expect(ran.log).toEqual([batteryLine(18, "darwin")])
    expect(ran.shown).toEqual([batteryLine(18, "darwin"), batteryLine(17, "darwin")])
  })
})

describe("the dashboard's warning line", () => {
  test("shows the battery's notice after the run's own, until it goes", async () => {
    const warnings = await Effect.runPromise(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>({ ...emptyStatus, warnings: ["scheme"] })
        const gate = yield* makeHoldsGate({ status, notices: ["scheme"], wakeUp: Effect.void })
        const text = batteryLine(9, "darwin")
        yield* gate.changeHolds((now) => withBattery(now, text))
        const low = (yield* SubscriptionRef.get(status)).warnings
        yield* gate.changeHolds((now) => withBattery(now, null))
        return [low, (yield* SubscriptionRef.get(status)).warnings]
      }).pipe(Effect.provide(ledgerLayer())),
    )
    expect(warnings).toEqual([["scheme", batteryLine(9, "darwin")], ["scheme"]])
  })
})

describe("a run on battery", () => {
  const folder = (name: string) =>
    realpathSync(mkdtempSync(join(tmpdir(), `tutti-battery-${name}-`)))

  /** A worker that takes `takes` to commit and close its ticket. */
  const takes = (world: World, root: string, id: TicketId, span: Duration.Input): SessionScript =>
    turn(
      [
        sleep(span),
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

  test("says BATTERY as it runs low, and notifies at 10%", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = TestAppConfig.appConfig().settings
    const ran = await scenario(
      {
        config: { repo, settings: { ...defaults, concurrent: 1 } },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World) => ({
          "t-1": [takes(world, root, "t-1" as TicketId, "5 minutes")],
        }),
      },
      Effect.gen(function* () {
        const charge = yield* Charge
        yield* charge.set(on(19))
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        for (let minute = 0; minute < 8; minute++) {
          if (minute === 2) yield* charge.set(on(9))
          yield* TestClock.adjust("1 minute")
          yield* Effect.promise(() => Bun.sleep(3))
        }
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(batteryLayer)),
    )
    expectExitCode(ran, 0)
    expect(ran.log.filter((text) => text.startsWith("BATTERY: "))).toEqual([
      batteryLine(19, process.platform),
      batteryLine(9, process.platform),
    ])
    expect(ran.events.filter((record) => record.kind === "battery")).toEqual([
      expect.objectContaining({ level: 19, threshold: 20 }),
      expect.objectContaining({ level: 9, threshold: 10 }),
    ])
    expect(ran.notices).toContain("Battery 9% left · plug in to keep the run going")
  }, 30_000)
})
