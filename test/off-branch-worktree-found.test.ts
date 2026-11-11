// A ticket's worktree left off its branch (mid-rebase, detached, on another branch) is found at
// <worktrees>/<id> by every reader of it, not by a worker's start alone (tutti-i0vf): Worktrees
// gives the lookup (worktreeOf), a merge by hand's cleanup (handMerged.ts) treats such a worktree
// as one on its branch, and the deferred-free report (deferredFree.ts) names it. Both found a
// worktree by its branch alone before, as Worktrees did before tutti-34k9.3.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, type Scope, Stream } from "effect"
import * as free from "../src/run/deferredFree.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const folder = (name: string) => mkdtempSync(join(tmpdir(), `tutti-off-branch-${name}-`))

/** Detaches the worktree at `path`: HEAD at its commit, on no branch. */
const detach = (path: string) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.checkout(path, yield* repository.head("HEAD", path))
  })

describe("Worktrees.worktreeOf, over the in-memory repository", () => {
  const repo = realpathSync(folder("repo"))
  // The root as tmpdir gives it (/var/… on macOS), where git lists a worktree's real path.
  const root = folder("root")
  const real = realpathSync(root)
  const id = "demo-1" as TicketId
  const branch = "tutti/demo-1"
  const layer = Worktrees.layer({ repo, root, base: "main" }).pipe(
    Layer.provideMerge(gitLayer({ dir: repo })),
    Layer.provideMerge(BunServices.layer),
  )
  const lookedUp = <A>(body: Effect.Effect<A, unknown, Worktrees | Git | Repository>) =>
    Effect.runPromise(body.pipe(Effect.provide(layer)))

  test("the worktree on the ticket's branch, wherever it is", async () => {
    const found = await lookedUp(
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, "/elsewhere/demo-1", { branch, base: "main" })
        return yield* (yield* Worktrees).worktreeOf(id)
      }),
    )
    expect(found).toMatchObject({ path: "/elsewhere/demo-1", branch })
  })

  test("else the one at <root>/<id>, by its real path, left detached", async () => {
    const at = join(real, id)
    mkdirSync(join(root, id), { recursive: true })
    const found = await lookedUp(
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, at, { branch, base: "main" })
        yield* detach(at)
        return yield* (yield* Worktrees).worktreeOf(id)
      }),
    )
    expect(found?.path).toBe(at)
    expect(found?.branch).toBeUndefined()
  })

  test("none without one, nor for one whose folder is gone", async () => {
    const at = join(real, id)
    const found = await lookedUp(
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const none = yield* worktrees.worktreeOf(id)
        yield* (yield* Git).addWorktree(repo, at, { branch, base: "main" })
        yield* (yield* Repository).removeFolder(at)
        return { none, gone: yield* worktrees.worktreeOf(id) }
      }),
    )
    expect(found).toEqual({ none: undefined, gone: undefined })
  })

  test("an ID prepare would refuse is looked for by its branch alone", async () => {
    const odd = "x..y" as TicketId
    const at = join(real, odd)
    const found = await lookedUp(
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, at, { branch: "tutti/x..y", base: "main" })
        const worktrees = yield* Worktrees
        const onBranch = yield* worktrees.worktreeOf(odd)
        yield* detach(at)
        return { onBranch: onBranch?.path, detached: yield* worktrees.worktreeOf(odd) }
      }),
    )
    expect(found).toEqual({ onBranch: at, detached: undefined })
  })
})

describe("DEFERRED_FREE names a worktree left off its branch", () => {
  test("safe to remove when empty, kept with uncommitted changes or commits at its HEAD", async () => {
    const repo = "/repo"
    const root = realpathSync(folder("root"))
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "empty", status: "deferred", blockedBy: ["b-1"] },
      { id: "dirty", status: "deferred", blockedBy: ["b-1"] },
      { id: "ahead", status: "deferred", blockedBy: ["b-1"] },
    ]
    const freeing: free.Freeing = {
      repo,
      base: "main",
      filter: { excludeTypes: [] },
      inScope: () => true,
      pending: free.startPending(new Set(), new Set()),
    }
    const ran = await scenario(
      { backlog: seeds, git: { dir: repo }, worktrees: { root } },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        for (const id of ["empty", "dirty", "ahead"]) {
          const at = join(root, id)
          yield* git.addWorktree(repo, at, { branch: `tutti/${id}`, base: "main" })
          yield* detach(at)
        }
        yield* repository.write(join(root, "dirty"), { "a.ts": "a" })
        // A commit at its detached HEAD, which its branch doesn't have.
        yield* repository.commit(join(root, "ahead"), "ahead", { "b.ts": "b" })
        return yield* free.list(freeing, yield* (yield* Beads).list())
      }),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const blockers = ["b-1" as TicketId]
    expect([...ran.exit.value].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "ahead" as TicketId, blockers },
      { id: "dirty" as TicketId, blockers, uncommitted: join(root, "dirty") },
      { id: "empty" as TicketId, blockers, worktree: join(root, "empty") },
    ])
  })
})

