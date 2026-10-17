import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Scope } from "effect"
import fc from "fast-check"
import { uncheckedKey, uncheckedOf } from "../src/run/check.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Scripted } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** A check that runs until it is killed, `started` once it runs. */
const hanging = (started: Deferred.Deferred<void>): Scripted =>
  Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) as Effect.Effect<never>

const failedCheck = new CheckFailed({
  check: "fast",
  command: "scripts/check-fast.sh",
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: a.test.ts: expected 1"],
  lastLines: ["error: a.test.ts: expected 1", "1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed. */
const finished = (id: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(id, "done")
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** The ticket in this run's ledger, Working, as its worker finishes it. */
const working = (ticket: FinishedTicket) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.transition(ticket.id, Cause.Ready(), { title: ticket.title })
    yield* ledger.transition(ticket.id, Cause.Dispatched())
  })

/** Another ticket's merge, landing on main while the tickets ran. */
const moveMain = (files: Files = { "main.txt": "moved\n" }) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

/** The ticket's phase in this run's ledger. */
const phaseIn = (id: string) =>
  Effect.gen(function* () {
    const state = yield* (yield* Ledger).current
    return state.tickets.get(id)?.phase
  })

/**
 * A run that quits during the ticket's merge check: offered to the merge queue, rebased onto main,
 * and the run's scope closed once its check, `started` as it runs, is under way. Its phase as the
 * run ends.
 */
const quitDuringCheck = (ticket: FinishedTicket, started: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    yield* working(ticket)
    const scope = yield* Scope.make()
    const queue = yield* Effect.provideService(makeQueue(options), Scope.Scope, scope)
    yield* queue.offer(ticket)
    yield* Deferred.await(started)
    yield* Scope.close(scope, Exit.void)
    return yield* phaseIn(ticket.id)
  }).pipe(Effect.provide(Ledger.layer))

/** A later run, the ticket carried over to it waiting to merge: its phase once the queue settles. */
const nextRun = (ticket: FinishedTicket) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* working(ticket)
      const queue = yield* makeQueue(options)
      yield* queue.offer(ticket)
      yield* queue.settled
      return yield* phaseIn(ticket.id)
    }),
  ).pipe(Effect.provide(Ledger.layer))

/** The ticket's rebased-and-unchecked mark in state.json, as it is now. */
const markOf = (id: string) =>
  Effect.gen(function* () {
    const metadata = yield* (yield* Store).metadata(id)
    return Object.hasOwn(metadata, uncheckedKey) ? metadata[uncheckedKey] : undefined
  })

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Each check run's kind, in order. */
const checksRun = (ran: Ran<unknown>) => ran.checkRuns.map((run) => run.check)

describe("a branch rebased before a quit cut its check short", () => {
  test("is marked, and checked by the next run before it merges", async () => {
    const started = Deferred.makeUnsafe<void>()
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, checks: { fast: [hanging(started)] } },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        const a = yield* finished("a", { "a.txt": "a\n" })
        const fork = yield* git.mergeBase(repository.dir, "main", a.branch)
        const head = yield* repository.head(a.branch)
        yield* moveMain()
        const quit = yield* quitDuringCheck(a, started)
        // Its branch stays rebased onto main, on top of it, as the quit left it.
        const main = yield* repository.head("main")
        const onTop = (yield* git.mergeBase(repository.dir, "main", a.branch)) === main
        const marked = yield* markOf("a")
        const next = yield* nextRun(a)
        const merged = (yield* repository.tree("main")).get("a.txt")
        return { quit, onTop, marked, fork, head, next, merged, left: yield* markOf("a") }
      }),
    )
    const result = resultOf(ran)
    expect(result.quit?._tag).toBe("ToMerge")
    expect(result.onTop).toBe(true)
    expect(result.marked).toEqual({ fork: result.fork, head: result.head })
    expect(result.next?._tag).toBe("Done")
    expect(result.merged).toBe("a\n")
    expect(result.left).toBeUndefined()
    expect(checksRun(ran)).toEqual(["fast", "fast"])
    expect(
      ran.log.some((line) =>
        line.includes(
          "tutti/a is on top of main, but its check didn't finish after tutti rebased it",
        ),
      ),
    ).toBe(true)
  })

  test("doesn't merge when its check fails in the next run, and stays marked", async () => {
    const started = Deferred.makeUnsafe<void>()
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, checks: { fast: [hanging(started), failedCheck] } },
      Effect.gen(function* () {
        const repository = yield* Repository
        const a = yield* finished("a", { "a.txt": "a\n" })
        yield* moveMain()
        yield* quitDuringCheck(a, started)
        const next = yield* nextRun(a)
        const merged = (yield* repository.tree("main")).has("a.txt")
        return { next, merged, marked: yield* markOf("a") }
      }),
    )
    const result = resultOf(ran)
    expect(result.next?._tag).not.toBe("Done")
    expect(result.merged).toBe(false)
    expect(result.marked).toBeDefined()
    expect(checksRun(ran)).toEqual(["fast", "fast"])
  })

  test("is set up first when the base changed a dependency file since the mark's fork", async () => {
    const started = Deferred.makeUnsafe<void>()
    const settings = appConfig().settings
    const config = {
      settings: {
        ...settings,
        checks: {
          ...settings.checks,
          setup: { command: "bun install", files: ["package.json"] },
        },
      },
    }
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, config, checks: { fast: [hanging(started)] } },
      Effect.gen(function* () {
        const repository = yield* Repository
        const a = yield* finished("a", { "a.txt": "a\n" })
        yield* moveMain({ "package.json": "{}\n" })
        yield* quitDuringCheck(a, started)
        const next = yield* nextRun(a)
        return { next, merged: (yield* repository.tree("main")).get("a.txt") }
      }),
    )
    const result = resultOf(ran)
    expect(result.next?._tag).toBe("Done")
    expect(result.merged).toBe("a\n")
    // Each run sets it up before its check: the first's setup is lost with the quit.
    expect(checksRun(ran)).toEqual(["setup", "fast", "setup", "fast"])
  })
})

