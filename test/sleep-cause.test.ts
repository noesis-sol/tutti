// Why the machine slept (§ 5 item 15, tutti-abem): on macOS the SLEPT line names the cause pmset's
// log gives for the sleep that began as the machine was last seen awake (src/run/sleepCause.ts),
// none when no line matches, the log doesn't read or the system isn't macOS; a closed lid's sleep
// in a run kept awake says that keeping awake can't prevent it. The START block says what keeping
// awake covers (src/run/keepAwake.ts).
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { lidNote } from "../src/run/keepAwake.ts"
import { causeFromPmsetLog, liveSleepCauses } from "../src/run/sleepCause.ts"
import { keepAwakeHint, lidClosedHint, sleptLine, watchSleeps } from "../src/run/slept.ts"
import type { Sleep } from "../src/services/Wake.ts"
import * as TestEvents from "../src/testing/EventStream.ts"
import * as TestLog from "../src/testing/Log.ts"
import { layer as causesLayer } from "../src/testing/SleepCauses.ts"
import { Asleep, layer as asleepLayer } from "../src/testing/Wake.ts"
import { withVariable } from "./env.ts"

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", "pmset-log", name), "utf8")
const causes = fixture("causes.log")
const malformed = fixture("malformed.log")

/** The instant of a time on 2026-10-25 in pmset's fixture logs, written at UTC+2. */
const at = (time: string) => Date.parse(`2026-10-25T${time}+02:00`)

describe("the cause in pmset's log", () => {
  test("is the reason of the sleep entry nearest the instant, in words", () => {
    // The machine was last seen awake a moment before it entered sleep.
    expect(causeFromPmsetLog(causes, at("09:41:22"))).toBe("lid closed")
    expect(causeFromPmsetLog(causes, at("10:46:04"))).toBe("idle")
    expect(causeFromPmsetLog(causes, at("14:03:04"))).toBe("battery low")
    expect(causeFromPmsetLog(causes, at("18:20:39"))).toBe("asked to sleep")
  })

  test("names a Software Sleep that names the process asking", () => {
    expect(causeFromPmsetLog(causes, at("16:00:00"))).toBe("asked to sleep")
  })

  test("takes an entry up to a minute either side, the nearest of two", () => {
    expect(causeFromPmsetLog(causes, at("09:42:20"))).toBe("lid closed")
    expect(causeFromPmsetLog(causes, at("09:40:25"))).toBe("lid closed")
    // Idle Sleep at 10:46:05, Maintenance Sleep at 10:47:02.
    expect(causeFromPmsetLog(causes, at("10:46:30"))).toBe("idle")
    expect(causeFromPmsetLog(causes, at("10:46:40"))).toBeNull()
  })

  test("is none further than a minute from any entry", () => {
    expect(causeFromPmsetLog(causes, at("09:42:30"))).toBeNull()
    expect(causeFromPmsetLog(causes, at("11:30:00"))).toBeNull()
    expect(causeFromPmsetLog("", at("09:41:22"))).toBeNull()
  })

  test("is none for a reason it doesn't know", () => {
    expect(causeFromPmsetLog(causes, at("10:47:01"))).toBeNull()
    expect(causeFromPmsetLog(causes, at("12:31:29"))).toBeNull()
  })

  test("is none in a malformed log: no offset, a date or offset out of range, no quotes", () => {
    expect(causeFromPmsetLog(malformed, at("09:41:22"))).toBeNull()
  })

  test("is one of the four causes or none, whatever the log says", () => {
    const words = new Set(["lid closed", "battery low", "idle", "asked to sleep"])
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.integer(), (text, from) => {
        const cause = causeFromPmsetLog(`${causes}${text}\n${malformed}`, from)
        expect(cause === null || words.has(cause)).toBe(true)
      }),
    )
    for (const reason of ["constructor", "__proto__", "toString"]) {
      const log = `2026-10-25 09:41:23 +0200 Sleep \tEntering Sleep state due to '${reason}':x\n`
      expect(causeFromPmsetLog(log, at("09:41:23"))).toBeNull()
    }
  })
})

