// A quit while a ticket boards its train (mergetrain.ts's board) and the train still rebases its
// branch onto the one ahead: the branch is read once the train has ended, so the rebase that
// finishes after the quit is put back, and the ticket's checked_ahead mark goes only with it.
import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { aheadKey } from "../src/run/mergetrain.ts"
import { Move } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed, type Scripted } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, scenario } from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const settings = {
  ...defaults,
  checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  merge: { ...defaults.merge, check_hand_backs: 0, train: 1 },
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

test("a quit while a ticket boards and its train rebases puts its branch back once rebased", async () => {
  // b's rebase onto tutti/a starts as a's check runs, and is held until the quit has reached b's
  // boarding; a's check passes once b's rebase has begun, so a merges and b boards.
  const rebasing = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const aCheck: Scripted = () =>
    Effect.as(Deferred.await(rebasing), { ...passed("fast"), command: check })
  const ran = await scenario(
    {
      config: { settings },
      backlog: backlog().ticket("a").ticket("b").seeds,
      checks: { fast: [aCheck] },
    },
    Effect.gen(function* () {
      const git = yield* Git
      const held: typeof git = {
        ...git,
        rebase: (worktree, onto) =>
          worktree.endsWith("/b")
            ? Effect.andThen(
                Effect.andThen(Deferred.succeed(rebasing, undefined), Deferred.await(release)),
                git.rebase(worktree, onto),
              )
            : git.rebase(worktree, onto),
      }
      const queue = yield* makeQueue({ repo: "/repo", base: "main" }).pipe(
        Effect.provideService(Git, held),
      )
      const repository = yield* Repository
      const a = yield* finished("a" as TicketId, { "a.txt": "a\n" })
      const b = yield* finished("b" as TicketId, { "b.txt": "b\n" })
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      const before = yield* repository.head(b.branch)
      yield* queue.offer(a)
      yield* queue.offer(b)
      yield* Deferred.await(rebasing)
      yield* queue.changes.pipe(
        Stream.filter((state) => state.merging === "b"),
        Stream.runHead,
      )
      // The quit reaches b's boarding, which waits on its train, and the rebase finishes after it.
      const quit = yield* Effect.forkChild(Effect.andThen(queue.hold, queue.stopMerges))
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow
      const marked = (yield* (yield* Store).metadata("b" as TicketId))[aheadKey]
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(quit)
      return {
        before,
        marked,
        after: yield* repository.head(b.branch),
        mark: (yield* (yield* Store).metadata("b" as TicketId))[aheadKey],
        main: yield* repository.tree("main"),
      }
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )
  if (ran.exit._tag === "Failure") throw new Error(`the scenario failed: ${ran.exit.cause}`)
  const ended = ran.exit.value
  expect(ended.main.get("a.txt")).toBe("a\n")
  expect(ended.main.has("b.txt")).toBe(false)
  // Marked as the train began, kept while it rebased, cleared once the branch is back.
  expect(ended.marked).toBeDefined()
  expect(ended.after).toBe(ended.before)
  expect(ended.mark).toBeUndefined()
})
