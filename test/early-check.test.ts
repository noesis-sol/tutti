// The early check (src/run/earlyCheck.ts): a worker's call to the verifier checks its ticket's
// branch rebased onto the base in a worktree of its own, in the check slot no other check holds; a
// pass is kept by the rebased tree and the base, and the ticket's turn merges with no second check
// where its rebase gives the same tree on the same base, waiting for it if it still runs. A merge,
// a train, a fix, the checks gate and the full check take the slot, cancelling it; so do a new
// commit, another verifier round, the ticket leaving Working and the run winding down. Each is
// measured in early_check records, which the figures and the run report count.
import { describe, expect, test } from "bun:test"
import type { HookInput } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect, Exit, Fiber, Layer, type Scope, Stream } from "effect"
import { makeWorkers } from "../src/agent/AgentHost.ts"
import { WorkerEvent } from "../src/agent/WorkerState.ts"
import { make as makeEarly, noEarlyChecks } from "../src/run/earlyCheck.ts"
import type { EventRecord } from "../src/run/events.ts"
import { addRecord, earlyEvidence, earlyPart, noFigures } from "../src/run/figures.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed, type CheckResult } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { passed } from "../src/testing/Checks.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import type { Files } from "../src/testing/Git.ts"
import { Repository } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { advance, backlog, type Env, type Ran, type Setup, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main", setup: Effect.succeed(null) }

const { settings } = appConfig()
/** A project that checks each ticket in its turn alone, none ahead of it. */
const noTrain: Setup = {
  config: { settings: { ...settings, merge: { ...settings.merge, train: 0 } } },
}

const orDie = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.orDie(effect)

/**
 * A ticket its worker is working on: its worktree on tutti/<id> with a commit naming it, saved in
 * the Store, Working in the ledger.
 */
const working = (id: TicketId, files: Files = { [`${id}.txt`]: `${id}\n` }) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* orDie((yield* Worktrees).prepare(id))
    yield* orDie(
      git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" }),
    )
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* orDie(
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

/** Its worker closes it: it is finished, for the merge queue. */
const close = (ticket: FinishedTicket) =>
  Effect.gen(function* () {
    yield* orDie((yield* Beads).close(ticket.id, "done"))
  })

/** Another ticket's merge, landing on main. */
const moveMain = (files: Files = { "main.txt": "moved\n" }) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

/** The early_check records of `id` so far, as their details. */
const earlyOf = (id: TicketId) =>
  Effect.gen(function* () {
    const records = yield* (yield* Captured).records
    return records.flatMap((record) =>
      record.kind === "early_check" && record.ticket === id ? [record] : [],
    )
  })

/** Waits, turn by turn, until `id` has an early_check record of `detail`. */
const until = (id: TicketId, detail: string) =>
  Effect.gen(function* () {
    for (let turns = 0; turns < 20_000; turns++) {
      if ((yield* earlyOf(id)).some((record) => record.detail === detail)) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error(`${id} has no early_check record '${detail}'`))
  })

/** Lets the fibers forked run as far as they go. */
const settle = Effect.gen(function* () {
  for (let turns = 0; turns < 200; turns++) yield* Effect.yieldNow
})

/** A check that waits for `gate` before it passes, `started` told when it runs. */
const gated = (
  started: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>,
): Effect.Effect<CheckResult> =>
  Effect.andThen(
    Deferred.succeed(started, undefined),
    Effect.as(Deferred.await(gate), passed("fast")),
  )

/** A check that never ends: one that runs until it is killed. */
const endless = (started: Deferred.Deferred<void>): Effect.Effect<CheckResult> =>
  Effect.andThen(Deferred.succeed(started, undefined), Effect.never)

const failedCheck = (outputFile: string) =>
  new CheckFailed({
    check: "fast",
    command: "scripts/check-fast.sh",
    exitCode: 1,
    outputFile,
    failingLines: ["error: a.test.ts: expected 1"],
    lastLines: ["error: a.test.ts: expected 1", "1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

/** Runs `body` in a scenario with the ledger, and fails the test where it failed. */
const run = async <A>(
  setup: Setup,
  body: Effect.Effect<A, unknown, Env | Ledger | Scope.Scope>,
): Promise<Ran<A>> => {
  const tickets = backlog().ticket("t-1").ticket("t-2").seeds
  const ran = await scenario(
    { backlog: tickets, ...setup },
    body.pipe(Effect.provide(Ledger.layer)),
  )
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const details = (records: ReadonlyArray<EventRecord>, id: string) =>
  records.flatMap((record) =>
    record.kind === "early_check" && record.ticket === id ? [record.detail] : [],
  )

const recordOf = (records: ReadonlyArray<EventRecord>, id: string, detail: string) =>
  records.find(
    (record) => record.kind === "early_check" && record.ticket === id && record.detail === detail,
  ) as Extract<EventRecord, { kind: "early_check" }> | undefined

const fastRuns = (ran: Ran<unknown>) => ran.checkRuns.filter((each) => each.check === "fast")

const t1 = "t-1" as TicketId
const t2 = "t-2" as TicketId

describe("an early check starts", () => {
  test("on a call to the verifier: the branch rebased onto the base, in a worktree of its own", async () => {
    const ran = await run(
      {},
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const ticket = yield* working(t1)
        yield* moveMain()
        yield* early.called(t1)
        yield* until(t1, "passed")
        return ticket
      }),
    )
    const ticket = resultOf(ran)
    expect(details(ran.events, t1)).toEqual(["started", "passed"])
    const [check] = fastRuns(ran)
    expect(fastRuns(ran)).toHaveLength(1)
    expect(check?.cwd).not.toBe(ticket.worktree)
    expect(check?.cwd).toContain("early-check-")
    // Its worktree is removed once it has ended.
    expect(ran.worktreeCalls.map((each) => each.op)).toContain("removeDetached")
    const record = ran.events.find((each) => each.kind === "check" && each.suite === "early")
    expect(record).toMatchObject({ ticket: t1, result: "passed" })
    expect(ran.log.some((line) => line.includes(`EARLY_CHECK: ${t1}: checking tutti/${t1}`))).toBe(
      true,
    )
  })

  test("from the worker's own call to the verifier: AgentHost carries each round's begin once", async () => {
    const hook = (event: string, call: string) =>
      WorkerEvent.Hook({
        session: "s-1",
        input: {
          hook_event_name: event,
          session_id: "s-1",
          transcript_path: "/t",
          cwd: "/w",
          tool_name: "Agent",
          tool_input: { subagent_type: "verifier", prompt: "Verify" },
          tool_use_id: call,
        } as unknown as HookInput,
      })
    const calls = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* makeWorkers()
          const seen = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(workers.verifierCalls, 2)),
          )
          yield* settle
          const entry = yield* workers.open(t1, { session: "s-1", resumed: false })
          yield* workers.fold(entry, hook("PreToolUse", "toolu_1"))
          // The same call again, and its end, begin nothing.
          yield* workers.fold(entry, hook("PreToolUse", "toolu_1"))
          yield* workers.fold(entry, hook("PostToolUse", "toolu_1"))
          yield* workers.fold(entry, hook("PreToolUse", "toolu_2"))
          return yield* Fiber.join(seen)
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
        Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
      ),
    )
    expect([...calls]).toEqual([
      { ticket: t1, call: "toolu_1" },
      { ticket: t1, call: "toolu_2" },
    ])
  })

  test("not for a worktree with uncommitted changes, a branch with no commits, or a ticket not Working", async () => {
    const ran = await run(
      {},
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const dirty = yield* working(t1)
        yield* (yield* Repository).write(dirty.worktree, { [`${t1}.txt`]: "changed\n" })
        yield* early.called(t1)
        yield* working(t2)
        yield* (yield* Ledger).transition(t2, Move.Defer({ why: "deferred" }))
        yield* early.called(t2)
        yield* settle
      }),
    )
    expect(details(ran.events, t1)).toEqual([])
    expect(details(ran.events, t2)).toEqual([])
    expect(fastRuns(ran)).toHaveLength(0)
  })

  test("none with merge.early_check false", async () => {
    const off = { settings: { ...settings, merge: { ...settings.merge, early_check: false } } }
    const ran = await run(
      { config: off },
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        yield* working(t1)
        yield* early.called(t1)
        yield* settle
        return early
      }),
    )
    expect(resultOf(ran)).toBe(noEarlyChecks)
    expect(details(ran.events, t1)).toEqual([])
  })
})

