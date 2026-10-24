import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Clock, Duration, Effect, Layer } from "effect"
import { AttentionPoll, pollEvery, serve } from "../src/agent/attentionFiles.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { environment } from "./harness.ts"

const tempRepo = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-attention-poll-")))

/**
 * The first sleep the attention folder's poll takes as `serve` runs with `poll` given, under a
 * clock whose sleeps are recorded and never end.
 */
const firstPoll = (
  provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  poll?: Duration.Input,
): Promise<Duration.Duration> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* Clock.Clock
        const slept: Array<Duration.Duration> = []
        const recording: Clock.Clock = {
          currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
          currentTimeMillis: live.currentTimeMillis,
          currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
          currentTimeNanos: live.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: live.monotonicTimeNanos,
          sleep: (duration) =>
            Effect.andThen(
              Effect.sync(() => slept.push(duration)),
              Effect.never,
            ),
        }
        yield* serve({ repo: tempRepo(), ...(poll === undefined ? {} : { poll }) }).pipe(
          Effect.provideService(Clock.Clock, recording),
          provide,
        )
        while (slept.length === 0) yield* Effect.promise(() => Bun.sleep(1))
        return slept[0] as Duration.Duration
      }),
    ).pipe(
      Effect.provide(
        attentionLayer().pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer(), BunFileSystem.layer)),
        ),
      ),
    ),
  )

describe("the attention folder's poll", () => {
  test("is pollEvery, 2 seconds, when nothing sets it", async () => {
    const poll = await firstPoll((effect) => effect)
    expect(Duration.toMillis(poll)).toBe(Duration.toMillis(pollEvery))
    expect(Duration.toMillis(poll)).toBe(2_000)
  })

  test("is AttentionPoll's where it is provided", async () => {
    const poll = await firstPoll(Effect.provideService(AttentionPoll, Duration.minutes(5)))
    expect(Duration.toMillis(poll)).toBe(300_000)
  })

  test("is serve's poll option over AttentionPoll", async () => {
    const poll = await firstPoll(
      Effect.provideService(AttentionPoll, Duration.minutes(5)),
      "50 millis",
    )
    expect(Duration.toMillis(poll)).toBe(50)
  })

  test("never wakes in the scenarios, whatever TestClock advances", async () => {
    const poll = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* AttentionPoll
        }),
      ).pipe(Effect.provide(environment())),
    )
    expect(Duration.isFinite(poll)).toBe(false)
  })
})
