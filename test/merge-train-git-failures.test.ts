// The merge train when git fails (mergetrain.ts): a killed run's branch git can't find, can't put
// back, or left mid-rebase (putBackLeft); a branch checked ahead that changes nothing on top of the
// one ahead; the trains behind one whose check fails ahead of its turn; and a branch boarding its
// train as the run quits, as git can't say where it is, or as git can't put it back.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Logger, References, type Scope, Stream } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { aheadJson, aheadKey, putBackLeft, type RebasedAhead } from "../src/run/mergetrain.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { makeSetUps } from "../src/run/setup.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Scripted } from "../src/testing/Checks.ts"
import { type Call, type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** A check command, failed checks set aside at once, and `train` checked ahead. */
const settings = (train = 1) => ({
  ...defaults,
  checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  merge: { ...defaults.merge, check_hand_backs: 0, train },
})

const failing = new CheckFailed({
  check: "fast",
  command: check,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: b.test.ts: expected 1"],
  lastLines: ["1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Lets every fiber that can go on run, in real time: TestClock holds only sleeps. */
const settle = Effect.promise(() => Bun.sleep(20))

describe("a branch a killed run left rebased ahead of its turn, as the next run starts", () => {
  /** Where the worktrees are, in the test layer's repository. */
  const root = "/worktrees"

  /**
   * tutti/<id> with a commit of its own, rebased onto tutti/a by a killed run's train, and marked
   * so in state.json; `conflict`: its rebase stopped on a conflict, the run killed during it.
   */
  const leftRebased = (id: TicketId, conflict = false) =>
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      const store = yield* Store
      const worktree = `${root}/${id}`
      yield* git.addWorktree(repository.dir, worktree, { branch: `tutti/${id}`, base: "main" })
      yield* repository.commit(worktree, `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
      const orig = yield* repository.head(`tutti/${id}`)
      const onto = yield* repository.head("tutti/a")
      if (conflict) yield* repository.conflict(`tutti/${id}`, [`${id}.txt`])
      yield* Effect.ignore(git.rebase(worktree, onto))
      const head = conflict ? undefined : yield* repository.head(`tutti/${id}`)
      const mark: RebasedAhead = { orig, onto, head, behind: "tutti/a", setUp: false }
      yield* store.updateTicket(id, (record) => ({
        ...record,
        worktree,
        branch: `tutti/${id}`,
        metadata: { ...record.metadata, [aheadKey]: aheadJson(mark) },
      }))
      return { worktree, orig }
    })

  /**
   * The tickets' records in state.json, and tutti/a, the branch ahead, with a commit of its own;
   * `before` leaves branches rebased, putBackLeft runs, and `after` looks at what it left.
   */
  const killed = <A, B>(
    ids: ReadonlyArray<TicketId>,
    before: Effect.Effect<A, unknown, Env>,
    after: (left: A) => Effect.Effect<B, unknown, Env>,
  ): Promise<Ran<{ readonly left: A; readonly after: B; readonly debug: ReadonlyArray<string> }>> =>
    scenario(
      {
        state: {
          version: 1,
          tickets: Object.fromEntries(ids.map((id) => [id, { resumes: 0, metadata: {} }])),
        },
      },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        yield* git.addWorktree(repository.dir, `${root}/a`, { branch: "tutti/a", base: "main" })
        yield* repository.commit(`${root}/a`, "Do a (a)", { "a.txt": "a\n" })
        const left = yield* before
        const debug: Array<string> = []
        const collector = Logger.make((options) => {
          if (options.logLevel === "Debug") debug.push([options.message].flat().join(" "))
        })
        yield* putBackLeft(repository.dir, yield* makeSetUps).pipe(
          Effect.provide(Logger.layer([collector])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        )
        return { left, after: yield* after(left), debug }
      }),
    )

  /** The ticket's mark in state.json. */
  const markOf = (id: TicketId) =>
    Effect.flatMap(Store, (store) =>
      Effect.map(store.metadata(id), (metadata) => metadata[aheadKey]),
    )

  test("skips one whose branch git can't find, with a debug line, and goes on to the next", async () => {
    const ran = await killed(
      ["b" as TicketId, "c" as TicketId],
      Effect.gen(function* () {
        const b = yield* leftRebased("b" as TicketId)
        // c's mark names a branch that no longer exists.
        yield* (yield* Store).updateTicket("c" as TicketId, (record) => ({
          ...record,
          worktree: `${root}/c`,
          branch: "tutti/c",
          metadata: { [aheadKey]: { orig: b.orig, onto: b.orig, head: b.orig, behind: "tutti/a" } },
        }))
        return b
      }),
      () => Effect.all({ b: markOf("b" as TicketId), c: markOf("c" as TicketId) }),
    )
    const { left: b, after, debug } = resultOf(ran)
    // git rev-parse --verify --quiet says nothing of a branch it can't find.
    expect(debug).toEqual(["c: exit code 1"])
    expectLog(ran, [
      `  tutti/b was rebased onto tutti/a to be checked ahead of its turn by a run that was killed before its turn: put back as its worker left it, at ${b.orig.slice(0, 7)}`,
    ])
    expect(ran.log.some((text) => text.includes("tutti/c"))).toBe(false)
    // c's mark is kept, for the next run to try again.
    expect(after).toEqual({ b: undefined, c: expect.objectContaining({ behind: "tutti/a" }) })
  })

  test("aborts the rebase of one killed during it, its branch where its worker left it", async () => {
    const ran = await killed(
      ["b" as TicketId],
      Effect.gen(function* () {
        const b = yield* leftRebased("b" as TicketId, true)
        return { ...b, rebasing: yield* (yield* Git).rebaseInProgress(b.worktree) }
      }),
      (b) =>
        Effect.gen(function* () {
          const repository = yield* Repository
          return {
            rebasing: yield* (yield* Git).rebaseInProgress(b.worktree),
            branch: yield* repository.head("tutti/b"),
            checkedOut: yield* repository.head("HEAD", b.worktree),
            mark: yield* markOf("b" as TicketId),
          }
        }),
    )
    const { left, after } = resultOf(ran)
    expect(left.rebasing).toBe(true)
    expect(after).toEqual({
      rebasing: false,
      branch: left.orig,
      checkedOut: left.orig,
      mark: undefined,
    })
    expect(ran.log).toEqual([])
  })

  test("says REBASE_FAILED, naming its worktree, when git can't put it back", async () => {
    const ran = await killed(
      ["b" as TicketId],
      Effect.gen(function* () {
        const repository = yield* Repository
        const b = yield* leftRebased("b" as TicketId)
        yield* repository.fail("reset --hard", { dir: b.worktree })
        return { ...b, head: yield* repository.head("tutti/b") }
      }),
      () =>
        Effect.all({
          branch: Effect.flatMap(Repository, (repository) => repository.head("tutti/b")),
          mark: markOf("b" as TicketId),
        }),
    )
    const { left, after } = resultOf(ran)
    expectLog(ran, [
      `  REBASE_FAILED: b: tutti/b could not be put back as its worker left it, at ${left.orig.slice(0, 7)}, after a run that was killed left it rebased onto tutti/a to be checked ahead of its turn: git reset failed: error: reset --hard failed; check ${root}/b before it merges`,
    ])
    // Left rebased, and marked, for the next run to try again.
    expect(after.branch).toBe(left.head)
    expect(after.mark).toEqual(expect.objectContaining({ orig: left.orig, head: left.head }))
  })
})

/** A ticket its worker finished: a commit naming it on tutti/<id>, closed, Working. */
const finished = (id: TicketId, files: Files) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

/** Which ticket a check ran for: its worktree's name. */
const whose = (run: CheckRun): string => run.cwd.split("/").at(-1) ?? ""

/** Every check run as `play` says for its ticket, whatever order they come in. */
const each = (
  play: (id: string, nth: number) => Effect.Effect<void, CheckFailed>,
): ReadonlyArray<Scripted> => {
  const counts = new Map<string, number>()
  const one: Scripted = (run) => {
    const id = whose(run)
    const nth = (counts.get(id) ?? 0) + 1
    counts.set(id, nth)
    return Effect.as(play(id, nth), { ...passed("fast"), command: check })
  }
  return Array.from({ length: 8 }, () => one)
}

/** The services a check's script reaches, set as its scenario starts. */
interface Reach {
  repository: Repository["Service"]
  queue: MergeQueue
  tickets: Record<string, FinishedTicket>
}

interface Merged {
  readonly phases: Record<string, PhaseTag>
  /** Each ticket's branch before it was offered, and after the scenario's body. */
  readonly before: Record<string, string>
  readonly after: Record<string, string>
  /** b's mark in state.json at the end. */
  readonly mark: unknown
  readonly main: ReadonlyMap<string, string>
  readonly calls: ReadonlyArray<Call>
}

/**
 * The tickets finished, main moved on, all offered in order with a merge queue in a scope of its
 * own; `body` runs then, the queue settled after it unless it says otherwise. `checks` reach the
 * repository, the queue and the tickets through `reach`.
 */
const inLine = (
  plan: {
    readonly ids?: ReadonlyArray<TicketId>
    readonly train?: number
    readonly checks: (reach: Reach) => ReadonlyArray<Scripted>
    readonly files?: Readonly<Record<string, Files>>
  },
  body: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger | Scope.Scope> = (queue) =>
    Effect.asVoid(queue.settled),
) => {
  const ids = plan.ids ?? ["a" as TicketId, "b" as TicketId]
  const reach = { tickets: {} } as Reach
  let seeds = backlog()
  for (const id of ids) seeds = seeds.ticket(id)
  return scenario(
    {
      config: { settings: settings(plan.train) },
      backlog: seeds.seeds,
      checks: { fast: plan.checks(reach) },
    },
    Effect.gen(function* () {
      const queue = yield* makeQueue({ repo: "/repo", base: "main" })
      const repository = yield* Repository
      reach.repository = repository
      reach.queue = queue
      for (const id of ids) {
        reach.tickets[id] = yield* finished(id, plan.files?.[id] ?? { [`${id}.txt`]: `${id}\n` })
      }
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      const before: Record<string, string> = {}
      for (const id of ids) before[id] = yield* repository.head(`tutti/${id}`)
      for (const id of ids) yield* queue.offer(reach.tickets[id] as FinishedTicket)
      yield* body(queue)
      const after: Record<string, string> = {}
      for (const id of ids) {
        after[id] = yield* repository.head(`tutti/${id}`).pipe(Effect.orElseSucceed(() => ""))
      }
      return {
        phases: tagsOf(yield* (yield* Ledger).current),
        before,
        after,
        mark: (yield* (yield* Store).metadata("b" as TicketId))[aheadKey],
        main: yield* repository.tree("main"),
        calls: yield* repository.calls,
      } satisfies Merged
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )
}

/** The tickets the checks ran for, in order. */
const checked = (ran: Ran<unknown>) => ran.checkRuns.map(whose)

/** Waits until the queue has b's turn under way, and its train boarding it has gone as far as it can. */
const bsTurn = (queue: MergeQueue) =>
  Effect.andThen(
    queue.changes.pipe(
      Stream.filter((state) => state.merging === "b"),
      Stream.runHead,
    ),
    settle,
  )

const aheadLine =
  "  checking tutti/b ahead of its turn to merge, rebased onto tutti/a as it is checked"

describe("a ticket checked ahead of its turn", () => {
  test("that changes nothing on top of the branch ahead is put back as its worker left it", async () => {
    // b makes a's change: rebased onto tutti/a, it changes nothing. a's check runs once b's train
    // is over, and sees where b's branch is then.
    const trainOver = Deferred.makeUnsafe<void>()
    let during = ""
    const ran = await inLine(
      {
        files: { a: { "a.txt": "a\n" }, b: { "a.txt": "a\n" } },
        checks: (reach) =>
          each((id) =>
            id === "a"
              ? Effect.gen(function* () {
                  yield* Deferred.await(trainOver)
                  during = yield* reach.repository.head("tutti/b")
                })
              : Effect.void,
          ),
      },
      (queue) =>
        Effect.gen(function* () {
          // b shows as rebasing ahead of its turn, then not at all.
          yield* queue.checksAhead.pipe(
            Stream.map((shown) => shown.has("b")),
            Stream.changes,
            Stream.take(3),
            Stream.runDrain,
          )
          yield* Deferred.succeed(trainOver, undefined)
          yield* queue.settled
        }),
    )
    const merged = resultOf(ran)
    expect(during).toBe(merged.before.b as string)
    expect(checked(ran)).toEqual(["a"])
    expect(ran.log.some((text) => text.includes("ahead of its turn"))).toBe(false)
    expect(merged.mark).toBeUndefined()
    // It was rebased onto tutti/a, then reset to where its worker left it.
    const inB = merged.calls.filter((call) => call.dir.endsWith("/b")).map((call) => call.op)
    expect(inB).toEqual(expect.arrayContaining(["rebase", "reset --hard"]))
    expect(inB.indexOf("rebase")).toBeLessThan(inB.indexOf("reset --hard"))
    expect(merged.phases).toEqual({ a: "Done", b: "Done" })
  })

  test("whose check fails ahead of its turn stops the trains behind it", async () => {
    // a's check waits for c's, ahead of its turn on top of tutti/b, to be stopped; b's check ahead
    // fails once c's has started; c's never ends of itself. Were c's train not stopped as b's check
    // fails, a's check would never end, and the test would time out.
    const cStarted = Deferred.makeUnsafe<void>()
    const cStopped = Deferred.makeUnsafe<void>()
    const ran = await inLine({
      ids: ["a" as TicketId, "b" as TicketId, "c" as TicketId],
      train: 2,
      checks: () =>
        each((id, nth) => {
          if (id === "a") return Deferred.await(cStopped)
          if (id === "b" && nth === 1) {
            return Effect.andThen(Deferred.await(cStarted), Effect.fail(failing))
          }
          if (id === "c" && nth === 1) {
            return Effect.andThen(Deferred.succeed(cStarted, undefined), Effect.never).pipe(
              Effect.onInterrupt(() => Deferred.succeed(cStopped, undefined)),
            )
          }
          return Effect.void
        }),
    })
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Done", c: "Done" })
    expect(checked(ran)).toEqual(["a", "b", "c", "b", "c"])
    expectLog(ran, [
      "  checking tutti/c ahead of its turn to merge, rebased onto tutti/b as it is checked",
      /^ {2}'scripts\/check-fast\.sh' fails on tutti\/b ahead of its turn, on top of tutti\/a .*; it is checked again in its turn$/,
      /^ {2}a closed .*; merged into main/,
    ])
    expectLog(ran, [
      "  tutti/c was checked ahead of its turn on top of tutti/b, which did not merge as it was checked: put back as its worker left it",
    ])
    expect(["a.txt", "b.txt", "c.txt"].map((file) => merged.main.get(file))).toEqual([
      "a\n",
      "b\n",
      "c\n",
    ])
  })
})

describe("boarding a ticket's train in its turn", () => {
  test("as the run quits before its merge, puts its branch back and leaves it in line", async () => {
    // a merges while b's check ahead of its turn still runs; the run quits as b's turn waits for it.
    const bStarted = Deferred.makeUnsafe<void>()
    const ran = await inLine(
      {
        checks: () =>
          each((id) =>
            id === "a"
              ? Deferred.await(bStarted)
              : Effect.andThen(Deferred.succeed(bStarted, undefined), Effect.never),
          ),
      },
      (queue) =>
        Effect.gen(function* () {
          yield* bsTurn(queue)
          yield* queue.hold
          yield* queue.stopMerges
        }),
    )
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "ToMerge" })
    expect(checked(ran)).toEqual(["a", "b"])
    expect(merged.after.b).toBe(merged.before.b as string)
    expect(merged.main.get("a.txt")).toBe("a\n")
    expect(merged.main.has("b.txt")).toBe(false)
    expect(merged.mark).toBeUndefined()
    expectLog(ran, [aheadLine, /^ {2}a closed .*; merged into main/])
    // Its turn had taken its train: leaving the trains found none to put back.
    expect(ran.log.some((text) => text.includes("the run stopped before its turn"))).toBe(false)
  })

  test("when git can't tell where its branch is, stops the merges, its worktree left for review", async () => {
    // b's check ahead of its turn passes once its turn waits for it, and git then fails on it.
    const bStarted = Deferred.makeUnsafe<void>()
    const ran = await inLine({
      checks: (reach) =>
        each((id) =>
          id === "a"
            ? Deferred.await(bStarted)
            : Effect.gen(function* () {
                yield* Deferred.succeed(bStarted, undefined)
                yield* bsTurn(reach.queue)
                yield* reach.repository.fail("rev-parse", { dir: "/repo", stderr: "fatal: oops" })
              }),
        ),
    })
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Blocked" })
    expect(merged.main.has("b.txt")).toBe(false)
    expect(checked(ran)).toEqual(["a", "b"])
    expectLog(ran, [
      aheadLine,
      /^ {2}a closed .*; merged into main/,
      /^HOLD: GIT_FAILED: could not tell where tutti\/b is, after it was rebased to be checked ahead of its turn: fatal: oops; tutti\/b is not merged, its worktree .*\/b left for review$/,
    ])
  })

  test("when git can't put its branch back, sets it aside for review: rebase failed", async () => {
    // b's check fails ahead of its turn, and git reset fails in its worktree from then on.
    const bFailed = Deferred.makeUnsafe<void>()
    const ran = await inLine({
      checks: (reach) =>
        each((id, nth) =>
          id === "a"
            ? Deferred.await(bFailed)
            : nth === 1
              ? Effect.gen(function* () {
                  const worktree = (reach.tickets.b as FinishedTicket).worktree
                  yield* reach.repository.fail("reset --hard", { dir: worktree, times: 10 })
                  yield* Deferred.succeed(bFailed, undefined)
                  return yield* Effect.fail(failing)
                })
              : Effect.void,
        ),
    })
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Review" })
    expect(checked(ran)).toEqual(["a", "b"])
    expect(merged.main.has("b.txt")).toBe(false)
    expect(merged.after.b).not.toBe(merged.before.b as string)
    expect(merged.mark).toBeDefined()
    expectLog(ran, [
      aheadLine,
      /^ {2}a closed .*; merged into main/,
      new RegExp(
        `^ {2}REBASE_FAILED: b closed, but tutti/b could not be put back as its worker left it, at ${(merged.before.b as string).slice(0, 7)}, after it was rebased onto tutti/a to be checked ahead of its turn: git reset failed: error: reset --hard failed; worktree .*/b left for review$`,
      ),
    ])
  })
})
