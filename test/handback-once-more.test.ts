// A ticket left Blocked on its conflict, while the run goes on (§ 4.3): you hand it back once more,
// past its hand-backs if they are used up, its session resumed for it, or you rebase its branch by
// hand, which the run notices and merges. A worktree you are still working in is left as it is.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { makeHandBacks, maxHandBacks } from "../src/run/handback.ts"
import { rebasedByHand } from "../src/run/handRebased.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { handBackNow } from "../src/run/steer.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  init,
  result,
  run,
  type SessionScript,
  sessionState,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import {
  backlog,
  type Env,
  expectLog,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const check = "scripts/check-fast.sh"
const defaults = appConfig().settings
const a = "a" as TicketId

const settings = (resolve: boolean) => ({
  config: {
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
      merge: { ...defaults.merge, resolve_conflicts: resolve },
    },
  },
})

const worktrees = new Map<string, string>()
const worktreeOf = (id: string) => worktrees.get(id) ?? ""

const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

const resolving = (world: World, files: Files) =>
  run(Effect.suspend(() => Effect.asVoid(world.repository.continueRebase(worktreeOf("a"), files))))

/** A ticket, finished by its worker, with its worktree, closed, Working, its session idle. */
const finished = (id: TicketId = a, files: Files = { "a.txt": "a\n" }) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    worktrees.set(id, worktree.path)
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

const moveMain = (files: Files = { "a.txt": "main's a\n" }) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

const phaseOf = Effect.gen(function* () {
  return (yield* (yield* Ledger).current).tickets.get(a)?.phase as TicketPhase
})

/** Ticket a, blocked on its conflict with main; then `then`, the queue settled after it. */
const blocked = (
  setup: ReturnType<typeof settings>,
  scripts: (world: World) => Scripts,
  then: (
    queue: MergeQueue,
    ticket: FinishedTicket,
  ) => Effect.Effect<unknown, unknown, Env | Ledger>,
  before: Effect.Effect<void, unknown, Env | Ledger> = Effect.void,
): Promise<Ran<TicketPhase>> =>
  scenario(
    { backlog: backlog().ticket("a").ticket("b").seeds, ...setup, scripts },
    Effect.gen(function* () {
      const queue = yield* makeQueue(options)
      const ticket = yield* finished()
      yield* moveMain()
      yield* before
      yield* queue.offer(ticket)
      yield* queue.settled
      expect(yield* phaseOf).toEqual(
        expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
      )
      expect((yield* queue.handBacks.setAside).map((each) => each.ticket.id)).toEqual([a])
      yield* then(queue, ticket)
      yield* queue.settled
      return yield* phaseOf
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<TicketPhase, unknown, Env | Scope.Scope>,
  )

const phaseIn = (ran: Ran<TicketPhase>): TicketPhase => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const attempts = (ran: Ran<unknown>) =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.to === "Resolving" ? [record.attempt] : [],
  )

const sessionClosed = Effect.gen(function* () {
  const host = yield* AgentHost
  yield* host.state(a).pipe(
    Stream.filter((state) => state._tag === "Closed"),
    Stream.runHead,
  )
})

/** You rebase its branch by hand, resolving its conflict, as far as `finish` says. */
const rebaseByHand = (finish: boolean) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    yield* Effect.exit(git.rebase(worktreeOf("a"), "main"))
    if (finish) yield* repository.continueRebase(worktreeOf("a"), { "a.txt": "by hand\n" })
  })

