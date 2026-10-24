// The steps the two hand-backs share (handback.ts): leftClean, what a worker must leave its worktree
// as after either, each mode in its own words; and makeCounts, the per-ticket count of hand-backs
// that the conflict hand-backs (HandBacks) and the check hand-backs (Fixes) each keep apart.
// leftClean runs against the in-memory Git.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeFixes } from "../src/run/checkback.ts"
import { type HandBackMode, leftClean, makeCounts, makeHandBacks } from "../src/run/handback.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { Git } from "../src/services/Git.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"

const worktree = "/worktrees/a"
const ticket = {
  id: "a",
  title: "Ticket a",
  branch: "tutti/a",
  worktree,
} satisfies FinishedTicket

/** What leftClean says of a's worktree in `mode`, once `arrange` has left it as a test wants it. */
const left = (
  mode: HandBackMode,
  arrange: Effect.Effect<void, unknown, Git | Repository> = Effect.void,
): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* Repository
      yield* (yield* Git).addWorktree(repository.dir, worktree, {
        branch: "tutti/a",
        base: "main",
      })
      yield* repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" })
      yield* arrange
      return yield* leftClean(ticket, mode)
    }).pipe(Effect.provide(memoryGit())),
  )

/** A rebase of the branch onto a commit of main's, stopped on conflicts in a.txt. */
const conflicted = Effect.gen(function* () {
  const repository = yield* Repository
  const onto = yield* repository.commit(repository.dir, "Main's a", { "a.txt": "main\n" })
  yield* repository.conflict("tutti/a", ["a.txt"])
  yield* Effect.flip((yield* Git).rebase(worktree, onto))
})

const modes: ReadonlyArray<HandBackMode> = ["resolving", "fixing"]

describe("leftClean", () => {
  test.each(modes)("takes a worktree clean and on its branch, %s", async (mode) => {
    expect(await left(mode)).toBeUndefined()
  })

  test("says a rebase in progress in each mode's words", async () => {
    expect(await left("resolving", conflicted)).toBe("its worker left the rebase unfinished")
    expect(await left("fixing", conflicted)).toBe(
      `its worker left a rebase in progress in ${worktree}`,
    )
  })

  test.each(modes)("says uncommitted changes the same way, %s", async (mode) => {
    const halfDone = Effect.flatMap(Repository, (it) =>
      it.write(worktree, { "a.txt": "half done\n" }),
    )
    expect(await left(mode, halfDone)).toBe(`its worker left uncommitted changes in ${worktree}`)
  })

  test.each(modes)("names the files left untracked, %s", async (mode) => {
    const loose = Effect.flatMap(Repository, (it) => it.write(worktree, { "b.txt": "b\n" }))
    expect(await left(mode, loose)).toBe(`its worker left untracked files in ${worktree}: b.txt`)
  })
})

describe("makeCounts", () => {
  test("counts each ticket's hand-backs apart, next saying the one it counts", async () => {
    const counted = await Effect.runPromise(
      Effect.gen(function* () {
        const counts = yield* makeCounts
        const first = yield* counts.next("a")
        const second = yield* counts.next("a")
        const other = yield* counts.next("b")
        return {
          first,
          second,
          other,
          a: yield* counts.count("a"),
          b: yield* counts.count("b"),
          c: yield* counts.count("c"),
        }
      }),
    )
    expect(counted).toEqual({ first: 1, second: 2, other: 1, a: 2, b: 1, c: 0 })
  })

  test("keeps a run's conflict hand-backs and check hand-backs apart", async () => {
    const counted = await Effect.runPromise(
      Effect.gen(function* () {
        const handBacks = yield* makeHandBacks
        const fixes = yield* makeFixes
        yield* handBacks.next("a")
        yield* handBacks.next("a")
        yield* fixes.next("a")
        return { conflicts: yield* handBacks.count("a"), checks: yield* fixes.count("a") }
      }),
    )
    expect(counted).toEqual({ conflicts: 2, checks: 1 })
  })
})
