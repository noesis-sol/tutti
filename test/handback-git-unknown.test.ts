// What a hand-back does where git can't say (merge.ts's onBranch and baseSince): a base git can't
// read, asked gitTries times, is never taken for one that didn't move, so what the worker left goes
// back to its merge; a worktree whose HEAD git can't read is never taken for one on its branch, so
// the worker's fix or resolution isn't accepted on it and its branch is never reset. Settling a
// closed ticket fails with git's error rather than read it as on its branch. Each scenario runs
// under TestClock, moved on gitAgainAfter at a time while git is asked again.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { gitAgainAfter, gitTries } from "../src/run/branch.ts"
import { type CheckStop, undoFix, verifyFixed } from "../src/run/checkback.ts"
import { type RebaseStop, undoResolution, verifyResolved } from "../src/run/handback.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag, type TicketPhase } from "../src/run/phase.ts"
import { read, untilSettled } from "../src/run/settle.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { type TicketWorktree, Worktrees } from "../src/services/Worktrees.ts"
import {
  init,
  result,
  run,
  type SessionScript,
  sessionState,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import {
  advance,
  backlog,
  type Env,
  expectLog,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const check = "scripts/check-fast.sh"
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    },
  },
}

const failing = () =>
  new CheckFailed({
    check: "fast",
    command: check,
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: ["error: a.test.ts: expected 1"],
    lastLines: ["1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phasesOf = (state: State): Record<string, TicketPhase> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

/** Waits until the ticket is in `tag`. */
const until = (id: string, tag: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) => state.tickets.get(id)?.phase._tag === tag),
      Stream.runHead,
    )
  })

/** Where the ticket's worktree is, once `finished` has made it: for its worker's script. */
const worktrees = new Map<string, TicketWorktree>()
const worktreeOf = (id: string) => worktrees.get(id)?.path ?? ""

/** The worker's first session: it finished its ticket, idle, then plays `then`. */
const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

/** Makes the main checkout's next `times` rev-parses fail, as the worker's turn ends. */
const baseUnreadable = (world: World, times: number) =>
  run(
    Effect.suspend(() =>
      world.repository.fail("rev-parse", {
        dir: world.repository.dir,
        times,
        stderr: "fatal: took too long",
      }),
    ),
  )

/** A check hand-back's turn: the worker commits a fix naming the ticket, then `after`. */
const fixes = (world: World, after: SessionScript = []) =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(
          world.repository.commit(worktreeOf("a"), "Fix the check (a)", { "fix.txt": "fixed\n" }),
        ),
      ),
    ),
    ...after,
  ])

/** A conflict hand-back's turn: the worker resolves the conflict in a.txt, then `after`. */
const resolves = (world: World, after: SessionScript = []) =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(world.repository.continueRebase(worktreeOf("a"), { "a.txt": "both\n" })),
      ),
    ),
    ...after,
  ])

/** A ticket its worker finished, its session started and idle, Working in the ledger. */
const finished = (id: string, files: Files, started = true) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    worktrees.set(id, worktree)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Cause.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Cause.Dispatched())
    if (started) {
      const sessionId = `session-${id}`
      yield* (yield* Store).saveSession(id, {
        session: sessionId,
        worktree: worktree.path,
        branch: worktree.branch,
      })
      yield* (yield* AgentHost).start(id, { sessionId, cwd: worktree.path })
      yield* untilSettled(id)
    }
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Moves the clock on gitAgainAfter at a time, a few times, letting the merge catch up after each. */
const askedAgain = Effect.gen(function* () {
  for (let i = 0; i < 3 * gitTries; i++) {
    yield* Effect.promise(() => Bun.sleep(5))
    yield* advance(gitAgainAfter)
  }
})

/**
 * Finishes a (a.txt), lands `landed` on main, and merges a through a queue of its own until it
 * settles, the clock moved on once a is handed back (`handed`).
 */
const merges = (
  scripts: (world: World) => Scripts,
  landed: Files,
  handed: PhaseTag,
  checks: { readonly fast: ReadonlyArray<CheckFailed> } | undefined = undefined,
) =>
  scenario(
    {
      backlog: backlog().ticket("a").seeds,
      ...withCheck,
      ...(checks === undefined ? {} : { checks }),
      scripts,
    },
    Effect.gen(function* () {
      const queue: MergeQueue = yield* makeQueue(options)
      const ticket = yield* finished("a", { "a.txt": "a\n" })
      const repository = yield* Repository
      yield* repository.commit(repository.dir, "Land something else", landed)
      const during = yield* Effect.forkChild(Effect.andThen(until("a", handed), askedAgain))
      yield* queue.offer(ticket)
      yield* queue.settled
      yield* Fiber.join(during)
      return phasesOf(yield* (yield* Ledger).current)
    }).pipe(Effect.provide(Ledger.layer)),
  )

const unknownFix =
  "  a's worker committed 1 commit, but git could not tell whether main moved on meanwhile: fatal: took too long; tutti/a goes back to its merge, which checks it"
const unknownResolution =
  "  a's worker finished the rebase, but git could not tell whether main moved on meanwhile: fatal: took too long; tutti/a goes back to its merge, which checks it"