describe("handed back once more", () => {
  test("its hand-backs used up, its worker has one more and resolves it, resumed", async () => {
    const again = (world: World, files: Files, then: Files) =>
      turn([
        resolving(world, files),
        run(Effect.asVoid(world.repository.commit(world.repository.dir, "Land more", then))),
      ])
    const ran = await blocked(
      settings(true),
      (world) => ({
        a: [
          finishedSession([
            ...again(world, { "a.txt": "both\n" }, { "a.txt": "main again\n" }),
            ...again(world, { "a.txt": "all\n" }, { "a.txt": "main once more\n" }),
          ]),
          turn([resolving(world, { "a.txt": "at last\n" })]),
        ],
      }),
      (queue) =>
        // Its session closed as it was blocked, which the queue settling doesn't wait for.
        Effect.andThen(sessionClosed, handBackNow(a, queue, options)),
    )
    expect(phaseIn(ran)).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(attempts(ran)).toEqual([1, 2, 3])
    expect(ran.sent.filter((item) => item._tag === "Resumed")).toHaveLength(1)
    expectLog(ran, [
      /you handed a back; tutti\/a is back in the merge queue, to be rebased onto main if need be/,
    ])
  })

  test("a resolution left undone is set aside too: handed back, its worker resolves it", async () => {
    const ran = await blocked(
      settings(true),
      (world) => ({
        a: [finishedSession(turn([])), turn([resolving(world, { "a.txt": "both\n" })])],
      }),
      (queue) => Effect.andThen(sessionClosed, handBackNow(a, queue, options)),
    )
    expect(phaseIn(ran)).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(attempts(ran)).toEqual([1, 2])
  })

  test("its worker steered in its last hand-back, it is handed it all the same", async () => {
    const again = (world: World, files: Files, then: Files) =>
      turn([
        resolving(world, files),
        run(Effect.asVoid(world.repository.commit(world.repository.dir, "Land more", then))),
      ])
    const ran = await blocked(
      settings(true),
      (world) => ({
        a: [
          finishedSession([
            ...again(world, { "a.txt": "both\n" }, { "a.txt": "main again\n" }),
            ...again(world, { "a.txt": "all\n" }, { "a.txt": "main once more\n" }),
          ]),
          turn([resolving(world, { "a.txt": "at last\n" })]),
        ],
      }),
      (queue) =>
        Effect.gen(function* () {
          yield* sessionClosed
          yield* (yield* Ledger).steer(a, "message")
          yield* handBackNow(a, queue, options)
        }),
    )
    expect(phaseIn(ran)).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(attempts(ran)).toEqual([1, 2, 3])
  })

  test("a branch you rebased meanwhile just merges, with nothing sent to its worker", async () => {
    const ran = await blocked(
      settings(false),
      () => ({ a: [finishedSession()] }),
      (queue) => Effect.andThen(rebaseByHand(true), handBackNow(a, queue, options)),
    )
    expect(phaseIn(ran)).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(attempts(ran)).toEqual([])
  })

  test("a worktree mid-rebase stays blocked, and the line says why", async () => {
    const ran = await blocked(
      settings(false),
      () => ({ a: [finishedSession()] }),
      (queue) =>
        Effect.gen(function* () {
          yield* rebaseByHand(false)
          expect(yield* handBackNow(a, queue, options)).toBe(false)
          expect((yield* queue.handBacks.setAside).map((each) => each.ticket.id)).toEqual([a])
        }),
    )
    expect(phaseIn(ran)).toEqual(expect.objectContaining({ _tag: "Blocked" }))
    expectLog(ran, [
      /a stays blocked though you handed it back: its worktree .* a rebase in progress/,
    ])
  })

  test("a ticket with no conflict set aside stays as it is", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, ...settings(true), scripts: () => ({}) },
      Effect.gen(function* () {
        const queue = yield* makeQueue(options)
        return yield* handBackNow(a, queue, options)
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<boolean, unknown, Env | Scope.Scope>,
    )
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toBe(false)
  })
})

describe("a branch rebased by hand while the run goes on", () => {
  test("is noticed as the run looks, and merges", async () => {
    const ran = await blocked(
      settings(false),
      () => ({ a: [finishedSession()] }),
      (queue) => Effect.andThen(rebaseByHand(true), queue.recheck),
    )
    expect(phaseIn(ran)).toEqual(expect.objectContaining({ _tag: "Done" }))
    expectLog(ran, [/tutti\/a was rebased by hand: a is back in the merge queue/])
  })

  test("isn't taken up as the run quits", async () => {
    const ran = await blocked(
      settings(false),
      () => ({ a: [finishedSession()] }),
      (queue) =>
        Effect.gen(function* () {
          yield* rebaseByHand(true)
          yield* queue.hold
          yield* queue.recheck
        }),
    )
    expect(phaseIn(ran)._tag).toBe("Blocked")
  })

  test("isn't taken up once the merges have stopped", async () => {
    const ran = await blocked(
      settings(false),
      () => ({ a: [finishedSession()], b: [finishedSession()] }),
      (queue) =>
        Effect.gen(function* () {
          const repository = yield* Repository
          const other = yield* finished("b" as TicketId, { "b.txt": "b\n" })
          yield* repository.write(repository.dir, { "a.txt": "changes the run didn't make\n" })
          yield* queue.offer(other)
          yield* queue.settled
          expect((yield* queue.state).stop).not.toBeNull()
          yield* rebaseByHand(true)
          yield* queue.recheck
        }),
    )
    expect(phaseIn(ran)._tag).toBe("Blocked")
  })

  test("isn't taken up mid-rebase, nor for a commit with no rebase", async () => {
    const ran = await blocked(
      settings(false),
      () => ({ a: [finishedSession()] }),
      (queue) =>
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* repository.commit(worktreeOf("a"), "One more (a)", { "b.txt": "b\n" })
          yield* queue.recheck
          expect((yield* phaseOf)._tag).toBe("Blocked")
          yield* rebaseByHand(false)
          yield* queue.recheck
          expect((yield* phaseOf)._tag).toBe("Blocked")
        }),
    )
    expect(phaseIn(ran)._tag).toBe("Blocked")
  })
})

