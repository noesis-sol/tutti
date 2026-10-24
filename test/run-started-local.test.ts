// When a run started (src/run/localTime.ts's runStarted), as its events' `run` and its lock's
// `started`: local time with its offset, as each event's `time` is, and still read by the lock.
import { describe, expect, test } from "bun:test"
import { stamp } from "../src/run/eventstream.ts"
import { runStarted } from "../src/run/localTime.ts"
import { AlreadyRunning } from "../src/services/RunLock.ts"
import { withVariable } from "./env.ts"

const inBerlin = <A>(body: () => A): A => withVariable("TZ", "Europe/Berlin", body)

describe("the run's start time", () => {
  test("is local with its offset, not UTC", () =>
    inBerlin(() => {
      const at = new Date(2026, 9, 17, 9, 12, 3, 980).getTime()
      expect(runStarted(at)).toBe("2026-10-17T09:12:03.98+02:00")
    }))

  test("is in a record's run with the same offset as its time, so the two compare", () =>
    inBerlin(() => {
      const started = new Date(2026, 9, 17, 9, 12, 3).getTime()
      const record = stamp({ kind: "queue", queued: 0 }, runStarted(started), started + 1500)
      expect(record.run).toBe("2026-10-17T09:12:03+02:00")
      expect(record.time).toBe("2026-10-17T09:12:04.5+02:00")
      expect(record.run < record.time).toBe(true)
    }))

  test("is Z in UTC, as Go's RFC3339Nano writes it", () =>
    withVariable("TZ", "UTC", () => {
      expect(runStarted(Date.UTC(2026, 9, 17, 9, 12, 3))).toBe("2026-10-17T09:12:03Z")
    }))

  test("is read by the lock's refusal as its local time", () =>
    inBerlin(() => {
      const refusal = new AlreadyRunning({
        program: "tutti",
        repo: "/r",
        holder: { pid: 44497, started: runStarted(new Date(2026, 9, 17, 8, 31, 5).getTime()) },
      })
      expect(refusal.message).toContain("since 08:31")
    }))
})
