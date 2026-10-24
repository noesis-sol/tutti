// A git read that steers a merge is asked again a few seconds later while it fails, up to gitTries
// reads, and its failure is "can't tell", never clean, on its branch or the base not moved
// (merge.ts's steering, onBranch, worktreeStatus and baseSince). Each read is failed once, which
// the merge rides out, and always, which sets the ticket aside or stops the merges. Each scenario
// is a merge queue under TestClock, moved on gitAgainAfter at a time while the merges run.
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber } from "effect"
import { baseSince, gitAgainAfter, gitTries, onBranch, worktreeStatus } from "../src/run/branch.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type TicketPhase } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git, GitFailed, type GitOp, GitTimedOut } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Fault, Repository, type Tree } from "../src/testing/Git.ts"
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
}

/** Moves the clock on gitAgainAfter at a time until `fiber` is done, and joins it. */
const joinMovingClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) yield* advance(gitAgainAfter)
    return yield* Fiber.join(fiber)
  })

/**
 * Finishes a, then b, gives `faults` to the repository (`a` the ticket a is), and merges them
 * through a queue of their own, in that order, until it settles.
 */
const merges = (faults: (a: FinishedTicket) => Effect.Effect<void, unknown, Env>) =>
  scenario(
    setup,
    Effect.gen(function* () {
      const a = yield* finished("a")
      const b = yield* finished("b")
      yield* faults(a)
      const queue = yield* makeQueue(options)
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
        }),
      )
      yield* joinMovingClock(fiber)
      const state = yield* (yield* Ledger).current
      return {
        phases: { a: state.tickets.get("a")?.phase, b: state.tickets.get("b")?.phase },
        stop: (yield* queue.state).stop?.why,
        main: yield* (yield* Repository).tree("main"),
      } satisfies Merged
    }).pipe(Effect.provide(Ledger.layer)),
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Makes the next calls of `op` fail as `fault` says. */
const failing = (op: GitOp, fault: Fault) =>
  Effect.flatMap(Repository, (repository) => repository.fail(op, fault))

describe("a read failed once is asked again, and the merges go on", () => {
  test("the worktree's status: uncommitted changes still set the ticket aside, DIRTY_WORKTREE", async () => {
    let worktree = ""
    const ran = await merges((a) =>
      Effect.gen(function* () {
        worktree = a.worktree
        yield* (yield* Repository).write(a.worktree, { "a.txt": "a fix left uncommitted\n" })
        // The look for a change of its own fails, so the status that steers is read, failing once.
        yield* failing("status", { dir: a.worktree, times: 2, stderr: "fatal: took too long" })
      }),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "DIRTY_WORKTREE" }),
    )
    expect(merged.phases.b?._tag).toBe("Done")
    expect(merged.stop).toBeUndefined()
    expect(merged.main.has("a.txt")).toBe(false)
    expect(merged.main.get("b.txt")).toBe("b\n")
    expectLog(ran, [
      `  DIRTY_WORKTREE: a closed, but ${worktree} has uncommitted changes to a.txt, so tutti/a, on top of main, can't be checked as it would merge; worktree left for review (commit or undo them, check, merge)`,
    ])
  })

  for (const [op, dir] of [
    ["symbolic-ref", "worktree"],
    ["symbolic-ref", "/repo"],
    ["rev-parse", "/repo"],
    ["merge-base", "/repo"],
    ["status", "/repo"],
  ] as const) {
    test(`${op} in ${dir === "/repo" ? "the main checkout" : "the worktree"}: both tickets merge`, async () => {
      const ran = await merges((a) =>
        failing(op, { dir: dir === "/repo" ? "/repo" : a.worktree, timedOut: true }),
      )
      const merged = resultOf(ran)
      expect(merged.phases.a?._tag).toBe("Done")
      expect(merged.phases.b?._tag).toBe("Done")
      expect(merged.stop).toBeUndefined()
      expect(merged.main.get("a.txt")).toBe("a\n")
      expect(merged.main.get("b.txt")).toBe("b\n")
      expect(ran.log.some((text) => text.includes("GIT_FAILED"))).toBe(false)
    })
  }
})

describe("the files the branch changes, read as its fast-forward fails", () => {
  test("failed once: asked again, the main checkout's change in their way is DIRTY_TREE", async () => {
    let ffFailed = false
    let changedFailed = false
    const ran = await scenario(
      setup,
      Effect.gen(function* () {
        const repository = yield* Repository
        const a = yield* finished("a")
        // A file git leaves out of the main checkout's clean tree, which the branch changes too.
        yield* repository.commit(a.worktree, "Note it (a)", { ".beads/notes.txt": "a\n" })
        yield* repository.write(repository.dir, { ".beads/notes.txt": "local\n" })
        const git = yield* Git
        const queue = yield* makeQueue(options).pipe(
          Effect.provideService(Git, {
            ...git,
            fastForward: (dir, branch) =>
              Effect.suspend(() => {
                ffFailed = true
                return git.fastForward(dir, branch).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new GitFailed({
                        op: "merge --ff-only",
                        command: "git merge --ff-only tutti/a",
                        exitCode: 1,
                        stderr: "error: untracked files would be overwritten",
                      }),
                    ),
                  ),
                )
              }),
            changedFiles: (dir, from, to) =>
              Effect.suspend(() => {
                if (!ffFailed || changedFailed) return git.changedFiles(dir, from, to)
                changedFailed = true
                return Effect.fail(
                  new GitTimedOut({
                    op: "diff --name-only",
                    command: "git diff --name-only",
                    timeLimit: Duration.seconds(30),
                  }),
                )
              }),
          }),
        )
        const fiber = yield* Effect.forkChild(
          Effect.andThen(queue.offer(a), Effect.andThen(queue.settled, queue.state)),
        )
        return (yield* joinMovingClock(fiber)).stop?.why
      }).pipe(Effect.provide(Ledger.layer)),
    )
    expect(changedFailed).toBe(true)
    expect(resultOf(ran)).toBe("DIRTY_TREE")
    expectLog(ran, [
      /^HOLD: DIRTY_TREE: uncommitted changes in \/repo to \.beads\/notes\.txt, which tutti\/a changes/,
    ])
  })
})