describe("the check slot", () => {
  test("no early check starts while another check holds it, nor beside another early check", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const ran = await run(
      { checks: { fast: [endless(started)] } },
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        yield* working(t1)
        yield* working(t2)
        const release = yield* Deferred.make<void>()
        const held = yield* Effect.forkChild(
          early.claim("tutti/t-9's merge", Deferred.await(release)),
        )
        yield* settle
        yield* early.called(t1)
        yield* settle
        expect(yield* earlyOf(t1)).toEqual([])
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(held)
        // Free again: t-1's starts, and t-2's waits for none beside it.
        yield* early.called(t1)
        yield* Deferred.await(started)
        yield* early.called(t2)
        yield* settle
        yield* early.stop("the test ended")
      }),
    )
    expect(details(ran.events, t1)).toEqual(["started", "cancelled"])
    expect(details(ran.events, t2)).toEqual([])
  }, 15_000)

  test("a merge of another ticket takes it, cancelling the early check under way", async () => {
    const ran = await run(
      {
        ...noTrain,
        checks: {
          fast: [endless(Effect.runSync(Deferred.make<void>())), passed("fast")],
        },
      },
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const queue = yield* makeQueue({ ...options, early })
        yield* working(t1)
        const two = yield* working(t2)
        yield* early.called(t1)
        yield* until(t1, "started")
        yield* settle
        yield* close(two)
        yield* queue.offer(two)
        yield* queue.settled
        yield* settle
      }),
    )
    const cancelled = recordOf(ran.events, t1, "cancelled")
    expect(cancelled?.why).toBe("tutti/t-2's merge took the check slot")
    expect(
      ran.events.find((each) => each.kind === "phase" && each.ticket === t2 && each.to === "Done"),
    ).toBeDefined()
  }, 15_000)
})

