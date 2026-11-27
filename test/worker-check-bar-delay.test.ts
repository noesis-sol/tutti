// A worker's narrow test run has no bar on its card (§ 7.2, tutti-h2zc): src/run/ownCheck.ts
// watches a testing Bash call in Checking only once it has run ownBarAfter, so that a run of one
// test file, over in seconds, doesn't flash a bar; it is still timed for the next run's estimate.

import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { TestRun } from "../src/agent/AgentHost.ts"
import { TestRunEvent } from "../src/agent/hooks.ts"
import {
  type Checking,
  type CheckShown,
  estimateCap,
  makeChecking,
  ownCheckKey,
  showEvery,
} from "../src/run/checking.ts"
import { followOwnChecks, ownBarAfter } from "../src/run/ownCheck.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { progressFileOf } from "../src/services/Checks.ts"
import { advance } from "./harness.ts"

const t1 = "t-1" as TicketId

const settle = Effect.gen(function* () {
  for (let turns = 0; turns < 200; turns++) yield* Effect.yieldNow
})

/** Follows the test runs `body` offers in a Checking of `passes`, on TestClock. */
const following = <A>(
  body: (
    offer: (run: TestRun) => Effect.Effect<void>,
    checking: Checking["Service"],
  ) => Effect.Effect<A>,
  passes: Parameters<typeof makeChecking>[0] = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<TestRun>()
        const checking = makeChecking(passes)
        yield* Effect.forkScoped(
          followOwnChecks(
            Stream.fromQueue(queue),
            checking,
            Effect.succeed({ fast: "scripts/check-fast.sh", full: "scripts/check-full.sh" }),
          ),
        )
        const offer = (run: TestRun) => Effect.andThen(Queue.offer(queue, run), settle)
        return yield* body(offer, checking)
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )

const began = (call: string, command: string, where?: string): TestRun => ({
  ticket: t1,
  ...(where === undefined ? {} : { worktree: where }),
  event: TestRunEvent.Began({ call, command }),
})

const ended = (call: string, passed: boolean): TestRun => ({
  ticket: t1,
  event: TestRunEvent.Ended({ call, passed }),
})

const ownNow = (checking: Checking["Service"]) =>
  Effect.map(checking.now, (now) => now.get(ownCheckKey(t1)))

/** The card's own check at each read of the progress file over `duration`, and its last. */
const readsOver = (checking: Checking["Service"], duration: Duration.Duration) =>
  Effect.gen(function* () {
    const reads: Array<CheckShown | undefined> = []
    const turns = Duration.toMillis(duration) / Duration.toMillis(showEvery)
    for (let turn = 0; turn < turns; turn++) {
      yield* Effect.andThen(advance(showEvery), settle)
      reads.push(yield* ownNow(checking))
    }
    return reads
  })

describe("a worker's narrow test run", () => {
  test("one that ends before ownBarAfter has no bar at any read, though its command has passes", async () => {
    const reads = await following(
      (offer, checking) =>
        Effect.gen(function* () {
          yield* offer(began("c1", "scripts/check-fast.sh"))
          const reads = yield* readsOver(checking, Duration.subtract(ownBarAfter, showEvery))
          yield* offer(ended("c1", true))
          return [...reads, yield* ownNow(checking)]
        }),
      { fast: [100] },
    )
    expect(reads.length).toBeGreaterThan(1)
    expect(reads.every((shown) => shown === undefined)).toBe(true)
  })

  test("one still running at ownBarAfter has its bar, its estimate counted from its start", async () => {
    const shown = await following(
      (offer, checking) =>
        Effect.gen(function* () {
          yield* offer(began("c1", "scripts/check-fast.sh"))
          yield* advance(ownBarAfter)
          yield* settle
          return yield* ownNow(checking)
        }),
      { fast: [100] },
    )
    expect(shown?.began).toBe(0)
    expect(shown?.fill).toEqual({ filled: 0.05, count: "≈5%", estimate: true })
  })

  test("short runs are timed all the same: the next run of the command has their estimate", async () => {
    const fill = await following((offer, checking) =>
      Effect.gen(function* () {
        for (const call of ["c1", "c2"]) {
          yield* offer(began(call, "bun test a.test.ts"))
          yield* advance("4 seconds")
          yield* offer(ended(call, true))
        }
        yield* offer(began("c3", "bun test a.test.ts"))
        yield* advance(ownBarAfter)
        yield* settle
        return (yield* ownNow(checking))?.fill
      }),
    )
    // 5 s against the 4 s its last runs took: the estimate at its cap.
    expect(fill).toEqual({ filled: estimateCap, count: "≈90%", estimate: true })
  })

  test("its progress file is emptied as it begins, and what it copied before the bar is read", async () => {
    const where = realpathSync(mkdtempSync(join(tmpdir(), "worker-check-bar-delay-")))
    const file = progressFileOf(where)
    const seen = await following((offer, checking) =>
      Effect.gen(function* () {
        yield* offer(began("c1", "scripts/check-fast.sh", where))
        yield* offer(ended("c1", false))
        appendFileSync(file, "SUITE: old\nPROGRESS: 9/10\n")
        yield* offer(began("c2", "scripts/check-fast.sh", where))
        const emptied = readFileSync(file, "utf8")
        appendFileSync(file, "SUITE: unit\nPROGRESS: 2/8\n")
        yield* readsOver(checking, ownBarAfter)
        yield* advance(showEvery)
        yield* settle
        const shown = yield* ownNow(checking)
        return { emptied, suite: shown?.suite, count: shown?.fill?.count }
      }),
    )
    expect(seen).toEqual({ emptied: "", suite: "unit", count: "2/8" })
  })
})
