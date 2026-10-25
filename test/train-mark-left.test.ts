// A branch still marked as rebased by a train onto the branch ahead (mergetrain.ts's checked_ahead)
// as its turn comes, git having failed to put it back on a quit or as the run started: its merge
// (merge.ts's Enter step) sets it aside as REBASE_FAILED, rather than merge the commits of the branch
// ahead with its own. One back where its worker left it merges, its mark cleared.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { aheadKey } from "../src/run/mergetrain.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Ran, scenario } from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** A check command, failed checks set aside at once, no trains. */
const settings = {
  ...defaults,
  checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  merge: { ...defaults.merge, check_hand_backs: 0, train: 0 },
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A ticket its worker finished: a commit naming it on tutti/<id>, closed, Working. */
const finished = (id: TicketId) =>
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

interface Left {
  /** b's branch as its worker left it, and as the train rebased it onto tutti/a. */
  readonly orig: string
  readonly head: string
  readonly phases: Record<string, PhaseTag>
  readonly main: ReadonlyMap<string, string>
  readonly mark: unknown
}

/**
 * b finished, its branch rebased onto tutti/a, which didn't merge, and marked as `mark` says;
 * `before` may move it. Then b alone goes through the merge queue.
 */
const leftMarked = (
  mark: (rebased: { orig: string; onto: string; head: string }) => Schema.Json,
  before: (b: FinishedTicket, orig: string) => Effect.Effect<void, unknown, Git> = () =>
    Effect.void,
): Promise<Ran<Left>> =>
  scenario(
    {
      config: { settings },
      backlog: backlog().ticket("a").ticket("b").seeds,
      checks: { fast: [passed("fast"), passed("fast")] },
    },
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      const store = yield* Store
      const queue = yield* makeQueue({ repo: repository.dir, base: "main" })
      const a = yield* finished("a" as TicketId)
      const b = yield* finished("b" as TicketId)
      const orig = yield* repository.head(b.branch)
      const onto = yield* repository.head(a.branch)
      yield* git.rebase(b.worktree, onto)
      const head = yield* repository.head(b.branch)
      yield* store.setMetadata("b" as TicketId, aheadKey, mark({ orig, onto, head }))
      yield* before(b, orig)
      yield* queue.offer(b)
      yield* queue.settled
      return {
        orig,
        head,
        phases: tagsOf(yield* (yield* Ledger).current),
        main: yield* repository.tree("main"),
        mark: (yield* store.metadata("b" as TicketId))[aheadKey],
      }
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )

describe("a branch still marked as rebased onto the branch ahead, as its turn comes", () => {
  test("is set aside as REBASE_FAILED, unmerged, its mark kept", async () => {
    const ran = await leftMarked(({ orig, onto, head }) => ({
      orig,
      onto,
      head,
      behind: "tutti/a",
      setUp: false,
    }))
    const left = resultOf(ran)
    expect(left.phases.b).toBe("Review")
    expect(left.main.has("a.txt")).toBe(false)
    expect(left.main.has("b.txt")).toBe(false)
    expect(left.mark).toEqual(expect.objectContaining({ orig: left.orig, head: left.head }))
    expect(ran.checkRuns).toEqual([])
    expect(
      ran.log.some(
        (text) =>
          text.includes("REBASE_FAILED") &&
          text.includes(
            `b closed, but tutti/b was rebased onto tutti/a to be checked ahead of its turn and could not be put back as its worker left it, at ${left.orig.slice(0, 7)}, so it may have the commits of tutti/a`,
          ),
      ),
    ).toBe(true)
  })

  test("back where its worker left it, merges without the branch ahead, its mark cleared", async () => {
    const ran = await leftMarked(
      ({ orig, onto, head }) => ({ orig, onto, head, behind: "tutti/a", setUp: false }),
      (b, orig) => Effect.flatMap(Git, (git) => git.resetBranch(b.worktree, orig)),
    )
    const left = resultOf(ran)
    expect(left.phases.b).toBe("Done")
    expect(left.main.get("b.txt")).toBe("b\n")
    expect(left.main.has("a.txt")).toBe(false)
    expect(left.mark).toBeUndefined()
    expect(ran.log.some((text) => text.includes("REBASE_FAILED"))).toBe(false)
  })

  test("with a mark that names no commit to put it back to, merges as any other, the mark cleared", async () => {
    const ran = await leftMarked(() => ({ behind: "tutti/a" }))
    const left = resultOf(ran)
    expect(left.phases.b).toBe("Done")
    expect(left.mark).toBeUndefined()
  })
})
