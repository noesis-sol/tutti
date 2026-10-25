// The latest action of a ticket checked ahead of its turn to merge (orchestra 0.8.6's
// mergeTrain.activity, merge_train_dashboard_test.go): its card says how its check ahead goes, from
// its rebase onto the branch ahead to its turn.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { EventStream } from "../src/run/eventstream.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { line } from "../src/run/log.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import type { CheckAhead } from "../src/run/mergetrain.ts"
import { Move } from "../src/run/phase.ts"
import { run } from "../src/run/run.ts"
import { checkAheadText, emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed, type Scripted } from "../src/testing/Checks.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"
import { advance, backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const checking = "checked ahead of its turn, on top of tutti/a as it is checked"
const passedAhead =
  "passed its check ahead of its turn, on top of tutti/a: merges with no further check if tutti/a merges as checked"

describe("checkAheadText", () => {
  test("says each step of the check ahead of its turn as orchestra's dashboard does", () => {
    const text = (step: CheckAhead["step"]) => checkAheadText({ step, behind: "tutti/a" })
    expect(text("rebase")).toBe(
      "rebasing onto tutti/a, to be checked ahead of its turn on top of it as it is checked",
    )
    expect(text("check")).toBe(checking)
    expect(text("passed")).toBe(passedAhead)
    expect(text("failed")).toBe(
      "failed its check ahead of its turn, on top of tutti/a: checked again in its turn",
    )
  })

  test("says the branch ahead sanitised, whatever its ticket's ID", () => {
    const steps = fc.constantFrom<CheckAhead["step"]>("rebase", "check", "passed", "failed")
    fc.assert(
      fc.property(steps, fc.string({ unit: "binary" }), (step, behind) => {
        const text = checkAheadText({ step, behind })
        expect(sanitizeLine(text)).toBe(text)
        expect(text).toBe(checkAheadText({ step, behind: sanitizeLine(behind) }))
      }),
    )
  })
})

type Env = Ledger | Log | EventStream | Captured | Scope.Scope

/** Runs `effect` with the ledger over captured logs and events, under TestClock, in a scope. */
const withLedger = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
    ),
  )

/** Moves `ticket` by each of `causes` in turn, failing the test on an invalid one. */
const go = (ticket: TicketId, ...causes: ReadonlyArray<Move>) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    for (const [i, cause] of causes.entries()) {
      const options = i === 0 ? { title: `Title of ${ticket}` } : {}
      const next = yield* ledger.transition(ticket, cause, options)
      if (Result.isFailure(next)) throw new Error(next.failure.phaseBug(ticket))
    }
  })

const toMerge = [Move.Ready(), Move.Dispatched(), Move.Verified({ place: 1 })] as const

/** The card's action line of `ticket` with `checksAhead`. */
const actionWith = (ticket: string, checksAhead: ReadonlyMap<string, CheckAhead>) =>
  Effect.gen(function* () {
    const ledger = yield* (yield* Ledger).current
    const status = { ...emptyStatus, branch: "main", concurrency: 2, checksAhead }
    const view = project({ ledger, workers: new Map(), requests: [], status })
    return view.cards.find((card) => card.ticket === ticket)?.action
  })

describe("a card waiting to merge", () => {
  test("says how its check ahead of its turn goes, and nothing once there is none", async () => {
    const seen = await withLedger(
      Effect.gen(function* () {
        yield* go("b" as TicketId, ...toMerge)
        const failed: CheckAhead = { step: "failed", behind: "tutti/a" }
        return {
          checking: yield* actionWith("b", new Map([["b", { step: "check", behind: "tutti/a" }]])),
          failed: yield* actionWith("b", new Map([["b", failed]])),
          other: yield* actionWith("b", new Map([["c", failed]])),
          none: yield* actionWith("b", new Map()),
        }
      }),
    )
    expect(seen).toEqual({
      checking,
      failed: "failed its check ahead of its turn, on top of tutti/a: checked again in its turn",
      other: null,
      none: null,
    })
  })

  test("says it in its turn while its train is boarded, its merge's step after", async () => {
    const seen = await withLedger(
      Effect.gen(function* () {
        yield* go("b" as TicketId, ...toMerge, Move.ItsTurn())
        return {
          boarding: yield* actionWith("b", new Map([["b", { step: "check", behind: "tutti/a" }]])),
          after: yield* actionWith("b", new Map()),
        }
      }),
    )
    expect(seen).toEqual({ boarding: checking, after: "rebasing onto main" })
  })
})

/** Claims its ticket and, after `takes`, commits a file and closes it, as a worker does. */
const works = (world: World, root: string, id: TicketId, takes: Duration.Input): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      sleep(takes),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: `${id}\n` }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** Waits, in real time, until the run has written no log line or record for 30 ms. */
const caughtUp = Effect.gen(function* () {
  const captured = yield* Captured
  let said = -1
  for (let i = 0, still = 0; i < 1000 && still < 6; i++) {
    const now = (yield* texts).length + (yield* captured.records).length
    still = now === said ? still + 1 : 0
    said = now
    yield* Effect.promise(() => Bun.sleep(5))
  }
})

