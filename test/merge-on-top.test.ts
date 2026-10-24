// A finished ticket whose branch is on top of the base already, nothing having merged while it ran,
// is checked before it merges as a rebased one is (merge.ts's Locate step, orchestra 0.8.5): no ticket
// reaches the base unchecked. Each scenario is a whole run under TestClock.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { failedCheckSaid } from "../src/run/reportEvidence.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Script as ChecksScript } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import {
  backlog,
  type Env,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-merge-on-top-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings
type Settings = typeof defaults

/** Claims its ticket, commits `files` and closes it, as a worker does. */
const works = (world: World, root: string, id: string, files: Files): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** A hand-back turn in which the worker commits a fix naming its ticket. */
const fixes = (world: World, root: string, id: string, files: Files): SessionScript =>
  turn([
    ...bash(check),
    ...bash(
      `git commit -am "Fix the check (${id})"`,
      Effect.asVoid(
        Effect.orDie(world.repository.commit(join(root, id), `Fix the check (${id})`, files)),
      ),
    ),
  ])

/** The fast check failing, its lines saying what failed. */
const fails = () =>
  new CheckFailed({
    check: "fast",
    command: check,
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: ["error: a.test.ts: expected 1"],
    lastLines: ["1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

interface Plan {
  /** Laid over the settings: the defaults with the check command `check`. */
  readonly settings?: (settings: Settings) => Partial<Settings>
  readonly checks?: ChecksScript
  /** a's worker's turns. */
  readonly turns: (world: World, root: string) => Scripts["a"]
}

/** What a run of a leaves besides the scenario's: where it ran, and main's files after it. */
interface Places {
  readonly root: string
  readonly main: ReadonlyMap<string, string>
}

/** A whole run of the one ticket a on main, its worktree made in git first, and where it ran. */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let main: ReadonlyMap<string, string> = new Map()
  const base: Settings = {
    ...defaults,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  }
  return scenario(
    {
      config: { repo, settings: { ...base, ...plan.settings?.(base) } },
      backlog: backlog().ticket("a").seeds,
      git: { dir: repo },
      worktrees: { root },
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) => ({ a: plan.turns(world, root) }),
    },
    Effect.gen(function* () {
      yield* (yield* Git).addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      const outcome = yield* Fiber.join(fiber)
      main = yield* (yield* Repository).tree("main")
      return outcome
    }),
  ).then((ran) => ({ ...ran, root, main }))
}

/** The phases a moved through, from its `phase` records. */
const pathOfA = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === "a" ? [record.to ?? "outside"] : [],
  )

/** The run ended with `code`, with no PHASE_BUG logged and nothing left behind. */
const expectClean = (ran: Ran<Outcome>, code: number) => {
  expectExitCode(ran, code)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
}

/** The client_composed messages a's worker was sent after its ticket's prompt. */
const composed = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.sent
    .flatMap((item) =>
      item._tag === "Message" && item.ticket === "a" && item.message.client_composed === true
        ? [String(item.message.message.content)]
        : [],
    )
    .slice(1)

const onTopLine = `  tutti/a is on top of main already: checking it with '${check}' before it merges`
const closedLine =
  /^ {2}a closed \([0-9a-f]{7} .*\); merged into main, worktree and branch removed$/

