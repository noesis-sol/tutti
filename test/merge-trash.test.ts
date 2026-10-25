// A merged worktree's folder deleted outside the merge queue (trash.ts): the merge moves it into the
// worktrees' trash folder and git forgets it, and its files are deleted in the background, so the
// queue goes on to the next ticket while a slow deletion is still under way. A deletion that fails
// is CLEANUP_FAILED, and what an earlier run left in the trash is deleted as the next run starts.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Layer, type Scope } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { run } from "../src/run/run.ts"
import { Trash, layer as trashLayer } from "../src/run/trash.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { trashFolder, Worktrees } from "../src/services/Worktrees.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-merge-trash-${name}-`)))

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads. */
const finished = (id: TicketId, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    // What its setup installed, which git ignores and the merge's removal deletes.
    mkdirSync(join(worktree.path, "node_modules"), { recursive: true })
    writeFileSync(join(worktree.path, "node_modules", "installed.txt"), "x\n")
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

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

/**
 * Finishes the tickets `ids` and merges them in that order, with the Worktrees service's methods
 * `wrap` gives in place of its own, the trash's deletions too; `settled` is run once the queue has
 * settled.
 */
const merging = <A>(
  ids: ReadonlyArray<TicketId>,
  wrap: (live: Worktrees["Service"]) => Partial<Worktrees["Service"]>,
  settled: (merged: {
    readonly tickets: ReadonlyArray<FinishedTicket>
    readonly phases: Record<string, PhaseTag>
  }) => Effect.Effect<A, never, Trash>,
) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    return yield* Effect.gen(function* () {
      const tickets: Array<FinishedTicket> = []
      for (const id of ids) tickets.push(yield* finished(id, { [`${id}.txt`]: `${id}\n` }))
      const queue = yield* makeQueue(options)
      for (const ticket of tickets) yield* queue.offer(ticket)
      yield* queue.settled
      return yield* settled({ tickets, phases: tagsOf(yield* (yield* Ledger).current) })
    }).pipe(
      Effect.provide(Ledger.layer),
      // Its own, over the Worktrees given here, not the one the harness built.
      Effect.provide(Layer.fresh(trashLayer)),
      Effect.provideService(Worktrees, { ...worktrees, ...wrap(worktrees) }),
    )
  }) satisfies Effect.Effect<A, unknown, Env | Scope.Scope>

describe("a merged worktree's folder", () => {
  test("is set aside and the queue goes on while its slow deletion is still under way", async () => {
    const root = folder("worktrees")
    const ran = await scenario(
      { backlog: backlog().ticket("a").ticket("b").seeds, worktrees: { root } },
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        const aside: Array<string> = []
        return yield* merging(
          ["a" as TicketId, "b" as TicketId],
          (live) => ({
            remove: (id, removal) =>
              Effect.tap(live.remove(id, removal), (path) =>
                Effect.sync(() => {
                  if (path !== undefined) aside.push(path)
                }),
              ),
            // Held open until the test lets it go.
            deleteAside: (path) => Effect.andThen(Deferred.await(release), live.deleteAside(path)),
          }),
          ({ tickets, phases }) =>
            Effect.gen(function* () {
              // Both merged while neither folder is deleted yet.
              const during = {
                phases,
                worktreesLeft: tickets.map((ticket) => existsSync(ticket.worktree)),
                asideLeft: aside.map((path) => existsSync(path)),
              }
              yield* Deferred.succeed(release, undefined)
              yield* (yield* Trash).settled
              return { during, aside, asideAfter: aside.map((path) => existsSync(path)) }
            }),
        )
      }),
    )
    if (ran.exit._tag === "Failure") throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const { during, aside, asideAfter } = ran.exit.value
    expect(during.phases).toEqual({ a: "Done", b: "Done" })
    // Moved out of the worktrees' folder at once, into the trash folder, still there.
    expect(during.worktreesLeft).toEqual([false, false])
    expect(aside).toHaveLength(2)
    for (const path of aside) expect(path.startsWith(join(root, trashFolder))).toBe(true)
    expect(during.asideLeft).toEqual([true, true])
    expect(asideAfter).toEqual([false, false])
    expectLog(ran, [
      /^ {2}a closed \([0-9a-f]{7} Do a \(a\)\); merged into main, worktree and branch removed$/,
      /^ {2}b closed \([0-9a-f]{7} Do b \(b\)\); merged into main, worktree and branch removed$/,
    ])
    expect(ran.log.some((line) => line.includes("CLEANUP_FAILED"))).toBe(false)
  })

  test("a deletion that fails is CLEANUP_FAILED, naming the folder; the ticket is Done", async () => {
    const failure = new PlatformError(
      new SystemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
        description: "permission denied",
      }),
    )
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      merging(
        ["a" as TicketId],
        () => ({ deleteAside: () => Effect.fail(failure) }),
        ({ phases }) =>
          Effect.as(
            Effect.flatMap(Effect.service(Trash), (trash) => trash.settled),
            phases,
          ),
      ),
    )
    if (ran.exit._tag === "Failure") throw new Error(`the scenario failed: ${ran.exit.cause}`)
    expect(ran.exit.value).toEqual({ a: "Done" })
    const warned = ran.log.filter((line) => line.includes("CLEANUP_FAILED"))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(
      new RegExp(
        `^ {2}CLEANUP_FAILED: for (\\S+/${trashFolder}/a-\\S+): the folder of a merged worktree, set aside to be deleted, is left \\(.*permission denied.*\\); rm -rf \\1 deletes it$`,
      ),
    )
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "warn", ticket: "a", text: warned[0] }),
    )
  })
})

describe("the trash an earlier run left", () => {
  test("is deleted as the next run starts, each folder said", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const left = join(root, trashFolder, "t-1-aB3xYz")
    mkdirSync(join(left, "t-1", "node_modules"), { recursive: true })
    writeFileSync(join(left, "t-1", "node_modules", "installed.txt"), "x\n")
    const ticket = join(root, "t-2")
    mkdirSync(ticket, { recursive: true })
    const ran = await scenario(
      { config: { repo }, git: { dir: repo }, worktrees: { root } },
      Effect.andThen(
        run({ version: "0.1.0-test", base: "main" }),
        Effect.flatMap(Effect.service(Trash), (trash) => trash.settled),
      ),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(existsSync(left)).toBe(false)
    expect(existsSync(ticket)).toBe(true)
    expect(ran.worktreeCalls).toContainEqual({ op: "deleteAside", path: left })
    expectLog(ran, [`  deleted ${left}, a merged worktree's folder an earlier run left`])
  })
})
