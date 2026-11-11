// An untracked file in the main checkout doesn't stop the merges: git fast-forwards over it, and
// refuses only one the branch would overwrite, which is DIRTY_TREE naming it (tutti-epza.5).

import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket, MergeStop } from "../src/run/mergeShared.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { checkoutChanges, checkoutTrackedChanges } from "../src/services/gitStatus.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

interface Merged {
  readonly phases: Readonly<Record<string, TicketPhase>>
  readonly stop: MergeStop | null
  /** The main checkout's a.txt and .DS_Store, as its working tree has them. */
  readonly local: Readonly<Record<string, string | undefined>>
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phasesOf = (state: State): Record<string, TicketPhase> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

/** A ticket its worker finished, its commit adding `files`, closed in Beads, Working in the ledger. */
const finished = (id: TicketId, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
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

/** Merges ticket a, adding `adds`, with `local` written untracked in the main checkout first. */
const mergeBeside = (adds: Files, local: Files) =>
  scenario(
    { backlog: backlog().ticket("a").seeds },
    Effect.gen(function* () {
      const repository = yield* Repository
      const queue = yield* makeQueue(options)
      const a = yield* finished("a" as TicketId, adds)
      yield* repository.write(repository.dir, local)
      yield* queue.offer(a)
      yield* queue.settled
      return {
        phases: phasesOf(yield* (yield* Ledger).current),
        stop: (yield* queue.state).stop,
        local: {
          "a.txt": yield* repository.read(repository.dir, "a.txt"),
          ".DS_Store": yield* repository.read(repository.dir, ".DS_Store"),
        },
      } satisfies Merged
    }).pipe(Effect.provide(Ledger.layer)),
  )

describe("an untracked file in the main checkout", () => {
  test("one the branch doesn't add: the ticket merges, the file left as it was", async () => {
    const ran = await mergeBeside({ "a.txt": "a\n" }, { ".DS_Store": "finder\n" })
    const merged = resultOf(ran)
    expect(merged.stop).toBeNull()
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(merged.local).toEqual({ "a.txt": "a\n", ".DS_Store": "finder\n" })
    expect(ran.log.some((text) => text.includes("DIRTY_TREE"))).toBe(false)
  })

  test("one the branch adds: git refuses, DIRTY_TREE naming it, the run held", async () => {
    const ran = await mergeBeside({ "a.txt": "a\n" }, { "a.txt": "local\n" })
    const merged = resultOf(ran)
    expect(merged.stop).toMatchObject({ why: "DIRTY_TREE", code: 5, ticket: "a" })
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Blocked", why: "DIRTY_TREE" }))
    expect(merged.local["a.txt"]).toBe("local\n")
    expectLog(ran, [
      /^HOLD: DIRTY_TREE: uncommitted changes in \/repo to a\.txt, which tutti\/a changes; /,
    ])
  })
})

describe("checkoutTrackedChanges", () => {
  test("the tracked changes outside the tools' folders, sorted, no untracked file", () => {
    const status = [
      { code: "??", path: "z.ts" },
      { code: " M", path: "b.txt" },
      { code: "R ", path: "a.ts", from: "old.ts" },
      { code: "!!", path: "node_modules/x" },
      { code: " M", path: ".beads/issues.jsonl" },
      { code: " M", path: ".tutti/run/state.json" },
      { code: " M", path: ".orchestra/run/state.json" },
      { code: " D", path: ".tutti/settings.json" },
    ]
    expect(checkoutTrackedChanges(status)).toEqual([".tutti/settings.json", "a.ts", "b.txt"])
    expect(checkoutChanges(status)).toEqual([".tutti/settings.json", "a.ts", "b.txt", "z.ts"])
  })
})
