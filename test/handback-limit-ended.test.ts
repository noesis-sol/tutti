// A hand-back whose worker is at the account's usage limit (handback.ts' give): its wait for the
// limit to lift ends when the worker's states end, its session cut before a state says it is gone,
// and lasts at most --usage-limit-wait, so that the hand-back, and the run with it, always ends.
// The worker is a stub over the scenario's AgentHost: its states are what each test gives.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Stream } from "effect"
import { AgentGone, AgentHost, type MessageUuid } from "../src/agent/AgentHost.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { type AtReset, give, type HandBack, noReset } from "../src/run/handback.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import type { Sha } from "../src/services/Git.ts"
import { advance, backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

setDefaultTimeout(30_000)

const id = "t-1" as TicketId
const limited = WorkerState.UsageLimited({ resetsAt: null })
const uuid = "u-1" as MessageUuid
const wait = Duration.hours(1)

const handBack: HandBack = {
  ticket: { id, title: "One ticket", branch: "tutti/t-1", worktree: "/w/t-1" },
  mode: "fixing",
  prompt: "Fix the check.",
  what: line`${id}'s check failed`,
  onto: "a".repeat(40) as Sha,
  to: "b".repeat(40) as Sha,
  done: Effect.succeed(false),
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Lets every fiber that can go on run, in real time: TestClock holds only sleeps. */
const settle = Effect.promise(() => Bun.sleep(20))

/**
 * give, its worker at the limit, its states `states()` each time they are asked for, its hand-back
 * answered as `answered` says, and the clock moved on by `step` until give is done: what it gave,
 * or "still waiting" after `most` steps.
 */
const giving = (
  states: () => Stream.Stream<WorkerState>,
  atReset: AtReset,
  answered: Effect.Effect<void> = Effect.never,
  step = Duration.minutes(10),
  most = 30,
) =>
  scenario(
    { backlog: backlog().ticket(id).seeds, config: { usageLimitWait: wait } },
    Effect.gen(function* () {
      const host = yield* AgentHost
      const stub: AgentHost["Service"] = {
        ...host,
        current: () => Effect.succeed(limited),
        state: () => states(),
        send: () => Effect.succeed(uuid),
        answered: () => answered,
        interrupt: () => Effect.fail(new AgentGone({ ticket: id, why: "a stub" })),
      }
      const fiber = yield* Effect.forkChild(
        give(handBack, Duration.minutes(20), {
          atReset,
          loaded: Effect.succeed(false),
        }).pipe(Effect.provideService(AgentHost, stub)),
      )
      for (let i = 0; i < most && fiber.pollUnsafe() === undefined; i++) {
        yield* settle
        yield* advance(step)
      }
      if (fiber.pollUnsafe() === undefined) {
        yield* Fiber.interrupt(fiber)
        return "still waiting"
      }
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<unknown, unknown, Env>,
  )

describe("a hand-back to a worker at the usage limit", () => {
  test("waits for the limit to lift at most --usage-limit-wait, then ends", async () => {
    // Sent at once (no hold), its worker stays at the limit and never settles.
    const ran = await giving(() => Stream.concat(Stream.make(limited), Stream.never), noReset)
    expect(resultOf(ran)).toEqual(expect.stringContaining("with the hand-back not done"))
    expectLog(ran, [
      `  ${id}'s worker is at the usage limit on its hand-back: it carries on once the limit lifts, the wait not counting toward the 20m`,
      `  ${id}'s worker has been at the usage limit on its hand-back for 1h, --usage-limit-wait: its hand-back is over`,
    ])
  })

  test("kept for the reset, goes on once its worker's states end after it is sent", async () => {
    // Sent at the reset, its session is cut before a state says it left the limit or went.
    let sent = false
    const atReset: AtReset = {
      keep: () =>
        Effect.succeed(
          Effect.sync(() => {
            sent = true
            return uuid
          }),
        ),
      takeBack: () => Effect.succeed(false),
      waits: (_id, wait) => wait,
    }
    const ran = await giving(
      () => (sent ? Stream.empty : Stream.make(limited)),
      atReset,
      Effect.void,
    )
    expect(resultOf(ran)).toBeUndefined()
  })

  test("kept for the reset that never comes, ends after --usage-limit-wait", async () => {
    const atReset: AtReset = {
      keep: () => Effect.succeed(Effect.never),
      takeBack: () => Effect.succeed(true),
      waits: (_id, wait) => wait,
    }
    const ran = await giving(() => Stream.concat(Stream.make(limited), Stream.never), atReset)
    expect(resultOf(ran)).toBe(
      "its worker was still at the usage limit after 1h, --usage-limit-wait",
    )
  })
})
