// The merge queue's writes to its state (tutti-125): a change made while another waits on the
// ledger (an offer, a turn) is kept when that other one writes, as each applies to the state as it
// is then.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger, make as makeLedger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue, type QueueState } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  init,
  result,
  type SessionScript,
  sessionState,
  sleep,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { advance, backlog, type Env, type Ran, type Setup, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** The default settings with a check command, which a hand-back needs to check a resolution. */
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: {
        ...defaults.checks,
        fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
      },
    },
  },
} satisfies Setup

/** A transition held until the test opens it: `entered` once the queue's call reaches it. */
interface Gate {
  readonly ticket: string
  readonly cause: Move["_tag"]
  readonly entered: Deferred.Deferred<void>
  readonly open: Deferred.Deferred<void>
}

const gate = (ticket: string, cause: Move["_tag"]) =>
  Effect.all({ entered: Deferred.make<void>(), open: Deferred.make<void>() }).pipe(
    Effect.map((deferreds): Gate => ({ ticket, cause, ...deferreds })),
  )

/** The ledger, its transitions of `gates` held until each is opened. */
const gatedLedger = (gates: ReadonlyArray<Gate>) =>
  Layer.effect(
    Ledger,
    Effect.map(makeLedger, (ledger) => ({
      ...ledger,
      transition: (
        ticket: TicketId,
        cause: Move,
        more?: Parameters<typeof ledger.transition>[2],
      ) => {
        const held = gates.find((each) => each.ticket === ticket && each.cause === cause._tag)
        const moved = ledger.transition(ticket, cause, more)
        return held === undefined
          ? moved
          : Effect.andThen(
              Deferred.succeed(held.entered, undefined),
              Effect.andThen(Deferred.await(held.open), moved),
            )
      },
    })),
  )

/** What a scenario hands back: each ticket's phase, and the queue's state as it settled. */
interface Kept {
  readonly phases: Readonly<Record<string, TicketPhase>>
  /** The queue's state once the held write was done, before it settled. */
  readonly written: QueueState
  readonly settled: QueueState
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (ran.exit._tag === "Failure") throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phasesOf = (state: State): Record<string, TicketPhase> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

const untilPhase = (id: TicketId, tag: TicketPhase["_tag"]) =>
  Effect.gen(function* () {
    yield* (yield* Ledger).changes.pipe(
      Stream.filter((state) => state.tickets.get(id)?.phase._tag === tag),
      Stream.runHead,
    )
  })

const untilQueue = (queue: MergeQueue, ready: (state: QueueState) => boolean) =>
  queue.changes.pipe(Stream.filter(ready), Stream.runHead)

/** The worker's first session: it finished its ticket, idle, then plays `then`. */
const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads,
 * Working in the ledger, its session started and its worker idle.
 */
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
    const sessionId = `session-${id}`
    yield* (yield* Store).saveSession(id, {
      session: sessionId,
      worktree: worktree.path,
      branch: worktree.branch,
    })
    yield* (yield* AgentHost).start(id, { sessionId, cwd: worktree.path })
    yield* untilSettled(id)
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/**
 * Runs `body` with a merge queue over a ledger whose `gates` are held, and hands back each ticket's
 * phase, the state `body` saw written, and the state the queue settled in.
 */
const withQueue = (
  gates: ReadonlyArray<Effect.Effect<Gate>>,
  body: (
    queue: MergeQueue,
    gates: ReadonlyArray<Gate>,
  ) => Effect.Effect<QueueState, unknown, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const held = yield* Effect.all(gates)
    return yield* Effect.gen(function* () {
      const queue = yield* makeQueue(options)
      const written = yield* body(queue, held)
      const settled = yield* queue.settled
      return {
        phases: phasesOf(yield* (yield* Ledger).current),
        written,
        settled,
      } satisfies Kept
    }).pipe(Effect.provide(gatedLedger(held)))
  })

/**
 * Ticket a's conflicts handed back to its worker, which answers a minute later without resolving
 * them, and ticket b, on top of main, offered while a's hand-back is under way: `cause`, b's offer
 * (Verified) or its turn (ItsTurn), is held while a's hand-back ends, and its write then keeps it
 * over.
 */
