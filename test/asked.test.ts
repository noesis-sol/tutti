import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, type Scope } from "effect"
import { answeredText, takeAnswers } from "../src/run/asked.ts"
import type { EventRecord } from "../src/run/events.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Cause, type TicketPhase } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store, type TicketRecord } from "../src/services/Store.ts"
import {
  claimsAndCloses,
  failStart,
  filesQuestion,
  type SessionScript,
} from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectLog,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1"
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }
const tiny = backlog().ticket(id, { title: "One ticket" })

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const records = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

/** The tags of what the ticket's worker was sent, in order: Started, Message, Closed, … */
const sentTags = (ran: Ran<unknown>) =>
  ran.sent.filter((sent) => sent.ticket === id).map((sent) => sent._tag)

/** The messages the ticket's worker was sent, as text. */
const sentTexts = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id ? [String(sent.message.message.content)] : [],
  )

/** The sessions the ticket's worker was started and resumed with, in order. */
const sessions = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Started" || sent._tag === "Resumed" ? [sent.session] : [],
  )

/** A folder for the worktrees, so a test knows where its ticket's is before it starts. */
const worktreesRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-asked-")))

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  let places = 0
  return {
    offer: (finished, cause = (place) => Cause.Verified({ place })) =>
      ledger.transition(finished.id, cause(++places)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    checksAhead: undefined as never,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/** The worker's sessions, from what its commands do to the in-memory Beads and git. */
type Sessions = (world: World, root: string) => ReadonlyArray<SessionScript>

/** Claims the ticket, files questions titled `titles` blocking it, and puts it back to open. */
const asks = (world: World, ...titles: ReadonlyArray<string>): SessionScript =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        Effect.forEach(titles, (title) =>
          world.beads.create({ title, labels: ["human"], blocks: [id] }),
        ),
        world.beads.update(id, { status: "open" }),
      ),
    ),
  })

/** Claims the ticket and files a question titled `title` blocking it, leaving it in progress. */
const asksInProgress = (world: World, title: string): SessionScript =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(world.beads.create({ title, labels: ["human"], blocks: [id] })),
  })

/** Claims the ticket again, commits a change naming it and closes it. */
const finishes = (world: World, root: string): SessionScript =>
  claimsAndCloses(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    commit: orDie(world.repository.commit(join(root, id), `Change (${id})`, { "a.txt": "a\n" })),
    close: orDie(world.beads.close(id, "done")),
  })

/** What the scenario saw: the fiber's end as Asked, each poll's resumed tickets, their fibers'. */
interface Seen {
  readonly asked: Worked
  readonly polls: ReadonlyArray<ReadonlyArray<string>>
  readonly carried: ReadonlyArray<Worked>
  readonly phase: TicketPhase | undefined
  /** The ticket's record in state.json as the scenario ends. */
  readonly saved: TicketRecord | undefined
}

/** The ticket's questions that aren't closed, by title. */
const openQuestions = Effect.gen(function* () {
  const issue = yield* (yield* Beads).show(id)
  return issue.dependencies.flatMap((dependency) =>
    dependency.issue !== undefined &&
    dependency.issue.status !== "closed" &&
    dependency.issue.labels.includes("human")
      ? [dependency.issue]
      : [],
  )
})

/**
 * Dispatches the ticket and runs its fiber until it ends; then, on each of `answers`, a ready poll
 * later, closes the open questions with those titles and polls for answers, the resumed workers'
 * fibers carried on and joined.
 */
