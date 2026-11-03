// What the merge train's setup and check leave in the worktree of a ticket checked ahead of its
// turn (mergetrain.ts): a lockfile its setup rewrote, a file its check formatted. The train rebases
// only a branch whose worktree is clean, so putting the branch back discards those changes, rather
// than leave the branch rebased onto the branch ahead and set the ticket aside, REBASE_FAILED.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, type Scope } from "effect"
import { restoreBranch } from "../src/run/branch.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { aheadKey } from "../src/run/mergetrain.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Scripted } from "../src/testing/Checks.ts"
import { type Files, layer as memoryGit, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

describe("restoreBranch told to discard", () => {
  const worktree = "/worktrees/a"
  const ticket = { branch: "tutti/a", worktree }

  test("resets a worktree with changes to tracked files, naming them", async () => {
    const ended = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/a", base: "main" })
        const to = yield* repository.commit(worktree, "Do a (a)", { "bun.lock": "v1\n" })
        const attempt = yield* repository.commit(worktree, "Try a (a)", { "a.txt": "a\n" })
        yield* repository.write(worktree, { "bun.lock": "v2\n" })
        const restored = yield* restoreBranch(ticket, to, 1, true)
        return {
          restored,
          to,
          attempt,
          branch: yield* repository.head("tutti/a"),
          status: yield* git.status(worktree),
        }
      }).pipe(Effect.provide(memoryGit())),
    )
    expect(ended.restored).toEqual({ _tag: "Reset", from: ended.attempt, discarded: ["bun.lock"] })
    expect(ended.branch).toBe(ended.to)
    expect(ended.status).toEqual([])
  })

  test("still leaves a worktree git can't say is clean", async () => {
    const restored = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/a", base: "main" })
        const to = yield* repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" })
        yield* repository.commit(worktree, "Try a (a)", { "a.txt": "tried\n" })
        yield* repository.fail("status")
        return yield* restoreBranch(ticket, to, 1, true)
      }).pipe(Effect.provide(memoryGit())),
    )
    expect(restored._tag).toBe("Dirty")
  })
})

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const settings = {
  ...defaults,
  checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  merge: { ...defaults.merge, check_hand_backs: 0, train: 1 },
}

const failing = new CheckFailed({
  check: "fast",
  command: check,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: b.test.ts: expected 1"],
  lastLines: ["1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

/** Which ticket a check ran for: its worktree's name. */
const whose = (run: CheckRun): string => run.cwd.split("/").at(-1) ?? ""

/** Every check run as `play` says for its ticket, whatever order they come in. */
const each = (
  play: (id: string, nth: number) => Effect.Effect<void, CheckFailed>,
): ReadonlyArray<Scripted> => {
  const counts = new Map<string, number>()
  const one: Scripted = (run) => {
    const id = whose(run)
    const nth = (counts.get(id) ?? 0) + 1
    counts.set(id, nth)
    return Effect.as(play(id, nth), { ...passed("fast"), command: check })
  }
  return Array.from({ length: 8 }, () => one)
}

/** A ticket its worker finished: a commit naming it on tutti/<id>, closed, Working. */
const finished = (id: TicketId, files: Files) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
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

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

interface Reach {
  repository: Repository["Service"]
  tickets: Record<string, FinishedTicket>
}

/** a and b finished, main moved on, both offered in order; the queue settles. */
const inLine = (checks: (reach: Reach) => ReadonlyArray<Scripted>) => {
  const reach = { tickets: {} } as Reach
  return scenario(
    {
      config: { settings },
      backlog: backlog().ticket("a").ticket("b").seeds,
      checks: { fast: checks(reach) },
    },
    Effect.gen(function* () {
      const queue: MergeQueue = yield* makeQueue({ repo: "/repo", base: "main" })
      const repository = yield* Repository
      reach.repository = repository
      reach.tickets.a = yield* finished("a" as TicketId, { "a.txt": "a\n" })
      reach.tickets.b = yield* finished("b" as TicketId, { "b.txt": "b\n", "bun.lock": "v1\n" })
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      yield* queue.offer(reach.tickets.a)
      yield* queue.offer(reach.tickets.b)
      yield* queue.settled
      return {
        phases: tagsOf(yield* (yield* Ledger).current),
        mark: (yield* (yield* Store).metadata("b" as TicketId))[aheadKey],
        main: yield* repository.tree("main"),
      }
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)) as Effect.Effect<
      {
        readonly phases: Record<string, PhaseTag>
        readonly mark: unknown
        readonly main: ReadonlyMap<string, string>
      },
      unknown,
      Env | Scope.Scope
    >,
  )
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("a ticket whose check ahead of its turn changed tracked files", () => {
  test("is put back as its worker left it, the changes discarded, and merges in its turn", async () => {
    // b's check ahead of its turn rewrites its lockfile and fails; a merges once it has.
    const bFailed = Deferred.makeUnsafe<void>()
    const ran = await inLine((reach) =>
      each((id, nth) =>
        id === "a"
          ? Deferred.await(bFailed)
          : nth === 1
            ? Effect.gen(function* () {
                const worktree = (reach.tickets.b as FinishedTicket).worktree
                yield* reach.repository.write(worktree, { "bun.lock": "v2\n" })
                yield* Deferred.succeed(bFailed, undefined)
                return yield* Effect.fail(failing)
              })
            : Effect.void,
      ),
    )
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Done" })
    expect(ran.checkRuns.map(whose)).toEqual(["a", "b", "b"])
    expect(merged.mark).toBeUndefined()
    expect(merged.main.get("bun.lock")).toBe("v1\n")
    expect(merged.main.get("b.txt")).toBe("b\n")
    expectLog(ran, [
      /^ {2}tutti\/b was checked ahead of its turn on top of tutti\/a, which merged as it was checked, but .*: put back as its worker left it, discarding what its setup and check ahead of its turn changed in bun\.lock$/,
    ])
    expect(ran.log.some((text) => text.includes("REBASE_FAILED"))).toBe(false)
  })
})