describe("at the ticket's turn", () => {
  test("the same tree on the same base merges with no second check: a hit", async () => {
    const ran = await run(
      noTrain,
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const queue = yield* makeQueue({ ...options, early })
        const ticket = yield* working(t1)
        yield* moveMain()
        yield* early.called(t1)
        yield* until(t1, "passed")
        yield* close(ticket)
        yield* queue.offer(ticket)
        yield* queue.settled
      }),
    )
    expect(details(ran.events, t1)).toEqual(["started", "passed", "hit"])
    expect(fastRuns(ran)).toHaveLength(1)
    expect(recordOf(ran.events, t1, "hit")).toMatchObject({ waited: 0 })
    const done = ran.events.find(
      (each) => each.kind === "phase" && each.ticket === t1 && each.to === "Done",
    )
    expect(done).toBeDefined()
  })

  test("still running, it is waited for", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const gate = Effect.runSync(Deferred.make<void>())
    const ran = await run(
      { ...noTrain, checks: { fast: [gated(started, gate)] } },
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const queue = yield* makeQueue({ ...options, early })
        const ticket = yield* working(t1)
        yield* early.called(t1)
        yield* Deferred.await(started)
        yield* close(ticket)
        yield* queue.offer(ticket)
        yield* settle
        yield* advance("30 seconds")
        yield* Deferred.succeed(gate, undefined)
        yield* queue.settled
      }),
    )
    expect(details(ran.events, t1)).toEqual(["started", "passed", "hit"])
    expect(fastRuns(ran)).toHaveLength(1)
    expect(recordOf(ran.events, t1, "hit")?.waited).toBeGreaterThan(0)
  }, 15_000)

  test("the base moved on since: a miss, and the merge check runs", async () => {
    const ran = await run(
      noTrain,
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const queue = yield* makeQueue({ ...options, early })
        const ticket = yield* working(t1)
        yield* early.called(t1)
        yield* until(t1, "passed")
        yield* moveMain()
        yield* close(ticket)
        yield* queue.offer(ticket)
        yield* queue.settled
      }),
    )
    expect(details(ran.events, t1)).toEqual(["started", "passed", "miss"])
    expect(recordOf(ran.events, t1, "miss")?.why).toContain("main moved on")
    expect(fastRuns(ran)).toHaveLength(2)
  })

  test("another tree, as a commit after it passed: a miss", async () => {
    const ran = await run(
      noTrain,
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const queue = yield* makeQueue({ ...options, early })
        const ticket = yield* working(t1)
        yield* early.called(t1)
        yield* until(t1, "passed")
        yield* (yield* Repository).commit(ticket.worktree, `Fix (${t1})`, { "fix.txt": "fix\n" })
        yield* close(ticket)
        yield* queue.offer(ticket)
        yield* queue.settled
      }),
    )
    expect(details(ran.events, t1)).toEqual(["started", "passed", "miss"])
    expect(recordOf(ran.events, t1, "miss")?.why).toContain("another tree")
    expect(fastRuns(ran)).toHaveLength(2)
  })

  test("a failed early check is dropped, its worker not told: the merge check decides", async () => {
    const ran = await run(
      {
        ...noTrain,
        checks: {
          fast: [(each) => Effect.fail(failedCheck(each.outputFile)), passed("fast")],
        },
      },
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const queue = yield* makeQueue({ ...options, early })
        const ticket = yield* working(t1)
        yield* early.called(t1)
        yield* until(t1, "failed")
        yield* close(ticket)
        yield* queue.offer(ticket)
        yield* queue.settled
      }),
    )
    expect(details(ran.events, t1)).toEqual(["started", "failed", "miss"])
    expect(recordOf(ran.events, t1, "miss")?.why).toBe("it failed")
    const check = ran.events.find((each) => each.kind === "check" && each.suite === "early")
    expect(check).toMatchObject({ ticket: t1, result: "failed" })
    expect(fastRuns(ran)).toHaveLength(2)
    expect(ran.sent.filter((each) => each._tag === "Message")).toEqual([])
    const done = ran.events.find(
      (each) => each.kind === "phase" && each.ticket === t1 && each.to === "Done",
    )
    expect(done).toBeDefined()
  })
})