const asked = (
  scripts: Sessions,
  answers: ReadonlyArray<ReadonlyArray<string>>,
): Promise<Ran<Seen>> => {
  const root = worktreesRoot()
  return scenario(
    {
      backlog: tiny.seeds,
      scripts: (world) => ({ [id]: scripts(world, root) }),
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
      yield* ledger.transition(id, Cause.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Cause.Dispatched())
      const queue = yield* lineOnly
      const options = { base: "main", queue }
      const first = yield* work(ticket, options)
      const polls: Array<ReadonlyArray<string>> = []
      const carried: Array<Worked> = []
      for (const titles of answers) {
        yield* advance(readyPoll)
        for (const question of yield* openQuestions) {
          if (titles.includes(question.title)) yield* beads.close(question.id, "answered")
        }
        const fibers: Array<Fiber.Fiber<Worked, unknown>> = []
        polls.push(
          yield* takeAnswers({
            ...options,
            carry: (_, fiber) =>
              Effect.map(Effect.forkChild(fiber), (running) => {
                fibers.push(running)
              }),
          }),
        )
        for (const fiber of fibers) carried.push(yield* Fiber.join(fiber))
      }
      const phase = (yield* ledger.current).tickets.get(id)?.phase
      const saved = yield* (yield* Store).ticket(id)
      return { asked: first, polls, carried, phase, saved } satisfies Seen
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Seen, unknown, Env | Scope.Scope>,
  )
}

/** The question the ticket was Asked on, as its fiber left it. */
const questionOf = (seen: Seen): string => {
  const phase = seen.asked.phase
  if (phase?._tag !== "Asked") throw new Error(`not Asked: ${phase?._tag}`)
  return phase.question
}

describe("a worker that filed a question ticket", () => {
  test("moves its ticket to Asked, its session closed, its fiber over", async () => {
    const ran = await asked((world) => [asks(world, "Which way?")], [[]])
    const seen = resultOf(ran)
    expect(seen.asked.phase).toEqual(expect.objectContaining({ _tag: "Asked" }))
    expect(seen.asked.stop).toBeNull()
    const question = questionOf(seen)
    // Its turn ended, then its session was closed; nothing resumes it while the question is open.
    expect(sentTags(ran)).toEqual(["Started", "Message", "Closed"])
    expect(seen.polls).toEqual([[]])
    expect(seen.phase?._tag).toBe("Asked")
    expect(records(ran, "asked")).toEqual([
      expect.objectContaining({ ticket: id, detail: `${question}: Which way?` }),
    ])
    expect(records(ran, "answered")).toEqual([])
    expectLog(ran, [
      new RegExp(
        `^ {2}ASKED: t-1 waits on your answer to ${question} \\(Which way\\?\\); answer with: bd human respond ${question}; worktree .*t-1 left open$`,
      ),
    ])
  })

  test("answered later in the run: resumed, told so, and finished", async () => {
    const ran = await asked(
      (world, root) => [asks(world, "Which way?"), finishes(world, root)],
      [[], ["Which way?"]],
    )
    const seen = resultOf(ran)
    const question = questionOf(seen)
    // The first poll found it unanswered; the next one, after the answer, resumed it.
    expect(seen.polls).toEqual([[], [id]])
    expect(seen.carried).toEqual([
      { phase: expect.objectContaining({ _tag: "ToMerge" }), stop: null },
    ])
    expect(seen.phase?._tag).toBe("ToMerge")
    // The same session, by its saved ID, in the same worktree.
    const [started, resumed] = sessions(ran)
    expect(resumed).toEqual(started)
    expect(sentTags(ran)).toEqual(["Started", "Message", "Closed", "Resumed", "Message"])
    expect(sentTexts(ran).at(-1)).toBe(answeredText(id, question, "Which way?"))
    expectEvents(ran, ["asked", "phase", "answered", "resumed", "phase"])
    const moved = records(ran, "phase").filter(
      (record) => record.kind === "phase" && record.cause === "Answered",
    )
    expect(moved).toEqual([expect.objectContaining({ ticket: id, from: "Asked", to: "Working" })])
    expect(records(ran, "answered")).toEqual([
      expect.objectContaining({
        ticket: id,
        title: "One ticket",
        detail: `${question}: Which way?`,
      }),
    ])
    expect(records(ran, "resumed")).toEqual([
      expect.objectContaining({ ticket: id, why: "answered", session: started?.sessionId }),
    ])
    expectLog(ran, [
      /ASKED: t-1 waits on your answer/,
      `  ANSWERED: ${question} (Which way?) is answered, so t-1 comes back`,
      new RegExp(
        `^ {2}RESUMED: t-1's question ${question} is answered; resuming its session \\S+ \\(worktree .*t-1\\)$`,
      ),
    ])
  })

  test("stays Asked while another question still blocks it", async () => {
    const ran = await asked(
      (world, root) => [asks(world, "Which way?", "Which name?"), finishes(world, root)],
      [["Which way?"], ["Which name?"]],
    )
    const seen = resultOf(ran)
    expect(seen.polls).toEqual([[], [id]])
    expect(seen.phase?._tag).toBe("ToMerge")
    expect(sentTags(ran)).toEqual(["Started", "Message", "Closed", "Resumed", "Message"])
  })

  test("asking again once resumed: Asked again, its session closed again", async () => {
    const ran = await asked(
      (world) => [asks(world, "Which way?"), asks(world, "And then?")],
      [["Which way?"], []],
    )
    const seen = resultOf(ran)
    expect(seen.polls).toEqual([[id], []])
    expect(seen.carried).toEqual([
      { phase: expect.objectContaining({ _tag: "Asked" }), stop: null },
    ])
    expect(seen.phase?._tag).toBe("Asked")
    expect(seen.phase?._tag === "Asked" && seen.phase.question).not.toBe(questionOf(seen))
    expect(sentTags(ran)).toEqual(["Started", "Message", "Closed", "Resumed", "Message", "Closed"])
    expect(records(ran, "asked")).toHaveLength(2)
  })

  test("left in progress, whose session can't be resumed: WORKER_GONE says to reopen it", async () => {
    const ran = await asked(
      (world) => [
        asksInProgress(world, "Which way?"),
        [failStart("No conversation found with session ID")],
      ],
      [["Which way?"]],
    )
    const seen = resultOf(ran)
    expect(seen.polls).toEqual([[]])
    expect(seen.phase).toEqual(expect.objectContaining({ _tag: "Review", why: "WORKER_GONE" }))
    expectLog(ran, [
      /^ {2}WORKER_GONE: t-1's question \S+ is answered, but its session could not be resumed \(No conversation found with session ID\); worktree .*t-1 left for review, no longer followed; reopen it to run it again \(bd update t-1 --status open\), or finish it by hand$/,
    ])
    // Its record forgotten and the ticket outside bd ready, no later run takes it up by itself.
    expect(seen.saved).toBeUndefined()
    const issue = ran.issues.find((each) => each.id === id)
    expect(issue?.status).toBe("in_progress")
    expect(issue?.notes).toContain("reopen it to run it again")
  })

  test("whose session can't be resumed: WORKER_GONE, dropped, its record forgotten", async () => {
    const ran = await asked(
      (world) => [asks(world, "Which way?"), [failStart("No conversation found with session ID")]],
      [["Which way?"]],
    )
    const seen = resultOf(ran)
    expect(seen.polls).toEqual([[]])
    expect(seen.carried).toEqual([])
    expect(seen.phase).toEqual(expect.objectContaining({ _tag: "Review", why: "WORKER_GONE" }))
    expect(records(ran, "resumed")).toEqual([])
    expectEvents(ran, ["asked", "phase", "answered", "phase", "warn"])
    expectLog(ran, [
      /^ {2}WORKER_GONE: t-1's question \S+ is answered, but its session could not be resumed \(No conversation found with session ID\); worktree .*t-1 left for review, no longer followed; it is in bd ready, so a later run takes it up again, or finish it by hand$/,
    ])
    expect(seen.saved).toBeUndefined()
    expect(ran.issues.find((each) => each.id === id)?.status).toBe("open")
    expect(ran.log.join("\n")).not.toContain("PHASE_BUG")
  })
})
