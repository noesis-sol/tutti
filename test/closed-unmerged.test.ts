import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { closedBranches, closedUnmergedLine } from "../src/run/closedBranches.ts"
import { asksGit, mergeHold } from "../src/run/holds.ts"
import { type Entry, emptyState, type State } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { Dependency, Issue, TicketId } from "../src/services/Beads.ts"
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
  scenario,
  type World,
} from "./harness.ts"

const where = { repo: "/repo", base: "main" }

/** The scenario's value, or a test failure saying why it gave none. */
const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A branch cut from main with a commit `message` on it, in a worktree of its own. */
const branchWith = (repo: string, branch: string, message: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const path = join(repo, "..", `${branch.replace("/", "-")}-${Math.random()}`)
    yield* git.addWorktree(repo, path, { branch, base: "main" })
    yield* repository.commit(path, message, files)
    return path
  })

/** How many calls of `op` the Git service has had. */
const callsOf = (op: string) =>
  Effect.map(
    Effect.flatMap(Repository, (repository) => repository.calls),
    (calls) => calls.filter((call) => call.op === op).length,
  )

const warned = (ran: Ran<unknown>, id: TicketId): number =>
  ran.log.filter((each) => each === closedUnmergedLine(id, "main")).length

/** A state in which the run has the tickets in these phases. */
const stateWith = (phases: Readonly<Record<string, TicketPhase>>): State => ({
  ...emptyState,
  tickets: new Map(
    Object.entries(phases).map(([ticket, phase]) => [
      ticket as TicketId,
      { ticket, phase } as Entry,
    ]),
  ),
})

/** A link of `type` to ticket `id`, as bd show gives it, with its status and labels. */
const link = (
  id: TicketId,
  type: string,
  status = "closed",
  labels: ReadonlyArray<string> = [],
): Dependency => ({ id, type, issue: { id, status, labels } as unknown as Issue })

describe("asksGit and mergeHold", () => {
  const state = stateWith({
    done: TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc1234" }) }),
    merging: TicketPhase.ToMerge({ place: 1 }),
    working: TicketPhase.Working(),
    deferred: TicketPhase.Deferred({ why: "needs a design" }),
  })

  test("only a closed ticket the run knows nothing unmerged of is asked of git", () => {
    expect(asksGit(state, link("by-hand" as TicketId, "blocks"))).toBe(true)
    expect(asksGit(state, link("deferred" as TicketId, "blocks"))).toBe(true)
    expect(asksGit(state, link("done" as TicketId, "blocks"))).toBe(false)
    expect(asksGit(state, link("merging" as TicketId, "blocks"))).toBe(false)
    expect(asksGit(state, link("working" as TicketId, "blocks"))).toBe(false)
    expect(asksGit(state, link("open" as TicketId, "discovered-from", "open"))).toBe(false)
    expect(asksGit(state, link("labelled" as TicketId, "blocks", "closed", ["unmerged"]))).toBe(
      false,
    )
  })

  test("git's reason holds a blocker's dependents, and a source's follow-ups", () => {
    const branches = new Map([
      ["x", "tutti/x is not on main"],
      ["done", "tutti/done is not on main"],
    ])
    expect(
      mergeHold(state, { dependencies: [link("x" as TicketId, "blocks")] }, branches)?.text,
    ).toBe("after x merges: closed but not merged (tutti/x is not on main)")
    expect(
      mergeHold(state, { dependencies: [link("x" as TicketId, "discovered-from")] }, branches)
        ?.text,
    ).toBe("after x merges: filed by its worker, closed but not merged (tutti/x is not on main)")
    // The run merged it: what git said of a branch left behind doesn't count.
    expect(
      mergeHold(state, { dependencies: [link("done" as TicketId, "blocks")] }, branches),
    ).toBeUndefined()
    expect(mergeHold(state, { dependencies: [link("x" as TicketId, "blocks")] })).toBeUndefined()
  })
})

