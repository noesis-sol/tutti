import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Fiber, type Scope } from "effect"
import { takeAnswers } from "../src/run/asked.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import type { StopReason } from "../src/run/holds.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import type { Outcome } from "../src/run/run.ts"
import { run } from "../src/run/run.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, filesQuestion, result, sleep, run as step, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository } from "../src/testing/Git.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }
const defaults = appConfig().settings

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** t-1's worker files a question blocking it and puts it back to open. */
const asks = (world: World) =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        world.beads.create({ title: "Which way?", labels: ["human"], blocks: [id] }),
        world.beads.update(id, { status: "open" }),
      ),
    ),
  })

/** Closes t-1's open question, as the maintainer answering it would. */
const answers = (world: World) =>
  orDie(
    Effect.gen(function* () {
      for (const dependency of (yield* world.beads.show(id)).dependencies) {
        if (dependency.issue?.title === "Which way?" && dependency.issue.status !== "closed") {
          yield* world.beads.close(dependency.id, "answered")
        }
      }
    }),
  )

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  let places = 0
  return {
    offer: (finished, cause = (place) => Move.Verified({ place })) =>
      ledger.transition(finished.id, cause(++places)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    held: yield* makeHeld,
    checksAhead: undefined as never,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/** Advances the clock a minute at a time, `n` times, each given the fibers a moment to run. */
const minutes = (n: number) =>
  Effect.forEach(
    Array.from({ length: n }),
    () =>
      Effect.andThen(
        advance("1 minute"),
        Effect.promise(() => Bun.sleep(3)),
      ),
    { discard: true },
  )

interface Seen {
  /** The TICKET_LIMIT stops raised by the time the resumed worker had gone on 59 minutes. */
  readonly early: ReadonlyArray<StopReason>
  readonly stops: ReadonlyArray<StopReason>
  readonly carried: ReadonlyArray<Worked>
}

/**
 * Dispatches the ticket, whose worker asks a question; waits `waited` on its answer, then answers
 * it and resumes the worker, which goes on for 3 hours, the clock advanced past an hour from then.
 */
const answered = (waited: number): Promise<Ran<Seen>> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-asked-limit-")))
  return scenario(
    {
      backlog: backlog().ticket(id, { title: ticket.title }).seeds,
      config: {
        settings: {
          ...defaults,
          workers: { ...defaults.workers, ticket_limit: Duration.hours(1) },
        },
      },
      scripts: (world) => ({
        [id]: [asks(world), turn([...bash("make"), sleep("3 hours")], result("done"))],
      }),
      worktrees: { root },
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const beads = yield* Beads
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      const stops: Array<StopReason> = []
      const options = {
        base: "main",
        queue: yield* lineOnly,
        onTicketLimit: (stop: StopReason) => Effect.sync(() => void stops.push(stop)),
      }
      yield* work(ticket, options)
      yield* minutes(waited)
      for (const dependency of (yield* beads.show(id)).dependencies) {
        if (dependency.issue?.title === "Which way?") yield* beads.close(dependency.id, "answered")
      }
      const fibers: Array<Fiber.Fiber<Worked, unknown>> = []
      yield* takeAnswers({
        ...options,
        carry: (_, start) =>
          Effect.gen(function* () {
            const fiber = yield* start
            if (fiber !== undefined) fibers.push(yield* Effect.forkChild(fiber))
            return true
          }),
      })
      yield* minutes(59)
      const early = [...stops]
      yield* minutes(5)
      yield* advance("3 hours")
      const carried: Array<Worked> = []
      for (const fiber of fibers) carried.push(yield* Fiber.join(fiber))
      return { early, stops, carried } satisfies Seen
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Seen, unknown, Env | Scope.Scope>,
  )
}

describe("a worker resumed once its question is answered", () => {
  test("raises TICKET_LIMIT past its ticket limit, counted from its resume", async () => {
    const ran = await answered(50)
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const { early, stops, carried } = ran.exit.value
    expect(carried).toHaveLength(1)
    // The 50 minutes it waited on its answer count for nothing.
    expect(early).toEqual([])
    expect(stops).toEqual([expect.objectContaining({ why: "TICKET_LIMIT", ticket: id })])
    expect(stops[0]?.text).toMatch(/^TICKET_LIMIT: t-1 still working after 1h/)
    expect(ran.issues.find((each) => each.id === id)?.notes).toContain(
      "its worker was still working after the 1h ticket limit",
    )
    // An hour of minutes, each given the run a moment of real time: more than 5 s under load.
  }, 30_000)

  test("in a run, holds it with TICKET_LIMIT, the worker suspended as it ends", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-asked-limit-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-asked-limit-")))
    // t-1 asks; t-2's worker answers it, and t-1, resumed, goes on for 3 hours with a 1h limit.
    const ran: Ran<Outcome> = await scenario(
      {
        config: {
          repo,
          settings: {
            ...defaults,
            concurrent: 1,
            workers: { ...defaults.workers, ticket_limit: Duration.hours(1) },
          },
        },
        backlog: backlog().ticket(id).ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          [id]: [asks(world), turn([...bash("make"), sleep("3 hours")], result("done"))],
          "t-2": [
            turn(
              [
                ...bash(
                  "bd update t-2 --claim",
                  orDie(world.beads.update("t-2" as TicketId, { claim: true })),
                ),
                step(answers(world)),
                sleep("2 minutes"),
                ...bash(
                  "git commit",
                  orDie(
                    world.repository.commit(join(root, "t-2"), "Change (t-2)", { "b.txt": "b\n" }),
                  ),
                ),
                ...bash("bd close t-2", orDie(world.beads.close("t-2" as TicketId, "done"))),
              ],
              result("Closed t-2."),
            ),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const each of [id, "t-2"]) {
          yield* git.addWorktree(repo, join(root, each), { branch: `tutti/${each}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
        )
        yield* minutes(90)
        yield* advance("3 hours")
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 3)
    expectLog(ran, [
      /^ {2}RESUMED: t-1's question \S+ is answered/,
      /^HOLD: TICKET_LIMIT: t-1 still working after 1h/,
    ])
    const suspended = ran.events.filter((record) => record.kind === "suspended")
    expect(suspended).toEqual([expect.objectContaining({ ticket: id, why: "TICKET_LIMIT" })])
  }, 30_000)
})
