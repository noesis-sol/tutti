// A commit made on the base by hand between the merge's read of it and the rebase: the branch is
// rebased onto the commit read, so the setup's diff goes by the commit it is on, and the newer one
// is rebased onto, set up for and checked in the next pass.
import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

const setupCommand = "bun install --frozen-lockfile"

const defaults = appConfig().settings

const config = {
  settings: {
    ...defaults,
    checks: { ...defaults.checks, setup: { command: setupCommand, files: ["bun.lock"] } },
  },
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, Working. */
const finished = (id: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
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

test("a commit on the base between the read and the rebase is rebased onto in the next pass", async () => {
  const ran = await scenario(
    { backlog: backlog().ticket("a").seeds, config },
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      const a = yield* finished("a", { "a.ts": "a\n" })
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      const read = yield* repository.head("main")
      // Each rebase's target; the first is preceded by a commit to main by hand, changing bun.lock.
      const targets: Array<string> = []
      let byHand = ""
      const moving: typeof git = {
        ...git,
        rebase: (worktree, onto) =>
          Effect.gen(function* () {
            if (byHand === "") {
              byHand = yield* repository.commit(repository.dir, "By hand", { "bun.lock": "v2\n" })
            }
            targets.push(onto)
            return yield* git.rebase(worktree, onto)
          }),
      }
      const queue = yield* makeQueue(options).pipe(Effect.provideService(Git, moving))
      yield* queue.offer(a)
      yield* queue.settled
      return {
        read,
        byHand,
        targets,
        phase: (yield* (yield* Ledger).current).tickets.get("a")?.phase,
        main: yield* repository.head("main"),
        files: Object.fromEntries(yield* repository.tree("main")),
      }
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )
  const merged = resultOf(ran)
  // Onto the commit read, then onto the one made by hand, never onto the base's name.
  expect(merged.targets).toEqual([merged.read, merged.byHand])
  expect(merged.phase?._tag === "Done" && merged.phase.outcome._tag).toBe("Merged")
  expect(merged.files).toEqual(
    expect.objectContaining({ "a.ts": "a\n", "main.txt": "moved\n", "bun.lock": "v2\n" }),
  )
  // The first pass's rebase brought no setup file; the second's brought bun.lock, set up for.
  expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast", "setup", "fast"])
  expectLog(ran, [
    "  rebased tutti/a onto main, which moved on while it ran",
    "  'scripted fast' passes on the rebased tutti/a",
    "  rebased tutti/a onto main, which moved on while it ran",
    `  a: bun.lock changed in the rebase; running '${setupCommand}' before the check`,
    "  'scripted fast' passes on the rebased tutti/a",
    /^ {2}a closed \(.*\); merged into main, worktree and branch removed$/,
  ])
})
