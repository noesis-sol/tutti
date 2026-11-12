// The early check's wait at its ticket's turn (tutti-epza.13, tutti-kazz): the merge waits for an
// early check still running, a line saying what it waits for, until the check has run twice the
// longest of the last early checks that passed, or its own time limit where that is sooner or
// before any passed; one still running then is cancelled, a miss, and the merge runs its own check.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, type Scope } from "effect"
import { make as makeEarly, waitBound } from "../src/run/earlyCheck.ts"
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

/** A check that never ends, `started` told when it runs. */
const endless = (started: Deferred.Deferred<void>): Effect.Effect<CheckResult> =>
  Effect.andThen(Deferred.succeed(started, undefined), Effect.never)

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

describe("how long an early check may run before its turn gives it up", () => {
  test("twice the longest of the last passes, no longer than the check's time limit", () => {
    expect(waitBound([], 600)).toEqual({ seconds: 600, why: "the check's time limit (10m)" })
    expect(waitBound([60], 600)).toEqual({
      seconds: 120,
      why: "twice the longest of the last pass (1m)",
    })
    expect(waitBound([10, 100, 60], 600)).toEqual({
      seconds: 200,
      why: "twice the longest of the last 3 passes (1m40s)",
    })
    expect(waitBound([10, 300, 60], 600)).toEqual({
      seconds: 600,
      why: "the check's time limit (10m)",
    })
    expect(waitBound([400], 600)).toEqual({ seconds: 600, why: "the check's time limit (10m)" })
  })
})

describe("at its ticket's turn, an early check still running", () => {
  test("past the estimate of a fresh check is waited for: its pass merges with no second check", async () => {
    const ran = await run(
      {
        ...noTrain,
        checks: {
          fast: [
            // t-2's early check, which takes a minute: the last pass.
            Effect.as(Effect.sleep("1 minute"), passed("fast")),
            // t-1's, which takes one and a half.
            Effect.as(Effect.sleep("90 seconds"), passed("fast")),
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
        yield* advance("1 minute")
        yield* until(t2, "passed")
        const ticket = yield* working(t1)
        yield* early.called(t1)
        yield* until(t1, "started")
        yield* settle
        yield* Effect.orDie((yield* Beads).close(t1, "done"))
        yield* queue.offer(ticket)
        yield* settle
        yield* advance("89 seconds")
        yield* settle
        const before = recordsOf(yield* (yield* Captured).records, t1).map((each) => each.detail)
        yield* advance("1 second")
        yield* queue.settled
        return before
      }),
    )
    expect(ran.exit._tag === "Success" && ran.exit.value).toEqual(["started"])
    const records = recordsOf(ran.events, t1)
    expect(records.map((each) => each.detail)).toEqual(["started", "passed", "hit"])
    const hit = records.find((each) => each.detail === "hit")
    expect(hit?.waited).toBeGreaterThanOrEqual(89)
    expect(ran.log).toContainEqual(
      "  EARLY_CHECK: t-1: still running after 0s: its turn waits up to 2m more for it, until it has run twice the longest of the last pass (1m)",
    )
    expect(ran.checkRuns.filter((each) => each.check === "fast")).toHaveLength(2)
    const done = ran.events.find(
      (each) => each.kind === "phase" && each.ticket === t1 && each.to === "Done",
    )
    expect(done).toBeDefined()
  }, 15_000)

  test("past twice the longest of the last passes is cancelled: the merge checks", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const ran = await run(
      {
        ...noTrain,
        checks: {
          fast: [
            // t-2's early check, which takes a minute: the last pass.
            Effect.as(Effect.sleep("1 minute"), passed("fast")),
            endless(started),
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
        yield* advance("1 minute")
        yield* until(t2, "passed")
        const ticket = yield* working(t1)
        yield* early.called(t1)
        yield* Deferred.await(started)
        yield* Effect.orDie((yield* Beads).close(t1, "done"))
        yield* queue.offer(ticket)
        yield* settle
        yield* advance("119 seconds")
        yield* settle
        const before = recordsOf(yield* (yield* Captured).records, t1).map((each) => each.detail)
        yield* advance("2 seconds")
        yield* queue.settled
        return before
      }),
    )
    expect(ran.exit._tag === "Success" && ran.exit.value).toEqual(["started"])
    const records = recordsOf(ran.events, t1)
    expect(records.map((each) => each.detail)).toEqual(["started", "cancelled", "miss"])
    expect(records.find((each) => each.detail === "miss")?.why).toMatch(
      /^it still ran after 2m\d*s?, twice the longest of the last pass \(1m\)$/,
    )
    expect(ran.log).toContainEqual(
      "  EARLY_CHECK: t-1: still running after 0s: its turn waits up to 2m more for it, until it has run twice the longest of the last pass (1m)",
    )
    expect(ran.checkRuns.filter((each) => each.check === "fast")).toHaveLength(3)
    const done = ran.events.find(
      (each) => each.kind === "phase" && each.ticket === t1 && each.to === "Done",
    )
    expect(done).toBeDefined()
  }, 15_000)
})