describe("the rebased-and-unchecked mark", () => {
  test("is cleared once the rebased branch's check passes, and the branch merges", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      Effect.gen(function* () {
        const repository = yield* Repository
        const a = yield* finished("a", { "a.txt": "a\n" })
        yield* moveMain()
        const phase = yield* nextRun(a)
        return {
          phase,
          merged: (yield* repository.tree("main")).get("a.txt"),
          mark: yield* markOf("a"),
        }
      }),
    )
    const result = resultOf(ran)
    expect(result.phase?._tag).toBe("Done")
    expect(result.merged).toBe("a\n")
    expect(result.mark).toBeUndefined()
    expect(checksRun(ran)).toEqual(["fast"])
  })

  test("isn't there for a branch on top of the base tutti never rebased: it merges unchecked", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      Effect.gen(function* () {
        const a = yield* finished("a", { "a.txt": "a\n" })
        return yield* nextRun(a)
      }),
    )
    expect(resultOf(ran)?._tag).toBe("Done")
    expect(checksRun(ran)).toEqual([])
  })

  test("found on a branch on top of the base, with nothing of where, still has it checked", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      Effect.gen(function* () {
        const a = yield* finished("a", { "a.txt": "a\n" })
        yield* (yield* Store).setMetadata("a", uncheckedKey, "edited by hand")
        const phase = yield* nextRun(a)
        return { phase, mark: yield* markOf("a") }
      }),
    )
    const result = resultOf(ran)
    expect(result.phase?._tag).toBe("Done")
    expect(result.mark).toBeUndefined()
    expect(checksRun(ran)).toEqual(["fast"])
  })
})

describe("uncheckedOf", () => {
  test("reads a mark's fork and head", () => {
    expect(uncheckedOf({ fork: "abc1234", head: "def5678" })).toEqual({
      fork: "abc1234",
      head: "def5678",
    })
  })

  test("is undefined for no mark", () => {
    expect(uncheckedOf(undefined)).toBeUndefined()
    expect(uncheckedOf(null)).toBeUndefined()
  })

  test("takes only a commit hash for a commit", () => {
    expect(uncheckedOf({ fork: "--upload-pack=x", head: 7 })).toEqual({ fork: "", head: "" })
    expect(uncheckedOf(["abc1234"])).toEqual({ fork: "", head: "" })
  })

  test("gives a mark, its commits hashes or none, for any JSON a hand left there", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const mark = uncheckedOf(value as Parameters<typeof uncheckedOf>[0])
        if (value === null) return mark === undefined
        return (
          mark !== undefined &&
          [mark.fork, mark.head].every((each) => each === "" || /^[0-9a-f]{7,64}$/.test(each))
        )
      }),
    )
  })
})
