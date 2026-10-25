import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { init, result, run, sessionState, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, scenario, type World } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** The default settings with a check command, which a hand-back needs to check a resolution. */
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: "check" } },
    },
  },
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** Where ticket a's worktree is, once `finished` has made it: for its worker's script. */
let worktree = ""

/**
 * Ticket a, its worker finished and idle: its worktree on tutti/a with a commit of each of
 * `commits`, the last naming it, closed in Beads, Working in the ledger.
 */
const finished = (...commits: ReadonlyArray<Files>) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const prepared = yield* (yield* Worktrees).prepare("a" as TicketId)
    worktree = prepared.path
    yield* git.addWorktree(repository.dir, prepared.path, { branch: prepared.branch, base: "main" })
    for (const [n, files] of commits.entries()) {
      const last = n === commits.length - 1
      yield* repository.commit(prepared.path, last ? "Do a (a)" : "Start a", files)
    }
    yield* (yield* Beads).close("a" as TicketId, "done")
    const ledger = yield* Ledger
    yield* ledger.transition("a" as TicketId, Move.Ready(), { title: "Ticket a" })
    yield* ledger.transition("a" as TicketId, Move.Dispatched())
    yield* (yield* Store).saveSession("a" as TicketId, {
      session: "session-a",
      worktree: prepared.path,
      branch: prepared.branch,
    })
    yield* (yield* AgentHost).start("a" as TicketId, { sessionId: "session-a", cwd: prepared.path })
    yield* untilSettled("a" as TicketId)
    return {
      id: "a" as TicketId,
      title: "Ticket a",
      branch: prepared.branch,
      worktree: prepared.path,
    } satisfies FinishedTicket
  })

interface Merged {
  readonly phase: TicketPhase | undefined
  /** main's head before the merge, and after it. */
  readonly before: string
  readonly after: string
  /** Where tutti/a is as it is removed: the test layer's Worktrees only records the removal. */
  readonly branch: string
}

/**
 * Ticket a, made of `commits`, conflicting with main's change to a.txt, merged until the queue
 * settles: its worker resolves the conflict writing `resolved`.
 */
const handedBack = (resolved: Files, ...commits: ReadonlyArray<Files>) =>
  scenario(
    {
      backlog: backlog().ticket("a").seeds,
      ...withCheck,
      scripts: (world: World) => ({
        a: [
          [
            init(),
            sessionState("running"),
            result(),
            sessionState("idle"),
            ...turn([
              run(Effect.suspend(() => world.repository.continueRebase(worktree, resolved))),
            ]),
          ],
        ],
      }),
    },
    Effect.gen(function* () {
      const queue = yield* makeQueue(options)
      const ticket = yield* finished(...commits)
      const repository = yield* Repository
      yield* repository.commit(repository.dir, "Land something else", { "a.txt": "main's a\n" })
      const head = yield* repository.head("main")
      yield* queue.offer(ticket)
      yield* queue.settled
      return {
        phase: (yield* (yield* Ledger).current).tickets.get("a" as TicketId)?.phase,
        before: head,
        after: yield* repository.head("main"),
        branch: yield* repository.head(ticket.branch),
      } satisfies Merged
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )

const resolvingLine =
  "  RESOLVING: tutti/a conflicts with main in a.txt; handed back to its worker to resolve (up to 20m)"

describe("a hand-back whose resolution leaves the branch changing nothing", () => {
  test("its worker skipping every commit closes it at once as unchanged, unchecked", async () => {
    const ran = await handedBack({ "a.txt": "main's a\n" }, { "a.txt": "a\n" })
    const merged = resultOf(ran)
    expect(merged.phase?._tag === "Done" && merged.phase.outcome._tag).toBe("NoChange")
    expect(merged.after).toBe(merged.before)
    expect(merged.branch).toBe(merged.before)
    // Not checked, nor put back in line to be found unchanged there.
    expect(ran.checkRuns).toEqual([])
    expect(pathOf(ran, "a")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "Done",
    ])
    expect(ran.worktreeCalls.filter((call) => call.op === "remove")).toEqual([
      { op: "remove", id: "a" as TicketId, force: false, aside: true },
    ])
    expectLog(ran, [
      resolvingLine,
      "  a closed with no change: its worker found the changes of tutti/a on main already and skipped them in the rebase, so there is nothing to merge; worktree and branch removed",
    ])
    expect(ran.log.some((each) => each.includes("checking it with"))).toBe(false)
    expect(ran.events.filter((record) => record.kind === "closed")).toEqual([
      expect.objectContaining({ ticket: "a", title: "Ticket a", detail: "no change to merge" }),
    ])
  })

  test("commits left that together change nothing close it so too, the branch moved to main", async () => {
    // The first commit applies; the second, conflicting, is resolved as undoing the first.
    const ran = await handedBack(
      { "a.txt": "main's a\n" },
      { "b.txt": "b\n" },
      { "a.txt": "a\n", "b.txt": null },
    )
    const merged = resultOf(ran)
    expect(merged.phase?._tag === "Done" && merged.phase.outcome._tag).toBe("NoChange")
    expect(merged.after).toBe(merged.before)
    expect(merged.branch).toBe(merged.before)
    expect(ran.checkRuns).toEqual([])
    expectLog(ran, [
      resolvingLine,
      "  a closed with no change: the commits on tutti/a, taken together, change nothing, so there is nothing to merge; worktree and branch removed",
    ])
  })
})
