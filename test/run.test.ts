import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Fiber, Queue, type Scope } from "effect"
import { Command } from "effect/cli"
import { requestFile } from "../src/agent/attentionFiles.ts"
import { planServices, tuttiWith } from "../src/cli/commands.ts"
import { gitAgainAfter, gitTries } from "../src/run/branch.ts"
import type { DrainRequest } from "../src/run/drain.ts"
import { drainLine, drainWords } from "../src/run/drain.ts"
import { runTime } from "../src/run/endOfRun.ts"
import {
  addStop,
  exitCodeOf,
  noStops,
  stopCodes,
  stopFor,
  stopOfLine,
  stopsLine,
} from "../src/run/holds.ts"
import { type Line, line } from "../src/run/log.ts"
import { errorStop, type Outcome, panicStop, run } from "../src/run/run.ts"
import { Beads, BeadsFailed, type TicketId } from "../src/services/Beads.ts"
import { Git, GitFailed } from "../src/services/Git.ts"
import { StoreWriteFailed } from "../src/services/Store.ts"
import {
  bash,
  canUseTool,
  claimsAndCloses,
  gone,
  type SessionScript,
  run as step,
  tool,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { Repository } from "../src/testing/Git.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

/** A new folder, its real path: the main checkout's (for the attention files), or the worktrees'. */
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-${name}-`)))

const start: ReadonlyArray<Line> = [line`START tutti 0.1.0-test`]

/** What a ticket's worker's commands do to the in-memory Beads and git. */
const commands = (world: World, root: string, id: TicketId) => {
  const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))
  return {
    claim: orDie(world.beads.update(id, { claim: true })),
    commit: orDie(
      world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
    ),
    close: orDie(world.beads.close(id, "done")),
  }
}

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  claimsAndCloses(id, commands(world, root, id))

interface Plan {
  /** The tickets whose worktrees the run makes, in git: the Worktrees test layer makes folders. */
  readonly tickets: ReadonlyArray<string>
  readonly setup: Omit<Setup, "scripts" | "worktrees"> & {
    readonly scripts: (world: World, root: string) => NonNullable<Setup["scripts"]>
  }
  /** Runs beside the run, before it is joined. */
  readonly during?: (repo: string) => Effect.Effect<void, unknown, Env>
  readonly drains?: Queue.Dequeue<DrainRequest>
  /** Changes the run's services before it starts. */
  readonly before?: (repo: string) => Effect.Effect<void, unknown, Env>
  readonly around?: (
    run: Effect.Effect<Outcome, never, Env | Scope.Scope>,
  ) => Effect.Effect<Outcome, never, Env | Scope.Scope>
}

/**
 * A whole run on main in a main checkout of its own (a real folder, for the attention files, with
 * the in-memory git there), each ticket's worktree in git where the Worktrees test layer puts it.
 */
const runs = (plan: Plan): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const { scripts, config, ...setup } = plan.setup
  return scenario(
    {
      ...setup,
      config: { ...config, repo },
      git: { ...setup.git, dir: repo },
      worktrees: { root },
      scripts: (world: World) => {
        const made = scripts(world, root)
        return typeof made === "function" ? made(world) : made
      },
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      if (plan.before !== undefined) yield* plan.before(repo)
      const running = run({
        version: "0.1.0-test",
        base: "main",
        start,
        ...(plan.drains === undefined ? {} : { drains: plan.drains }),
      })
      const fiber = yield* Effect.forkChild(
        plan.around === undefined ? running : plan.around(running),
      )
      if (plan.during !== undefined) yield* plan.during(repo)
      return yield* Fiber.join(fiber)
    }),
  )
}

const recordsOf = (ran: Ran<unknown>, kind: string) =>
  ran.events.filter((record) => record.kind === kind)

describe("a plain run", () => {
  test("dispatches, settles, merges and ends with the summary, the closing line and the end", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1", { title: "One ticket" }).seeds,
        scripts: (world, root) => ({ "t-1": [finishes(world, root, "t-1" as TicketId)] }),
      },
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      "START tutti 0.1.0-test",
      "[1] t-1 dispatching: One ticket",
      /^ {2}t-1 closed \(.*\); merged into main/,
      /^tutti 0\.1\.0-test on main · \d/,
      "  Completed 1 · Set aside 0 · Needs you 0",
      /^ {2}✓ t-1 done: /,
      "READY_EMPTY after 1 tickets",
    ])
    expectEvents(ran, ["dispatch", "closed", "done", "end"])
    expect(recordsOf(ran, "end")).toEqual([expect.objectContaining({ code: 0 })])
    expect(recordsOf(ran, "done")).toEqual([
      expect.objectContaining({ text: "READY_EMPTY after 1 tickets" }),
    ])
  })

  test("a scoped run's closing line ends with its scope line", async () => {
    const ran = await runs({
      tickets: ["e-1.1"],
      setup: {
        config: { ticket: "e-1" as TicketId },
        backlog: backlog().epic("e-1", ["e-1.1"]).ticket("other").seeds,
        scripts: (world, root) => ({ "e-1.1": [finishes(world, root, "e-1.1" as TicketId)] }),
      },
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "e-1.1": "Done" })
    expectLog(ran, [/^READY_EMPTY after 1 tickets; SCOPE_DONE: e-1/])
  })

  test("fills a freed slot at once, and ends when nothing is left to start or merge", async () => {
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      setup: {
        config: { settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        scripts: (world, root) => ({
          "t-1": [finishes(world, root, "t-1" as TicketId)],
          "t-2": [finishes(world, root, "t-2" as TicketId)],
        }),
      },
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      "[2] t-2 dispatching: t-2",
      "  Completed 2 · Set aside 0 · Needs you 0",
      "READY_EMPTY after 2 tickets",
    ])
  })
})

describe("attention in plain mode", () => {
  test("a PERMISSION line names the tutti answer command, and its answer unblocks the worker", async () => {
    const rm = { command: "rm -rf build" }
    const ran = await runs({
      tickets: ["t-1"],
      setup: {
        policy: waitForTest,
        backlog: backlog().ticket("t-1", { title: "One ticket" }).seeds,
        scripts: (world, root) => {
          const c = commands(world, root, "t-1" as TicketId)
          return {
            "t-1": [
              turn([
                ...bash("bd update t-1 --claim", c.claim),
                canUseTool("Bash", rm, {
                  decisionReason: "held by the safety check",
                  decisionReasonType: "safetyCheck",
                  suppressAlwaysAllowRule: true,
                } as never),
                ...tool("Bash", rm),
                ...bash('git commit -am "Change (t-1)"', c.commit),
                ...bash("bd close t-1", c.close),
              ]),
            ],
          }
        },
      },
      during: (repo) =>
        Effect.gen(function* () {
          // The request's file is there for tutti answer; it answers on the real clock.
          while (!existsSync(join(repo, requestFile("r1")))) {
            yield* Effect.promise(() => Bun.sleep(5))
          }
          const said: Array<string> = []
          const console: Console.Console = Object.assign(Object.create(globalThis.console), {
            log: (...args: ReadonlyArray<unknown>) => said.push(args.join(" ")),
            error: (...args: ReadonlyArray<unknown>) => said.push(args.join(" ")),
          })
          yield* Effect.promise(() =>
            Effect.runPromise(
              Command.runWith(tuttiWith(Effect.succeed(repo), planServices), { version: "test" })([
                "answer",
                "r1",
                "allow",
                "--confirm",
              ]).pipe(
                Effect.provide(BunServices.layer),
                Effect.provideService(Console.Console, console),
              ),
            ),
          )
          expect(said.join("\n")).toContain("r1")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      "  PERMISSION: t-1's worker asks: Bash(rm -rf build) (held by the safety check); answer with: tutti answer r1 allow --confirm | deny",
      "  PERMISSION: t-1's worker: Bash(rm -rf build) allowed, via tutti answer",
      /^ {2}t-1 closed \(.*\); merged into main/,
      "READY_EMPTY after 1 tickets",
    ])
    expect(recordsOf(ran, "attention_answered")).toEqual([
      expect.objectContaining({ request: "r1", answer: "allow", via: "answer_command" }),
    ])
  })
})

describe("the drain", () => {
  test("no new tickets; the running one finishes and merges; DRAINED, exit 0", async () => {
    const drains = Effect.runSync(Queue.unbounded<DrainRequest>())
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      drains,
      setup: {
        config: { settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        scripts: (world, root) => {
          const c = commands(world, root, "t-1" as TicketId)
          const asked = Queue.offer(drains, { on: true, how: "by SIGUSR1" })
          return {
            "t-1": [
              turn([
                ...bash("bd update t-1 --claim", c.claim),
                step(Effect.asVoid(asked)),
                ...bash('git commit -am "Change (t-1)"', c.commit),
                ...bash("bd close t-1", c.close),
              ]),
            ],
            "t-2": [finishes(world, root, "t-2" as TicketId)],
          }
        },
      },
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Queued" })
    expectLog(ran, [
      "DRAIN: stopping after t-1 finishes: no new tickets will start, asked by SIGUSR1",
      /^ {2}t-1 closed \(.*\); merged into main/,
      "DRAINED after 1 tickets",
    ])
    expectEvents(ran, ["drain", "done", "end"])
    expect(ran.log.some((each) => each.includes("t-2 dispatching"))).toBe(false)
  })

  test("the DRAIN line's words, as orchestra's", () => {
    expect(drainWords([])).toEqual(["stopping now, as nothing is running", "", ""])
    expect(String(drainLine(["b" as TicketId, "a" as TicketId], "from the dashboard"))).toBe(
      "DRAIN: stopping after the 2 running tickets finish (a, b): no new tickets will start, asked from the dashboard",
    )
  })
})

describe("stops and exit codes", () => {
  test("each stop reason's exit code is orchestra's, 8 for USAGE_LIMIT and no TERMINAL_FAILED", () => {
    expect(stopCodes).toEqual({
      REQUIREMENTS_MISSING: 2,
      SETUP_PROBLEM: 2,
      CHECKS_HELD: 2,
      LOGIN: 2,
      PAUSED: 3,
      BLOCKED: 3,
      TICKET_LIMIT: 3,
      BEADS_FAILED: 4,
      GIT_FAILED: 4,
      WORKTREE_FAILED: 4,
      STATE_UNWRITABLE: 4,
      PANIC: 4,
      DIRTY_TREE: 5,
      MERGE_FAILED: 6,
      ENVIRONMENT: 7,
      USAGE_LIMIT: 8,
      INTERRUPTED: 130,
    })
    const stop = (error: Parameters<typeof errorStop>[1]) => errorStop("t-1" as TicketId, error)
    expect(
      stop(
        new GitFailed({
          op: "worktree add",
          command: "git worktree add",
          exitCode: 128,
          stderr: "fatal: no\n",
        }),
      ),
    ).toEqual(expect.objectContaining({ why: "GIT_FAILED", code: 4 }))
    expect(
      stop(new BeadsFailed({ command: "bd show", exitCode: 1, stderr: "x", noSuchIssue: false })),
    ).toEqual(expect.objectContaining({ why: "BEADS_FAILED", code: 4 }))
    expect(stop(new StoreWriteFailed({ file: "state.json", reason: "disk full" }))).toEqual(
      expect.objectContaining({ why: "STATE_UNWRITABLE", code: 4 }),
    )
    expect(panicStop("t-1" as TicketId, new Error("boom\nat …"))).toEqual(
      expect.objectContaining({ why: "PANIC", code: 4, text: "PANIC: t-1's fiber: boom" }),
    )
  })

  test("the first stop decides the exit code; the line gives it, then each other with `; also`", () => {
    const paused = stopOfLine({
      why: "PAUSED",
      code: 3,
      line: line`HOLD: PAUSED: t-1 still in_progress`,
    })
    const dirty = stopFor("DIRTY_TREE", "uncommitted changes in /repo")
    const both = addStop(addStop(noStops, paused), dirty)
    expect(exitCodeOf(noStops)).toBe(0)
    expect(exitCodeOf(both)).toBe(3)
    expect(String(stopsLine(both))).toBe(
      "PAUSED: t-1 still in_progress; also DIRTY_TREE: uncommitted changes in /repo",
    )
  })

  test("PAUSED: the run ends on the worker's stop, exit 3, its session suspended", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").seeds,
        scripts: (world, root) => {
          const c = commands(world, root, "t-1" as TicketId)
          // Gone, resumed once, and gone again.
          return {
            "t-1": [[...turn([step(c.claim)]).slice(0, -2), gone("exit 1")], [gone("exit 1")]],
          }
        },
      },
    })
    expectExitCode(ran, 3)
    expectPhases(ran, { "t-1": "Stopped" })
    // With nothing else running, the stop holds nothing: no HOLD line, as orchestra's.
    expectLog(ran, [/^PAUSED: t-1 still in_progress/])
    expect(ran.log.some((text) => text.startsWith("HOLD: "))).toBe(false)
    expect(recordsOf(ran, "stop")).toHaveLength(1)
    expect(recordsOf(ran, "suspended")).toEqual([
      expect.objectContaining({ ticket: "t-1", why: "PAUSED" }),
    ])
    expect(recordsOf(ran, "end")).toEqual([expect.objectContaining({ code: 3 })])
  })

  test("DIRTY_TREE: the main checkout changed under the run, exit 5, the ticket blocked", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").seeds,
        scripts: (world, root) => {
          const c = commands(world, root, "t-1" as TicketId)
          const stray = Effect.flatMap(Repository, (repository) =>
            repository.write(repository.dir, { "stray.txt": "x\n" }),
          ).pipe(Effect.provideService(Repository, world.repository))
          return {
            "t-1": [
              turn([
                ...bash("bd update t-1 --claim", c.claim),
                step(stray),
                ...bash('git commit -am "Change (t-1)"', c.commit),
                ...bash("bd close t-1", c.close),
              ]),
            ],
          }
        },
      },
    })
    expectExitCode(ran, 5)
    expectPhases(ran, { "t-1": "Blocked" })
    expectLog(ran, [/^HOLD: DIRTY_TREE: /, /^ {2}Completed 0 · /, /^DIRTY_TREE: /])
    expect(recordsOf(ran, "stop")).toEqual([expect.objectContaining({ detail: "DIRTY_TREE" })])
  })

  test("MERGE_FAILED: the branch doesn't fast-forward, exit 6", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").seeds,
        scripts: (world, root) => ({ "t-1": [finishes(world, root, "t-1" as TicketId)] }),
      },
      before: () => Effect.flatMap(Repository, (repository) => repository.fail("merge --ff-only")),
      // Read after the refusal, the branch has left the base where it is: it doesn't fast-forward.
      around: (running) =>
        Effect.gen(function* () {
          const git = yield* Git
          let refused = false
          return yield* running.pipe(
            Effect.provideService(Git, {
              ...git,
              fastForward: (repo, branch) =>
                Effect.tapError(git.fastForward(repo, branch), () =>
                  Effect.sync(() => {
                    refused = true
                  }),
                ),
              mergeBase: (repo, a, b) =>
                refused ? Effect.succeed("0".repeat(40)) : git.mergeBase(repo, a, b),
            }),
          )
        }),
    })
    expectExitCode(ran, 6)
    expectPhases(ran, { "t-1": "Blocked" })
    expectLog(ran, [/^MERGE_FAILED: /])
  })

  test("GIT_FAILED: git can't read the main checkout as a ticket merges, exit 4", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").seeds,
        scripts: (world, root) => ({ "t-1": [finishes(world, root, "t-1" as TicketId)] }),
      },
      before: (repo) =>
        Effect.flatMap(Repository, (repository) =>
          repository.fail("status", { dir: repo, times: 10 }),
        ),
      // git is asked again a few seconds after each failure, gitTries times.
      during: () =>
        Effect.gen(function* () {
          for (let i = 0; i < 3 * gitTries; i++) {
            for (let j = 0; j < 200; j++) yield* Effect.yieldNow
            yield* advance(gitAgainAfter)
          }
        }),
    })
    expectExitCode(ran, 4)
    expectLog(ran, [/^GIT_FAILED: could not read the state of /])
  })

  test("BEADS_FAILED: bd ready fails three times running, exit 4, with nothing started", async () => {
    const ran = await runs({
      tickets: [],
      setup: { backlog: backlog().ticket("t-1").seeds, scripts: () => ({}) },
      around: (running) =>
        Effect.gen(function* () {
          const beads = yield* Beads
          return yield* running.pipe(
            Effect.provideService(Beads, {
              ...beads,
              ready: () =>
                Effect.fail(
                  new BeadsFailed({
                    command: "bd ready",
                    exitCode: 1,
                    stderr: "database is locked",
                    noSuchIssue: false,
                  }),
                ),
            }),
          )
        }),
      during: () =>
        Effect.gen(function* () {
          for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 200; j++) yield* Effect.yieldNow
            yield* advance("3 seconds")
          }
        }),
    })
    expectExitCode(ran, 4)
    expectLog(ran, [
      "could not read the queue (try 1 of 3), reading it again: database is locked",
      "could not read the queue (try 2 of 3), reading it again: database is locked",
      /^ {2}Completed 0 · Set aside 0 · Needs you 0$/,
      "BEADS_FAILED: could not read the queue: database is locked",
    ])
  })

  test("the run's time, to the second", () => {
    expect(runTime(0)).toBe("0s")
    expect(runTime(45_900)).toBe("45s")
    expect(runTime(125_000)).toBe("2m5s")
    expect(runTime(3_600_000 + 12 * 60_000)).toBe("1h12m")
  })
})
