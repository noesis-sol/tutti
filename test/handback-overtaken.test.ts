// A conflict with what merged since a ticket's last hand-back (handback.ts): the merge queue's race,
// not its worker's failure, as fab-mgi.7.9's in Fabrica's run of 2026-11-04. It counts toward no
// attempt, only toward the most a ticket is handed back in a run.
import { describe, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Exit, Fiber, Result, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { makeHandBacks, maxHandBacks, mostHandBacks, toHandBack } from "../src/run/handback.ts"
import { Ledger } from "../src/run/ledger.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { Move, type PhaseTag, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git, type Sha } from "../src/services/Git.ts"
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
import { type CheckRun, passed } from "../src/testing/Checks.ts"
import type { Files } from "../src/testing/Git.ts"
import { Repository } from "../src/testing/Git.ts"
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
}

const worktrees = new Map<string, string>()
const worktreeOf = (id: string) => worktrees.get(id) ?? ""

const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

const finished = (id: TicketId, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const host = yield* AgentHost
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
    yield* host.start(id, { sessionId, cwd: worktree.path })
    yield* untilSettled(id)
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

const moveMain = Effect.gen(function* () {
  const repository = yield* Repository
  yield* repository.commit(repository.dir, "Land something else", { "a.txt": "main's a\n" })
})

const withQueue = <E>(
  body: (queue: MergeQueue) => Effect.Effect<void, E, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    yield* body(yield* makeQueue(options))
    const { tickets } = yield* (yield* Ledger).current
    return Object.fromEntries([...tickets.values()].map((entry) => [entry.ticket, entry.phase]))
  }).pipe(Effect.provide(Ledger.layer))

/** Waits until the ticket is in `tag`. */
const until = (id: TicketId, tag: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) => state.tickets.get(id)?.phase._tag === tag),
      Stream.runHead,
    )
  })

/** The worker resolves a's conflict, writing `n` into a.txt, then `meanwhile` runs. */
const resolves = (world: World, n: number, meanwhile: SessionScript = []) =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(world.repository.continueRebase(worktreeOf("a"), { "a.txt": `${n}\n` })),
      ),
    ),
    ...meanwhile,
  ])

/** Another ticket lands during the resolve, changing the file that conflicted, or `path`. */
const lands = (world: World, n: number, path = "a.txt") =>
  run(
    Effect.asVoid(
      world.repository.commit(world.repository.dir, `Land ${n}`, { [path]: `main ${n}\n` }),
    ),
  )

/** Ticket a, finished and conflicting with main, through the queue, its worker playing `then`. */
const conflicted = (then: (world: World) => SessionScript) =>
  scenario(
    {
      backlog: backlog().ticket("a").seeds,
      ...withCheck,
      scripts: (world): Scripts => ({ a: [finishedSession(then(world))] }),
    },
    withQueue((queue) =>
      Effect.gen(function* () {
        const ticket = yield* finished("a" as TicketId, { "a.txt": "a\n" })
        yield* moveMain
        yield* queue.offer(ticket)
        yield* queue.settled
      }),
    ),
  )

const phases = (ran: Ran<Record<string, TicketPhase>>): Record<string, TicketPhase> => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const attempts = (ran: Ran<unknown>) =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === "a" && record.to === "Resolving"
      ? [record.attempt]
      : [],
  )

const counted =
  "  RESOLVING: tutti/a conflicts with main in a.txt; handed back to its worker to resolve (up to 20m)"
const overtaken = `${counted}; not counted as an attempt: what merged since its last hand-back made this conflict`

const logged = (ran: Ran<unknown>, wanted: string) =>
  ran.log.filter((each) => each === wanted).length

