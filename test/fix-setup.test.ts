import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
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
import type { Script } from "../src/testing/Checks.ts"
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

// The setup (setup.ts) before the check on a worker's own commits: its fix of a failed check
// (checkback.ts) or its resolution of a rebase (handback.ts), when they change a setup file, as
// orchestra's checkRebased has it.

const options = { repo: "/repo", base: "main" }
const check = "scripts/check-fast.sh"
const setupCommand = "bun install --frozen-lockfile"

/** The default settings with a check command and the setup, for bun.lock. */
const defaults = appConfig().settings
const config = {
  settings: {
    ...defaults,
    checks: {
      ...defaults.checks,
      fast: { ...defaults.checks.fast, command: check },
      setup: { command: setupCommand, files: ["bun.lock"] },
    },
  },
}

const said = {
  lastLines: ["error: a.test.ts: expected 1"],
  failingLines: ["error: a.test.ts: expected 1"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
}

const failing = new CheckFailed({
  check: "fast",
  command: check,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  ...said,
})

const setupFailed = new CheckFailed({
  check: "setup",
  command: setupCommand,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  ...said,
})

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phasesOf = (state: State): Record<string, TicketPhase> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

/** Where the ticket's worktree is, once `finished` has made it: for its worker's script. */
const worktrees = new Map<string, string>()
const worktreeOf = (id: string) => worktrees.get(id) ?? ""

/** The worker's first session: it finished its ticket, idle, then plays `then`. */
const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

/** A hand-back turn in which the worker commits a fix naming the ticket, writing `files`. */
const fixes = (world: World, id: string, files: Files) =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(world.repository.commit(worktreeOf(id), `Fix the check (${id})`, files)),
      ),
    ),
  ])

/** A hand-back turn in which the worker resolves the rebase's conflict, writing `files`. */
const resolves = (world: World, id: string, files: Files) =>
  turn([
    run(
      Effect.suspend(() => Effect.asVoid(world.repository.continueRebase(worktreeOf(id), files))),
    ),
  ])

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads,
 * Working in the ledger, its session started and saved, and its worker idle.
 */
const finished = (id: string, files: Files) =>
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

/** Runs `body` with a merge queue in a scope of its own, and hands back each ticket's phase. */
const withQueue = <E>(
  body: (queue: MergeQueue) => Effect.Effect<void, E, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const queue = yield* makeQueue(options)
    yield* body(queue)
    return phasesOf(yield* (yield* Ledger).current)
  }).pipe(Effect.provide(Ledger.layer))

/**
 * Finishes ticket a (a.txt and bun.lock), lands `landed` on main, offers a to the queue with the
 * checks `checks` plays, and waits until the queue settles.
 */
const merged = (landed: Files, checks: Script, scripts: (world: World) => Scripts) =>
  scenario(
    { backlog: backlog().ticket("a").seeds, config, checks, scripts },
    withQueue((queue) =>
      Effect.gen(function* () {
        const ticket = yield* finished("a", { "a.txt": "a\n", "bun.lock": "a's\n" })
        const repository = yield* Repository
        yield* repository.commit(repository.dir, "Land something else", landed)
        yield* queue.offer(ticket)
        yield* queue.settled
      }),
    ),
  )

const fixLine = `  a: bun.lock changed in its worker's fix; running '${setupCommand}' before the check`
const passesLine = `  '${check}' passes on tutti/a as its worker fixed it`

describe("the setup before a fix's check", () => {
  test("runs when the fix changes a setup file, though the rebase brought none", async () => {
    const ran = await merged({ "b.txt": "b\n" }, { fast: [failing] }, (world) => ({
      a: [finishedSession(fixes(world, "a", { "bun.lock": "fixed\n" }))],
    }))
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["fast", "setup", "fast"])
    const [, setup, checked] = ran.checkRuns
    expect(setup?.cwd).toBe(worktreeOf("a"))
    expect(checked?.cwd).toBe(worktreeOf("a"))
    expectLog(ran, [/^ {2}FIXING: /, fixLine, passesLine, /^ {2}a closed /])
  })

  test("doesn't run when neither the fix nor the rebase changes one", async () => {
    const ran = await merged({ "b.txt": "b\n" }, { fast: [failing] }, (world) => ({
      a: [finishedSession(fixes(world, "a", { "fix.txt": "fixed\n" }))],
    }))
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["fast", "fast"])
    expect(ran.log.some((each) => each.includes("before the check"))).toBe(false)
  })

  test("names the rebase's files and the fix's apart", async () => {
    const both = { ...config.settings.checks.setup, files: ["bun.lock", "package.json"] }
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").seeds,
        config: {
          settings: { ...config.settings, checks: { ...config.settings.checks, setup: both } },
        },
        checks: { fast: [failing] },
        scripts: (world) => ({
          a: [finishedSession(fixes(world, "a", { "bun.lock": "fixed\n" }))],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const ticket = yield* finished("a", { "a.txt": "a\n" })
          const repository = yield* Repository
          yield* repository.commit(repository.dir, "Land something else", {
            "package.json": "{}\n",
          })
          yield* queue.offer(ticket)
          yield* queue.settled
        }),
      ),
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    // The merge's setup, for package.json, passed: the fix's sets up again for its bun.lock.
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["setup", "fast", "setup", "fast"])
    expectLog(ran, [
      `  a: package.json changed in the rebase; running '${setupCommand}' before the check`,
      /^ {2}FIXING: /,
      fixLine,
      passesLine,
    ])
  })

  test("failing, runs again before the next fix's check, which changes none", async () => {
    const ran = await merged(
      { "b.txt": "b\n" },
      { fast: [failing], setup: [setupFailed] },
      (world) => ({
        a: [
          finishedSession([
            ...fixes(world, "a", { "bun.lock": "fixed\n" }),
            ...fixes(world, "a", { "fix.txt": "fixed\n" }),
          ]),
        ],
      }),
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    // The failed setup leaves the worktree set up for the branch before the first fix, so the
    // second fix's check sets up for the first's bun.lock.
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["fast", "setup", "setup", "fast"])
    expectLog(ran, [/^ {2}FIXING: /, fixLine, /^ {2}FIXING: /, fixLine, passesLine])
  })
})

describe("the setup before a resolution's check", () => {
  test("runs when the resolution changes a setup file, though the base brought none", async () => {
    const ran = await merged({ "a.txt": "main's a\n" }, {}, (world) => ({
      a: [finishedSession(resolves(world, "a", { "a.txt": "both\n", "bun.lock": "both\n" }))],
    }))
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["setup", "fast"])
    expectLog(ran, [
      /^ {2}RESOLVING: /,
      `  a: bun.lock changed in its worker's resolution; running '${setupCommand}' before the check`,
      /^ {2}a closed /,
    ])
  })

  test("doesn't run when the resolution keeps the setup files as they were", async () => {
    const ran = await merged({ "a.txt": "main's a\n" }, {}, (world) => ({
      a: [finishedSession(resolves(world, "a", { "a.txt": "both\n" }))],
    }))
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["fast"])
    expect(ran.log.some((each) => each.includes("before the check"))).toBe(false)
  })
})