describe("a hand-back whose base git can't read", () => {
  test("a fix, the read failed once: asked again, the fix checked where it is, and merged", async () => {
    const ran = await merges(
      (world) => ({ a: [finishedSession(fixes(world, [baseUnreadable(world, 1)]))] }),
      { "b.txt": "b\n" },
      "Fixing",
      { fast: [failing()] },
    )
    expect(resultOf(ran).a?._tag).toBe("Done")
    expectLog(ran, [`  '${check}' passes on tutti/a as its worker fixed it`])
    expect(ran.log).not.toContain(unknownFix)
  })

  test("a fix, the read failing always: not taken for a base that didn't move; back to its merge", async () => {
    const ran = await merges(
      (world) => ({ a: [finishedSession(fixes(world, [baseUnreadable(world, gitTries)]))] }),
      { "b.txt": "b\n" },
      "Fixing",
      { fast: [failing()] },
    )
    expect(resultOf(ran).a?._tag).toBe("Done")
    expectLog(ran, [unknownFix, `  '${check}' passes on tutti/a as its worker fixed it`])
  })

  test("a resolution, the read failed once: asked again, checked where it is, and merged", async () => {
    const ran = await merges(
      (world) => ({ a: [finishedSession(resolves(world, [baseUnreadable(world, 1)]))] }),
      { "a.txt": "main's a\n" },
      "Resolving",
    )
    expect(resultOf(ran).a?._tag).toBe("Done")
    expectLog(ran, [`  a's worker finished the rebase; checking it with '${check}'`])
    expect(ran.log).not.toContain(unknownResolution)
  })

  test("a resolution, the read failing always: not taken for a base that didn't move; back to its merge", async () => {
    const ran = await merges(
      (world) => ({ a: [finishedSession(resolves(world, [baseUnreadable(world, gitTries)]))] }),
      { "a.txt": "main's a\n" },
      "Resolving",
    )
    expect(resultOf(ran).a?._tag).toBe("Done")
    expectLog(ran, [unknownResolution])
    expect(ran.log.some((text) => text.includes("finished the rebase; checking it with"))).toBe(
      false,
    )
  })
})

/** Moves the clock on gitAgainAfter at a time until `fiber` is done, and joins it. */
const joinMovingClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) yield* advance(gitAgainAfter)
    return yield* Fiber.join(fiber)
  })

/**
 * Finishes a, its session never started, with a second commit on its branch, and runs `body` on it
 * with every symbolic-ref in its worktree failing: `first`, the commit before the second.
 */
const headUnreadable = <A>(
  body: (a: FinishedTicket, first: string) => Effect.Effect<A, unknown, Env | Ledger>,
) =>
  scenario(
    { backlog: backlog().ticket("a").seeds, ...withCheck },
    Effect.gen(function* () {
      const a = yield* finished("a", { "a.txt": "a\n" }, false)
      const repository = yield* Repository
      const first = yield* repository.head(a.branch)
      yield* repository.commit(a.worktree, "Fix the check (a)", { "fix.txt": "fixed\n" })
      yield* repository.fail("symbolic-ref", {
        dir: a.worktree,
        times: 100,
        stderr: "fatal: locked",
      })
      const fiber = yield* Effect.forkChild(body(a, first))
      const value = yield* joinMovingClock(fiber)
      return { value, head: yield* repository.head(a.branch), first }
    }).pipe(Effect.provide(Ledger.layer)),
  )

const checkStop = (ticket: FinishedTicket, at: string): CheckStop => ({
  ticket,
  onto: "",
  fork: "",
  head: at,
  at,
  error: failing(),
  output: "/dev/fd/9",
})

const rebaseStop = (ticket: FinishedTicket, head: string): RebaseStop => ({
  ticket,
  onto: "",
  fork: "",
  head,
  own: 1,
  files: ["a.txt"],
})

describe("a worktree whose HEAD git can't read", () => {
  test("verifyFixed rejects the fix: never taken for one on its branch", async () => {
    const ran = await headUnreadable((a, first) => verifyFixed(checkStop(a, first), options))
    expect(resultOf(ran).value).toEqual({
      _tag: "Rejected",
      why: "git could not say what its worker committed: fatal: locked",
    })
  })

  test("undoFix leaves the branch where it is", async () => {
    const ran = await headUnreadable((a, first) => undoFix(checkStop(a, first)))
    const { value, head, first } = resultOf(ran)
    expect(head).not.toBe(first)
    expect(value).toContain("as git could not tell what")
    expect(value).toContain("has checked out: fatal: locked")
  })

  test("verifyResolved rejects the resolution: never taken for one on its branch", async () => {
    const ran = await headUnreadable((a, first) => verifyResolved(rebaseStop(a, first), options))
    expect(resultOf(ran).value).toBe("git could not say what its worker left: fatal: locked")
  })

  test("undoResolution leaves the branch where it is", async () => {
    const ran = await headUnreadable((a, first) => undoResolution(rebaseStop(a, first)))
    const { value, head, first } = resultOf(ran)
    expect(head).not.toBe(first)
    expect(value).toContain("as git could not tell what")
    expect(value).toContain("has checked out: fatal: locked")
  })

  test("settling the closed ticket fails with git's error, never reading it as finished", async () => {
    const ran = await headUnreadable((a) =>
      Effect.flip(
        read(
          {
            ticket: a.id,
            worktree: worktrees.get(a.id) as TicketWorktree,
            session: "session-a",
            message: "m",
          },
          "main",
        ),
      ),
    )
    expect(resultOf(ran).value).toMatchObject({
      _tag: "GitFailed",
      op: "symbolic-ref",
      stderr: "fatal: locked",
    })
  })
})