describe("a read that always fails is 'can't tell'", () => {
  test("the worktree's status: set aside, GIT_FAILED, never counted clean; the next ticket merges", async () => {
    let worktree = ""
    const ran = await merges((a) =>
      Effect.gen(function* () {
        worktree = a.worktree
        yield* (yield* Repository).write(a.worktree, { "a.txt": "a fix left uncommitted\n" })
        yield* failing("status", { dir: a.worktree, times: 100, stderr: "fatal: took too long" })
      }),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Review", why: "GIT_FAILED" }))
    expect(merged.phases.b?._tag).toBe("Done")
    expect(merged.stop).toBeUndefined()
    expect(merged.main.has("a.txt")).toBe(false)
    // Only b's check ran: a was never checked with a status that can't be read.
    expect(ran.checkRuns.map((run) => run.cwd)).toEqual([expect.stringMatching(/b$/)])
    expectLog(ran, [
      `  GIT_FAILED: a closed, but git could not read the status of ${worktree} (${gitTries} tries): fatal: took too long, so it can't be shown to have no uncommitted changes; tutti/a is not merged, its worktree left for review`,
    ])
  })

  test("the worktree's branch: set aside, GIT_FAILED, never on its branch; the next ticket merges", async () => {
    let worktree = ""
    const ran = await merges((a) =>
      Effect.gen(function* () {
        worktree = a.worktree
        yield* failing("symbolic-ref", { dir: a.worktree, times: 100, stderr: "fatal: locked" })
      }),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Review", why: "GIT_FAILED" }))
    expect(merged.phases.b?._tag).toBe("Done")
    expect(merged.stop).toBeUndefined()
    expect(merged.main.has("a.txt")).toBe(false)
    expectLog(ran, [
      `  GIT_FAILED: a closed, but git could not tell what its worktree ${worktree} has checked out (${gitTries} tries): fatal: locked; tutti/a is not merged, its worktree left for review`,
    ])
  })

  test("where the branch left the base: Blocked, the merges stopped, GIT_FAILED", async () => {
    const ran = await merges(() =>
      failing("merge-base", { times: 100, stderr: "fatal: bad object" }),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Blocked", why: "GIT_FAILED" }))
    expect(merged.stop).toBe("GIT_FAILED")
    expect(merged.main.has("a.txt")).toBe(false)
    expectLog(ran, [
      /^HOLD: GIT_FAILED: could not tell where tutti\/a left main \(3 tries\): fatal: bad object; tutti\/a is not merged/,
    ])
  })
})

describe("the reads themselves", () => {
  const read = <A>(body: (a: FinishedTicket) => Effect.Effect<A, unknown, Env | Ledger>) =>
    scenario(
      setup,
      Effect.gen(function* () {
        const a = yield* finished("a")
        const fiber = yield* Effect.forkChild(body(a))
        return yield* joinMovingClock(fiber)
      }).pipe(Effect.provide(Ledger.layer)),
    )

  test("onBranch: once asks again; always is Unknown; a single try is Unknown at once", async () => {
    const ran = await read((a) =>
      Effect.gen(function* () {
        yield* failing("symbolic-ref", { dir: a.worktree })
        const once = yield* onBranch(a)
        yield* failing("symbolic-ref", { dir: a.worktree, times: gitTries })
        const always = yield* onBranch(a)
        yield* failing("symbolic-ref", { dir: a.worktree })
        const single = yield* onBranch(a, 1)
        const after = yield* onBranch(a, 1)
        return [once._tag, always._tag, single._tag, after._tag]
      }),
    )
    expect(resultOf(ran)).toEqual(["OnBranch", "Unknown", "Unknown", "OnBranch"])
  })

  test("worktreeStatus: once asks again; always is Unknown, never Clean", async () => {
    const ran = await read((a) =>
      Effect.gen(function* () {
        yield* (yield* Repository).write(a.worktree, { "a.txt": "changed\n" })
        yield* failing("status", { dir: a.worktree })
        const once = yield* worktreeStatus(a.worktree)
        yield* failing("status", { dir: a.worktree, times: gitTries })
        const always = yield* worktreeStatus(a.worktree)
        return [once, always._tag]
      }),
    )
    const [once, always] = resultOf(ran)
    expect(once).toEqual(expect.objectContaining({ _tag: "Dirty", files: ["a.txt"] }))
    expect(always).toBe("Unknown")
  })

  test("baseSince: once asks again; always is Unknown, never Still", async () => {
    const ran = await read(() =>
      Effect.gen(function* () {
        const repository = yield* Repository
        const start = yield* repository.head("main")
        yield* repository.commit(repository.dir, "Land something else", { "main.txt": "x\n" })
        yield* failing("rev-parse", { dir: "/repo" })
        const once = yield* baseSince(options, start)
        yield* failing("rev-parse", { dir: "/repo", times: gitTries })
        const always = yield* baseSince(options, yield* repository.head("main"))
        const still = yield* baseSince(options, yield* repository.head("main"))
        return [once._tag, always._tag, still._tag]
      }),
    )
    expect(resultOf(ran)).toEqual(["Moved", "Unknown", "Still"])
  })
})
