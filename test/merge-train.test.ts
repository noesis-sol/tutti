// The merge train (mergetrain.ts, orchestra 0.8.6 and 0.9.0's blame): while a ticket is checked in
// its turn, the next in line is rebased onto its branch and checked beside it. Each scenario merges
// two finished tickets, a then b, behind a base that moved on while they ran.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Exit, Fiber, type Scope } from "effect"
import { importSettings } from "../src/init/import.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Scripted } from "../src/testing/Checks.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** The settings: a check command, failed checks set aside at once, and `train` checked ahead. */
const settings = (train = 1, setup = defaults.checks.setup) => ({
  ...defaults,
  checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check }, setup },
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

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

/** A ticket its worker finished: a commit naming it on tutti/<id>, closed, Working. */
const finished = (id: string, files: Files) =>
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

interface Merged {
  readonly phases: Record<string, PhaseTag>
  /** b's branch before it was offered, and after the scenario's body. */
  readonly b: { readonly before: string; readonly after: string }
  /** main's files at the end. */
  readonly main: ReadonlyMap<string, string>
}

/**
 * a and b finished, main moved on, both offered in that order with a merge queue in a scope of its
 * own; `body` runs then, the queue settled after it unless it says otherwise.
 */
const twoTickets = (
  plan: {
    readonly train?: number
    readonly checks: ReadonlyArray<Scripted>
    readonly files?: { readonly a: Files; readonly b: Files }
    readonly machineFull?: boolean
    /** The setup command, run when deps.txt changes. */
    readonly setup?: boolean
  },
  body: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger | Scope.Scope> = (queue) =>
    Effect.asVoid(queue.settled),
) =>
  scenario(
    {
      config: {
        settings: settings(
          plan.train,
          plan.setup === true ? { command: "install.sh", files: ["deps.txt"] } : undefined,
        ),
      },
      backlog: backlog().ticket("a").ticket("b").seeds,
      checks: { fast: plan.checks },
    },
    Effect.gen(function* () {
      const queue = yield* makeQueue({
        repo: "/repo",
        base: "main",
        ...(plan.machineFull === undefined
          ? {}
          : { machineFull: Effect.succeed(plan.machineFull) }),
      })
      const repository = yield* Repository
      const a = yield* finished("a", plan.files?.a ?? { "a.txt": "a\n" })
      const b = yield* finished("b", plan.files?.b ?? { "b.txt": "b\n" })
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      const before = yield* repository.head(b.branch)
      yield* queue.offer(a)
      yield* queue.offer(b)
      yield* body(queue)
      const after = yield* repository.head(b.branch).pipe(Effect.orElseSucceed(() => ""))
      return {
        phases: tagsOf(yield* (yield* Ledger).current),
        b: { before, after },
        main: yield* repository.tree("main"),
      } satisfies Merged
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )

/** The tickets the checks ran for, in order. */
const checked = (ran: Ran<unknown>) => ran.checkRuns.map(whose)

const aheadLine =
  "  checking tutti/b ahead of its turn to merge, rebased onto tutti/a as it is checked"
const passedAhead = `  '${check}' passes on tutti/b ahead of its turn, on top of tutti/a`

describe("the next ticket in line", () => {
  test("is checked while the one ahead is, and merges after it with no second check", async () => {
    // a's check passes once b's, ahead of its turn, has passed beside it.
    const bPassed = Deferred.makeUnsafe<void>()
    const ran = await twoTickets({
      checks: each((id) =>
        id === "a" ? Deferred.await(bPassed) : Deferred.succeed(bPassed, undefined),
      ),
    })
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Done" })
    expect(checked(ran)).toEqual(["a", "b"])
    expect(merged.main.get("a.txt")).toBe("a\n")
    expect(merged.main.get("b.txt")).toBe("b\n")
    const noFurther =
      "  tutti/b was checked ahead of its turn on top of tutti/a, which merged as it was checked: merging it with no further check"
    expectLog(ran, [
      "  rebased tutti/a onto main, which moved on while it ran",
      aheadLine,
      passedAhead,
      noFurther,
      /^ {2}b closed .*; merged into main/,
    ])
    expectLog(ran, [`  '${check}' passes on the rebased tutti/a`, /^ {2}a closed /, noFurther])
    expect(ran.log.some((text) => text.includes("rebased tutti/b onto main"))).toBe(false)
    // b's check record says it ran ahead of its turn (§ 10); a's doesn't.
    const records = ran.events.flatMap((r) => (r.kind === "check" ? [r] : []))
    expect(records.map((r) => [r.ticket, r.suite, r.train ?? false])).toEqual(
      expect.arrayContaining([
        ["a", "merge", false],
        ["b", "merge", true],
      ]),
    )
  })

  test("whose own check fails ahead of its turn is put back, rebased and checked in its turn", async () => {
    // b's check fails ahead of its turn, then passes in it; a's passes once b's has failed.
    const bFailed = Deferred.makeUnsafe<void>()
    const ran = await twoTickets({
      checks: each((id, nth) =>
        id === "a"
          ? Deferred.await(bFailed)
          : nth === 1
            ? Effect.andThen(Deferred.succeed(bFailed, undefined), Effect.fail(failing))
            : Effect.void,
      ),
    })
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Done" })
    expect(checked(ran)).toEqual(["a", "b", "b"])
    expect(merged.main.get("b.txt")).toBe("b\n")
    const putBack =
      /^ {2}tutti\/b was checked ahead of its turn on top of tutti\/a, which merged as it was checked, but 'scripts\/check-fast\.sh' fails on tutti\/b on top of it \(output is in .*\): put back as its worker left it$/
    expectLog(ran, [
      aheadLine,
      /^ {2}'scripts\/check-fast\.sh' fails on tutti\/b ahead of its turn, on top of tutti\/a \(output is in .*\/b\/\.tutti\/run\/check\.log\); it is checked again in its turn$/,
      putBack,
      "  rebased tutti/b onto main, which moved on while it ran",
      `  '${check}' passes on the rebased tutti/b`,
      /^ {2}b closed .*; merged into main/,
    ])
    expectLog(ran, [/^ {2}a closed .*; merged into main/, putBack])
    expect(ran.log.some((text) => text.includes("did not merge as it was checked"))).toBe(false)
    // A failure ahead of its turn says nothing of the ticket: no warning, no note.
    expect(ran.events.filter((record) => record.kind === "warn")).toEqual([])
  })

  test("is put back, rebased and checked in its turn when the one ahead fails its check", async () => {
    // b's check passes ahead of its turn; a's then fails, and a is set aside. b's train may be stopped
    // before it records its pass: either way, it didn't merge as it was checked.
    const bPassed = Deferred.makeUnsafe<void>()
    const ran = await twoTickets({
      checks: each((id) =>
        id === "a"
          ? Effect.andThen(Deferred.await(bPassed), Effect.fail(failing))
          : Deferred.succeed(bPassed, undefined),
      ),
    })
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Review", b: "Done" })
    // a is checked once more after b's merge moved main on, and fails again.
    expect(checked(ran)).toEqual(["a", "b", "b", "a"])
    // b merged as its worker left it, rebased onto main: none of a's change came with it.
    expect(merged.main.has("a.txt")).toBe(false)
    expect(merged.main.get("b.txt")).toBe("b\n")
    expectLog(ran, [
      aheadLine,
      /^ {2}CHECKS_FAILED: a closed, but/,
      "  tutti/b was checked ahead of its turn on top of tutti/a, which did not merge as it was checked: put back as its worker left it",
      "  rebased tutti/b onto main, which moved on while it ran",
      `  '${check}' passes on the rebased tutti/b`,
      /^ {2}b closed .*; merged into main/,
    ])
  })

  test("set up on top of the one ahead, which fails, is set up again in its turn", async () => {
    // a changes deps.txt, the setup's file, so b is set up on top of tutti/a ahead of its turn; a's
    // check then fails. b's dependencies are a's: its turn sets it up again on main.
    const bPassed = Deferred.makeUnsafe<void>()
    const ran = await twoTickets({
      setup: true,
      files: { a: { "deps.txt": "a's deps\n", "a.txt": "a\n" }, b: { "b.txt": "b\n" } },
      checks: each((id) =>
        id === "a"
          ? Effect.andThen(Deferred.await(bPassed), Effect.fail(failing))
          : Deferred.succeed(bPassed, undefined),
      ),
    })
    const merged = resultOf(ran)
    expect(merged.phases.b).toBe("Done")
    expect(merged.main.has("deps.txt")).toBe(false)
    const setUpB = ran.checkRuns.filter((run) => run.check === "setup" && whose(run) === "b")
    expect(setUpB).toHaveLength(2)
    expectLog(ran, [
      "  b: deps.txt changed in the rebase; running 'install.sh' before the check",
      "  tutti/b was checked ahead of its turn on top of tutti/a, which did not merge as it was checked: put back as its worker left it",
      "  rebased tutti/b onto main, which moved on while it ran",
      "  b: its dependencies were set up on top of tutti/a, ahead of its turn; running 'install.sh' before the check",
      `  '${check}' passes on the rebased tutti/b`,
    ])
  })

  test("that doesn't rebase cleanly onto the one ahead isn't checked ahead", async () => {
    const ran = await twoTickets({
      checks: each(() => Effect.void),
      files: { a: { "x.txt": "a's x\n" }, b: { "x.txt": "b's x\n" } },
    })
    const merged = resultOf(ran)
    expect(merged.phases.a).toBe("Done")
    // Its turn rebases it onto main, where it conflicts, as it would without the train.
    expect(merged.phases.b).toBe("Blocked")
    expect(checked(ran)).toEqual(["a"])
    expectLog(ran, [
      "  tutti/b is not checked ahead of its turn: it does not rebase cleanly onto tutti/a",
      /^ {2}a closed .*; merged into main/,
      /^ {2}MERGE_CONFLICT: b closed, but tutti\/b conflicts with main in x\.txt/,
    ])
    expect(merged.b.after).toBe(merged.b.before)
  })

  test("is checked in its turn alone with merge.train 0", async () => {
    const ran = await twoTickets({ train: 0, checks: each(() => Effect.void) })
    expect(resultOf(ran).phases).toEqual({ a: "Done", b: "Done" })
    expect(checked(ran)).toEqual(["a", "b"])
    expect(ran.log.some((text) => text.includes("ahead of its turn"))).toBe(false)
    expectLog(ran, ["  rebased tutti/b onto main, which moved on while it ran"])
  })

  test("isn't checked ahead while the run holds at the machine's cap", async () => {
    const ran = await twoTickets({ machineFull: true, checks: each(() => Effect.void) })
    expect(resultOf(ran).phases).toEqual({ a: "Done", b: "Done" })
    expect(checked(ran)).toEqual(["a", "b"])
    expect(ran.log.some((text) => text.includes("ahead of its turn"))).toBe(false)
  })

  test("is put back as its worker left it when the run stops before its turn", async () => {
    // a's check never ends; b's passes ahead of its turn, then the run quits.
    const bPassed = Deferred.makeUnsafe<void>()
    const ran = await twoTickets(
      {
        checks: each((id) => (id === "a" ? Effect.never : Deferred.succeed(bPassed, undefined))),
      },
      (queue) =>
        Effect.gen(function* () {
          yield* Deferred.await(bPassed)
          // Its pass is recorded as its check's fiber ends.
          yield* Effect.yieldNow
          yield* queue.hold
          yield* queue.stopMerges
        }),
    )
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "ToMerge", b: "ToMerge" })
    expect(merged.b.after).toBe(merged.b.before)
    expect(merged.main.has("b.txt")).toBe(false)
    expectLog(ran, [
      aheadLine,
      "  tutti/b was rebased onto tutti/a to be checked ahead of its turn, but the run stopped before its turn: put back as its worker left it",
    ])
  })
})

