// git failing for one ticket sets that ticket aside, the others going on, rather than stop the run
// with GIT_FAILED: making its worktree (a project's post-checkout hook failing or stalling) is tried
// again as gitAgain says, then the ticket is deferred without a worker; a closed ticket whose
// worktree git can't read as its worker settles is left for review, GIT_FAILED, as an open one is.
// Each scenario runs under TestClock, moved on gitAgainAfter at a time while git is asked again. Git
// makes a worktree with the project's hooks off, run on a real repository, slow.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Fiber, Layer, type Scope } from "effect"
import { gitAgainAfter, gitTries } from "../src/run/branch.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import { type Start, type StartTicket, start } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git, GitFailed, GitWriter } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { run, turn } from "../src/testing/AgentHost.ts"
import { type Fault, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { hooksDir, makeRepo } from "./git.ts"
import { advance, backlog, type Env, expectLog, type Ran, scenario, type World } from "./harness.ts"

const id = "t-1" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

/** A folder for the worktrees, so a test knows where its ticket's is before it starts. */
const worktreesRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-git-aside-")))

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Moves the clock on gitAgainAfter at a time until `fiber` is done, and joins it. */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) yield* advance(gitAgainAfter)
    return yield* Fiber.join(fiber)
  })

const hookFailed = new GitFailed({
  op: "worktree add",
  command: "git -c core.hooksPath=/dev/null worktree add --quiet -b tutti/t-1 /wt main",
  exitCode: 1,
  stderr: "error: could not lock config file .git/config: File exists\n",
})

interface Started {
  readonly start: Start
  readonly phase: TicketPhase | undefined
  /** How many times the worktree was asked for. */
  readonly prepared: number
}

/** Dispatches the ticket and starts it on main, its worktree failing `failures` times first. */
const starting = (failures: number): Promise<Ran<Started>> =>
  scenario(
    {
      backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
      scripts: { [id]: [turn([])] },
      worktrees: { root: worktreesRoot() },
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const worktrees = yield* Worktrees
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      let prepared = 0
      const failing = Worktrees.of({
        ...worktrees,
        prepare: (each) =>
          Effect.suspend(() =>
            ++prepared <= failures ? Effect.fail(hookFailed) : worktrees.prepare(each),
          ),
      })
      const fiber = yield* Effect.forkChild(
        start(ticket, "main").pipe(Effect.provideService(Worktrees, failing)),
      )
      return {
        start: yield* settle(fiber),
        phase: (yield* ledger.current).tickets.get(id)?.phase,
        prepared,
      } satisfies Started
    }).pipe(Effect.provide(Ledger.layer)),
  )

