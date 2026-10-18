import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { type Outcome, run } from "../src/run/run.ts"
import { unmergedLabel } from "../src/run/scope.ts"
import { forkKey, stillUnmerged } from "../src/run/unmerged.ts"
import { Beads, BeadsFailed, type Issue } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses, type SessionScript } from "../src/testing/AgentHost.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import {
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

/** A new folder, its real path: the main checkout's (for the attention files), or the worktrees'. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-unmerged-${name}-`)))

const issueOf = (ran: Ran<unknown>, id: string): Issue => {
  const issue = ran.issues.find((each) => each.id === id)
  if (issue === undefined) throw new Error(`no issue ${id}`)
  return issue
}

/** A branch cut from main with a commit `message` on it, in a worktree of its own. */
const branchWith = (repo: string, branch: string, message: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const path = join(repo, "..", `${branch.replace("/", "-")}-${Date.now()}`)
    yield* git.addWorktree(repo, path, { branch, base: "main" })
    yield* repository.commit(path, message, files)
  })

/** Labels the closed ticket `unmerged`, as an earlier run left it, its fork noted. */
const leftUnmerged = (repo: string, id: string, branch = `tutti/${id}`) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    yield* beads.setMetadata(id, forkKey, yield* (yield* Git).mergeBase(repo, "main", branch))
    yield* beads.addLabel(id, unmergedLabel)
  })

/** Another commit on main. */
const moveMain = (repo: string, message: string, files: Files) =>
  Effect.flatMap(Repository, (repository) => repository.commit(repo, message, files))

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly backlog: ReadonlyArray<Seed>
  readonly scripts: (world: World, root: string) => Readonly<Record<string, SessionScript[]>>
  /** Readies the repository and Beads before the run starts. */
  readonly before?: (repo: string) => Effect.Effect<void, unknown, Env>
  readonly around?: (run: Effect.Effect<Outcome, never, Env>) => Effect.Effect<Outcome, never, Env>
  readonly config?: Setup["config"]
}

/** A whole plain run on main, each ticket's worktree in git where the Worktrees test layer puts it. */
const runs = (plan: Plan): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      backlog: plan.backlog,
      config: { ...plan.config, repo },
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      if (plan.before !== undefined) yield* plan.before(repo)
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const running = Effect.scoped(run({ version: "0.1.0-test", base: "main" }))
      const fiber = yield* Effect.forkChild(
        plan.around === undefined ? running : plan.around(running),
      )
      return yield* Fiber.join(fiber)
    }),
  )
}

/** What a ticket's worker's commands do to the in-memory Beads and git. */
const commands = (world: World, root: string, id: string) => {
  const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))
  return {
    claim: orDie(world.beads.update(id, { claim: true })),
    commit: orDie(
      world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
    ),
    close: orDie(world.beads.close(id, "done")),
  }
}

