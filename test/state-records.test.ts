// state.json's ticket records across runs (§ 4.8): a ticket merged, closed with no change or
// dropped WORKER_GONE is forgotten; one the run leaves otherwise keeps its record, with the phase
// it left the run in; and the records a crashed run left unsuspended are carried over.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { carryOnText, crashedWhy } from "../src/run/carry.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { type RunStamp, type State, Store, type TicketRecord } from "../src/services/Store.ts"
import {
  bash,
  claimsAndCloses,
  defers,
  failStart,
  gone,
  run as runs,
  type SessionScript,
  turn,
  withoutNotes,
} from "../src/testing/AgentHost.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { Repository } from "../src/testing/Git.ts"
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

/** A new folder, its real path: the main checkout's, or the worktrees'. */
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-records-${name}-`)))

/** The pid of a process that has ended. */
const endedPid = (): number => Bun.spawnSync(["true"]).pid

/** The run that wrote state.json last, as process `pid`. */
const lastRun = (pid: number): RunStamp => ({
  pid,
  started: "2026-10-19T08:00:00Z",
  version: "0.1.0-test",
})

/** What a run that crashed left of a ticket it had in progress: no suspension, no phase. */
const crashRecord = (root: string, id: string): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  resumes: 0,
  metadata: {},
})

interface Plan {
  readonly backlog: ReadonlyArray<Seed>
  /** What the last run left in state.json, by ticket, each worktree under `root`. */
  readonly saved?: (root: string) => Readonly<Record<string, TicketRecord>>
  /** The run that wrote state.json last. */
  readonly last?: RunStamp
  /** The tickets whose worktrees are there, in git, before the run. */
  readonly worktrees?: ReadonlyArray<string>
  readonly scripts?: (
    world: World,
    root: string,
  ) => Readonly<Record<string, ReadonlyArray<SessionScript>>>
  readonly before?: (repo: string, root: string) => Effect.Effect<void, unknown, Env>
}

interface Ended {
  readonly ran: Ran<Outcome>
  readonly state: State
  readonly root: string
}

/** A whole plain run on main, and state.json as it left it. */
const plainRun = async (plan: Plan): Promise<Ended> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let state: State | undefined
  const ran = await scenario(
    {
      backlog: plan.backlog,
      config: { repo },
      git: { dir: repo },
      worktrees: { root },
      state: {
        version: 1,
        ...(plan.last === undefined ? {} : { run: plan.last }),
        tickets: plan.saved?.(root) ?? {},
      },
      scripts: (world: World) => plan.scripts?.(world, root) ?? {},
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.worktrees ?? []) {
        mkdirSync(join(root, id), { recursive: true })
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      if (plan.before !== undefined) yield* plan.before(repo, root)
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      const outcome = yield* Fiber.join(fiber)
      state = yield* (yield* Store).state
      return outcome
    }),
  )
  if (state === undefined) throw new Error(`the run failed: ${ran.exit}`)
  return { ran, state, root }
}

/** What a ticket's worker's commands do to the in-memory Beads and git. */
const commands = (world: World, root: string, id: string) => {
  const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))
  return {
    claim: orDie(world.beads.update(id, { claim: true })),
    commit: orDie(
      world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
    ),
    misnamed: orDie(
      world.repository.commit(join(root, id), "Change something (t-10)", { "a.txt": "a\n" }),
    ),
    close: orDie(world.beads.close(id, "done")),
    defer: orDie(world.beads.defer(id)),
  }
}

/** The ticket's sessions as they were started and resumed: `Started s` or `Resumed s`. */
const sessionsOf = (ran: Ran<unknown>, id: string) =>
  ran.sent.flatMap((sent) =>
    (sent._tag === "Started" || sent._tag === "Resumed") && sent.ticket === id
      ? [`${sent._tag} ${sent.session.sessionId}`]
      : [],
  )

/** The messages the ticket's worker was sent, as text. */
const textsOf = (ran: Ran<unknown>, id: string) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id
      ? [withoutNotes(String(sent.message.message.content))]
      : [],
  )

const carriedOver = (ran: Ran<unknown>) => ran.log.some((each) => each.includes("carried over"))

describe("state.json: a ticket the run is done with", () => {
  test("merged, is forgotten", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1").seeds,
      worktrees: ["t-1"],
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("closed with no change, is forgotten", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1").seeds,
      worktrees: ["t-1"],
      scripts: (world, root) => ({
        "t-1": [turn([...bash("bd close t-1", commands(world, root, "t-1").close)])],
      }),
    })
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [/t-1 closed with no change/])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("dropped WORKER_GONE, its session not resumed, is forgotten", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1").seeds,
      worktrees: ["t-1"],
      scripts: (world, root) => ({
        "t-1": [
          [...turn([runs(commands(world, root, "t-1").claim)]).slice(0, -2), gone("exit 1")],
          [failStart("No conversation found with session ID")],
        ],
      }),
    })
    expectPhases(ran, { "t-1": "Review" })
    expectLog(ran, [/WORKER_GONE: t-1 is in progress/])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("closed with no change as it merges, the base having its change, is forgotten", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1").seeds,
      worktrees: ["t-1"],
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
      // main gets the same change while t-1 runs: the rebase drops its commit (closeUnchanged).
      before: (repo) =>
        Effect.asVoid(
          Effect.flatMap(Repository, (repository) =>
            repository.commit(repo, "Land the same change", { "t-1.txt": "x\n" }),
          ),
        ),
    })
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [/t-1 closed with no change: rebased onto main, which has its changes already/])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("deferred, is forgotten: undeferred, it starts a new session", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1").seeds,
      worktrees: ["t-1"],
      scripts: (world, root) => {
        const c = commands(world, root, "t-1")
        return { "t-1": [defers("t-1", { claim: c.claim, defer: c.defer })] }
      },
    })
    expectPhases(ran, { "t-1": "Deferred" })
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("left for review otherwise, keeps its record, with the phase it left the run in", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1").seeds,
      worktrees: ["t-1"],
      scripts: (world, root) => {
        const c = commands(world, root, "t-1")
        return { "t-1": [turn([runs(c.misnamed), runs(c.close)])] }
      },
    })
    expectPhases(ran, { "t-1": "Review" })
    const record = state.tickets["t-1"]
    expect(record?.session).toEqual(expect.any(String))
    expect(record?.suspended).toBeUndefined()
    expect(record?.phase).toBe("Review")
  })
})

describe("state.json: what a crashed run left", () => {
  test("a ticket in progress is resumed with its session, told the last run crashed", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
      saved: (root) => ({ "t-1": crashRecord(root, "t-1") }),
      last: lastRun(endedPid()),
      worktrees: ["t-1"],
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(sessionsOf(ran, "t-1")).toEqual(["Resumed session-t-1"])
    expect(textsOf(ran, "t-1")).toEqual([carryOnText("t-1", crashedWhy)])
    expectLog(ran, [
      /^ {2}RESUMED: t-1 was in progress as the last run crashed; resuming its session session-t-1 \(worktree .*t-1\)$/,
    ])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("a ticket closed is merged", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1", { status: "closed" }).seeds,
      saved: (root) => ({ "t-1": crashRecord(root, "t-1") }),
      last: lastRun(endedPid()),
      worktrees: ["t-1"],
      before: (_, root) =>
        Effect.asVoid(
          Effect.flatMap(Repository, (repository) =>
            repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
          ),
        ),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expectLog(ran, ["  t-1, carried over from the last run, is closed, so it waits to merge"])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("a ticket back in the queue is forgotten, and starts afresh", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1").seeds,
      saved: (root) => ({ "t-1": crashRecord(root, "t-1") }),
      last: lastRun(endedPid()),
      worktrees: ["t-1"],
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
    })
    expectPhases(ran, { "t-1": "Done" })
    expect(carriedOver(ran)).toBe(false)
    const [started] = sessionsOf(ran, "t-1")
    expect(started).toStartWith("Started ")
    expect(started).not.toBe("Started session-t-1")
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("a ticket set aside is forgotten, not resumed", async () => {
    const { ran, state } = await plainRun({
      backlog: backlog().ticket("t-1", { status: "deferred" }).seeds,
      saved: (root) => ({ "t-1": crashRecord(root, "t-1") }),
      last: lastRun(endedPid()),
      worktrees: ["t-1"],
    })
    expectPhases(ran, {})
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expect(carriedOver(ran)).toBe(false)
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("is resumed though a live process has the PID of the run that wrote it now", async () => {
    // The run lock is held, so the run state.json names has ended, whatever has its PID.
    const { ran } = await plainRun({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
      saved: (root) => ({ "t-1": crashRecord(root, "t-1") }),
      last: lastRun(process.pid),
      worktrees: ["t-1"],
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
    })
    expectPhases(ran, { "t-1": "Done" })
    expect(sessionsOf(ran, "t-1")).toEqual(["Resumed session-t-1"])
    expect(textsOf(ran, "t-1")).toEqual([carryOnText("t-1", crashedWhy)])
  })

  test("a record a run that ended left, with its phase, isn't taken for a crash's", async () => {
    const { ran } = await plainRun({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
      saved: (root) => ({ "t-1": { ...crashRecord(root, "t-1"), phase: "Review" } }),
      last: lastRun(endedPid()),
      worktrees: ["t-1"],
    })
    expectPhases(ran, {})
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expect(carriedOver(ran)).toBe(false)
  })
})
