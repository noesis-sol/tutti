// What a ticket Blocked on its conflict keeps of hand-backs being off, for Needs you to say what `h`
// does (tutti-5mc3): by each setting that turns them off, on each way a merge blocks it, and not
// where they are on.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger } from "../src/run/ledger.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { Move } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Checks } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { init, result, sessionState } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const a = "a" as TicketId
const defaults = appConfig().settings
const settings = (resolve: boolean, command: string | null) => ({
  settings: {
    ...defaults,
    merge: { ...defaults.merge, resolve_conflicts: resolve },
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command } },
  },
})
const idle = [init(), sessionState("running"), result(), sessionState("idle")]

const finished = Effect.gen(function* () {
  const git = yield* Git
  const repository = yield* Repository
  const worktree = yield* (yield* Worktrees).prepare(a)
  yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
  yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
  yield* (yield* Beads).close(a, "done")
  const ledger = yield* Ledger
  yield* ledger.transition(a, Move.Ready(), { title: "Ticket a" })
  yield* ledger.transition(a, Move.Dispatched())
  const sessionId = "session-a"
  yield* (yield* Store).saveSession(a, {
    session: sessionId,
    worktree: worktree.path,
    branch: worktree.branch,
  })
  yield* (yield* AgentHost).start(a, { sessionId, cwd: worktree.path })
  yield* untilSettled(a)
  return {
    id: a,
    title: "Ticket a",
    branch: worktree.branch,
    worktree: worktree.path,
  } satisfies FinishedTicket
})

type Queue = ReturnType<typeof makeQueue>

/** What ticket a keeps once its merge is over, under `config`, main having changed `landed`. */
const keptAfter = async (
  config: ReturnType<typeof settings>,
  landed: string,
  around: (queue: Queue) => Queue = (queue) => queue,
  before: (queue: MergeQueue) => Effect.Effect<void> = () => Effect.void,
) => {
  const ran = await scenario(
    { backlog: backlog().ticket("a").seeds, config, scripts: () => ({ a: [idle] }) },
    Effect.gen(function* () {
      const queue = yield* around(makeQueue(options))
      const ticket = yield* finished
      const repository = yield* Repository
      yield* repository.commit(repository.dir, "Land b (b)", { [landed]: "main's\n" })
      yield* before(queue)
      yield* queue.offer(ticket)
      yield* queue.settled
      return (yield* (yield* Ledger).current).tickets.get(a)
    }).pipe(Effect.provide(Ledger.layer)),
  )
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("a ticket blocked on its rebase's conflict", () => {
  test("with no check command: keeps that hand-backs are off", async () => {
    const entry = await keptAfter(settings(true, null), "a.txt")
    expect(entry?.phase).toEqual(expect.objectContaining({ _tag: "Blocked" }))
    expect(entry?.about?.handBacksOff).toBe(true)
    expect(entry?.about?.reason).toContain("there is no check command")
  })

  test("with resolving turned off: keeps that hand-backs are off", async () => {
    const entry = await keptAfter(settings(false, "scripts/check-fast.sh"), "a.txt")
    expect(entry?.about?.handBacksOff).toBe(true)
  })
})

describe("a ticket you took up that conflicts again", () => {
  const takenUp = (queue: MergeQueue) => queue.handBacks.takeUp(a)
  const same = (queue: Queue) => queue

  test("with resolving turned off: keeps that hand-backs are off", async () => {
    const config = settings(false, "scripts/check-fast.sh")
    const entry = await keptAfter(config, "a.txt", same, takenUp)
    expect(entry?.about?.reason).toContain("you fixed its branch by hand")
    expect(entry?.about?.handBacksOff).toBe(true)
  })

  test("with hand-backs on: keeps nothing of it, as `h` gives it back to its worker", async () => {
    const config = settings(true, "scripts/check-fast.sh")
    const entry = await keptAfter(config, "a.txt", same, takenUp)
    expect(entry?.about?.reason).toContain("you fixed its branch by hand")
    expect(entry?.about?.handBacksOff).toBeUndefined()
  })
})

describe("a ticket blocked as its base kept changing while its checks ran", () => {
  /** Main moves on by a file of its own in each check, until the budget runs out. */
  const overtaken = (queue: Queue): Queue =>
    Effect.gen(function* () {
      const repository = yield* Repository
      const checks = yield* Checks
      let n = 0
      return yield* Effect.provideService(queue, Checks, {
        ...checks,
        fast: (run) =>
          Effect.flatMap(
            repository.commit("/repo", `By hand ${++n}`, { [`hand${n}.txt`]: "x\n" }),
            () => checks.fast(run),
          ),
      })
    }) as Queue

  test("with resolving turned off: keeps that hand-backs are off", async () => {
    const entry = await keptAfter(settings(false, "scripts/check-fast.sh"), "z.txt", overtaken)
    expect(entry?.about?.reason).toContain("kept changing")
    expect(entry?.about?.handBacksOff).toBe(true)
  })

  test("with hand-backs on: keeps nothing of it", async () => {
    const entry = await keptAfter(settings(true, "scripts/check-fast.sh"), "z.txt", overtaken)
    expect(entry?.about?.reason).toContain("kept changing")
    expect(entry?.about?.handBacksOff).toBeUndefined()
  })
})
