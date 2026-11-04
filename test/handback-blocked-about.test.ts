// What a ticket Blocked on its merge keeps for Needs you (§ 7.2, tutti-urp4): the files in conflict,
// its worktree and why it was left so, from its conflict's hand-backs used or a merge that stopped
// the merges; gone once it leaves Blocked.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { maxHandBacks, mostHandBacks } from "../src/run/handback.ts"
import { type BlockedAbout, Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Finished, Move, TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { init, result, run, sessionState, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Ran, type Scripts, scenario, type World } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const a = "a" as TicketId
const b = "b" as TicketId
const defaults = appConfig().settings
const config = {
  settings: {
    ...defaults,
    checks: {
      ...defaults.checks,
      fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
    },
  },
}

const worktrees = new Map<string, string>()

const finished = (id: TicketId, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
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
    yield* (yield* AgentHost).start(id, { sessionId, cwd: worktree.path })
    yield* untilSettled(id)
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Ticket a finished, main moved on by a commit saying `message`, then its turn in the queue. */
const merging = (scripts: (world: World) => Scripts, message: string) =>
  scenario(
    { backlog: backlog().ticket("a").ticket("b").seeds, config, scripts },
    Effect.gen(function* () {
      const queue = yield* makeQueue(options)
      const ledger = yield* Ledger
      const repository = yield* Repository
      yield* ledger.transition(b, Move.Ready(), { title: "Ticket b" })
      const ticket = yield* finished(a, { "a.txt": "a\n" })
      yield* repository.commit(repository.dir, message, { "a.txt": "main's a\n" })
      yield* queue.offer(ticket)
      yield* queue.settled
      return (yield* ledger.current).tickets.get(a)
    }).pipe(Effect.provide(Ledger.layer)),
  )

const about = (ran: Ran<{ readonly about?: BlockedAbout | undefined } | undefined>) => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value?.about
}

const idle = [init(), sessionState("running"), result(), sessionState("idle")]

const resolvesThenMainMoves = (
  world: World,
  files: Files,
  then: Files,
  message: string,
  conflicts = false,
) =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(world.repository.continueRebase(worktrees.get("a") ?? "", files)),
      ),
    ),
    run(Effect.asVoid(world.repository.commit(world.repository.dir, message, then))),
    ...(conflicts ? [run(world.repository.conflict("tutti/a", ["a.txt"]))] : []),
  ])

describe("a ticket blocked on its conflict", () => {
  test("keeps its files, worktree and hand-backs used, and which merge moved the base", async () => {
    const ran = await merging(
      (world) => ({
        a: [
          [
            ...idle,
            ...Array.from({ length: mostHandBacks }, (_, i) =>
              resolvesThenMainMoves(
                world,
                { "a.txt": `both ${i}\n` },
                { "a.txt": `main ${i}\n` },
                `Land b ${i} (b)`,
              ),
            ).flat(),
          ],
        ],
      }),
      "Land something else",
    )
    expect(about(ran)).toEqual({
      worktree: worktrees.get("a") ?? "",
      files: ["a.txt"],
      reason: `${mostHandBacks} hand-backs used; main moved on as b merged`,
    })
  })

  test("hand-backs used on a conflict nothing merged made: says only those", async () => {
    const ran = await merging(
      (world) => ({
        a: [
          [
            ...idle,
            ...[0, 1].flatMap((i) =>
              resolvesThenMainMoves(
                world,
                { "a.txt": `both ${i}\n` },
                { "z.txt": `main ${i}\n` },
                `Land b ${i} (b)`,
                true,
              ),
            ),
          ],
        ],
      }),
      "Land something else",
    )
    expect(about(ran)?.reason).toBe(`${maxHandBacks} hand-backs used`)
  })

  test("a commit that names no ticket of the run is named by its hash", async () => {
    const off = {
      config: {
        settings: {
          ...config.settings,
          merge: { ...config.settings.merge, resolve_conflicts: false },
        },
      },
    }
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, ...off, scripts: () => ({ a: [idle] }) },
      Effect.gen(function* () {
        const queue = yield* makeQueue(options)
        const repository = yield* Repository
        const ticket = yield* finished(a, { "a.txt": "a\n" })
        yield* repository.commit(repository.dir, "Change by hand", { "a.txt": "main's a\n" })
        const head = yield* (yield* Git).revParse(repository.dir, "main")
        yield* queue.offer(ticket)
        yield* queue.settled
        const entry = (yield* (yield* Ledger).current).tickets.get(a)
        return { about: entry?.about, head }
      }).pipe(Effect.provide(Ledger.layer)),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const { about: kept, head } = ran.exit.value
    expect(kept?.files).toEqual(["a.txt"])
    expect(kept?.reason).toBe(
      `not handed back to its worker: resolving conflicts is turned off; main moved on as ${head.slice(0, 7)} merged`,
    )
    expect(kept?.handBacksOff).toBe(true)
  })
})

describe("a ticket whose merge stopped the merges", () => {
  test("keeps its worktree and the line's reason, with no files", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, config, scripts: () => ({ a: [idle] }) },
      Effect.gen(function* () {
        const queue = yield* makeQueue(options)
        const repository = yield* Repository
        const ticket = yield* finished(a, { "a.txt": "a\n" })
        yield* repository.write(repository.dir, { "README.md": "edited by hand\n" })
        yield* queue.offer(ticket)
        yield* queue.settled
        yield* (yield* Ledger).changes.pipe(
          Stream.filter((state) => state.tickets.get(a)?.phase._tag === "Blocked"),
          Stream.runHead,
        )
        return (yield* (yield* Ledger).current).tickets.get(a)
      }).pipe(Effect.provide(Ledger.layer)),
    )
    const kept = about(ran)
    expect(kept?.worktree).toBe(worktrees.get("a") ?? "")
    expect(kept?.files).toEqual([])
    expect(kept?.reason).toMatch(/^uncommitted changes in .*; tutti\/a is not merged/)
  })
})

describe("what a ticket keeps of its block", () => {
  test("is gone once it leaves Blocked", async () => {
    const kept = { worktree: "/wt/a", files: ["a.txt"], reason: "2 hand-backs used" }
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition(a, Move.Ready(), { title: "Ticket a" })
        yield* ledger.transition(a, Move.Dispatched())
        yield* ledger.transition(a, Move.Verified({ place: 1 }))
        yield* ledger.transition(a, Move.ItsTurn())
        yield* ledger.transition(a, Move.Block({ why: "MERGE_CONFLICT" }), { about: kept })
        const blocked = (yield* ledger.current).tickets.get(a)
        yield* ledger.transition(a, Move.MergedByHand({ commit: "abc" }))
        return { blocked, after: (yield* ledger.current).tickets.get(a) }
      }).pipe(Effect.provide(Ledger.layer)),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    expect(ran.exit.value.blocked?.about).toEqual(kept)
    expect(ran.exit.value.after?.phase).toEqual(
      TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc" }) }),
    )
    expect(ran.exit.value.after?.about).toBeUndefined()
  })
})