describe("a branch on top of the base already", () => {
  test("is checked before it merges: the check runs once, and a merges", async () => {
    const ran = await runs({
      turns: (world, root) => [works(world, root, "a", { "a.txt": "a\n" })],
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done" })
    expect(pathOfA(ran)).toEqual(["Queued", "Working", "ToMerge", "Merging", "Done"])
    expectLog(ran, [
      onTopLine,
      "  'scripted fast' passes on tutti/a on top of main",
      closedLine,
      "READY_EMPTY after 1 tickets",
    ])
    expect(ran.log.some((text) => text.includes("rebased tutti/a"))).toBe(false)
    expect(ran.checkRuns.map((each) => [each.check, each.cwd])).toEqual([
      ["fast", join(ran.root, "a")],
    ])
    expect(ran.main.get("a.txt")).toBe("a\n")
  })

  test("a failing check is handed back to its worker, and the fix merges, checked once", async () => {
    const ran = await runs({
      checks: { fast: [fails()] },
      turns: (world, root) => [
        [
          ...works(world, root, "a", { "a.txt": "a\n" }),
          ...fixes(world, root, "a", { "fix.txt": "fixed\n" }),
        ],
      ],
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done" })
    expect(pathOfA(ran)).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Fixing",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expectLog(ran, [
      onTopLine,
      `  FIXING: '${check}' fails on tutti/a on top of main; handed back to its worker to fix (1 of 2, up to 20m)`,
      `  '${check}' passes on tutti/a as its worker fixed it`,
      closedLine,
      "READY_EMPTY after 1 tickets",
    ])
    const [handBack, ...others] = composed(ran)
    expect(others).toEqual([])
    expect(handBack).toContain(`tutti: Before tutti/a merges into main, '${check}' fails on it.`)
    expect(handBack).toContain("these lines say what failed:\nerror: a.test.ts: expected 1")
    expect(handBack).toContain("Fix tutti/a so that the check passes.")
    // Nothing landed, and nothing was rebased.
    expect(handBack).not.toContain("landed")
    expect(handBack).not.toContain("rebased")
    // The check failed on a, then passed on its fix, which merged without a third check.
    expect(ran.checkRuns).toHaveLength(2)
    expect(ran.log.some((text) => text.includes("CHECKS_FAILED"))).toBe(false)
    expect(ran.main.get("fix.txt")).toBe("fixed\n")
  })

  test("with hand-backs off, a failing check sets it aside, CHECKS_FAILED, main unchanged", async () => {
    const ran = await runs({
      settings: (settings) => ({ merge: { ...settings.merge, check_hand_backs: 0 } }),
      checks: { fast: [fails()] },
      turns: (world, root) => [works(world, root, "a", { "a.txt": "a\n" })],
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Review" })
    expect(pathOfA(ran)).toEqual(["Queued", "Working", "ToMerge", "Merging", "Review"])
    expectLog(ran, [
      onTopLine,
      new RegExp(
        `^ {2}CHECKS_FAILED: a closed, but '${check}' fails on tutti/a on top of main; worktree .*/a left for review \\(output is in .*/a/\\.tutti/run/check\\.log\\); checked once more if main moves on in this run$`,
      ),
      "READY_EMPTY after 1 tickets",
    ])
    expectEvents(ran, ["dispatch", "warn", "end"])
    expect(ran.events.find((r) => r.kind === "phase" && r.to === "Review")).toMatchObject({
      ticket: "a",
      why: "CHECKS_FAILED",
    })
    expect(ran.checkRuns).toHaveLength(1)
    expect(ran.main.has("a.txt")).toBe(false)
    expect(ran.issues.find((issue) => issue.id === "a")?.labels).toContain("unmerged")
  })

  test("its worker's own change to a setup file runs no setup: it installed for itself", async () => {
    const setup = "bun install --frozen-lockfile"
    const ran = await runs({
      settings: (settings) => ({
        checks: { ...settings.checks, setup: { command: setup, files: ["bun.lock"] } },
      }),
      turns: (world, root) => [works(world, root, "a", { "bun.lock": "left-pad 2\n" })],
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done" })
    // The setup ran once, in its new worktree before its worker, and not again before the check.
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["setup", "fast"])
    expect(ran.log.filter((text) => text.includes(`running '${setup}'`))).toEqual([
      `  a: running '${setup}' in its new worktree before its worker starts`,
    ])
  })

  test("with no check command, it merges as before, without the line", async () => {
    const ran = await runs({
      settings: (settings) => ({
        checks: { ...settings.checks, fast: { ...settings.checks.fast, command: null } },
      }),
      turns: (world, root) => [works(world, root, "a", { "a.txt": "a\n" })],
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done" })
    expect(ran.checkRuns).toEqual([])
    expect(ran.log.some((text) => text.includes("on top of main"))).toBe(false)
  })

  test("commits that together change nothing need no check", async () => {
    const ran = await runs({
      turns: (world, root) => [
        turn(
          [
            ...bash(
              "bd update a --claim",
              Effect.asVoid(Effect.orDie(world.beads.update("a", { claim: true }))),
            ),
            ...bash(
              'git commit -am "Add and take out a.txt (a)"',
              Effect.asVoid(
                Effect.orDie(
                  Effect.gen(function* () {
                    yield* world.repository.commit(join(root, "a"), "Add a.txt (a)", {
                      "a.txt": "a\n",
                    })
                    yield* world.repository.commit(join(root, "a"), "Take out a.txt (a)", {
                      "a.txt": null,
                    })
                  }),
                ),
              ),
            ),
            ...bash("bd close a", Effect.asVoid(Effect.orDie(world.beads.close("a", "done")))),
          ],
          result("Closed a."),
        ),
      ],
    })
    expectClean(ran, 0)
    expect(ran.checkRuns).toEqual([])
    expect(ran.log.some((text) => text.includes("on top of main"))).toBe(false)
    expectLog(ran, [/^ {2}a closed with no change: the commits on tutti\/a, taken together/])
  })
})

/**
 * Merges a, finished on top of main with a.txt committed, through a merge queue of its own, with
 * `script` run on it first: as when its worktree changes after its worker ended, while it waits in
 * the merge queue. The fast check is `check`.
 */
const mergesOnTop = (script: (ticket: FinishedTicket) => Effect.Effect<void, unknown, Env>) =>
  scenario(
    {
      config: {
        repo: "/repo",
        settings: {
          ...defaults,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: backlog().ticket("a").seeds,
    },
    Effect.gen(function* () {
      const repository = yield* Repository
      const worktree = yield* (yield* Worktrees).prepare("a")
      yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
        branch: worktree.branch,
        base: "main",
      })
      yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
      yield* (yield* Beads).close("a", "done")
      const ledger = yield* Ledger
      yield* ledger.transition("a", Move.Ready(), { title: "Ticket a" })
      yield* ledger.transition("a", Move.Dispatched())
      const ticket = {
        id: "a",
        title: "Ticket a",
        branch: worktree.branch,
        worktree: worktree.path,
      } satisfies FinishedTicket
      yield* script(ticket)
      const queue = yield* makeQueue({ repo: repository.dir, base: "main" })
      yield* queue.offer(ticket)
      yield* queue.settled
      return {
        phase: (yield* ledger.current).tickets.get("a")?.phase,
        main: yield* repository.tree("main"),
      }
    }).pipe(Effect.provide(Ledger.layer)),
  )

describe("a branch on top of the base with uncommitted changes in its worktree", () => {
  test("is set aside unchecked, DIRTY_WORKTREE: they would be checked but never merge", async () => {
    let worktree = ""
    const ran = await mergesOnTop((ticket) =>
      Effect.gen(function* () {
        worktree = ticket.worktree
        yield* (yield* Repository).write(ticket.worktree, { "a.txt": "changed\n" })
      }),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const { phase, main } = ran.exit.value
    expect(phase).toEqual(expect.objectContaining({ _tag: "Review", why: "DIRTY_WORKTREE" }))
    expectLog(ran, [
      `  DIRTY_WORKTREE: a closed, but ${worktree} has uncommitted changes to a.txt, so tutti/a, on top of main, can't be checked as it would merge; worktree left for review (commit or undo them, check, merge)`,
    ])
    expect(ran.log.some((text) => text.includes("checking it with"))).toBe(false)
    expect(ran.checkRuns).toEqual([])
    expect(main.has("a.txt")).toBe(false)
  })

  test("an untracked file is no uncommitted change: it is checked and merges", async () => {
    const ran = await mergesOnTop((ticket) =>
      Effect.gen(function* () {
        yield* (yield* Repository).write(ticket.worktree, { "notes.txt": "scratch\n" })
      }),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const { phase, main } = ran.exit.value
    expect(phase?._tag).toBe("Done")
    expectLog(ran, [onTopLine])
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["fast"])
    expect(main.get("a.txt")).toBe("a\n")
  })
})

describe("what the reviewer is told of a check failed on top of the base", () => {
  test("says the branch was on top of the base, not rebased", () => {
    const said = failedCheckSaid({
      id: "t-1",
      branch: "tutti/t-1",
      base: "main",
      onto: "abcdef0123",
      onTop: true,
      error: fails(),
      output: "/wt/t-1/.tutti/run/check.log",
      folders: ["src/run"],
    })
    expect(said.split("\n")[0]).toBe(
      `t-1: '${check}' fails on tutti/t-1 on top of main at abcdef0; its output is in /wt/t-1/.tutti/run/check.log.`,
    )
  })
})