describe("closedBranches", () => {
  test("a branch with commits main lacks is not on main, said once, git asked once a head", async () => {
    const ran = await scenario(
      {},
      Effect.gen(function* () {
        yield* branchWith(where.repo, "tutti/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })
        const branches = yield* closedBranches(where)
        const head = yield* branches.head
        const first = yield* branches.why("t-1" as TicketId, head)
        const asked = yield* callsOf("merge-tree")
        const again = yield* branches.why("t-1" as TicketId, head)
        return { first, again, asked, after: yield* callsOf("merge-tree") }
      }),
    )
    const { first, again, asked, after } = resultOf(ran)
    expect(first).toBe("tutti/t-1 is not on main")
    expect(again).toBe(first)
    expect(after).toBe(asked)
    expect(warned(ran, "t-1" as TicketId)).toBe(1)
    expect(ran.events.filter((each) => each.kind === "warn").map((each) => each.text)).toEqual([
      closedUnmergedLine("t-1" as TicketId, "main"),
    ])
  })

  test("no branch, one on main and one main holds the changes of hold nothing", async () => {
    const ran = await scenario(
      {},
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        yield* git.createBranch(where.repo, "tutti/t-2", "main")
        yield* branchWith(where.repo, "tutti/t-3", "Do it (t-3)", { "t-3.txt": "3\n" })
        yield* git.fastForward(where.repo, "tutti/t-3")
        yield* branchWith(where.repo, "tutti/t-4", "Do it (t-4)", { "t-4.txt": "4\n" })
        yield* repository.commit(where.repo, "Squash t-4", { "t-4.txt": "4\n" })
        const branches = yield* closedBranches(where)
        const head = yield* branches.head
        const whys = []
        for (const id of [
          "t-1" as TicketId,
          "t-2" as TicketId,
          "t-3" as TicketId,
          "t-4" as TicketId,
        ])
          whys.push(yield* branches.why(id, head))
        return whys
      }),
    )
    expect(resultOf(ran)).toEqual([undefined, undefined, undefined, undefined])
    expect(ran.log.some((each) => each.includes("CLOSED_UNMERGED"))).toBe(false)
  })

  test("git failing holds with its error, uncached and unwarned, until git can tell", async () => {
    const ran = await scenario(
      {},
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* branchWith(where.repo, "tutti/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })
        const branches = yield* closedBranches(where)
        const head = yield* branches.head
        yield* repository.fail("merge-tree", { stderr: "fatal: the index is locked", times: 2 })
        const failed = [
          yield* branches.why("t-1" as TicketId, head),
          yield* branches.why("t-1" as TicketId, head),
        ]
        return { failed, later: yield* branches.why("t-1" as TicketId, head) }
      }),
    )
    const { failed, later } = resultOf(ran)
    expect(failed).toEqual([
      "git can't tell whether tutti/t-1 is on main: fatal: the index is locked",
      "git can't tell whether tutti/t-1 is on main: fatal: the index is locked",
    ])
    expect(later).toBe("tutti/t-1 is not on main")
    expect(warned(ran, "t-1" as TicketId)).toBe(1)
  })

  test("merging the branch into main, or deleting it, frees it", async () => {
    const ran = await scenario(
      {},
      Effect.gen(function* () {
        const git = yield* Git
        yield* branchWith(where.repo, "tutti/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })
        const path = yield* branchWith(where.repo, "tutti/t-2", "Do it (t-2)", { "t-2.txt": "2\n" })
        const branches = yield* closedBranches(where)
        const before = yield* branches.head
        const held = [
          yield* branches.why("t-1" as TicketId, before),
          yield* branches.why("t-2" as TicketId, before),
        ]
        yield* git.fastForward(where.repo, "tutti/t-1")
        const merged = yield* branches.why("t-1" as TicketId, yield* branches.head)
        yield* git.removeWorktree(where.repo, path, { force: true })
        yield* git.deleteBranch(where.repo, "tutti/t-2", { force: true })
        const deleted = yield* branches.why("t-2" as TicketId, before)
        return { held, merged, deleted }
      }),
    )
    const { held, merged, deleted } = resultOf(ran)
    expect(held).toEqual(["tutti/t-1 is not on main", "tutti/t-2 is not on main"])
    expect(merged).toBeUndefined()
    expect(deleted).toBeUndefined()
  })
})

/** A new folder, its real path: the main checkout's (for the attention files), or the worktrees'. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-closed-unmerged-${name}-`)))

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly backlog: ReadonlyArray<Seed>
  readonly scripts: (
    world: World,
    root: string,
    repo: string,
  ) => Readonly<Record<string, SessionScript[]>>
  /** Readies the repository and Beads before the run starts. */
  readonly before?: (repo: string) => Effect.Effect<void, unknown, Env>
}

/** A whole plain run on main, each ticket's worktree in git where the Worktrees test layer puts it. */
const runs = (plan: Plan): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      backlog: plan.backlog,
      config: { repo },
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root, repo),
    },
    Effect.gen(function* () {
      const git = yield* Git
      if (plan.before !== undefined) yield* plan.before(repo)
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      return yield* Fiber.join(fiber)
    }),
  )
}