describe("the live source", () => {
  /** A folder whose `pmset` prints `log` and exits with `exit`. */
  const fakePmset = (log: string, exit = 0): string => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-sleep-cause-"))
    writeFileSync(join(dir, "pmset.log"), log)
    writeFileSync(
      join(dir, "pmset"),
      `#!/bin/sh\n[ "$1 $2" = "-g log" ] || exit 9\n/bin/cat '${join(dir, "pmset.log")}'\nexit ${exit}\n`,
    )
    chmodSync(join(dir, "pmset"), 0o755)
    return dir
  }

  const read = (platform: NodeJS.Platform, dir: string, from: number) =>
    withVariable("PATH", dir, () =>
      Effect.runPromise(
        liveSleepCauses(platform).read(from).pipe(Effect.provide(BunServices.layer)),
      ),
    )

  test("reads pmset's log on macOS", async () => {
    expect(await read("darwin", fakePmset(causes), at("09:41:22"))).toBe("lid closed")
  })

  test("names none when pmset fails, or isn't there", async () => {
    expect(await read("darwin", fakePmset(causes, 1), at("09:41:22"))).toBeNull()
    expect(await read("darwin", mkdtempSync(join(tmpdir(), "tutti-sleep-cause-")), 0)).toBeNull()
  })

  test("reads nothing off macOS", async () => {
    expect(await read("linux", fakePmset(causes), at("09:41:22"))).toBeNull()
  })
})

describe("the SLEPT line", () => {
  const lid: Sleep = { from: at("09:41:22"), to: at("09:45:17") }
  const idle: Sleep = { from: at("10:46:04"), to: at("10:58:00") }
  const unknown: Sleep = { from: at("11:30:00"), to: at("11:50:00") }

  test("names the cause after the times, and nothing without one", () => {
    expect<string>(sleptLine(lid, "lid closed")).toMatch(
      /^SLEPT: the machine slept 4m \(\d\d:\d\d-\d\d:\d\d, lid closed\); checks and limits don't count it$/,
    )
    expect<string>(sleptLine(lid, "battery low")).toContain(", battery low); ")
    expect<string>(sleptLine(lid, "idle")).toContain(", idle); ")
    expect<string>(sleptLine(lid, "asked to sleep")).toContain(", asked to sleep); ")
    expect<string>(sleptLine(lid)).toMatch(/\(\d\d:\d\d-\d\d:\d\d\); checks/)
  })

  /** The lines and records watchSleeps writes for `sleeps`, pmset's log `log`. */
  const said = (keepAwake: boolean, log: string | null, sleeps: ReadonlyArray<Sleep>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(watchSleeps({ keepAwake }))
        yield* Effect.promise(() => Bun.sleep(5))
        for (const each of sleeps) {
          yield* (yield* Asleep).noted(each)
          yield* Effect.promise(() => Bun.sleep(5))
        }
        yield* Fiber.interrupt(fiber)
        return {
          log: yield* TestLog.texts,
          records: yield* (yield* TestEvents.Captured).records,
        }
      }).pipe(
        Effect.provide(Layer.mergeAll(TestLog.layer(), TestEvents.layer(), asleepLayer)),
        Effect.provide(log === null ? Layer.empty : causesLayer(log)),
        Effect.provide(Layer.merge(TestClock.layer(), BunServices.layer)),
      ),
    )

  test("each sleep's line and record name its cause from pmset's log", async () => {
    const { log, records } = await said(true, causes, [lid, idle, unknown])
    expect(log).toEqual([
      sleptLine(lid, "lid closed"),
      lidClosedHint,
      sleptLine(idle, "idle"),
      sleptLine(unknown),
    ])
    expect(records.map((record) => (record as { text: string }).text)).toEqual([
      sleptLine(lid, "lid closed"),
      sleptLine(idle, "idle"),
      sleptLine(unknown),
    ])
  })

  test("a closed lid in a run kept awake says keeping awake can't prevent it", () => {
    expect<string>(lidClosedHint).toBe(
      "  keeping the machine awake can't prevent a closed lid's sleep: keep the Mac on power with an external display, or run sudo pmset -a disablesleep 1 (and 0 after)",
    )
  })

  test("not kept awake, a closed lid's sleep takes no hint to use it; the next sleep does", async () => {
    const { log } = await said(false, causes, [lid, idle])
    expect(log).toEqual([sleptLine(lid, "lid closed"), sleptLine(idle, "idle"), keepAwakeHint])
  })

  test("a malformed log, or none to read, leaves the line as it was", async () => {
    expect((await said(true, malformed, [lid])).log).toEqual([sleptLine(lid)])
    expect((await said(false, null, [lid])).log).toEqual([sleptLine(lid), keepAwakeHint])
  })
})

describe("what keeping awake covers", () => {
  test("the START block's note on a laptop says a closed lid still sleeps it", () => {
    expect(lidNote("darwin")).toBe(
      "keeping the machine awake prevents idle sleep only: closing the lid still sleeps the Mac unless it runs on power with an external display; sudo pmset -a disablesleep 1 keeps a closed Mac awake, system-wide, until sudo pmset -a disablesleep 0, which tutti never runs itself",
    )
    expect(lidNote("linux")).toContain(
      "closing the lid still suspends the machine unless it is docked or has an external display",
    )
    expect(lidNote("win32")).toBeNull()
  })
})
