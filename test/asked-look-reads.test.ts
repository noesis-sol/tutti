// What a look reads of bd for its Asked tickets (tutti-gr4z.6, asked.ts's AskedLook): no bd show of
// a ticket whose question the look's open list has open; one show of a ticket shared by
// answerQuestions and takeAnswers, and again only after --auto-answer answered its question; a
// question open before the run shown once in the run, or not at all once carry-over's autoAnswerOf
// has judged it; one answered by hand resumes its ticket at the next look.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Duration, Effect, Exit, Fiber, Ref, type Scope } from "effect"
import { askedLook, takeAnswers } from "../src/run/asked.ts"
import {
  AutoAnswer,
  type AutoAnswering,
  answerQuestions,
  leavesPart,
  makeAutoAnswering,
} from "../src/run/autoAnswer.ts"
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

/** A question's metadata: three options, the second recommended. */
const withOptions = {
  options: [
    { label: "Postgres", description: "a server to run" },
    { label: "SQLite", description: "one file" },
    { label: "Files", description: "no queries" },
  ],
  recommended: 1,
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

/** What the looks saw: the IDs bd showed in each, and the tickets each resumed. */
interface Looked {
  readonly shows: ReadonlyArray<ReadonlyArray<string>>
  readonly resumed: ReadonlyArray<ReadonlyArray<string>>
}

/** A look's step, between two looks: the backlog changed as the maintainer would. */
type Between = (look: number, beads: Beads["Service"]) => Effect.Effect<void>

interface Plan {
  /** --auto-answer, as the run gives it: null without it. */
  readonly auto: (since: number) => Effect.Effect<AutoAnswering | null>
  /** How many looks. */
  readonly looks: number
  /** Whether the look reads bd's open list (run.ts does, bd answering). */
  readonly listed?: boolean
  readonly between?: Between
  /** The ticket's question metadata, filed by its worker. */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** A question open before the run, `q-1`, that the ticket was carried over Asked on. */
  readonly carried?: { readonly judged: boolean }
}

/**
 * The ticket Asked, by its worker filing a question during the run or carried over on one filed
 * before it; then `plan.looks` looks, each reading bd's open list (or not), answering questions and
 * taking answers as run.ts's fill does, the bd shows each made counted.
 */
const looks = (plan: Plan): Promise<Ran<Looked>> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-asked-look-")))
  const seeds =
    plan.carried === undefined
      ? backlog().ticket(id, { title: ticket.title }).seeds
      : backlog()
          .ticket("q-1", { labels: ["human"], title: "Which way?", metadata: withOptions })
          .ticket(id, { title: ticket.title, blockedBy: ["q-1"] }).seeds
  return scenario(
    {
      backlog: seeds,
      worktrees: { root },
      scripts: (world: World) => ({
        [id]: [
          filesQuestion(id, {
            claim: orDie(world.beads.update(id, { claim: true })),
            file: orDie(
              Effect.andThen(
                world.beads.create({
                  title: "Which store?",
                  labels: ["human"],
                  blocks: [id],
                  metadata: plan.metadata ?? withOptions,
                }),
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
      // The run begins a minute after the backlog was made.
      yield* advance("1 minute")
      const auto = yield* plan.auto(yield* Clock.currentTimeMillis)
      const options: WorkOptions = { base: "main", queue: yield* lineOnly }
      if (plan.carried === undefined) {
        yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
        yield* ledger.transition(id, Move.Dispatched())
        yield* work(ticket, options).pipe(Effect.provideService(AutoAnswer, auto))
      } else {
        yield* ledger.transition(id, Move.StillAsked({ question: "q-1" }), { title: ticket.title })
        if (plan.carried.judged) {
          yield* leavesPart("q-1" as TicketId).pipe(Effect.provideService(AutoAnswer, auto))
        }
      }
      const shown = yield* Ref.make<ReadonlyArray<string>>([])
      const counted = Beads.of({
        ...beads,
        show: (shownId, as) =>
          Effect.andThen(
            Ref.update(shown, (all) => [...all, shownId]),
            beads.show(shownId, as),
          ),
      })
      const shows: Array<ReadonlyArray<string>> = []
      const resumed: Array<ReadonlyArray<string>> = []
      for (let at = 0; at < plan.looks; at++) {
        if (at > 0) yield* plan.between?.(at, beads) ?? Effect.void
        yield* Ref.set(shown, [])
        const fibers: Array<Fiber.Fiber<unknown, unknown>> = []
        const look = askedLook(plan.listed === false ? undefined : yield* beads.list())
        const back = yield* Effect.andThen(
          answerQuestions(look),
          takeAnswers(
            {
              ...options,
              carry: (_, start) =>
                Effect.gen(function* () {
                  const fiber = yield* start
                  if (fiber !== undefined) fibers.push(yield* Effect.forkChild(fiber))
                  return true
                }),
            },
            look,
          ),
        ).pipe(Effect.provideService(Beads, counted), Effect.provideService(AutoAnswer, auto))
        resumed.push(back)
        shows.push(yield* Ref.get(shown))
        for (const fiber of fibers) yield* Fiber.interrupt(fiber)
      }
      return { shows, resumed } satisfies Looked
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Looked, unknown, Env | Scope.Scope>,
  )
}

/** --auto-answer at once, for a run that began at `since`. */
const atOnce = (since: number) => makeAutoAnswering(Duration.zero, since)

/** Without --auto-answer. */
const off = () => Effect.succeed(null)

/** The IDs shown in each look that are `shownId`. */
const showsOf = (looked: Looked, shownId: string) =>
  looked.shows.map((each) => each.filter((one) => one === shownId).length)

describe("a look's reads of an Asked ticket", () => {
  test("its question open in the look's list: no bd show at any look", async () => {
    const looked = resultOf(await looks({ auto: off, looks: 3 }))
    expect(looked.shows).toEqual([[], [], []])
    expect(looked.resumed).toEqual([[], [], []])
  })

  test("without the list: the ticket shown once a look, for both answerQuestions and takeAnswers", async () => {
    const looked = resultOf(
      await looks({
        auto: (since) => makeAutoAnswering(Duration.minutes(10), since),
        looks: 2,
        listed: false,
      }),
    )
    expect(showsOf(looked, id)).toEqual([1, 1])
    expect(looked.resumed).toEqual([[], []])
  })

  test("a question open before the run: shown once in the run", async () => {
    const looked = resultOf(await looks({ auto: atOnce, looks: 3, carried: { judged: false } }))
    expect(looked.shows).toEqual([["q-1"], [], []])
    expect(looked.resumed).toEqual([[], [], []])
  })

  test("a question open before the run, without the list: shown once, its ticket each look", async () => {
    const looked = resultOf(
      await looks({ auto: atOnce, looks: 3, carried: { judged: false }, listed: false }),
    )
    expect(showsOf(looked, "q-1")).toEqual([1, 0, 0])
    expect(showsOf(looked, id)).toEqual([1, 1, 1])
  })

  test("a carried ticket: autoAnswerOf's verdict on its question seeds the memory", async () => {
    const looked = resultOf(await looks({ auto: atOnce, looks: 2, carried: { judged: true } }))
    expect(looked.shows).toEqual([[], []])
  })

  test("a question left to you for another reason: shown at each look, its metadata may change", async () => {
    const looked = resultOf(
      await looks({ auto: atOnce, looks: 2, metadata: { ...withOptions, maintainer_only: true } }),
    )
    expect(looked.shows.map((each) => each.length)).toEqual([1, 1])
    expect(showsOf(looked, id)).toEqual([0, 0])
  })

  test("answered by --auto-answer: the ticket shown again and resumed at that look", async () => {
    const looked = resultOf(await looks({ auto: atOnce, looks: 1 }))
    // The question, to answer it; then the ticket, its question closed.
    expect(looked.shows).toEqual([[expect.stringMatching(/./), id]])
    expect(looked.shows[0]?.[0]).not.toBe(id)
    expect(looked.resumed).toEqual([[id]])
  })

  test("answered by hand: shown and resumed at the next look", async () => {
    const looked = resultOf(
      await looks({
        auto: off,
        looks: 3,
        between: (look, beads) =>
          look === 2
            ? Effect.gen(function* () {
                const issue = yield* Effect.orDie(beads.show(id))
                for (const link of issue.dependencies) {
                  if (link.issue?.labels.includes("human")) {
                    yield* Effect.orDie(beads.close(link.id, "Use Files"))
                  }
                }
              })
            : Effect.void,
      }),
    )
    expect(looked.shows).toEqual([[], [], [id]])
    expect(looked.resumed).toEqual([[], [], [id]])
  })
})
