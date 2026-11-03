// A check's time limit and the machine's load (tutti-epza.13): the time the machine is loaded
// doesn't count toward a check's or setup's limit, up to the limit again, as a hand-back's
// (Wake.ts's sleepAwakeUnloaded, exec's `loaded`), and a merge check that times out while the
// machine was loaded runs once more before its ticket is set aside (merge.ts's Check step).
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Clock, Duration, Effect, Exit, Fiber, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { howFailed, makePasses, timedOutLoaded } from "../src/run/check.ts"
import { makeFixes } from "../src/run/checkback.ts"
import { checkWithFix, makeHandBacks } from "../src/run/handback.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import { makeSetUps } from "../src/run/setup.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckTimedOut } from "../src/services/Checks.ts"
import { CommandTimedOut, exec } from "../src/services/exec.ts"
import { Git } from "../src/services/Git.ts"
import { sleepAwakeUnloaded } from "../src/services/Wake.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { passed } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, type Ran, type Setup, scenario } from "./harness.ts"

// The exec tests start real processes.
setDefaultTimeout(30_000)

describe("a time limit that leaves out the time the machine is loaded", () => {
  /** When `limit`, the machine loaded as `loaded` says at each instant, runs out, and what it left out. */
  const endOf = (limit: Duration.Input, loaded: (ms: number) => boolean) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ended = yield* Ref.make<number | undefined>(undefined)
        const fiber = yield* Effect.forkChild(
          sleepAwakeUnloaded(limit, Effect.map(Clock.currentTimeMillis, loaded), "5 seconds").pipe(
            Effect.tap(() => Effect.flatMap(Clock.currentTimeMillis, (ms) => Ref.set(ended, ms))),
          ),
        )
        for (let ms = 0; ms < 200_000 && (yield* Ref.get(ended)) === undefined; ms += 1000) {
          yield* TestClock.adjust("1 second")
        }
        const extra = yield* Fiber.join(fiber)
        return { ended: yield* Ref.get(ended), extra }
      }).pipe(Effect.provide(TestClock.layer())),
    )

  test("never loaded, it runs out at its limit, leaving nothing out", async () => {
    expect(await endOf("30 seconds", () => false)).toEqual({ ended: 30_000, extra: 0 })
  })

  test("loaded throughout, it runs out at twice its limit, no more", async () => {
    expect(await endOf("30 seconds", () => true)).toEqual({ ended: 60_000, extra: 30_000 })
  })

  test("loaded for a while, that while is added to it", async () => {
    expect(await endOf("30 seconds", (ms) => ms < 10_000)).toEqual({
      ended: 40_000,
      extra: 10_000,
    })
  })
})

describe("exec's time limit with the machine loaded", () => {
  const provide = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
    Effect.runPromise(Effect.exit(Effect.provide(effect, BunServices.layer)))

  const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
    return error.error
  }

  test("a command that outlasts its limit on a loaded machine finishes within twice it", async () => {
    const exit = await provide(
      exec({
        command: "sh",
        args: ["-c", "sleep 1"],
        timeLimit: "700 millis",
        loaded: Effect.succeed(true),
      }),
    )
    expect(Exit.isSuccess(exit) && exit.value.exitCode).toBe(0)
  })

  test("unloaded, it times out at its limit, saying no load was asked of it", async () => {
    const error = failure(
      await provide(exec({ command: "sh", args: ["-c", "sleep 5"], timeLimit: "300 millis" })),
    )
    expect(error).toBeInstanceOf(CommandTimedOut)
    expect(error instanceof CommandTimedOut && error.loaded).toBeUndefined()
  })

  test("past twice its limit, it times out, saying how long the load added", async () => {
    const error = failure(
      await provide(
        exec({
          command: "sh",
          args: ["-c", "sleep 5"],
          timeLimit: "300 millis",
          loaded: Effect.succeed(true),
        }),
      ),
    )
    expect(error).toBeInstanceOf(CommandTimedOut)
    const loaded = error instanceof CommandTimedOut ? error.loaded : undefined
    expect(loaded === undefined ? undefined : Duration.toMillis(loaded)).toBe(300)
  })
})

