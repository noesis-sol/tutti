// What takeAnswers tells the look of an answered question (tutti-luwa, asked.ts's AskedLook): whose
// ticket found no slot, which RunView stops counting as needing you (Status's answered); not one
// still open, nor one whose ticket came back.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, type Scope } from "effect"
import { askedLook, takeAnswers } from "../src/run/asked.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type WorkOptions, work } from "../src/run/work.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { filesQuestion, turn } from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { advance, backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

const id = "t-1" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

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

interface Looked {
  /** What the look found answered with no slot. */
  readonly noSlot: ReadonlyArray<string>
  /** The tickets it resumed. */
  readonly resumed: ReadonlyArray<string>
  /** The ticket's phase after it. */
  readonly phase: string | undefined
}

/**
 * The ticket Asked, by its worker filing a question; answered or not; then a look, with `slot` for
 * whether the scheduler has a slot for it.
 */
const looked = (plan: {
  readonly answer: boolean
  readonly slot: boolean
}): Promise<Ran<Looked>> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-asked-no-slot-")))
  return scenario(
    {
      backlog: backlog().ticket(id, { title: ticket.title }).seeds,
      worktrees: { root },
      scripts: (world: World) => ({
        [id]: [
          filesQuestion(id, {
            claim: orDie(world.beads.update(id, { claim: true })),
            file: orDie(
              Effect.andThen(
                world.beads.create({ title: "Which store?", labels: ["human"], blocks: [id] }),
                world.beads.update(id, { status: "open" }),
              ),
            ),
          }),
          // Resumed: its turn ends at once.
          turn([]),
        ],
      }),
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
      yield* advance("1 minute")
      const options: WorkOptions = { base: "main", queue: yield* lineOnly }
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      yield* work(ticket, options)
      if (plan.answer) {
        for (const dependency of (yield* beads.show(id)).dependencies) {
          if (dependency.issue?.title === "Which store?") {
            yield* beads.close(dependency.id, "answered")
          }
        }
      }
      const fibers: Array<Fiber.Fiber<unknown, unknown>> = []
      const look = askedLook(yield* beads.list())
      const resumed = yield* takeAnswers(
        {
          ...options,
          carry: (_, start) =>
            Effect.gen(function* () {
              if (!plan.slot) return false
              const fiber = yield* start
              if (fiber !== undefined) fibers.push(yield* Effect.forkChild(fiber))
              return true
            }),
        },
        look,
      )
      for (const fiber of fibers) yield* Fiber.interrupt(fiber)
      return {
        noSlot: [...look.noSlot],
        resumed,
        phase: (yield* ledger.current).tickets.get(id)?.phase._tag,
      } satisfies Looked
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Looked, unknown, Env | Scope.Scope>,
  )
}

describe("what a look tells of an answered question", () => {
  test("answered with no slot: its ticket stays Asked, and the look says so", async () => {
    const seen = resultOf(await looked({ answer: true, slot: false }))
    expect(seen.phase).toBe("Asked")
    expect(seen.resumed).toEqual([])
    expect(seen.noSlot).toHaveLength(1)
  })

  test("answered with a slot: its ticket comes back, and nothing is left waiting", async () => {
    const seen = resultOf(await looked({ answer: true, slot: true }))
    expect(seen.resumed).toEqual([id])
    expect(seen.noSlot).toEqual([])
  })

  test("still open: it isn't answered, whatever the slots", async () => {
    const seen = resultOf(await looked({ answer: false, slot: false }))
    expect(seen.phase).toBe("Asked")
    expect(seen.noSlot).toEqual([])
  })
})
