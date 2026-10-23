// A fast-forward git refuses isn't always a branch that doesn't fast-forward (merge.ts's
// fastForward): a commit made on the base by hand since prepare read it sends the ticket back to be
// rebased and checked; git kept from writing, as by another's .git/index.lock, while the branch
// still fast-forwards, is tried again a few seconds later, up to gitTries in all, then holds the run
// with GIT_FAILED. Each scenario is a merge queue under TestClock, moved on gitAgainAfter at a time
// while the merges run.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { type FinishedTicket, gitAgainAfter, gitTries } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type TicketPhase } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git, type GitError } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository, type Tree } from "../src/testing/Git.ts"
import { advance, backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const check = "scripts/check-fast.sh"
const defaults = appConfig().settings
const setup = {
  config: {
    repo: "/repo",
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    },
  },
  backlog: backlog().ticket("a").ticket("b").seeds,
}
const locked =
  "fatal: Unable to create '/repo/.git/index.lock': File exists. Another git process seems to be running in this repository"

/** A ticket its worker finished on top of main, `<id>.txt` committed, closed, Working. */
const finished = (id: string) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Cause.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Cause.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

interface Merged {
  readonly phases: Readonly<Record<string, TicketPhase | undefined>>
  readonly stop: string | undefined
  readonly main: Tree
  /** How many fast-forwards the main checkout was asked for. */
  readonly fastForwards: number
}

/**
 * Finishes a, then b, and merges them through a queue of their own, in that order, until it
 * settles, the clock moved on gitAgainAfter at a time; `fastForward` stands in for git's, given it.
 */
const merges = (
  before: Effect.Effect<void, unknown, Env> = Effect.void,
  fastForward?: (
    git: Git["Service"],
    repo: string,
    branch: string,
  ) => Effect.Effect<void, GitError, Env>,
) =>
  scenario(
    setup,
    Effect.gen(function* () {
      const a = yield* finished("a")
      const b = yield* finished("b")
      yield* before
      const git = yield* Git
      const repository = yield* Repository
      const queue = yield* makeQueue(options).pipe(
        Effect.provideService(Git, {
          ...git,
          ...(fastForward === undefined
            ? {}
            : {
                fastForward: (repo: string, branch: string) =>
                  Effect.provideService(fastForward(git, repo, branch), Repository, repository),
              }),
        }),
      )
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
        }),
      )
      for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) {
        yield* advance(gitAgainAfter)
      }
      yield* Fiber.join(fiber)
      const state = yield* (yield* Ledger).current
      return {
        phases: { a: state.tickets.get("a")?.phase, b: state.tickets.get("b")?.phase },
        stop: (yield* queue.state).stop?.why,
        main: yield* repository.tree("main"),
        fastForwards: (yield* repository.calls).filter((call) => call.op === "merge --ff-only")
          .length,
      } satisfies Merged
    }).pipe(Effect.provide(Ledger.layer)),
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Makes the next `times` fast-forwards in the main checkout fail as with another's index.lock. */
const lockedFor = (times: number) =>
  Effect.flatMap(Repository, (repository) =>
    repository.fail("merge --ff-only", { dir: "/repo", times, exitCode: 128, stderr: locked }),
  )

describe("a fast-forward git was kept from, the branch still fast-forwarding", () => {
  test("once: tried again a few seconds later, and both tickets merge", async () => {
    const ran = await merges(lockedFor(1))
    const merged = resultOf(ran)
    expect(merged.phases.a?._tag).toBe("Done")
    expect(merged.phases.b?._tag).toBe("Done")
    expect(merged.stop).toBeUndefined()
    expect(merged.main.get("a.txt")).toBe("a\n")
    expect(merged.main.get("b.txt")).toBe("b\n")
    expect(merged.fastForwards).toBe(3)
    expect(ran.log.some((text) => /MERGE_FAILED|GIT_FAILED/.test(text))).toBe(false)
  })

  test(`every time: ${gitTries} tries, then Blocked and the run held, GIT_FAILED`, async () => {
    const ran = await merges(lockedFor(100))
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Blocked", why: "GIT_FAILED" }))
    expect(merged.stop).toBe("GIT_FAILED")
    expect(merged.main.has("a.txt")).toBe(false)
    expect(merged.fastForwards).toBe(gitTries)
    expectLog(ran, [
      new RegExp(
        `^HOLD: GIT_FAILED: tutti/a fast-forwards onto main, but git could not merge it \\(${gitTries} tries\\): fatal: Unable to create '/repo/\\.git/index\\.lock': File exists\\.`,
      ),
    ])
    expect(ran.log.some((text) => text.includes("MERGE_FAILED"))).toBe(false)
  })
})

describe("the base moved on between prepare and the fast-forward", () => {
  test("the branch is rebased onto it and checked again, then merges", async () => {
    let moved = false
    const ran = await merges(Effect.void, (git, repo, branch) =>
      Effect.gen(function* () {
        if (!moved) {
          moved = true
          const repository = yield* Repository
          yield* Effect.orDie(repository.commit(repository.dir, "By hand", { "hand.txt": "x\n" }))
        }
        return yield* git.fastForward(repo, branch)
      }),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a?._tag).toBe("Done")
    expect(merged.phases.b?._tag).toBe("Done")
    expect(merged.stop).toBeUndefined()
    expect(merged.main.get("a.txt")).toBe("a\n")
    expect(merged.main.get("b.txt")).toBe("b\n")
    expect(merged.main.get("hand.txt")).toBe("x\n")
    // a is checked on top of main, then again once rebased onto the commit made by hand.
    expect(ran.checkRuns.map((run) => run.cwd.split("/").at(-1))).toEqual(["a", "a", "b"])
    expectLog(ran, [
      /^ {2}main moved on to [0-9a-f]{7} before tutti\/a fast-forwarded onto [0-9a-f]{7}: rebasing and checking it again before it merges$/,
    ])
    expect(ran.log.some((text) => /MERGE_FAILED|GIT_FAILED/.test(text))).toBe(false)
  })
})