describe("an early check is cancelled", () => {
  /** Starts t-1's early check, endless, then does `then`; the scenario's records. */
  const cancelledBy = (
    then: (ticket: FinishedTicket) => Effect.Effect<void, unknown, Env | Ledger>,
  ) => {
    const started = Effect.runSync(Deferred.make<void>())
    return run(
      { checks: { fast: [endless(started)] } },
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        const ticket = yield* working(t1)
        yield* early.called(t1)
        yield* Deferred.await(started)
        yield* then(ticket)
        yield* until(t1, "cancelled")
        yield* settle
        yield* early.stop("the test ended")
        return early
      }),
    )
  }

  test("by a new commit on its branch", async () => {
    const ran = await cancelledBy((ticket) =>
      Effect.gen(function* () {
        yield* (yield* Repository).commit(ticket.worktree, `More (${t1})`, { "more.txt": "x\n" })
        yield* advance("5 seconds")
      }),
    )
    expect(recordOf(ran.events, t1, "cancelled")?.why).toContain("tutti/t-1 moved on to")
  }, 15_000)

  test("by its ticket leaving Working", async () => {
    const ran = await cancelledBy(() =>
      Effect.gen(function* () {
        yield* (yield* Ledger).transition(t1, Move.Defer({ why: "stuck" }))
      }),
    )
    expect(recordOf(ran.events, t1, "cancelled")?.why).toBe("t-1 left Working (Deferred)")
  }, 15_000)

  test("by the run winding down, and none starts after", async () => {
    const ran = await cancelledBy(() =>
      Effect.gen(function* () {
        yield* (yield* Ledger).windDown
      }),
    )
    expect(recordOf(ran.events, t1, "cancelled")?.why).toBe("the run is winding down")
  }, 15_000)

  test("by another call to the verifier, which starts another", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const ran = await run(
      { checks: { fast: [endless(started), passed("fast")] } },
      Effect.gen(function* () {
        const early = yield* makeEarly(options)
        yield* working(t1)
        yield* early.called(t1)
        yield* Deferred.await(started)
        yield* early.called(t1)
        yield* until(t1, "passed")
      }),
    )
    expect(details(ran.events, t1)).toEqual(["started", "cancelled", "started", "passed"])
    expect(recordOf(ran.events, t1, "cancelled")?.why).toBe("its worker called the verifier again")
  }, 15_000)
})

describe("the figures", () => {
  const early = (detail: string, fields: Record<string, unknown> = {}) =>
    ({ kind: "early_check", ticket: "t-1", detail, text: "x", ...fields }) as never

  test("count the hits, the misses, the seconds saved and those thrown away", () => {
    const figures = [
      early("passed", { seconds: 80 }),
      early("hit", { seconds: 80, waited: 3 }),
      early("cancelled", { seconds: 20 }),
      early("passed", { seconds: 75 }),
      early("miss", { why: "main moved on" }),
    ].reduce((sum, event) => addRecord(sum, event, 0), noFigures)
    expect(figures.early).toEqual({ hits: 1, misses: 1, saved: 80, spent: 175 })
    expect(earlyPart(figures.early)).toEqual([
      { text: "early used 1 of 2, saved 1m20s, 1m35s thrown away" },
    ])
    expect(earlyEvidence(figures.early)).toContain("1 of the 2 merges")
  })

  test("say nothing where no turn found an early check", () => {
    expect(earlyPart(noFigures.early)).toEqual([])
    expect(earlyEvidence(noFigures.early)).toBeNull()
  })
})