/** A check that timed out, the load having added `loaded` to its limit where given. */
const timedOut = (loaded?: Duration.Input) =>
  new CheckTimedOut({
    check: "fast",
    command: "scripts/check-fast.sh",
    timeLimit: Duration.minutes(30),
    outputFile: "/dev/fd/9",
    ...(loaded === undefined ? {} : { loaded: Duration.fromInputUnsafe(loaded) }),
    failingLines: [],
    lastLines: ["running suite 4"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

describe("what is said of a check that timed out", () => {
  test("its line names the time the load added to its limit", () => {
    expect(howFailed(timedOut("12 minutes"))).toBe(
      "did not finish within 30m (and 12m more for the machine's load)",
    )
    expect(howFailed(timedOut())).toBe("did not finish within 30m")
    expect(howFailed(timedOut(0))).toBe("did not finish within 30m")
  })

  test("it timed out loaded only where the load added to its limit", () => {
    expect(timedOutLoaded(timedOut("1 second"))).toBe(true)
    expect(timedOutLoaded(timedOut(0))).toBe(false)
    expect(timedOutLoaded(timedOut())).toBe(false)
  })
})

describe("a merge check that timed out while the machine was loaded", () => {
  const phasesOf = (state: State): Record<string, TicketPhase> =>
    Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

  /** A ticket its worker finished: its branch with a commit naming it, closed, Working. */
  const finished = (id: TicketId, files: Files) =>
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      const worktree = yield* (yield* Worktrees).prepare(id)
      yield* git.addWorktree(repository.dir, worktree.path, {
        branch: worktree.branch,
        base: "main",
      })
      yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
      yield* (yield* Beads).close(id, "done")
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

  /** Merges ticket a, main moved on meanwhile, the machine loaded as `loaded` says. */
  const mergeA = (setup: Setup, loaded: boolean) =>
    scenario(
      { backlog: backlog().ticket("a").seeds, ...setup },
      Effect.gen(function* () {
        const queue: MergeQueue = yield* makeQueue({
          repo: "/repo",
          base: "main",
          loaded: Effect.succeed(loaded),
        })
        const ticket = yield* finished("a" as TicketId, { "a.txt": "a\n" })
        const repository = yield* Repository
        yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        yield* queue.offer(ticket)
        yield* queue.settled
        return phasesOf(yield* (yield* Ledger).current)
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
        Record<string, TicketPhase>,
        unknown,
        Env | Scope.Scope
      >,
    )

  const phaseOf = (ran: Ran<Record<string, TicketPhase>>) => {
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    return ran.exit.value.a
  }
  const fastRuns = (ran: Ran<unknown>) => ran.checkRuns.filter((each) => each.check === "fast")
  const once = (ran: Ran<unknown>) =>
    ran.log.filter((each) => each.includes("checking it once more"))

  test("its check is given the machine's load, for its time limit", async () => {
    const ran = await mergeA({}, true)
    expect(phaseOf(ran)?._tag).toBe("Done")
    const [run] = fastRuns(ran)
    expect(run?.loaded).toBeDefined()
  })

  test("it runs once more, and merges where that one passes", async () => {
    const ran = await mergeA({ checks: { fast: [timedOut("10 minutes"), passed("fast")] } }, true)
    expect(phaseOf(ran)?._tag).toBe("Done")
    expect(fastRuns(ran)).toHaveLength(2)
    expect(once(ran)).toEqual([
      "  a: 'scripts/check-fast.sh' did not finish within 30m (and 10m more for the machine's load) on tutti/a rebased onto main while the machine was loaded; checking it once more before setting it aside",
    ])
  })

  test("no more than once: timed out again, it is set aside", async () => {
    const ran = await mergeA(
      { checks: { fast: [timedOut("10 minutes"), timedOut("30 minutes"), passed("fast")] } },
      true,
    )
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }))
    expect(fastRuns(ran)).toHaveLength(2)
    expect(once(ran)).toHaveLength(1)
  })

  test("one that timed out with the machine not loaded is set aside at once", async () => {
    const ran = await mergeA({ checks: { fast: [timedOut(0), passed("fast")] } }, false)
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }))
    expect(fastRuns(ran)).toHaveLength(1)
    expect(once(ran)).toEqual([])
  })
})

describe("the check of a fix that timed out while the machine was loaded", () => {
  /** Checks ticket a's branch as its worker's fix after a hand-back, the machine loaded as given. */
  const checkFix = (setup: Setup, loaded: boolean) =>
    scenario(
      { backlog: backlog().ticket("a").seeds, ...setup },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        const worktree = yield* (yield* Worktrees).prepare("a" as TicketId)
        yield* git.addWorktree(repository.dir, worktree.path, {
          branch: worktree.branch,
          base: "main",
        })
        yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
        const ticket = {
          id: "a" as TicketId,
          title: "Ticket a",
          branch: worktree.branch,
          worktree: worktree.path,
        }
        const onto = yield* git.revParse("/repo", "main")
        const from = yield* git.revParse("/repo", ticket.branch)
        const memory = {
          rechecks: yield* makeRechecks,
          setUps: yield* makeSetUps,
          passes: yield* makePasses,
          handBacks: yield* makeHandBacks,
          fixes: yield* makeFixes,
        }
        const { checked } = yield* checkWithFix(
          { ticket, onto, fork: onto },
          { what: "fix", from },
          { repo: "/repo", base: "main", loaded: Effect.succeed(loaded) },
          memory,
        )
        return checked._tag
      }).pipe(Effect.provide(Ledger.layer)),
    )

  const fastRuns = (ran: Ran<unknown>) => ran.checkRuns.filter((each) => each.check === "fast")

  test("it runs once more, and passes where that one does", async () => {
    const ran = await checkFix({ checks: { fast: [timedOut("5 minutes"), passed("fast")] } }, true)
    expect(ran.exit._tag === "Success" && ran.exit.value).toBe("Passed")
    expect(fastRuns(ran)).toHaveLength(2)
    expect(ran.log.filter((each) => each.includes("checking it once more"))).toHaveLength(1)
  })

  test("not loaded, its failure stands", async () => {
    const ran = await checkFix({ checks: { fast: [timedOut(), passed("fast")] } }, false)
    expect(ran.exit._tag === "Success" && ran.exit.value).toBe("Failed")
    expect(fastRuns(ran)).toHaveLength(1)
  })
})
