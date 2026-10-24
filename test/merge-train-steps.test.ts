// The merge train's steps (mergetrain.ts): a train that wasn't rebased onto the branch ahead, as
// its commits change nothing on top of it, but that git could not put back, is put back as its turn
// comes, its line saying why it wasn't checked ahead. Two finished tickets, a then b, behind a base
// that moved on while they ran; b makes a's change.
import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, scenario } from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** A ticket its worker finished: a commit naming it on tutti/<id>, closed, Working. */
const finished = (id: string, files: Files) =>
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

test("a train git could not put back after it changed nothing is put back in its turn", async () => {
  const ran = await scenario(
    {
      config: {
        settings: {
          ...defaults,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
          merge: { ...defaults.merge, check_hand_backs: 0, train: 1 },
        },
      },
      backlog: backlog().ticket("a").ticket("b").seeds,
      checks: { fast: Array.from({ length: 4 }, () => () => Effect.succeed(passed("fast"))) },
    },
    Effect.gen(function* () {
      const queue = yield* makeQueue({ repo: "/repo", base: "main" })
      const repository = yield* Repository
      const a = yield* finished("a", { "a.txt": "a\n" })
      const b = yield* finished("b", { "a.txt": "a\n" })
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      // The train's put-back after its rebase onto tutti/a dropped b's commit fails.
      yield* repository.fail("reset --hard", { dir: b.worktree })
      yield* queue.offer(a)
      yield* queue.offer(b)
      yield* queue.settled
      const phases = [...(yield* (yield* Ledger).current).tickets.values()].map(
        (entry) => [entry.ticket, entry.phase._tag] as const,
      )
      return { phases: Object.fromEntries(phases) }
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  expect(ran.exit.value.phases).toEqual({ a: "Done", b: "Done" })
  expectLog(ran, [
    /^ {2}a closed .*; merged into main/,
    "  tutti/b was checked ahead of its turn on top of tutti/a, which merged as it was checked, but it changes nothing on top of it: put back as its worker left it",
    /^ {2}b closed with no change: /,
  ])
  expect(ran.log.some((text) => text.includes("check was stopped"))).toBe(false)
})
