import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type PhaseTag, type TicketPhase } from "../src/run/phase.ts"
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

// The setup (setup.ts) before the check on a rebase its worker resolved (handback.ts), and before
// the check on a fix after one (checkback.ts's fixResolution).

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

const setupFailed = new CheckFailed({
  check: "setup",
  command: setupCommand,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: could not resolve left-pad"],
  lastLines: ["error: could not resolve left-pad"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phasesOf = (state: State): Record<string, TicketPhase> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** The ticket's phase once it is in `tag`. */
const phaseIn = (id: string, tag: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const found = yield* ledger.changes.pipe(
      Stream.map((state) => state.tickets.get(id)?.phase),
      Stream.filter((phase) => phase?._tag === tag),
      Stream.runHead,
    )
    return found._tag === "Some" ? found.value : undefined
  })

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

/** A hand-back turn in which the worker resolves the rebase's conflict, writing `files`. */
const resolves = (world: World, id: string, files: Files) =>
  turn([
    run(
      Effect.suspend(() => Effect.asVoid(world.repository.continueRebase(worktreeOf(id), files))),
    ),
  ])

/** A hand-back turn in which the worker commits a fix naming the ticket. */
const fixes = (world: World, id: string) =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(
          world.repository.commit(worktreeOf(id), `Fix the check (${id})`, { "fix.txt": "x\n" }),
        ),
      ),
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
 * Finishes ticket a (a.txt), lands `landed` on main, a change to a.txt that conflicts with it
 * among them, offers it to the queue with the checks `checks` plays, and waits until the queue
 * settles, `during` running beside it.
 */
const conflicted = (
  landed: Files,
  checks: Script,
  scripts: (world: World) => Scripts,
  during: Effect.Effect<void, unknown, Env | Ledger> = Effect.void,
) =>
  scenario(
    { backlog: backlog().ticket("a").seeds, config, checks, scripts },
    withQueue((queue) =>
      Effect.gen(function* () {
        const ticket = yield* finished("a", { "a.txt": "a\n" })
        const repository = yield* Repository
        yield* repository.commit(repository.dir, "Land something else", {
          "a.txt": "main's a\n",
          ...landed,
        })
        const beside = yield* Effect.forkChild(during)
        yield* queue.offer(ticket)
        yield* queue.settled
        yield* Fiber.join(beside)
      }),
    ),
  )

const setupLine = `  a: bun.lock changed in the rebase; running '${setupCommand}' before the check`
const checkingLine = `  a's worker finished the rebase; checking it with '${check}'`

describe("the setup before a resolution's check", () => {
  test("runs in the worktree when the base brought a setup file, then the check", async () => {
    const ran = await conflicted({ "bun.lock": "v2\n" }, {}, (world) => ({
      a: [finishedSession(resolves(world, "a", { "a.txt": "both\n" }))],
    }))
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["setup", "fast"])
    const [setup, checked] = ran.checkRuns
    expect(setup?.cwd).toEqual(expect.stringMatching(/\/a$/))
    expect(setup?.cwd).toBe(checked?.cwd as string)
    expect(setup?.outputFile).toBe(`${setup?.cwd}/.tutti/run/setup.log`)
    expectLog(ran, [/^ {2}RESOLVING: /, checkingLine, setupLine, /^ {2}a closed /])
  })

  test("doesn't run when the base brought no setup file", async () => {
    const ran = await conflicted({ "b.txt": "b\n" }, {}, (world) => ({
      a: [finishedSession(resolves(world, "a", { "a.txt": "both\n" }))],
    }))
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["fast"])
    expect(ran.log.some((each) => each.includes("before the check"))).toBe(false)
  })

  test("failing, is handed back as a failed check, and the fix is set up again", async () => {
    let fixing: TicketPhase | undefined
    const ran = await conflicted(
      { "bun.lock": "v2\n" },
      { setup: [setupFailed] },
      (world) => ({
        a: [
          finishedSession([...resolves(world, "a", { "a.txt": "both\n" }), ...fixes(world, "a")]),
        ],
      }),
      Effect.gen(function* () {
        fixing = yield* phaseIn("a", "Fixing")
      }),
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(fixing).toEqual(expect.objectContaining({ attempt: 1, afterResolution: true }))
    expect(pathOf(ran, "a")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "Fixing",
      "ToMerge",
      "Merging",
      "Done",
    ])
    // The failed setup leaves the worktree set up for where its branch left main, so the fix's
    // setup runs again, before its check.
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["setup", "setup", "fast"])
    expectLog(ran, [
      /^ {2}RESOLVING: /,
      checkingLine,
      setupLine,
      /^ {2}FIXING: the setup '.*', run before the check, fails on tutti\/a rebased onto main; /,
      setupLine,
      `  '${check}' passes on tutti/a as its worker fixed it`,
      /^ {2}a closed /,
    ])
  })
})