/** What a ticket's worker's commands do to the in-memory Beads and git; `then` after its commit. */
const commands = (
  world: World,
  root: string,
  id: TicketId,
  then: Effect.Effect<void, unknown> = Effect.void,
) => {
  const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))
  return {
    claim: orDie(world.beads.update(id, { claim: true })),
    commit: orDie(
      Effect.andThen(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
        then,
      ),
    ),
    close: orDie(world.beads.close(id, "done")),
  }
}

describe("a blocker closed by hand, its branch not merged", () => {
  test("holds the tickets it blocks, with one CLOSED_UNMERGED warning", async () => {
    const ran = await runs({
      tickets: [],
      backlog: backlog()
        .ticket("t-1", { status: "closed" })
        .ticket("t-2", { blockedBy: ["t-1"] })
        .ticket("t-3", { blockedBy: ["t-1"] }).seeds,
      before: (repo) =>
        Effect.asVoid(branchWith(repo, "tutti/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })),
      scripts: () => ({}),
    })
    expectExitCode(ran, 0)
    expect(ran.log.some((each) => each.includes("dispatching"))).toBe(false)
    expect(warned(ran, "t-1" as TicketId)).toBe(1)
    expectLog(ran, [
      closedUnmergedLine("t-1" as TicketId, "main"),
      "  t-2 waits: after t-1 merges: closed but not merged (tutti/t-1 is not on main)",
      "  t-3 waits: after t-1 merges: closed but not merged (tutti/t-1 is not on main)",
      "READY_EMPTY after 0 tickets",
    ])
  })

  test("git failing to tell keeps the tickets it blocks held, without a warning", async () => {
    const ran = await runs({
      tickets: [],
      backlog: backlog()
        .ticket("t-1", { status: "closed" })
        .ticket("t-2", { blockedBy: ["t-1"] }).seeds,
      before: (repo) =>
        Effect.gen(function* () {
          yield* branchWith(repo, "tutti/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })
          yield* (yield* Repository).fail("merge-tree", {
            stderr: "fatal: the index is locked",
            times: 100,
          })
        }),
      scripts: () => ({}),
    })
    expectExitCode(ran, 0)
    expect(ran.log.some((each) => each.includes("dispatching"))).toBe(false)
    expect(warned(ran, "t-1" as TicketId)).toBe(0)
    expectLog(ran, [
      "  t-2 waits: after t-1 merges: closed but not merged (git can't tell whether tutti/t-1 is on main: fatal: the index is locked)",
      "READY_EMPTY after 0 tickets",
    ])
  })

  test("merging its branch mid-run releases the tickets it blocks", async () => {
    const ran = await runs({
      tickets: ["t-0", "t-2"],
      backlog: backlog()
        .ticket("t-0")
        .ticket("t-1", { status: "closed" })
        .ticket("t-2", { blockedBy: ["t-1"] }).seeds,
      before: (repo) =>
        Effect.asVoid(branchWith(repo, "tutti/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })),
      scripts: (world, root, repo) => ({
        // t-0's worker squash-merges t-1's branch into main by hand as it works.
        "t-0": [
          claimsAndCloses(
            "t-0" as TicketId,
            commands(
              world,
              root,
              "t-0" as TicketId,
              world.repository.commit(repo, "Merge t-1 by hand", { "t-1.txt": "1\n" }),
            ),
          ),
        ],
        "t-2": [claimsAndCloses("t-2" as TicketId, commands(world, root, "t-2" as TicketId))],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-0": "Done", "t-2": "Done" })
    expect(warned(ran, "t-1" as TicketId)).toBe(1)
    expectLog(ran, [
      "  t-2 waits: after t-1 merges: closed but not merged (tutti/t-1 is not on main)",
      /t-0 dispatching/,
      /t-2 dispatching/,
    ])
  })

  test("a closed blocker with no branch holds nothing, and warns of nothing", async () => {
    const ran = await runs({
      tickets: ["t-2"],
      backlog: backlog()
        .ticket("t-1", { status: "closed" })
        .ticket("t-2", { blockedBy: ["t-1"] }).seeds,
      scripts: (world, root) => ({
        "t-2": [claimsAndCloses("t-2" as TicketId, commands(world, root, "t-2" as TicketId))],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-2": "Done" })
    expect(ran.log.some((each) => each.includes("CLOSED_UNMERGED"))).toBe(false)
    expect(ran.log.some((each) => each.includes("t-2 waits"))).toBe(false)
  })
})