describe("a conflict with what merged since the last hand-back", () => {
  test("a merge during each resolve uses up no hand-back: the ticket merges", async () => {
    const ran = await conflicted((world) => [
      ...resolves(world, 1, [lands(world, 1)]),
      ...resolves(world, 2, [lands(world, 2)]),
      ...resolves(world, 3),
    ])
    expect(phases(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(attempts(ran)).toEqual([1, 2, 3])
    expectLog(ran, [counted, overtaken, overtaken])
    expect(logged(ran, overtaken)).toBe(2)
  })

  test("a merge while it waits in line after its resolve uses up none either", async () => {
    const aWaits = Deferred.makeUnsafe<void>()
    const check = (each: CheckRun) =>
      Effect.as(each.cwd === worktreeOf("b") ? Deferred.await(aWaits) : Effect.void, passed("fast"))
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        // As fab-mgi.8.2 did, b merges for not waiting for a's resolve (conflictWait.ts).
        config: {
          settings: {
            ...withCheck.config.settings,
            merge: { ...defaults.merge, conflict_wait: Duration.zero },
          },
        },
        checks: { fast: [check, check, check] },
        scripts: (world): Scripts => ({
          a: [finishedSession([...resolves(world, 1), ...resolves(world, 2)])],
          b: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a" as TicketId, { "a.txt": "a\n" })
          yield* moveMain
          // On top of main, b merges with no rebase, changing the file a conflicted in; its check
          // lasts until a is back in line behind it.
          const b = yield* finished("b" as TicketId, { "a.txt": "b's a\n" })
          const during = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* until("a" as TicketId, "Resolving")
              yield* until("a" as TicketId, "ToMerge")
              yield* Deferred.succeed(aWaits, undefined)
            }),
          )
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
          yield* Fiber.join(during)
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(after.b).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(attempts(ran)).toEqual([1, 2])
    expectLog(ran, [counted, overtaken])
  })

  test("the hand-backs a run gives a ticket are bounded all the same", async () => {
    const ran = await conflicted((world) =>
      Array.from({ length: mostHandBacks }, (_, i) => resolves(world, i, [lands(world, i)])).flat(),
    )
    expect(phases(ran).a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(attempts(ran)).toEqual(Array.from({ length: mostHandBacks }, (_, i) => i + 1))
    expectLog(ran, [
      counted,
      overtaken,
      new RegExp(
        `^ {2}MERGE_CONFLICT: .*\\(not handed back to its worker: it was handed back to its worker ${mostHandBacks} times already, the most a run gives a ticket\\)`,
      ),
    ])
  })
})

describe("a conflict with anything else counts", () => {
  test("in a file what merged left alone: Blocked after the attempts", async () => {
    const elsewhere = (world: World, n: number) =>
      resolves(world, n, [
        lands(world, n, "z.txt"),
        run(world.repository.conflict("tutti/a", ["a.txt"])),
      ])
    const ran = await conflicted((world) => [...elsewhere(world, 1), ...elsewhere(world, 2)])
    expect(phases(ran).a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(attempts(ran)).toEqual(Array.from({ length: maxHandBacks }, (_, i) => i + 1))
    expect(logged(ran, overtaken)).toBe(0)
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: .*\(not handed back to its worker: it was handed back to its worker 2 times already\)/,
    ])
  })

  test("when git can't say what merged: not handed back past the attempts", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").seeds,
        ...withCheck,
        scripts: () => ({ a: [finishedSession()] }),
      },
      withQueue(() =>
        Effect.gen(function* () {
          const ticket = yield* finished("a" as TicketId, { "a.txt": "a\n" })
          const onto = yield* (yield* Repository).head("main")
          const stop = { ticket, onto, fork: onto, head: onto, own: 1, files: ["a.txt"] }
          const handBacks = yield* makeHandBacks
          yield* handBacks.next(ticket.id)
          yield* handBacks.next(ticket.id)
          // A commit git doesn't know: it can't say what merged since.
          yield* handBacks.handed({ ...stop, onto: "0".repeat(40) as Sha })
          const handed = yield* toHandBack(stop, options, handBacks)
          expect(Result.isFailure(handed) && handed.failure.why).toBe(
            "it was handed back to its worker 2 times already",
          )
        }),
      ),
    )
    expect(ran.exit._tag).toBe("Success")
  })
})