const handBackEnds = (cause: "Verified" | "ItsTurn") =>
  scenario(
    {
      backlog: backlog().ticket("a").ticket("b").seeds,
      ...withCheck,
      scripts: {
        a: [finishedSession(turn([sleep("1 minute")]))],
        b: [finishedSession()],
      },
    },
    withQueue([gate("b", cause)], (queue, [held]) =>
      Effect.gen(function* () {
        if (held === undefined) return yield* Effect.die("no gate")
        const a = yield* finished("a" as TicketId, { "a.txt": "a\n" })
        yield* (yield* Repository).commit("/repo", "Land something else", { "a.txt": "main's a\n" })
        const b = yield* finished("b" as TicketId, { "b.txt": "b\n" })
        yield* queue.offer(a)
        yield* untilQueue(queue, (state) => state.resolving.includes("a" as TicketId))
        const offered = yield* Effect.forkChild(queue.offer(b))
        yield* Deferred.await(held.entered)
        yield* advance("1 minute")
        yield* untilPhase("a" as TicketId, "Blocked")
        yield* untilQueue(queue, (state) => state.resolving.length === 0)
        yield* Deferred.succeed(held.open, undefined)
        yield* Fiber.join(offered)
        // b merges after the held write, whether or not the write undid a's end.
        yield* untilPhase("b" as TicketId, "Done")
        yield* untilQueue(queue, (state) => state.merging === null)
        return yield* queue.state
      }),
    ),
  )

describe("a hand-back's end, while a write waits on the ledger", () => {
  for (const [cause, what] of [
    ["Verified", "an offer"],
    ["ItsTurn", "a turn"],
  ] as const) {
    test(`is kept by ${what}'s write: the queue settles`, async () => {
      const kept = resultOf(await handBackEnds(cause))
      expect(kept.written.resolving).toEqual([])
      expect(kept.settled.resolving).toEqual([])
      expect(kept.phases.a).toEqual(
        expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
      )
      expect(kept.phases.b).toEqual(expect.objectContaining({ _tag: "Done" }))
    })
  }
})

describe("the merges stopping, while an offer waits on the ledger", () => {
  test("is kept by the offer's write: the queue settles stopped, the ticket offered waiting", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        scripts: { a: [finishedSession()], b: [finishedSession()] },
      },
      withQueue([gate("a", "Block"), gate("b", "Verified")], (queue, [blocked, verified]) =>
        Effect.gen(function* () {
          if (blocked === undefined || verified === undefined) return yield* Effect.die("no gate")
          const a = yield* finished("a" as TicketId, { "a.txt": "a\n" })
          const b = yield* finished("b" as TicketId, { "b.txt": "b\n" })
          yield* (yield* Repository).write("/repo", { "README.md": "edited by hand\n" })
          yield* queue.offer(a)
          // a's merge stops on the dirty tree; b's offer reads the state before it is over.
          yield* Deferred.await(blocked.entered)
          const offered = yield* Effect.forkChild(queue.offer(b))
          yield* Deferred.await(verified.entered)
          yield* Deferred.succeed(blocked.open, undefined)
          yield* untilQueue(queue, (state) => state.stop !== null)
          yield* Deferred.succeed(verified.open, undefined)
          yield* Fiber.join(offered)
          return yield* queue.state
        }),
      ),
    )
    const kept = resultOf(ran)
    expect(kept.written).toMatchObject({ waiting: ["b"], merging: null, resolving: [] })
    expect(kept.written.stop).toMatchObject({ why: "DIRTY_TREE", ticket: "a" })
    expect(kept.settled.stop).toMatchObject({ why: "DIRTY_TREE", ticket: "a" })
    expect(kept.phases.a).toEqual(expect.objectContaining({ _tag: "Blocked", why: "DIRTY_TREE" }))
    // Nothing merges after a stop: b waits where it was.
    expect(kept.phases.b).toEqual(expect.objectContaining({ _tag: "ToMerge", place: 1 }))
  })
})