const failing = new CheckFailed({
  check: "fast",
  command: "scripts/check-fast.sh",
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: b.test.ts: expected 1"],
  lastLines: ["1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

/**
 * A whole run on two slots: a closes at once and its check, on top of main, takes 10m. b closes at
 * 1m and is checked ahead of its turn on top of tutti/a as `checks` say, then in its turn if need
 * be. What b's card says, its status and action line, each time they change.
 */
const watched = async (checks: ReadonlyArray<Scripted>) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-train-dashboard-repo-")))
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-train-dashboard-worktrees-")))
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: 2,
    checks: {
      ...defaults.checks,
      fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
    },
    merge: { ...defaults.merge, check_hand_backs: 0, train: 1 },
  }
  const actions: Array<string> = []
  const ran = await scenario(
    {
      config: { repo, worktrees: root, settings },
      backlog: backlog().ticket("a", { priority: 0 }).ticket("b", { priority: 1 }).seeds,
      git: { dir: repo },
      worktrees: { root },
      checks: { fast: [slow("10 minutes"), ...checks] },
      scripts: (world: World) => ({
        a: [works(world, root, "a" as TicketId, 0)],
        b: [works(world, root, "b" as TicketId, "1 minute")],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["a", "b"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      const look = Effect.gen(function* () {
        if (shown === undefined) return
        const view: RunView = yield* SubscriptionRef.get(shown.view)
        const card = view.cards.find((one) => one.ticket === "b")
        const said = `${card?.status ?? "no card"}: ${card?.action ?? card?.latest?.text ?? ""}`
        if (actions.at(-1) !== said) actions.push(said)
      })
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
        }),
      )
      const polls = Duration.toMillis(Duration.minutes(12)) / Duration.toMillis(readyPoll)
      for (let i = 0; i < polls; i++) {
        yield* caughtUp
        yield* advance(readyPoll)
        yield* caughtUp
        yield* look
      }
      return yield* Fiber.join(fiber)
    }),
  )
  expectExitCode(ran, 0)
  expectPhases(ran, { a: "Done", b: "Done" })
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
  // Once its turn comes, its card no longer says it: it merges, and has no card at the end.
  expect(actions.filter((said) => said.startsWith("merging")).join("\n")).not.toContain("ahead")
  expect(actions.at(-1)).toBe("no card: ")
  // Before its train starts, it says nothing; its rebase is over before the dashboard looks.
  return actions.filter((said) => said.startsWith("to merge") && !said.endsWith(": "))
}

const slow = (takes: Duration.Input) => Effect.as(Effect.sleep(takes), passed("fast"))

describe("a whole run's dashboard", () => {
  test("shows b checked ahead of its turn, then passed, until it merges", async () => {
    const waiting = await watched([slow("5 minutes")])
    expect(waiting).toEqual([`to merge (1st): ${checking}`, `to merge (1st): ${passedAhead}`])
  }, 30_000)

  test("shows b checked ahead of its turn, then failed, until its turn checks it", async () => {
    const fails = Effect.andThen(Effect.sleep("5 minutes"), Effect.fail(failing))
    const waiting = await watched([fails, passed("fast")])
    expect(waiting).toEqual([
      `to merge (1st): ${checking}`,
      "to merge (1st): failed its check ahead of its turn, on top of tutti/a: checked again in its turn",
    ])
  }, 30_000)
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
    yield* go(id, Move.Ready(), Move.Dispatched())
    return {
      id,
      title: `Title of ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

describe("the merge queue's checks ahead", () => {
  test("show none once quitting stops them", async () => {
    // a's check never ends; b's passes ahead of its turn, then the queue is held as quitting.
    const bPassed = Deferred.makeUnsafe<void>()
    const ran = await scenario(
      {
        config: {
          settings: {
            ...appConfig().settings,
            checks: {
              ...appConfig().settings.checks,
              fast: { ...appConfig().settings.checks.fast, command: "scripts/check-fast.sh" },
            },
          },
        },
        backlog: backlog().ticket("a").ticket("b").seeds,
        checks: {
          fast: [Effect.never, Effect.as(Deferred.succeed(bPassed, undefined), passed("fast"))],
        },
      },
      Effect.gen(function* () {
        const queue = yield* makeQueue({ repo: "/repo", base: "main" })
        const repository = yield* Repository
        const a = yield* finished("a" as TicketId, { "a.txt": "a\n" })
        const b = yield* finished("b" as TicketId, { "b.txt": "b\n" })
        yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        yield* queue.offer(a)
        yield* queue.offer(b)
        yield* Deferred.await(bPassed)
        const now = Effect.map(Stream.runHead(queue.checksAhead), Option.getOrThrow)
        const shown = yield* Stream.runHead(
          Stream.filter(queue.checksAhead, (all) => all.get("b")?.step === "passed"),
        )
        const before = Option.getOrThrow(shown)
        yield* queue.hold
        yield* queue.stopMerges
        return { before: Object.fromEntries(before), after: Object.fromEntries(yield* now) }
      }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
    )
    if (ran.exit._tag === "Failure") throw new Error(`the scenario failed: ${ran.exit.cause}`)
    expect(ran.exit.value).toEqual({
      before: { b: { step: "passed", behind: "tutti/a" } },
      after: {},
    })
  })
})
