// The title line's PRESSURE hold (tutti-q8sf): red while the memory is pressed, amber with when the
// cap is due to rise once the pressure has passed and the cap waits out its calm, counting down
// (`PRESSURE · rising in 3m`); a reading pressed again turns it red and drops the time, and the
// hold lifted leaves no banner. A narrow pane keeps the word alone.

import { describe, expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { tuttiScheme } from "../src/project/scheme.ts"
import { shownHolds } from "../src/run/holds.ts"
import { make as makeHoldsGate } from "../src/run/holdsGate.ts"
import {
  type Kernel,
  pressureLowerAfter,
  pressureRaiseAfter,
  type Reading,
} from "../src/run/load.ts"
import { make as makePressureGate } from "../src/run/pressureGate.ts"
import { Banner, emptyStatus, type Status, type TitleView } from "../src/run/runView.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import type { Segments } from "../src/ui/line.tsx"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme } from "../src/ui/theme.ts"

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: false })

const title: TitleView = {
  version: "0.1.0",
  branch: "main",
  scope: null,
  began: 0,
  stopping: false,
  quitting: null,
  solo: null,
  shared: 0,
  keepAwake: false,
  autoAnswer: null,
}

const reading = (pressure: Kernel["pressure"], at: number): Reading => ({
  at,
  workers: new Map(),
  check: 0,
  kernel: { pressure, swaps: 0, load1: 1, cores: 10, available: -1 },
  swapping: 0,
  levels: { cpu: "green", pressure: "green", swapping: "green" },
})

/** What the title line shows of the holds, `width` columns wide at `now`: its last segment. */
interface Shown {
  readonly text: string
  readonly style: "stop" | "notice" | "other"
}

const shownOf = (segments: Segments, width: number): Shown | null => {
  const last = segments.at(-1)
  if (last === undefined || !last.text.startsWith("PRESSURE")) return null
  expect(segments.map((segment) => segment.text).join("").length).toBeLessThanOrEqual(width)
  const style =
    last.look === theme.styles.stop
      ? "stop"
      : last.look === theme.styles.deferred
        ? "notice"
        : "other"
  return { text: last.text, style }
}

describe("the title line's PRESSURE hold", () => {
  test("red while pressed, amber counting down to the rise once calm, red again, then gone", async () => {
    const seen = await Effect.runPromise(
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
        let at = 0
        /** Readings of `pressure` every 5 s for `ms`, the clock driven along with them. */
        const readings = (pressure: Kernel["pressure"], ms: number) =>
          Effect.gen(function* () {
            for (let gone = 0; gone < ms; gone += 5_000) {
              at += 5_000
              yield* TestClock.adjust(5_000)
              yield* gate.read(reading(pressure, at))
            }
          })
        const look = (width = 140) =>
          Effect.gen(function* () {
            const banners = shownHolds(yield* holds.now).holds.map((hold) => Banner.Hold(hold))
            return shownOf(titleSegments(title, banners, at, theme, width), width)
          })
        yield* gate.read(reading("warn", at))
        yield* readings("warn", pressureLowerAfter)
        const room = yield* gate.room(1)
        const pressed = yield* look()
        yield* readings("normal", 5_000)
        const calm = yield* look()
        const narrow = yield* look(30)
        yield* readings("normal", 120_000)
        const later = yield* look()
        yield* readings("warn", 5_000)
        const again = yield* look()
        yield* readings("normal", pressureRaiseAfter + 5_000)
        const lifted = yield* gate.lookAround(1)
        return { room, pressed, calm, narrow, later, again, lifted, gone: yield* look() }
      }).pipe(
        Effect.scoped,
        Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
      ),
    )
    expect(seen).toEqual({
      room: "began",
      pressed: { text: "PRESSURE", style: "stop" },
      calm: { text: "PRESSURE · rising in 5m", style: "notice" },
      narrow: { text: "PRESSURE", style: "notice" },
      later: { text: "PRESSURE · rising in 3m", style: "notice" },
      again: { text: "PRESSURE", style: "stop" },
      lifted: true,
      gone: null,
    })
  })

  test("a rise come due before its reading shows the word alone, still amber", () => {
    const banner = Banner.Hold({ word: "PRESSURE", resetsAt: 60_000, rising: true })
    expect(shownOf(titleSegments(title, [banner], 60_000, theme, 140), 140)).toEqual({
      text: "PRESSURE",
      style: "notice",
    })
    expect(shownOf(titleSegments(title, [banner], 59_000, theme, 140), 140)).toEqual({
      text: "PRESSURE · rising in 1m",
      style: "notice",
    })
  })
})
