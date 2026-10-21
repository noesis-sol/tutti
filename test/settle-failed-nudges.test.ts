// A worker whose turn failed on an API error settles Failed (§ 4.2), and the per-ticket fiber reads
// its ticket as for an idle one (§ 4.3): unsteered, its ticket still in progress, it is told to
// continue twice, and then, after the idle grace, the run holds with PAUSED.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Fiber, type Scope } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Cause } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import { idleGrace, nudgeText } from "../src/run/settle.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Git } from "../src/services/Git.ts"
import { apiErrorResult, run, turn } from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, type Env, expectLog, type Ran, scenario, type World } from "./harness.ts"

const id = "t-1"
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

/** A server error the API retries didn't get past: the turn's result, with is_error. */
const serverError = apiErrorResult("API Error: 500 Internal server error", 500)

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished, cause = (place) => Cause.Verified({ place })) =>
      ledger.transition(finished.id, cause(1)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/** Waits, yielding, until the log has a line matching `pattern`, then a little more. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 20_000; i++) {
      if ((yield* texts).some((each) => pattern.test(each))) break
      yield* Effect.yieldNow
    }
    for (let i = 0; i < 200; i++) yield* Effect.yieldNow
  })

/** Lets every fiber run as far as it can without the clock moving. */
const quiet = Effect.gen(function* () {
  for (let i = 0; i < 2_000; i++) yield* Effect.yieldNow
})

/**
 * Dispatches the ticket and runs its fiber on main, its worktree in a new folder, its worker's turns
 * each ending on a server error; `during` runs beside it before it is joined.
 */
const working = (
  turns: number,
  during: (fiber: Fiber.Fiber<Worked, unknown>) => Effect.Effect<void, unknown, Env | Ledger>,
): Promise<Ran<Worked>> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-settle-failed-")))
  const claim = (world: World) =>
    Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true })))
  return scenario(
    {
      backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
      worktrees: { root },
      scripts: (world) => ({
        [id]: [
          [
            ...turn([run(claim(world))], serverError),
            ...Array.from({ length: turns - 1 }, () => turn([], serverError)).flat(),
          ],
        ],
      }),
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Cause.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Cause.Dispatched())
      const fiber = yield* Effect.forkChild(work(ticket, { base: "main", queue: yield* lineOnly }))
      yield* during(fiber)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  )
}

const workedOf = (ran: Ran<Worked>): Worked => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The messages the ticket's worker was sent, as text. */
const sentTexts = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id ? [String(sent.message.message.content)] : [],
  )

describe("a worker settled Failed with its ticket still in progress", () => {
  test("an API error ending its turn gets the two continue nudges, then PAUSED after the grace", async () => {
    const states: Array<string> = []
    const ran = await working(3, (fiber) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* untilLogged(/told it to continue \(1 of 2\)/)
        yield* untilLogged(/told it to continue \(2 of 2\)/)
        yield* quiet
        // The nudge's turn failed too: the worker is Failed, not Idle, as it waits out the grace.
        states.push((yield* host.current(id))._tag)
        yield* advance(Duration.subtract(idleGrace, Duration.seconds(1)))
        yield* quiet
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* advance(Duration.seconds(1))
      }),
    )
    expect(states).toEqual(["Failed"])
    const worked = workedOf(ran)
    expect(worked.phase).toEqual(expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }))
    expect(worked.stop).toEqual(expect.objectContaining({ why: "PAUSED", code: 3, ticket: id }))
    const sent = sentTexts(ran)
    expect(sent).toHaveLength(3)
    expect(sent.slice(1)).toEqual([nudgeText(id), nudgeText(id)])
    const messages = ran.sent.flatMap((each) => (each._tag === "Message" ? [each.message] : []))
    expect(messages.every((message) => message.client_composed === true)).toBe(true)
    expectLog(ran, [
      "  t-1's worker ended its turn with the ticket still in progress; told it to continue (1 of 2)",
      "  t-1's worker ended its turn with the ticket still in progress; told it to continue (2 of 2)",
    ])
    expect(String(worked.stop?.line)).toMatch(/^PAUSED: t-1 still in_progress, its worker idle/)
  })

  test("after an API error, the nudge it takes up: it closes its ticket, which goes to merge", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-settle-failed-")))
    const path = join(root, id)
    const ran = await scenario(
      {
        backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
        worktrees: { root },
        scripts: (world) => ({
          [id]: [
            [
              ...turn(
                [run(Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))))],
                serverError,
              ),
              ...turn([
                run(
                  Effect.asVoid(
                    Effect.orDie(world.repository.commit(path, `Change (${id})`, { "a.txt": "a" })),
                  ),
                ),
                run(Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
              ]),
            ],
          ],
        }),
      },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const git = yield* Git
        const repository = yield* Repository
        yield* git.addWorktree(repository.dir, path, { branch: `tutti/${id}`, base: "main" })
        yield* ledger.transition(id, Cause.Ready(), { title: ticket.title })
        yield* ledger.transition(id, Cause.Dispatched())
        return yield* work(ticket, { base: "main", queue: yield* lineOnly })
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
    )
    expect(workedOf(ran).phase?._tag).toBe("ToMerge")
    expect(sentTexts(ran)).toEqual([expect.any(String), nudgeText(id)])
    expectLog(ran, [
      "  t-1's worker ended its turn with the ticket still in progress; told it to continue (1 of 2)",
    ])
  })
})
