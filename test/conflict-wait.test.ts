// A ticket in line waits for one whose conflict its branch would reopen (conflictWait.ts), as
// fab-mgi.7.7 and fab-mgi.8.2 didn't for fab-mgi.7.9 in Fabrica's run of 2026-11-04.
import { describe, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Exit, Fiber, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger } from "../src/run/ledger.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { Move, type PhaseTag, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckOutput, resultOf } from "../src/services/Checks.ts"
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
import { type CheckRun, passed } from "../src/testing/Checks.ts"
import type { Files } from "../src/testing/Git.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const defaults = appConfig().settings
type Settings = typeof defaults
const withCheck = (change: (settings: Settings) => Settings = (settings) => settings) => ({
  config: {
    settings: change({
      ...defaults,
      checks: {
        ...defaults.checks,
        fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
      },
    }),
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

const finished = (id: string, files: Files) =>
  Effect.gen(function* () {
    const ticket = id as TicketId
    const git = yield* Git
    const repository = yield* Repository
    const host = yield* AgentHost
    const worktree = yield* (yield* Worktrees).prepare(ticket)
    worktrees.set(id, worktree.path)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(ticket, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(ticket, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(ticket, Move.Dispatched())
    const sessionId = `session-${id}`
    yield* (yield* Store).saveSession(ticket, {
      session: sessionId,
      worktree: worktree.path,
      branch: worktree.branch,
    })
    yield* host.start(ticket, { sessionId, cwd: worktree.path })
    yield* untilSettled(ticket)
    return {
      id: ticket,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

// a's branch, then main's change to the file it changes: its rebase will conflict in a.txt.
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

const until = (id: string, tag: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) => state.tickets.get(id as TicketId)?.phase._tag === tag),
      Stream.runHead,
    )
  })

/** The ticket's worker resolves its conflict, writing into `file`, once `first` is over. */
const resolves = (
  world: World,
  id: string,
  file: string,
  first: Effect.Effect<void> = Effect.void,
) =>
  turn([
    run(first),
    run(
      Effect.suspend(() =>
        Effect.asVoid(world.repository.continueRebase(worktreeOf(id), { [file]: `${id}'s\n` })),
      ),
    ),
  ])

const phases = (ran: Ran<Record<string, TicketPhase>>): Record<string, TicketPhase> => {
  if (Exit.isFailure(ran.exit))
    throw new Error(`the scenario failed: ${ran.exit.cause}\n${ran.log.join("\n")}`)
  return ran.exit.value
}

const done = expect.objectContaining({ _tag: "Done" })

/** The tickets in the order they moved to `to`. */
const movedTo = (ran: Ran<unknown>, to: PhaseTag) =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.to === to ? [record.ticket] : [],
  )

const said = (ran: Ran<unknown>, pattern: RegExp) => ran.log.filter((each) => pattern.test(each))

/** Sets merge.conflict_wait. */
const waitFor = (limit: Duration.Duration) => (settings: Settings) => ({
  ...settings,
  merge: { ...settings.merge, conflict_wait: limit },
})

const phaseOf = (id: string) =>
  Effect.gen(function* () {
    const { tickets } = yield* (yield* Ledger).current
    return tickets.get(id as TicketId)?.phase
  })

/** Waits for a line the log says. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    while (!(yield* texts).some((each) => pattern.test(each))) yield* Effect.yieldNow
  })

const bWaits =
  "  b waits to merge: a's rebase conflicted in a.txt, which b changes too, so a goes first"

/** How many hand-backs a ticket had. */
const attempts = (ran: Ran<unknown>, id: string) =>
  ran.events.filter(
    (record) => record.kind === "phase" && record.ticket === id && record.to === "Resolving",
  ).length

describe("a ticket changing a file another's conflict is in", () => {
  test("waits for its resolve, which then needs no second hand-back", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck(),
        scripts: (world): Scripts => ({
          a: [finishedSession(resolves(world, "a", "a.txt"))],
          b: [finishedSession(resolves(world, "b", "a.txt"))],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          // On top of main: nothing but a's merge can make it conflict.
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(done)
    expect(after.b).toEqual(done)
    expect(attempts(ran, "a")).toBe(1)
    expect(movedTo(ran, "Done")).toEqual(["a", "b"])
    expect(said(ran, /waits to merge/)).toEqual([bWaits])
    expect(said(ran, /waits no longer/)).toEqual([])
  })

  test("waits alone: a ticket behind it that changes neither merges meanwhile", async () => {
    const cDone = Deferred.makeUnsafe<void>()
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").ticket("c").seeds,
        ...withCheck(),
        scripts: (world): Scripts => ({
          a: [finishedSession(resolves(world, "a", "a.txt", Deferred.await(cDone)))],
          b: [finishedSession(resolves(world, "b", "a.txt"))],
          c: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          const c = yield* finished("c", { "c.txt": "c\n" })
          const during = yield* Effect.forkChild(
            Effect.andThen(until("c", "Done"), Deferred.succeed(cDone, undefined)),
          )
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.offer(c)
          yield* queue.settled
          yield* Fiber.join(during)
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(done)
    expect(after.b).toEqual(done)
    expect(after.c).toEqual(done)
    expect(movedTo(ran, "Done")).toEqual(["c", "a", "b"])
    expect(attempts(ran, "a")).toBe(1)
  })

  test("isn't checked ahead of its turn while it waits; the one behind it is", async () => {
    const aGoes = Deferred.makeUnsafe<void>()
    const cAhead = Deferred.makeUnsafe<void>()
    // c, in its turn, holds until d has been checked ahead of it, on top of its branch.
    const check = (each: CheckRun) =>
      Effect.gen(function* () {
        if (each.cwd === worktreeOf("c")) yield* Deferred.await(cAhead)
        if (each.cwd === worktreeOf("d")) yield* Deferred.succeed(cAhead, undefined)
        return passed("fast")
      })
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").ticket("c").ticket("d").seeds,
        ...withCheck(),
        checks: { fast: [check, check, check, check, check, check] },
        scripts: (world): Scripts => ({
          a: [finishedSession(resolves(world, "a", "a.txt", Deferred.await(aGoes)))],
          b: [finishedSession(resolves(world, "b", "a.txt"))],
          c: [finishedSession()],
          d: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          const c = yield* finished("c", { "c.txt": "c\n" })
          const d = yield* finished("d", { "d.txt": "d\n" })
          const during = yield* Effect.forkChild(
            Effect.andThen(until("d", "Done"), Deferred.succeed(aGoes, undefined)),
          )
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.offer(c)
          yield* queue.offer(d)
          yield* queue.settled
          yield* Fiber.join(during)
        }),
      ),
    )
    const after = phases(ran)
    expect(after.b).toEqual(done)
    expect(after.d).toEqual(done)
    expect(movedTo(ran, "Done")).toEqual(["c", "d", "a", "b"])
    expect(said(ran, /checking tutti\/d ahead of its turn/).length).toBe(1)
    expect(said(ran, /checking tutti\/b ahead of its turn/)).toEqual([])
  })

  test("goes after one set aside: the wait ends with the conflict", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck(),
        // a's worker leaves its rebase as it is.
        scripts: (): Scripts => ({ a: [finishedSession(turn([]))], b: [finishedSession()] }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }))
    expect(after.b).toEqual(done)
    expect(said(ran, /waits to merge/)).toEqual([bWaits])
    expect(said(ran, /waits no longer/)).toEqual([])
  })

  test("still waits while a fix follows the resolve", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck(),
        checks: { fast: [{ exitCode: 1, output: "a's check\n" }] },
        scripts: (world): Scripts => ({
          a: [
            finishedSession([
              ...resolves(world, "a", "a.txt"),
              ...turn([
                run(
                  Effect.suspend(() =>
                    Effect.asVoid(
                      world.repository.commit(worktreeOf("a"), "Fix a (a)", { "fix.txt": "fix\n" }),
                    ),
                  ),
                ),
              ]),
            ]),
          ],
          b: [finishedSession(resolves(world, "b", "a.txt"))],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(done)
    expect(after.b).toEqual(done)
    expect(movedTo(ran, "Fixing")).toEqual(["a"])
    expect(movedTo(ran, "Done")).toEqual(["a", "b"])
  })

  test("waits for one back in line behind it, which goes first", async () => {
    const xHolds = Deferred.makeUnsafe<void>()
    // x's check, in its turn, lasts until a is back in line behind b, and a past b's time limit.
    const check = (each: CheckRun) =>
      Effect.as(each.cwd === worktreeOf("x") ? Deferred.await(xHolds) : Effect.void, passed("fast"))
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("x").ticket("b").seeds,
        ...withCheck(),
        checks: { fast: [check, check, check, check, check, check] },
        scripts: (world): Scripts => ({
          a: [finishedSession(resolves(world, "a", "a.txt"))],
          b: [finishedSession(resolves(world, "b", "a.txt"))],
          x: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const x = yield* finished("x", { "x.txt": "x\n" })
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          const during = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* until("a", "Resolving")
              yield* queue.offer(x)
              yield* queue.offer(b)
              yield* until("a", "ToMerge")
              yield* Deferred.succeed(xHolds, undefined)
            }),
          )
          yield* queue.offer(a)
          yield* Fiber.join(during)
          yield* queue.settled
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(done)
    expect(after.b).toEqual(done)
    expect(after.x).toEqual(done)
    expect(movedTo(ran, "Done")).toEqual(["x", "a", "b"])
    expect(attempts(ran, "a")).toBe(1)
  })
})

describe("a ticket checked ahead of its turn on top of the conflict's holder", () => {
  test("changes only what its worker left, so it doesn't wait for a's fix", async () => {
    const xDone = Deferred.makeUnsafe<void>()
    const aChecking = Deferred.makeUnsafe<void>()
    const cAhead = Deferred.makeUnsafe<void>()
    const cDone = Deferred.makeUnsafe<void>()
    // a's check on its resolution, once main has moved on, lasts until c is checked on top of its
    // branch, and fails: c's branch still has a's commits as a goes to its worker.
    let aChecks = 0
    const check = (each: CheckRun) =>
      Effect.gen(function* () {
        if (each.cwd === worktreeOf("c")) yield* Deferred.succeed(cAhead, undefined)
        if (each.cwd !== worktreeOf("a") || ++aChecks > 1) return passed("fast")
        yield* Deferred.succeed(aChecking, undefined)
        yield* Deferred.await(cAhead)
        const output = new CheckOutput()
        output.write(new TextEncoder().encode("a's check\n"))
        return yield* resultOf("fast", "scripts/check-fast.sh", 1, output, each.outputFile)
      })
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("x").ticket("c").seeds,
        ...withCheck(),
        checks: { fast: Array.from({ length: 8 }, () => check) },
        scripts: (world): Scripts => ({
          a: [
            finishedSession([
              ...resolves(world, "a", "a.txt", Deferred.await(xDone)),
              ...turn([
                run(Deferred.await(cDone)),
                run(
                  Effect.suspend(() =>
                    Effect.asVoid(
                      world.repository.commit(worktreeOf("a"), "Fix a (a)", { "fix.txt": "fix\n" }),
                    ),
                  ),
                ),
              ]),
            ]),
          ],
          x: [finishedSession()],
          c: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const x = yield* finished("x", { "x.txt": "x\n" })
          const c = yield* finished("c", { "c.txt": "c\n" })
          yield* queue.offer(a)
          yield* until("a", "Resolving")
          yield* queue.offer(x)
          yield* until("x", "Done")
          yield* Deferred.succeed(xDone, undefined)
          yield* Deferred.await(aChecking)
          yield* queue.offer(c)
          yield* until("c", "Done")
          yield* Deferred.succeed(cDone, undefined)
          yield* queue.settled
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(done)
    expect(after.c).toEqual(done)
    expect(movedTo(ran, "Done")).toEqual(["x", "c", "a"])
    expect(said(ran, /checking tutti\/c ahead of its turn/).length).toBe(1)
    expect(said(ran, /c waits/)).toEqual([])
  })
})

describe("the wait's limit", () => {
  test("a hung resolve holds the ticket for merge.conflict_wait, no more", async () => {
    const bDone = Deferred.makeUnsafe<void>()
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck(waitFor(Duration.minutes(2))),
        scripts: (world): Scripts => ({
          a: [
            finishedSession([
              ...resolves(world, "a", "a.txt", Deferred.await(bDone)),
              ...resolves(world, "a", "a.txt"),
            ]),
          ],
          b: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* untilLogged(/b waits to merge/)
          yield* advance(Duration.seconds(119))
          yield* Effect.yieldNow
          expect((yield* phaseOf("b"))?._tag).toBe("ToMerge")
          yield* advance(Duration.seconds(1))
          yield* until("b", "Done")
          yield* Deferred.succeed(bDone, undefined)
          yield* queue.settled
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(done)
    expect(after.b).toEqual(done)
    expect(movedTo(ran, "Done")).toEqual(["b", "a"])
    expect(attempts(ran, "a")).toBe(2)
    expect(said(ran, /waits no longer/)).toEqual([
      "  b waits no longer: a hasn't resolved its conflict after 2m, and may conflict again once b merges",
    ])
  })

  test("doesn't let it past one back in line", async () => {
    const aGoes = Deferred.makeUnsafe<void>()
    const xHolds = Deferred.makeUnsafe<void>()
    const check = (each: CheckRun) =>
      Effect.as(each.cwd === worktreeOf("x") ? Deferred.await(xHolds) : Effect.void, passed("fast"))
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").ticket("x").seeds,
        ...withCheck(waitFor(Duration.minutes(2))),
        checks: { fast: [check, check, check, check, check, check] },
        scripts: (world): Scripts => ({
          a: [finishedSession(resolves(world, "a", "a.txt", Deferred.await(aGoes)))],
          b: [finishedSession(resolves(world, "b", "a.txt"))],
          x: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          const x = yield* finished("x", { "x.txt": "x\n" })
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.offer(x)
          yield* untilLogged(/b waits to merge/)
          yield* until("x", "Merging")
          // b's limit passes during x's check, and a gets back in line behind b before it ends.
          yield* advance(Duration.minutes(3))
          yield* Deferred.succeed(aGoes, undefined)
          yield* until("a", "ToMerge")
          yield* Deferred.succeed(xHolds, undefined)
          yield* queue.settled
        }),
      ),
    )
    const after = phases(ran)
    expect(after.a).toEqual(done)
    expect(after.b).toEqual(done)
    expect(movedTo(ran, "Done")).toEqual(["x", "a", "b"])
    expect(said(ran, /waits no longer/)).toEqual([])
  })
})

describe("no wait", () => {
  // Without a wait, b merges while a resolves: its worker holds on until b is done.
  const noWait = async (change: (settings: Settings) => Settings) => {
    const bDone = Deferred.makeUnsafe<void>()
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck(change),
        scripts: (world): Scripts => ({
          a: [
            finishedSession([
              ...resolves(world, "a", "a.txt", Deferred.await(bDone)),
              ...resolves(world, "a", "a.txt"),
            ]),
          ],
          b: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* until("b", "Done")
          yield* Deferred.succeed(bDone, undefined)
          yield* queue.settled
        }),
      ),
    )
    expect(phases(ran).a).toEqual(done)
    expect(movedTo(ran, "Done")).toEqual(["b", "a"])
    expect(said(ran, /waits/)).toEqual([])
  }

  test('with merge.conflict_wait "0"', () => noWait(waitFor(Duration.zero)))

  test("with the queue's footprint off", () =>
    noWait((settings) => ({ ...settings, queue: { ...settings.queue, footprint: false } })))

  test("for a conflict only in a file queue.shared_files names", () =>
    noWait((settings) => ({
      ...settings,
      queue: { ...settings.queue, shared_files: ["*.txt"] },
    })))

  test("when git can't say what the branch changes", async () => {
    const bDone = Deferred.makeUnsafe<void>()
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck(),
        scripts: (world): Scripts => ({
          a: [
            finishedSession([
              ...resolves(world, "a", "a.txt", Deferred.await(bDone)),
              ...resolves(world, "a", "a.txt"),
            ]),
          ],
          b: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          yield* moveMain
          const b = yield* finished("b", { "a.txt": "b's a\n" })
          yield* queue.offer(a)
          yield* until("a", "Resolving")
          yield* (yield* Repository).fail("diff --name-only")
          yield* queue.offer(b)
          yield* until("b", "Done")
          yield* Deferred.succeed(bDone, undefined)
          yield* queue.settled
        }),
      ),
    )
    expect(phases(ran).b).toEqual(done)
    expect(said(ran, /waits to merge/)).toEqual([])
  })
})