describe("the run and the unmerged label", () => {
  test("a ticket merged by hand since loses its label before the first dispatch", async () => {
    const ran = await runs({
      tickets: ["t-2"],
      backlog: backlog()
        .ticket("t-1", { status: "closed" })
        .ticket("t-2", { blockedBy: ["t-1"] }).seeds,
      before: (repo) =>
        Effect.gen(function* () {
          yield* branchWith(repo, "wt/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })
          yield* leftUnmerged(repo, "t-1", "wt/t-1")
          yield* (yield* Git).fastForward(repo, "wt/t-1")
        }),
      scripts: (world, root) => ({
        "t-2": [claimsAndCloses("t-2", commands(world, root, "t-2"))],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-2": "Done" })
    expect(issueOf(ran, "t-1").labels).toEqual([])
    expectLog(ran, [
      /^ {2}t-1, left unmerged by an earlier run, is on main now \([0-9a-f]{7} Do it \(t-1\)\); its 'unmerged' label is removed$/,
      /t-2 dispatching/,
    ])
  })

  test("one not merged keeps its label, and the tickets it blocks wait", async () => {
    const ran = await runs({
      tickets: [],
      backlog: backlog()
        .ticket("t-1", { status: "closed" })
        .ticket("t-2", { blockedBy: ["t-1"] }).seeds,
      before: (repo) =>
        Effect.gen(function* () {
          yield* branchWith(repo, "tutti/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })
          yield* leftUnmerged(repo, "t-1")
          yield* moveMain(repo, "Something else", { "else.txt": "x\n" })
        }),
      scripts: () => ({}),
    })
    expectExitCode(ran, 0)
    expect(issueOf(ran, "t-1").labels).toEqual([unmergedLabel])
    expect(ran.log.some((each) => each.includes("t-2 dispatching"))).toBe(false)
    expectLog(ran, [
      "  t-1 was left unmerged by an earlier run; tickets it blocks wait until tutti/t-1 is merged into main or its 'unmerged' label is removed",
      "READY_EMPTY after 0 tickets",
    ])
  })

  test("bd failing to list them stops the run before it dispatches, BEADS_FAILED, exit 4", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      backlog: backlog().ticket("t-1").seeds,
      scripts: (world, root) => ({
        "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))],
      }),
      around: (running) =>
        Effect.gen(function* () {
          const beads = yield* Beads
          return yield* running.pipe(
            Effect.provideService(Beads, {
              ...beads,
              list: (filter) =>
                filter?.labels?.includes(unmergedLabel) === true
                  ? Effect.fail(
                      new BeadsFailed({
                        command: "bd list --label unmerged",
                        exitCode: 1,
                        stderr: "database is locked",
                        noSuchIssue: false,
                      }),
                    )
                  : beads.list(filter),
            }),
          )
        }),
    })
    expectExitCode(ran, 4)
    expect(ran.log.some((each) => each.includes("dispatching"))).toBe(false)
    expectLog(ran, [
      /^ {2}Completed 0 · Set aside 0 · Needs you 0$/,
      "BEADS_FAILED: could not read the tickets left unmerged: database is locked",
    ])
  })

  test("a ticket closed and not merged as the run ends is labelled, its fork noted", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      backlog: backlog().ticket("t-1").seeds,
      before: () => Effect.flatMap(Repository, (repository) => repository.fail("merge --ff-only")),
      scripts: (world, root) => ({
        "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))],
      }),
    })
    expectExitCode(ran, 6)
    expectPhases(ran, { "t-1": "Blocked" })
    expect(issueOf(ran, "t-1").labels).toEqual([unmergedLabel])
    expect(issueOf(ran, "t-1").metadata[forkKey]).toMatch(/^[0-9a-f]{7,64}$/)
    expectLog(ran, [
      "  t-1 is closed but not merged, labelled 'unmerged': tickets it blocks wait until tutti/t-1 is merged into main, in later runs too",
      /^tutti 0\.1\.0-test on main · /,
      /^MERGE_FAILED: /,
    ])
  })
})

describe("stillUnmerged, for the Nothing to run box", () => {
  test("the labelled tickets not merged since, read only: one merged by hand keeps its label", async () => {
    const repo = folder("box")
    const ran = await scenario(
      {
        backlog: [
          { id: "a", status: "closed" },
          { id: "b", status: "closed" },
          { id: "c", labels: [unmergedLabel] },
        ],
        git: { dir: repo },
      },
      Effect.gen(function* () {
        for (const id of ["a", "b"]) {
          yield* branchWith(repo, `tutti/${id}`, `Do it (${id})`, { [`${id}.txt`]: `${id}\n` })
          yield* leftUnmerged(repo, id)
        }
        yield* (yield* Git).fastForward(repo, "tutti/a")
        return yield* stillUnmerged({ repo, base: "main" })
      }),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    expect([...ran.exit.value]).toEqual(["b"])
    expect(issueOf(ran, "a").labels).toEqual([unmergedLabel])
    expect(ran.log).toEqual([])
  })
})
