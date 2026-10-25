// A quit during the run's start (run.ts's untilQuit): heard from before the requirements check, it
// cuts the step under way short, the tickets left unmerged read or the workers the last run left
// taken up, and the run quits at once, INTERRUPTED: no more of those workers is resumed, and those
// not taken up stay in state.json as they were, for the next run.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Queue } from "effect"
import { line } from "../src/run/log.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store, type TicketRecord } from "../src/services/Store.ts"
import {
  awaitInterrupt,
  claimsAndCloses,
  interruptedResult,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { backlog, type Ran, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-carry-quit-${name}-`)))

const tickets = ["t-1" as TicketId, "t-2" as TicketId, "t-3" as TicketId, "t-4" as TicketId]

/** What the last run saved of a ticket, its worktree under `root`: suspended at its ticket limit. */
const savedRecord = (root: string, id: TicketId): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  suspended: "TICKET_LIMIT",
  phase: "Stopped",
  resumes: 0,
  metadata: {},
})

/**
 * A whole run on main after one that left four workers, quit while bd lists the tickets left
 * unmerged, or by t-1's worker, resumed, as bd's show of t-2 hangs: carry-over under way.
 */
const quitDuringStart = (
  at: "unmerged" | "carry-over",
): Promise<{ readonly ran: Ran<Outcome>; readonly state: State; readonly root: string }> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const quits = Effect.runSync(Queue.unbounded<QuitRequest>())
  const quit = Effect.asVoid(Queue.offer(quits, quitBy("SIGINT")))
  let state: State | undefined
  const saved = Object.fromEntries(tickets.map((id) => [id, savedRecord(root, id)]))
  return scenario(
    {
      config: { repo },
      backlog: tickets.reduce((made, id) => made.ticket(id, { status: "in_progress" }), backlog())
        .seeds,
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, tickets: saved },
      scripts: Object.fromEntries(
        tickets.map((id) => [
          id,
          [
            id === "t-1"
              ? turn([step(quit), awaitInterrupt], interruptedResult)
              : claimsAndCloses(id),
          ],
        ]),
      ),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        mkdirSync(join(root, id), { recursive: true })
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const beads = yield* Beads
      // The first call only never answers, quitting the run first while bd lists.
      let hung = false
      const once = <A, E>(answer: Effect.Effect<A, E>, first: Effect.Effect<void>) =>
        Effect.suspend((): Effect.Effect<A, E> => {
          if (hung) return answer
          hung = true
          return Effect.andThen(first, Effect.never)
        })
      const running = run({
        version: "0.1.0-test",
        base: "main",
        start: [line`START tutti 0.1.0-test`],
        quits,
      }).pipe(
        Effect.provideService(Beads, {
          ...beads,
          show: (id) =>
            at === "carry-over" && id === "t-2"
              ? once(beads.show(id), Effect.void)
              : beads.show(id),
          list: (filter) =>
            at === "unmerged" && filter?.labels?.includes("unmerged") === true
              ? once(beads.list(filter), quit)
              : beads.list(filter),
        }),
      )
      const outcome = yield* Fiber.join(yield* Effect.forkChild(Effect.scoped(running)))
      state = yield* (yield* Store).state
      return outcome
    }),
  ).then((ran) => {
    if (state === undefined) throw new Error(`the run failed: ${ran.exit}`)
    return { ran, state, root }
  })
}

/** The tickets whose saved sessions were resumed, in order. */
const resumed = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) => (sent._tag === "Resumed" ? [sent.ticket] : []))

const exitCode = (ran: Ran<Outcome>) =>
  ran.exit._tag === "Success" ? ran.exit.value.exitCode : undefined

describe("a quit during the run's start", () => {
  test("during carry-over of several workers resumes no more of them, and quits at once", async () => {
    const { ran, state, root } = await quitDuringStart("carry-over")
    expect(exitCode(ran)).toBe(130)
    expect(ran.log.at(-1)).toBe(
      "INTERRUPTED: quit with Ctrl+C; t-1's session is saved for the next run",
    )
    // t-1 was resumed before the quit, and is interrupted and saved again; the others never start.
    expect(resumed(ran)).toEqual(["t-1" as TicketId])
    expect(ran.sent.filter((sent) => sent._tag === "Started")).toEqual([])
    expect(ran.sent).toContainEqual(expect.objectContaining({ _tag: "Interrupted", ticket: "t-1" }))
    expect(state.tickets["t-1"]).toEqual(
      expect.objectContaining({ session: "session-t-1", suspended: "quit", phase: "Stopped" }),
    )
    // Those not taken up are left in state.json as they were.
    for (const id of ["t-2" as TicketId, "t-3" as TicketId, "t-4" as TicketId]) {
      expect(state.tickets[id]).toEqual(savedRecord(root, id))
    }
  })

  test("while the tickets left unmerged are read resumes none of the workers", async () => {
    const { ran, state, root } = await quitDuringStart("unmerged")
    expect(exitCode(ran)).toBe(130)
    expect(ran.log).toContain("INTERRUPTED: quit with Ctrl+C")
    expect(resumed(ran)).toEqual([])
    expect(ran.sent).toEqual([])
    for (const id of tickets) expect(state.tickets[id]).toEqual(savedRecord(root, id))
  })
})
