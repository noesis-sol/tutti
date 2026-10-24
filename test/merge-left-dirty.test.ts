// A merge check, or the setup before it, that passes but leaves uncommitted changes to tracked files
// in the ticket's worktree (an install that rewrites its lockfile, a check that formats files) sets
// the ticket aside, DIRTY_WORKTREE (merge.ts's setAsideLeftDirty): the check passed on files that
// won't merge, and git would refuse to remove the worktree after the merge. Each scenario is a
// whole run under TestClock.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed, type Scripted } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import {
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-merge-left-dirty-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

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
  /** The fast check's runs, in order, given the world to change the worktree in. */
  readonly fast: (world: () => World) => ReadonlyArray<Scripted>
  /** a's worker's turns. */
  readonly turns: (world: World, root: string) => ReadonlyArray<SessionScript>
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
  let world: World | undefined
  const theWorld = (): World => {
    if (world === undefined) throw new Error("the check ran before the world was made")
    return world
  }
  return scenario(
    {
      config: {
        repo,
        settings: {
          ...defaults,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: backlog().ticket("a").seeds,
      git: { dir: repo },
      worktrees: { root },
      checks: { fast: plan.fast(theWorld) },
      scripts: (made: World) => {
        world = made
        return { a: plan.turns(made, root) }
      },
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

/** A check that passes, having written `files` into the worktree it ran in. */
const passesWriting =
  (world: () => World, files: Files): Scripted =>
  (each) =>
    Effect.as(
      Effect.suspend(() => world().repository.write(each.cwd, files)),
      passed("fast"),
    )

describe("a check that passes but leaves tracked files changed", () => {
  test("sets the ticket aside, DIRTY_WORKTREE, its worktree kept and main unchanged", async () => {
    const ran = await runs({
      fast: (world) => [passesWriting(world, { "a.txt": "formatted\n" })],
      turns: (world, root) => [works(world, root, "a", { "a.txt": "a\n" })],
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Review" })
    const worktree = join(ran.root, "a")
    expectLog(ran, [
      `  DIRTY_WORKTREE: a closed, but its setup or check left uncommitted changes to a.txt in ${worktree}, so tutti/a passed with changes that would not merge; worktree left for review (have the setup and check leave tracked files as they are, as a frozen-lockfile install does; undo the changes, check, merge)`,
    ])
    expect(ran.events.find((r) => r.kind === "phase" && r.to === "Review")).toMatchObject({
      ticket: "a",
      why: "DIRTY_WORKTREE",
    })
    expect(ran.log.some((text) => text.includes("passes on tutti/a"))).toBe(false)
    expect(ran.log.some((text) => text.includes("CLEANUP_FAILED"))).toBe(false)
    expect(ran.main.has("a.txt")).toBe(false)
    expect(ran.issues.find((issue) => issue.id === "a")?.labels).toContain("unmerged")
  })

  test("an untracked file it leaves is no uncommitted change: the ticket merges", async () => {
    const ran = await runs({
      fast: (world) => [passesWriting(world, { "coverage.txt": "92%\n" })],
      turns: (world, root) => [works(world, root, "a", { "a.txt": "a\n" })],
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done" })
    expect(ran.log.some((text) => text.includes("DIRTY_WORKTREE"))).toBe(false)
    expect(ran.main.get("a.txt")).toBe("a\n")
    expect(ran.main.has("coverage.txt")).toBe(false)
  })

  test("a pass on its worker's fix that leaves them changed sets it aside before it merges", async () => {
    const ran = await runs({
      fast: (world) => [fails(), passesWriting(world, { "a.txt": "formatted\n" })],
      turns: (world, root) => [
        [
          ...works(world, root, "a", { "a.txt": "a\n" }),
          ...fixes(world, root, "a", { "fix.txt": "fixed\n" }),
        ],
      ],
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Review" })
    expectLog(ran, [
      `  '${check}' passes on tutti/a as its worker fixed it`,
      /^ {2}DIRTY_WORKTREE: a closed, but its setup or check left uncommitted changes to a\.txt in /,
    ])
    // The fix's pass is not run again: the merge read the worktree's status instead.
    expect(ran.checkRuns.filter((each) => each.check === "fast")).toHaveLength(2)
    expect(ran.main.has("fix.txt")).toBe(false)
  })
})