describe("merge.train", () => {
  test("is 1 by default, and orchestra's merge_train imports to it", () => {
    expect(defaults.merge.train).toBe(1)
    const imported = importSettings({ merge_train: 2 })
    expect(imported.json).toEqual({ merge: { train: 2 } })
    expect(imported.imported).toEqual([{ key: "merge_train", to: "merge.train" }])
    expect(importSettings({ merge_train: -1 }).leftOut.map((left) => left.key)).toEqual([
      "merge_train (-1)",
    ])
  })
})

/** Claims its ticket and, after `takes`, commits a file and closes it, as a worker does. */
const works = (world: World, root: string, id: string, takes: Duration.Input): SessionScript =>
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

describe("a whole run", () => {
  test("merges the ticket checked ahead of its turn as soon as the one ahead merges", async () => {
    // Two slots. a closes at once and its check, on top of main, takes 10m. b closes at 1m and is
    // checked ahead of its turn on top of tutti/a, in 5m: once a merges at 10m, b merges with no
    // second check.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-merge-train-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-merge-train-worktrees-")))
    const slow = (takes: Duration.Input) => Effect.as(Effect.sleep(takes), passed("fast"))
    let main: ReadonlyMap<string, string> = new Map()
    const ran = await scenario(
      {
        config: { repo, worktrees: root, settings: { ...settings(), concurrent: 2 } },
        backlog: backlog().ticket("a", { priority: 0 }).ticket("b", { priority: 1 }).seeds,
        git: { dir: repo },
        worktrees: { root },
        checks: { fast: [slow("10 minutes"), slow("5 minutes")] },
        scripts: (world: World) => ({
          a: [works(world, root, "a", 0)],
          b: [works(world, root, "b", "1 minute")],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["a", "b"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        const polls = Duration.toMillis(Duration.minutes(12)) / Duration.toMillis(readyPoll)
        for (let i = 0; i < polls; i++) {
          yield* caughtUp
          yield* advance(readyPoll)
        }
        const outcome = yield* Fiber.join(fiber)
        main = yield* (yield* Repository).tree("main")
        return outcome
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(ran.leaks).toEqual({ fibers: [], processes: [] })
    expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
    expect(checked(ran)).toEqual(["a", "b"])
    expect([main.get("a.txt"), main.get("b.txt")]).toEqual(["a\n", "b\n"])
    expectLog(ran, [
      `  tutti/a is on top of main already: checking it with '${check}' before it merges`,
      aheadLine,
      "  'scripted fast' passes on tutti/b ahead of its turn, on top of tutti/a",
      /^ {2}a closed .*; merged into main/,
      "  tutti/b was checked ahead of its turn on top of tutti/a, which merged as it was checked: merging it with no further check",
      /^ {2}b closed .*; merged into main/,
      "READY_EMPTY after 2 tickets",
    ])
  }, 30_000)
})
