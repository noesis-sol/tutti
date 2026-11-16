// The floor under the early check's wait at its ticket's turn (tutti-hcbk): a check's length
// follows its change, so after passes of a few seconds (documents-only tickets, no test selected)
// twice the longest of them gave up the next ticket's healthy check of minutes, and the merge
// checked from nothing in the slot. The turn waits for an early check five minutes at least, the
// check's own time limit allowing.
import { describe, expect, test } from "bun:test"
import { Deferred, type Duration, Effect, Exit, type Scope } from "effect"
import { make as makeEarly, waitBound, waitFloor } from "../src/run/earlyCheck.ts"
import { Ledger } from "../src/run/ledger.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { Move } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { CheckResult } from "../src/services/Checks.ts"
import type { EventRecord } from "../src/services/events.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { Repository } from "../src/testing/Git.ts"
import { advance, backlog, type Env, type Ran, type Setup, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main", setup: Effect.succeed(null) }

const { settings } = appConfig()
/** A project that checks each ticket in its turn alone, none ahead of it. */
const noTrain: Setup = {
  config: { settings: { ...settings, merge: { ...settings.merge, train: 0 } } },
}

const t1 = "t-1" as TicketId
const t2 = "t-2" as TicketId

/** A ticket its worker is working on: its branch with a commit naming it, saved, Working. */
const working = (id: TicketId) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* Effect.orDie((yield* Worktrees).prepare(id))
    yield* Effect.orDie(
      git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" }),
    )
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
    yield* Effect.orDie(
      (yield* Store).saveSession(id, {
        session: `s-${id}`,
        worktree: worktree.path,
        branch: worktree.branch,
      }),
    )
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Waits, turn by turn, until `id` has an early_check record of `detail`. */
const until = (id: TicketId, detail: string) =>
  Effect.gen(function* () {
    for (let turns = 0; turns < 20_000; turns++) {
      const records = yield* (yield* Captured).records
      const seen = records.some(
        (record) =>
          record.kind === "early_check" && record.ticket === id && record.detail === detail,
      )
      if (seen) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error(`${id} has no early_check record '${detail}'`))
  })

/** Lets the fibers forked run as far as they go. */
const settle = Effect.gen(function* () {
  for (let turns = 0; turns < 200; turns++) yield* Effect.yieldNow
})

const run = async <A>(
  setup: Setup,
  body: Effect.Effect<A, unknown, Env | Ledger | Scope.Scope>,
): Promise<Ran<A>> => {
  const ran = await scenario(
    { backlog: backlog().ticket("t-1").ticket("t-2").seeds, ...setup },
    body.pipe(Effect.provide(Ledger.layer)),
  )
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran
}

const recordsOf = (records: ReadonlyArray<EventRecord>, id: string) =>
  records.flatMap((record) =>
    record.kind === "early_check" && record.ticket === id ? [record] : [],
  )

/**
 * t-2's early check passes in 4 seconds, then t-1's runs `check`, `started` told as it starts; t-1
 * comes to its turn, and the clock moves `before`, then `after`. Gives the run and t-1's records'
 * details between the two.
 */
const quickThenSlow = (
  check: Effect.Effect<CheckResult>,
  started: Deferred.Deferred<void>,
  before: Duration.Input,
  after: Duration.Input,
) =>
  run(
    {
      ...noTrain,
      checks: {
        fast: [
          // t-2's early check, a documents-only change's: four seconds, the last pass.
          Effect.as(Effect.sleep("4 seconds"), passed("fast")),
          Effect.andThen(Deferred.succeed(started, undefined), check),
          passed("fast"),
        ],
      },
    },
    Effect.gen(function* () {
      const early = yield* makeEarly(options)
      const queue = yield* makeQueue({ ...options, early })
      yield* working(t2)
      yield* early.called(t2)
      yield* until(t2, "started")
      yield* settle
      yield* advance("4 seconds")
      yield* until(t2, "passed")
      const ticket = yield* working(t1)
      yield* early.called(t1)
      yield* Deferred.await(started)
      yield* settle
      yield* Effect.orDie((yield* Beads).close(t1, "done"))
      yield* queue.offer(ticket)
      yield* settle
      yield* advance(before)
      yield* settle
      const between = recordsOf(yield* (yield* Captured).records, t1).map((each) => each.detail)
      yield* advance(after)
      yield* queue.settled
      return between
    }),
  )

const waits =
  "  EARLY_CHECK: t-1: still running after 0s: its turn waits up to 5m more for it, until it has run the floor of 5m under twice the longest of the last pass (4s)"

describe("the floor under how long an early check may run before its turn gives it up", () => {
  test("is five minutes", () => {
    expect(waitFloor).toBe(300)
  })

  test("holds over twice the longest of quick passes", () => {
    expect(waitBound([3.2, 4], 1800)).toEqual({
      seconds: 300,
      why: "the floor of 5m under twice the longest of the last 2 passes (4s)",
    })
    expect(waitBound([4], 1800)).toEqual({
      seconds: 300,
      why: "the floor of 5m under twice the longest of the last pass (4s)",
    })
  })

  test("gives way to twice the longest pass beyond it", () => {
    expect(waitBound([3.2, 200], 1800)).toEqual({
      seconds: 400,
      why: "twice the longest of the last 2 passes (3m20s)",
    })
    expect(waitBound([150], 1800)).toEqual({
      seconds: 300,
      why: "twice the longest of the last pass (2m30s)",
    })
  })

  test("is capped by the check's time limit", () => {
    expect(waitBound([3.2, 4], 120)).toEqual({
      seconds: 120,
      why: "the check's time limit (2m)",
    })
    expect(waitBound([3.2, 4], 300)).toEqual({
      seconds: 300,
      why: "the check's time limit (5m)",
    })
    expect(waitBound([], 1800)).toEqual({ seconds: 1800, why: "the check's time limit (30m)" })
  })
})

describe("after a quick pass, at its ticket's turn, an early check still running", () => {
  test("for 3 minutes is waited for: its pass merges with no second check", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const ran = await quickThenSlow(
      Effect.as(Effect.sleep("3 minutes"), passed("fast")),
      started,
      "179 seconds",
      "1 second",
    )
    expect(ran.exit._tag === "Success" && ran.exit.value).toEqual(["started"])
    const records = recordsOf(ran.events, t1)
    expect(records.map((each) => each.detail)).toEqual(["started", "passed", "hit"])
    expect(records.find((each) => each.detail === "hit")?.waited).toBeGreaterThanOrEqual(179)
    expect(ran.log).toContainEqual(waits)
    expect(ran.checkRuns.filter((each) => each.check === "fast")).toHaveLength(2)
    const done = ran.events.find(
      (each) => each.kind === "phase" && each.ticket === t1 && each.to === "Done",
    )
    expect(done).toBeDefined()
  }, 15_000)

  test("past the floor is cancelled: the merge checks", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const ran = await quickThenSlow(Effect.never, started, "299 seconds", "2 seconds")
    expect(ran.exit._tag === "Success" && ran.exit.value).toEqual(["started"])
    const records = recordsOf(ran.events, t1)
    expect(records.map((each) => each.detail)).toEqual(["started", "cancelled", "miss"])
    expect(records.find((each) => each.detail === "miss")?.why).toMatch(
      /^it still ran after 5m\d*s?, the floor of 5m under twice the longest of the last pass \(4s\)$/,
    )
    expect(ran.log).toContainEqual(waits)
    expect(ran.checkRuns.filter((each) => each.check === "fast")).toHaveLength(3)
    const done = ran.events.find(
      (each) => each.kind === "phase" && each.ticket === t1 && each.to === "Done",
    )
    expect(done).toBeDefined()
  }, 15_000)
})