describe("a worktree with uncommitted changes to tracked files", () => {
  test("is left alone by the look and by `h`, and merges once it is clean", async () => {
    const ran = await blocked(
      settings(false),
      () => ({ a: [finishedSession()] }),
      (queue) =>
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* rebaseByHand(true)
          yield* repository.write(worktreeOf("a"), { "a.txt": "not done yet\n" })
          yield* queue.recheck
          expect((yield* phaseOf)._tag).toBe("Blocked")
          expect(yield* handBackNow(a, queue, options)).toBe(false)
          expect((yield* phaseOf)._tag).toBe("Blocked")
          yield* repository.write(worktreeOf("a"), { "a.txt": "by hand\n" })
          yield* queue.recheck
        }),
    )
    expect(phaseIn(ran)).toEqual(expect.objectContaining({ _tag: "Done" }))
    expectLog(ran, [
      /a stays blocked though you handed it back: its worktree .* uncommitted changes/,
    ])
  })
})

describe("the look and `h` at once", () => {
  test("a ticket `h` took up as the look read git isn't put back twice", async () => {
    const ran = await blocked(
      settings(false),
      () => ({ a: [finishedSession()] }),
      (queue) =>
        Effect.gen(function* () {
          yield* rebaseByHand(true)
          const taken = { ...queue.handBacks, takeAside: () => Effect.succeed(undefined) }
          const back = yield* rebasedByHand({ offer: queue.offer, handBacks: taken }, options)
          expect(back).toEqual([])
        }),
    )
    expect(phaseIn(ran)._tag).toBe("Blocked")
  })
})

describe("a hand-back waiting for its steered worker", () => {
  test("isn't set aside: it has its own way back", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").seeds,
        ...settings(true),
        scripts: () => ({ a: [finishedSession()] }),
      },
      Effect.gen(function* () {
        const queue = yield* makeQueue(options)
        const ticket = yield* finished()
        yield* moveMain()
        yield* (yield* Ledger).steer(a, "message")
        yield* queue.offer(ticket)
        yield* queue.settled
        expect((yield* queue.handBacks.waiting).map((stop) => stop.ticket.id)).toEqual([a])
        expect(yield* queue.handBacks.setAside).toEqual([])
        return yield* phaseOf
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
        TicketPhase,
        unknown,
        Env | Scope.Scope
      >,
    )
    expect(phaseIn(ran)._tag).toBe("Blocked")
  })
})

describe("a run's hand-backs", () => {
  test("allow one more than the ticket has had, each time you ask", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handBacks = yield* makeHandBacks
        expect(yield* handBacks.limit(a)).toBe(maxHandBacks)
        yield* handBacks.allowOneMore(a)
        expect(yield* handBacks.limit(a)).toBe(maxHandBacks)
        yield* handBacks.next(a)
        yield* handBacks.next(a)
        yield* handBacks.allowOneMore(a)
        yield* handBacks.allowOneMore(a)
        expect(yield* handBacks.limit(a)).toBe(maxHandBacks + 1)
        yield* handBacks.next(a)
        yield* handBacks.allowOneMore(a)
        expect(yield* handBacks.limit(a)).toBe(maxHandBacks + 2)
      }),
    )
  })
})