describe("a ticket set aside, its worktree left detached, and merged by hand", () => {
  const options = { repo: "/repo", base: "main" }
  const a = "a" as TicketId

  /** A check that fails in a file no ticket here changes. */
  const elsewhere = new CheckFailed({
    check: "fast",
    command: "scripts/check-fast.sh",
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: ["shared/b.go:12: expected 1"],
    lastLines: ["shared/b.go:12: expected 1", "1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

  /** a, its worker finished: its worktree on tutti/a with a commit naming it, Working. */
  const finished = Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(a)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, "Do a (a)", { "a/a.go": "a\n" })
    yield* (yield* Beads).close(a, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(a, Move.Ready(), { title: "Ticket a" })
    yield* ledger.transition(a, Move.Dispatched())
    return {
      id: a,
      title: "Ticket a",
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

  const phaseOf = (state: State, id: TicketId) => state.tickets.get(id)?.phase._tag

  /** Waits until a is in its phase. */
  const until = (phase: PhaseTag) =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      yield* ledger.changes.pipe(
        Stream.filter((state) => phaseOf(state, a) === phase),
        Stream.runHead,
      )
    })

  /**
   * a finishes after main moved and its check fails on main, so it is set aside; its worktree is
   * then left detached, `leave` leaves what it will in it, main gets a's change squash-merged by
   * hand, and the queue looks for the tickets due a recheck. a's phase after.
   */
  const setAsideThen = (leave: (worktree: string) => Effect.Effect<void, unknown, Env>) =>
    scenario(
      { backlog: backlog().ticket("a").seeds, checks: { fast: [elsewhere] } },
      Effect.gen(function* () {
        const queue: MergeQueue = yield* makeQueue(options)
        const repository = yield* Repository
        const ticket = yield* finished
        yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        yield* queue.offer(ticket)
        yield* until("Review")
        yield* detach(ticket.worktree)
        yield* leave(ticket.worktree)
        yield* repository.commit(repository.dir, "Squash-merge a (a)", { "a/a.go": "a\n" })
        yield* queue.recheck
        yield* queue.settled
        return phaseOf(yield* (yield* Ledger).current, a)
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
        PhaseTag | undefined,
        unknown,
        Env | Scope.Scope
      >,
    )

  const resultOf = <A>(ran: Ran<A>): A => {
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    return ran.exit.value
  }

  test("is Done, its worktree found at <root>/<id> and set aside with its branch", async () => {
    const ran = await setAsideThen(() => Effect.void)
    expect(resultOf(ran)).toBe("Done")
    expectLog(ran, [
      /^ {2}a, set aside in this run, is on main now \([0-9a-f]{7} Squash-merge a \(a\)\): merged by hand, so no longer set aside; worktree and branch removed$/,
    ])
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id: a, force: false, aside: true })
  })

  test("with uncommitted changes in it, the worktree is found and left, saying so", async () => {
    const ran = await setAsideThen((worktree) =>
      Effect.flatMap(Repository, (repository) =>
        repository.write(worktree, { "notes.txt": "mine\n" }),
      ),
    )
    expect(resultOf(ran)).toBe("Done")
    expectLog(ran, [
      /^ {2}a, set aside in this run, is on main now \([0-9a-f]{7} Squash-merge a \(a\)\): merged by hand, so no longer set aside; worktree \S+ has uncommitted changes \(notes\.txt\), so it and tutti\/a are left as they are \(commit or remove them, then remove it\)$/,
    ])
    expect(ran.worktreeCalls.some((call) => call.op === "remove")).toBe(false)
  })
})
