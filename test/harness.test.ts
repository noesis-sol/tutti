import { describe, expect, test } from "bun:test"
import { Effect, Fiber, FiberSet, Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { settled } from "../src/agent/WorkerState.ts"
import { EventStream } from "../src/run/eventstream.ts"
import { RunFibers } from "../src/run/fibers.ts"
import { Log, line } from "../src/run/log.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { exec, ProcessGroups, run as runCommand } from "../src/services/exec.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { Backlog } from "../src/testing/Beads.ts"
import { Repository } from "../src/testing/Git.ts"
import {
  advance,
  backlog,
  environment,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  Leaked,
  type Outcome as RunOutcome,
  scenario,
  type World,
} from "./harness.ts"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits up to `ms` for the process to be gone, and says whether it went. */
const gone = async (pid: number, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    await Bun.sleep(20)
  }
  return true
}

/**
 * A trivial whole run: one ticket's worker forked into a registered FiberSet after a minute on the
 * clock, plays its script to a settled state and is ended, while the run runs a command.
 */
const trivialRun = Effect.gen(function* () {
  const fibers = yield* RunFibers
  const host = yield* AgentHost
  const repo = yield* Repository
  const log = yield* Log
  const events = yield* EventStream
  const tickets = yield* fibers.make("tickets")
  const ticket = yield* FiberSet.run(
    tickets,
    Effect.gen(function* () {
      yield* Effect.sleep("1 minute")
      const worktree = yield* (yield* Worktrees).prepare("t-1")
      yield* host.start("t-1", { sessionId: "s-1", cwd: worktree.path })
      yield* host.send("t-1", { text: "Work on t-1.", from: "clientComposed" })
      yield* host.state("t-1").pipe(Stream.filter(settled), Stream.take(1), Stream.runDrain)
      yield* host.end("t-1")
      yield* log.write(line`  t-1 merged`)
      return yield* repo.head("main")
    }),
  )
  const said = yield* runCommand({
    command: "sh",
    args: ["-c", "echo checked"],
    timeLimit: "10 seconds",
  })
  yield* log.write(line`${said.stdout.trim()}`)
  yield* Effect.yieldNow
  yield* advance("1 minute")
  const commit = yield* Fiber.join(ticket)
  yield* events.emit({ kind: "done", text: "READY_EMPTY" })
  return {
    exitCode: 0,
    phases: { "t-1": TicketPhase.Done({ outcome: Finished.Merged({ commit }) }) },
  } satisfies RunOutcome
})

const oneTicket = {
  backlog: backlog().ticket("t-1", { title: "One ticket" }).seeds,
  scripts: ({ beads, repository }: World) => ({
    "t-1": [
      claimsAndCloses("t-1", {
        claim: Effect.orDie(beads.update("t-1", { claim: true })),
        commit: Effect.asVoid(repository.commit(repository.dir, "Change (t-1)", { "a.txt": "a" })),
        close: Effect.orDie(beads.close("t-1")),
      }),
    ],
  }),
}

describe("scenario", () => {
  // Slow under load, not hanging: the ticket's sleep is registered before the command runs, but
  // as the file's first scenario it pays the cold start (~4× a warm run) and spawns a real sh.
  test("a trivial run passes, and its log, events, phases and exit code can be asserted", async () => {
    const ran = await scenario(oneTicket, trivialRun)
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, ["checked", /t-1 merged$/])
    expectEvents(ran, ["done"])
    expect(ran.leaks).toEqual({ fibers: [], processes: [] })
    expect(ran.worktreeCalls).toEqual([{ op: "prepare", id: "t-1" }])
    expect(ran.sent.map((sent) => sent._tag)).toEqual(["Started", "Message", "Closed", "Ended"])
    expect(ran.issues.find((issue) => issue.id === "t-1")?.status).toBe("closed")
  }, 30_000)

  test("a fiber left in a registered FiberSet once the run's scope closes fails it", async () => {
    // The set lives in a scope that outlives the run, as a service's would.
    const leaky = Effect.gen(function* () {
      const fibers = yield* RunFibers
      const outlives = yield* Scope.make()
      const set = yield* fibers.make("triage").pipe(Scope.provide(outlives))
      yield* FiberSet.run(set, Effect.never)
      return { exitCode: 0, phases: {} } satisfies RunOutcome
    })
    const failed = await scenario({}, leaky).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(Leaked)
    expect((failed as Leaked).leaks).toEqual({
      fibers: [{ name: "triage", fibers: 1 }],
      processes: [],
    })
    expect((failed as Leaked).message).toContain("1 fiber(s) in the FiberSet triage")
  })

  test("a process left running once the run's scope closes fails it, and is killed", async () => {
    let pid: number | undefined
    // A detached fiber outlives the run's scope, and so does the command it runs.
    const leaky = Effect.gen(function* () {
      yield* exec({
        command: "sh",
        args: ["-c", "sleep 30"],
        timeLimit: "1 minute",
      }).pipe(Effect.forkDetach)
      pid = yield* waitForGroup
      return { exitCode: 0, phases: {} } satisfies RunOutcome
    })
    const failed = await scenario({}, leaky).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(Leaked)
    expect((failed as Leaked).leaks).toEqual({ fibers: [], processes: [pid as number] })
    expect(await gone(pid as number)).toBe(true)
  })

  test("the fibers of a set in the run's scope are interrupted with it: no leak", async () => {
    const ran = await scenario(
      {},
      Effect.gen(function* () {
        const set = yield* (yield* RunFibers).make("scheduler")
        yield* FiberSet.run(set, Effect.never)
        return { exitCode: 0, phases: {} } satisfies RunOutcome
      }),
    )
    expect(ran.leaks).toEqual({ fibers: [], processes: [] })
  })

  test("a failed run is shown by the outcome assertions", async () => {
    const ran = await scenario({}, Effect.fail("no outcome"))
    expect(() => expectExitCode(ran as never, 0)).toThrow(/the run failed/)
  })
})

describe("environment", () => {
  test("each part starts as the setup says, under TestClock", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const issues = yield* (yield* Backlog).issues
        const stored = yield* (yield* Store).state
        const start = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        return { ids: issues.map((issue) => issue.id), stored, start }
      }).pipe(Effect.provide(environment({ backlog: backlog().chain("a-1", "a-2").seeds }))),
    )
    expect(state.ids).toEqual(["a-1", "a-2"])
    expect(state.stored.tickets).toEqual({})
    expect(state.start).toBe(0)
  })
})

describe("backlog", () => {
  test("builds tickets, epics and chains", () => {
    expect(
      backlog().ticket("t-1", { priority: 1 }).epic("e-1", ["e-1.1"]).chain("c-1", "c-2").seeds,
    ).toEqual([
      { id: "t-1", priority: 1 },
      { id: "e-1", type: "epic" },
      { id: "e-1.1", parent: "e-1" },
      { id: "c-1" },
      { id: "c-2", blockedBy: ["c-1"] },
    ])
  })
})

/** The process group exec has started, once it is registered. */
const waitForGroup: Effect.Effect<number> = Effect.gen(function* () {
  const groups = yield* ProcessGroups
  while (groups.size === 0) yield* Effect.promise(() => Bun.sleep(10))
  return [...groups][0] as number
})