describe("git failing to make a ticket's worktree", () => {
  test("every time: tried gitTries times, then the ticket is deferred without a worker", async () => {
    const ran = await starting(100)
    const started = resultOf(ran)
    expect(started.prepared).toBe(gitTries)
    expect(started.start).toMatchObject({
      _tag: "SetAside",
      why: "git could not make its worktree",
      deferred: true,
      session: false,
    })
    expect(started.phase).toMatchObject({
      _tag: "Deferred",
      why: "git could not make its worktree",
    })
    expect(ran.sent).toEqual([])
    const issue = ran.issues.find((each) => each.id === id)
    expect(issue?.status).toBe("deferred")
    expect(issue?.notes).toContain(
      `tutti: git could not make t-1's worktree (${gitTries} tries): error: could not lock config file`,
    )
    const again =
      "  git could not make t-1's worktree, trying again in 3s: error: could not lock config file .git/config: File exists"
    expectLog(ran, [
      again,
      again,
      `  GIT_FAILED: git could not make t-1's worktree (${gitTries} tries): error: could not lock config file .git/config: File exists -> deferred without starting a worker; bd undefer t-1 once git can make it`,
    ])
    expect(ran.log.some((text) => text.startsWith("HOLD:") || text.startsWith("STOP:"))).toBe(false)
  })

  test("once: made on the next try, and its worker starts", async () => {
    const ran = await starting(1)
    const started = resultOf(ran)
    expect(started.prepared).toBe(2)
    expect(started.start._tag).toBe("Started")
    expect(ran.log.some((text) => text.includes("GIT_FAILED"))).toBe(false)
  })
})

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished, cause = (place) => Move.Verified({ place })) =>
      ledger.transition(finished.id, cause(1)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    held: yield* makeHeld,
    checksAhead: undefined as never,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/**
 * Dispatches the ticket and runs its fiber on main, its worktree at `path`. Its worker claims it,
 * commits its change and closes it; as its turn ends, git's `op` in its worktree fails as `fault`
 * says.
 */
const closing = (
  path: string,
  op: "symbolic-ref" | "status",
  fault: Fault,
): Promise<Ran<Worked>> => {
  const step = (effect: (world: World) => Effect.Effect<unknown, unknown>) => (world: World) =>
    run(Effect.asVoid(Effect.orDie(Effect.suspend(() => effect(world)))))
  return scenario(
    {
      backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
      worktrees: { root: dirname(path) },
      scripts: (world) => ({
        [id]: [
          turn([
            step((w) => w.beads.update(id, { claim: true }))(world),
            step((w) => w.repository.commit(path, `Do it (${id})`, { "a.txt": "a\n" }))(world),
            step((w) => w.beads.close(id, "done"))(world),
            step((w) => w.repository.fail(op, { dir: path, ...fault }))(world),
          ]),
        ],
      }),
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, path, { branch: `tutti/${id}`, base: "main" })
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      const fiber = yield* Effect.forkChild(work(ticket, { base: "main", queue: yield* lineOnly }))
      return yield* settle(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  )
}

describe("a closed ticket whose worktree git can't read as its worker settles", () => {
  test("what it has checked out: left for review, GIT_FAILED, its worktree kept", async () => {
    const path = join(worktreesRoot(), id)
    const ran = await closing(path, "symbolic-ref", {
      times: gitTries,
      stderr: "fatal: index file corrupt\nmore",
    })
    const worked = resultOf(ran)
    expect(worked.phase).toMatchObject({ _tag: "Review", why: "GIT_FAILED" })
    expect(ran.worktreeCalls).not.toContainEqual(expect.objectContaining({ op: "remove", id }))
    const line = `GIT_FAILED: t-1 closed, but git could not read its worktree ${path} (${gitTries} tries): fatal: index file corrupt; tutti/t-1 is not merged, its worktree left for review`
    expectLog(ran, [`  ${line}`])
    expect(ran.issues.find((issue) => issue.id === id)?.notes).toContain(`tutti: ${line}`)
    expect(ran.log.some((text) => text.startsWith("HOLD:") || text.startsWith("STOP:"))).toBe(false)
  })

  test("its status timing out: the same", async () => {
    const path = join(worktreesRoot(), id)
    const ran = await closing(path, "status", { times: gitTries, timedOut: true })
    const worked = resultOf(ran)
    expect(worked.phase).toMatchObject({ _tag: "Review", why: "GIT_FAILED" })
    expectLog(ran, [
      /^ {2}GIT_FAILED: t-1 closed, but git could not read its worktree .* \(3 tries\): git took longer than /,
    ])
  })

  test("git failing once: read again, and the ticket goes to merge", async () => {
    const path = join(worktreesRoot(), id)
    const ran = await closing(path, "symbolic-ref", { stderr: "fatal: index file corrupt" })
    expect(resultOf(ran).phase?._tag).toBe("ToMerge")
    expect(ran.log.some((text) => text.includes("GIT_FAILED"))).toBe(false)
  })
})

describe("git worktree add on a real repository", () => {
  slow.test(
    "one git made before it failed is removed, and the next try makes it afresh",
    async () => {
      const repo = makeRepo()
      const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-git-aside-live-")))
      let added = 0
      // git makes the worktree, then fails, as one stopped past its time limit after its checkout.
      const failingOnce = Layer.effect(
        Git,
        Effect.map(Effect.service(Git), (real) =>
          Git.of({
            ...real,
            addWorktree: (dir, path, options) =>
              Effect.andThen(
                real.addWorktree(dir, path, options),
                Effect.suspend(() => (++added === 1 ? Effect.fail(hookFailed) : Effect.void)),
              ),
          }),
        ),
      )
      const layer = Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
        Layer.provide(failingOnce),
        Layer.provideMerge(Git.layer()),
        Layer.provideMerge(GitWriter.layer),
        Layer.provideMerge(BunServices.layer),
      )
      const tries = await Effect.runPromise(
        Effect.gen(function* () {
          const worktrees = yield* Worktrees
          const first = yield* Effect.exit(worktrees.prepare(id))
          const listed = yield* (yield* Git).worktrees(repo.dir)
          const second = yield* worktrees.prepare(id)
          return { first, listed, second }
        }).pipe(Effect.provide(layer)),
      )
      expect(Exit.isFailure(tries.first)).toBe(true)
      expect(tries.listed.map((each) => each.branch)).not.toContain("tutti/t-1")
      expect(tries.second).toMatchObject({ path: join(root, id), fresh: true })
      expect(existsSync(join(root, id, "README.md"))).toBe(true)
    },
  )

  slow.test(
    "runs without the project's hooks: a failing post-checkout hook doesn't fail it",
    async () => {
      const repo = makeRepo()
      const ran = join(dirname(repo.dir), "hook-ran")
      const hook = join(hooksDir(repo), "post-checkout")
      writeFileSync(hook, `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, { mode: 0o755 })
      const path = join(dirname(repo.dir), "wt")
      const live = Git.layer().pipe(
        Layer.provideMerge(GitWriter.layer),
        Layer.provideMerge(BunServices.layer),
      )
      const added = await Effect.runPromise(
        Effect.exit(
          Effect.flatMap(Git, (git) =>
            git.addWorktree(repo.dir, path, { branch: "tutti/t-1", base: "main" }),
          ).pipe(Effect.provide(live)),
        ),
      )
      expect(Exit.isSuccess(added)).toBe(true)
      expect(existsSync(join(path, "README.md"))).toBe(true)
      expect(existsSync(ran)).toBe(false)
    },
  )
})
