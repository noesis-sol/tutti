// How a failed read is made again (again.ts): up to its policy's tries, its spacing apart, the
// try that gives up never said to be made again; only failures `while` takes are tried again. Each
// test runs under TestClock, moved on the policy's spacing at a time.
import { describe, expect, test } from "bun:test"
import { Clock, Duration, Effect, Exit, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { type Again, retrying } from "../src/run/again.ts"

const policy: Again = { tries: 3, after: Duration.seconds(3) }

interface Ran {
  readonly exit: Exit.Exit<string, string>
  /** The tries made, each with the clock's time as it was made, in seconds. */
  readonly made: ReadonlyArray<number>
  /** The failed tries `tried` was told of, as `<error>:<number>`. */
  readonly told: ReadonlyArray<string>
}

/** Runs `read` (given its try's number) as `as` retries it, while `retries` takes the error. */
const run = (
  read: (n: number) => Effect.Effect<string, string>,
  retries?: (error: string) => boolean,
  as = policy,
): Promise<Ran> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const made = yield* Ref.make<ReadonlyArray<number>>([])
      const told = yield* Ref.make<ReadonlyArray<string>>([])
      const once = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const n = (yield* Ref.get(made)).length + 1
        yield* Ref.update(made, (all) => [...all, now / 1000])
        return yield* read(n)
      })
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          retrying(once, as, {
            ...(retries === undefined ? {} : { while: retries }),
            tried: (error, tried) => Ref.update(told, (all) => [...all, `${error}:${tried}`]),
          }),
        ),
      )
      for (let i = 0; i < 10 && fiber.pollUnsafe() === undefined; i++) {
        yield* TestClock.adjust(policy.after)
      }
      return {
        exit: yield* Fiber.join(fiber),
        made: yield* Ref.get(made),
        told: yield* Ref.get(told),
      } satisfies Ran
    }).pipe(Effect.provide(TestClock.layer())),
  )

describe("a read that always fails", () => {
  test("is made its policy's tries in all, apart, then fails with its last error", async () => {
    const ran = await run((n) => Effect.fail(`down ${n}`))
    expect(ran.exit).toEqual(Exit.fail("down 3"))
    expect(ran.made).toEqual([0, 3, 6])
  })

  test("has each try but the last said to be made again", async () => {
    const ran = await run((n) => Effect.fail(`down ${n}`))
    expect(ran.told).toEqual(["down 1:1", "down 2:2"])
  })
})

describe("a read that fails once", () => {
  test("is made again once, and gives its answer", async () => {
    const ran = await run((n) => (n === 1 ? Effect.fail("down") : Effect.succeed("read")))
    expect(ran.exit).toEqual(Exit.succeed("read"))
    expect(ran.made).toEqual([0, 3])
    expect(ran.told).toEqual(["down:1"])
  })
})

describe("a failure `while` doesn't take", () => {
  test("isn't tried again, nor said to be", async () => {
    const ran = await run(
      (n) => Effect.fail(n === 1 ? "locked" : "no such issue"),
      (error) => error !== "no such issue",
    )
    expect(ran.exit).toEqual(Exit.fail("no such issue"))
    expect(ran.made).toEqual([0, 3])
    expect(ran.told).toEqual(["locked:1"])
  })
})

describe("a policy of one try", () => {
  test("makes it once, and says nothing of trying again", async () => {
    const ran = await run((n) => Effect.fail(`down ${n}`), undefined, { ...policy, tries: 1 })
    expect(ran.exit).toEqual(Exit.fail("down 1"))
    expect(ran.made).toEqual([0])
    expect(ran.told).toEqual([])
  })
})
