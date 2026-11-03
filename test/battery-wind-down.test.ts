// The battery's wind-down (§ 5 item 16, tutti-epza.21): at 10%, discharging, the run winds down as
// the wind-down command does, no new tickets and those under way finishing and merging, and says so
// in its BATTERY line, its notification and the dashboard's warning line; plugged in again, it
// doesn't take tickets again by itself.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
  Battery,
  type BatteryReading,
  batteryEvery,
  batteryLine,
  watchBattery,
} from "../src/run/battery.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { layer as batteryLayer, Charge } from "../src/testing/Battery.ts"
import * as TestEvents from "../src/testing/EventStream.ts"
import * as TestLog from "../src/testing/Log.ts"
import { backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const on = (level: number): BatteryReading => ({ level, discharging: true })
const plugged = (level: number): BatteryReading => ({ level, discharging: false })

/** Lets the fibers forked so far run. */
const settle = Effect.promise(() => Bun.sleep(5))

describe("the watcher's wind-down", () => {
  /** The levels watchBattery winds the run down at over `readings`, one a minute, and its log. */
  const windDowns = (readings: ReadonlyArray<BatteryReading | null | undefined>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const charge = yield* Charge
        const levels: Array<number> = []
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
            windDown: (level) => Effect.sync(() => levels.push(level)),
          }),
        )
        yield* settle
        for (const reading of rest) {
          yield* charge.set(reading)
          yield* TestClock.adjust(batteryEvery)
          yield* settle
        }
        yield* Fiber.interrupt(fiber)
        return { levels, shown, log: yield* TestLog.texts }
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

  test("at 10% it winds the run down, once a discharge, and says so; at 20% it doesn't", async () => {
    const ran = await windDowns([on(25), on(19), on(10), on(9), on(4)])
    expect(ran.levels).toEqual([10])
    expect(ran.log).toEqual([batteryLine(19, "darwin"), batteryLine(10, "darwin", true)])
    expect(ran.shown).toEqual([
      batteryLine(19, "darwin"),
      batteryLine(10, "darwin", true),
      batteryLine(9, "darwin", true),
      batteryLine(4, "darwin", true),
    ])
    expect<string>(batteryLine(10, "darwin", true)).toBe(
      "BATTERY: 10% left, not charging: the run winds down; plug in or the Mac will sleep",
    )
  })

  test("no wind-down without a battery, charging, or above 10%", async () => {
    const ran = await windDowns([null, plugged(5), undefined, on(11), plugged(3)])
    expect(ran.levels).toEqual([])
  })

  test("plugged in and running down again, it winds down again", async () => {
    const ran = await windDowns([on(8), plugged(8), on(15), on(7)])
    expect(ran.levels).toEqual([8, 7])
    expect(ran.shown).toEqual([
      batteryLine(8, "darwin", true),
      null,
      batteryLine(15, "darwin"),
      batteryLine(7, "darwin", true),
    ])
  })
})

describe("a run on a battery at 10%", () => {
  const folder = (name: string) =>
    realpathSync(mkdtempSync(join(tmpdir(), `tutti-battery-wind-down-${name}-`)))

  /** A worker that takes `span` to commit and close its ticket. */
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

  test("takes no new ticket, finishes the one under way, ends DRAINED; plugging in doesn't take it back", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = TestAppConfig.appConfig().settings
    const ran = await scenario(
      {
        config: { repo, settings: { ...defaults, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World) => ({
          "t-1": [takes(world, root, "t-1" as TicketId, "5 minutes")],
          "t-2": [takes(world, root, "t-2" as TicketId, "1 minute")],
        }),
      },
      Effect.gen(function* () {
        const charge = yield* Charge
        yield* charge.set(on(19))
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        yield* git.addWorktree(repo, join(root, "t-2"), { branch: "tutti/t-2", base: "main" })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        for (let minute = 0; minute < 10; minute++) {
          if (minute === 2) yield* charge.set(on(9))
          if (minute === 3) yield* charge.set(plugged(9))
          yield* TestClock.adjust("1 minute")
          yield* Effect.promise(() => Bun.sleep(3))
        }
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(batteryLayer)),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Queued" })
    expect(ran.log).toContain(batteryLine(9, process.platform, true))
    expect(ran.log).toContain(
      "DRAIN: stopping after t-1 finishes: no new tickets will start, asked by the battery at 9%",
    )
    expect(ran.log).toContain("DRAINED after 1 tickets")
    expect(ran.log.some((each) => each.includes("t-2 dispatching"))).toBe(false)
    expect(ran.events.filter((record) => record.kind === "drain")).toHaveLength(1)
    expect(ran.events.some((record) => record.kind === "resume")).toBe(false)
    expect(ran.notices).toContain(
      "Battery 9% left · the run winds down; plug in to finish what runs",
    )
  }, 30_000)
})
