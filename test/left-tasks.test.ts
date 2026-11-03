// A worker kept from settling by nothing but background tasks it left running (a dev server, a
// watch-mode test), its turns over, has them stopped (tutti-epza.12): at once when its ticket is
// closed, else after tasksLimit with no turn; the log says which, and the worker settles after the
// turn the CLI starts to report them.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Exit, Fiber, type Scope } from "effect"
import { read } from "../src/agent/reading.ts"
import {
  initial,
  step,
  tasksOnlySince,
  type Worker,
  WorkerEvent,
  WorkerState,
} from "../src/agent/WorkerState.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import { tasksLimit } from "../src/run/settle.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  awaitStopTask,
  backgroundTasks,
  bash,
  result,
  type SessionScript,
  selfStartedTurn,
  sleep,
  taskStopped,
  turn,
} from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ session: "s", reading: read(message as unknown as SDKMessage) })
const init = sdk({ type: "system", subtype: "init", permissionMode: "auto", session_id: "s" })
const running = sdk({ type: "system", subtype: "session_state_changed", state: "running" })
const idle = sdk({ type: "system", subtype: "session_state_changed", state: "idle" })
const done = sdk({ type: "result", subtype: "success", is_error: false, result: "DONE" })
const failed = sdk({ type: "result", subtype: "error_during_execution", is_error: true })
const tasks = (...live: ReadonlyArray<{ readonly id: string; readonly ambient?: boolean }>) =>
  sdk({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: live.map(({ id, ambient }) => ({
      task_id: id,
      task_type: "local_bash",
      description: `run ${id}`,
      ...(ambient === undefined ? {} : { ambient }),
    })),
  })

/** The worker after `events`, the nth at time n. */
const fold = (events: ReadonlyArray<WorkerEvent>, from = 0): Worker =>
  events.reduce((worker, event, i) => step(worker, event, from + i), initial())

describe("tasksSince: only background tasks keep the worker Working", () => {
  test("is set once its turns are over with a task live, from that step on", () => {
    const worker = fold([init, tasks({ id: "b1" }), done, idle])
    expect(worker.state).toEqual(WorkerState.Working({ doing: "working", tasksSince: 3 }))
    expect(worker.descriptions).toEqual(new Map([["b1", "run b1"]]))
    // Another task starting by itself doesn't move it.
    const more = step(worker, tasks({ id: "b1" }, { id: "b2" }), 10)
    expect(tasksOnlySince(more.state)).toBe(3)
  })

  test("is set after a failed turn as after a clean one", () => {
    expect(tasksOnlySince(fold([init, tasks({ id: "b1" }), failed, idle]).state)).toBe(3)
  })

  test("isn't set while a turn runs, before idle, or with only ambient tasks live", () => {
    expect(tasksOnlySince(fold([init, tasks({ id: "b1" })]).state)).toBeUndefined()
    expect(tasksOnlySince(fold([init, tasks({ id: "b1" }), done]).state)).toBeUndefined()
    const ambient = fold([init, tasks({ id: "w", ambient: true }), done, idle])
    expect(ambient.state._tag).toBe("Idle")
  })

  test("goes with a turn, and comes back afresh after it", () => {
    const lingering = fold([init, tasks({ id: "b1" }), done, idle])
    // A Monitor watch's event starts a turn: the clock starts again after it.
    const turned = [running, init, done, idle].reduce(
      (worker, event, i) => step(worker, event, 100 + i),
      lingering,
    )
    expect(tasksOnlySince(step(lingering, running, 100).state)).toBeUndefined()
    expect(tasksOnlySince(turned.state)).toBe(103)
  })

  test("goes while a finished task's report is to come, and the worker settles after it", () => {
    const two = fold([init, tasks({ id: "b1" }), done, idle])
    const ended = step(two, tasks(), 10)
    expect(ended.state).toEqual(WorkerState.Working({ doing: "working" }))
    const reported = [running, init, done, idle].reduce(
      (worker, event, i) => step(worker, event, 20 + i),
      ended,
    )
    expect(reported.state).toEqual(WorkerState.Idle({ at: 23 }))
  })
})

describe("read: background_tasks_changed", () => {
  test("keeps the descriptions of the tasks that count", () => {
    const reading = read({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "a", task_type: "local_bash", description: "  npm run dev  " },
        { task_id: "b", task_type: "local_bash", description: "watch", ambient: true },
        { task_id: "c", task_type: "local_bash" },
      ],
    } as unknown as SDKMessage)
    expect(reading).toEqual(
      expect.objectContaining({
        _tag: "Tasks",
        live: ["a", "b", "c"],
        counted: ["a", "c"],
        descriptions: new Map([["a", "npm run dev"]]),
      }),
    )
  })
})

const id = "t-1" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished, cause = (place) => Move.Verified({ place })) =>
      ledger.transition(finished.id, cause(1)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    held: yield* makeHeld,
    checksAhead: undefined as never,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What the worker's commands do to the in-memory Beads and git, its worktree in `root`. */
const commands = (world: World, root: string) => ({
  claim: orDie(world.beads.update(id, { claim: true })),
  commit: orDie(world.repository.commit(join(root, id), `Change (${id})`, { "a.txt": "a\n" })),
  close: orDie(world.beads.close(id, "done")),
})

/** The dev server the worker leaves running. */
const devServer = backgroundTasks({ id: "b1", description: "npm run dev" })

/** Its stop: the CLI's notification, the set emptied, and the turn it starts to report it. */
const stopped: SessionScript = [awaitStopTask, ...taskStopped("b1"), ...selfStartedTurn()]

/**
 * Dispatches the ticket and runs its fiber on main, its worktree in a new folder, its worker's one
 * session `session`; `during` runs beside it before it is joined.
 */
const working = (
  session: (c: ReturnType<typeof commands>) => SessionScript,
  during: (fiber: Fiber.Fiber<Worked, unknown>) => Effect.Effect<void, unknown, Env | Ledger>,
): Promise<Ran<Worked>> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-left-tasks-")))
  return scenario(
    {
      backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
      worktrees: { root },
      scripts: (world) => ({ [id]: [session(commands(world, root))] }),
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      const fiber = yield* Effect.forkChild(work(ticket, { base: "main", queue: yield* lineOnly }))
      yield* during(fiber)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  )
}

const workedOf = (ran: Ran<Worked>): Worked => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The tasks the worker's session was asked to stop, in order. */
const stops = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) => (sent._tag === "StopTask" ? [`${sent.ticket} ${sent.task}`] : []))

/** Waits, yielding, until the log has a line matching `pattern`, then a little more. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 20_000; i++) {
      if ((yield* texts).some((each) => pattern.test(each))) break
      yield* Effect.yieldNow
    }
    for (let i = 0; i < 200; i++) yield* Effect.yieldNow
  })

/** Lets every fiber run as far as it can without the clock moving. */
const quiet = Effect.gen(function* () {
  for (let i = 0; i < 2_000; i++) yield* Effect.yieldNow
})

describe("a worker that leaves a background task running as its turns end", () => {
  test("its ticket closed: the task is stopped at once, and the ticket goes to merge", async () => {
    const ran = await working(
      (c) =>
        turn(
          [
            ...bash(`bd update ${id} --claim`, c.claim),
            ...bash("npm run dev &"),
            devServer,
            ...bash(`git commit -am "Change (${id})"`, c.commit),
            ...bash(`bd close ${id}`, c.close),
          ],
          result(`Closed ${id}.`),
        ).concat(stopped),
      () =>
        Effect.andThen(
          untilLogged(/stopped them/),
          // The turn reporting the stop starts 70 ms after it.
          advance("1 second"),
        ),
    )
    expect(workedOf(ran).phase).toEqual(expect.objectContaining({ _tag: "ToMerge" }))
    expect(stops(ran)).toEqual([`${id} b1`])
    expect(ran.log).toContain(
      `  ${id} is closed and its worker's turns are over, but background tasks it left running kept it from settling; stopped them: npm run dev`,
    )
  })

  test("its ticket in progress: stopped after tasksLimit with no turn, then nudged on", async () => {
    const ran = await working(
      (c) => [
        ...turn([...bash(`bd update ${id} --claim`, c.claim), devServer], result("Started it.")),
        ...stopped,
        // The continue nudge: it finishes.
        ...turn([
          ...bash(`git commit -am "Change (${id})"`, c.commit),
          ...bash(`bd close ${id}`, c.close),
        ]),
      ],
      () =>
        Effect.gen(function* () {
          yield* quiet
          yield* advance(Duration.subtract(tasksLimit, Duration.seconds(1)))
          yield* quiet
          expect(yield* texts).not.toContainEqual(expect.stringContaining("stopped them"))
          yield* advance(Duration.seconds(1))
          yield* untilLogged(/stopped them/)
          yield* advance("1 second")
        }),
    )
    expect(workedOf(ran).phase).toEqual(expect.objectContaining({ _tag: "ToMerge" }))
    expect(stops(ran)).toEqual([`${id} b1`])
    expect(ran.log).toContain(
      `  ${id}'s worker's turns have been over for 30m, but background tasks it left running kept it from settling; stopped them: npm run dev`,
    )
  })

  test("a turn while its task lives starts the wait again", async () => {
    const ran = await working(
      (c) => [
        ...turn([...bash(`bd update ${id} --claim`, c.claim), devServer], result("Started it.")),
        // An event a Monitor watch sees, 20 minutes in, starts a turn by itself.
        sleep("20 minutes"),
        ...selfStartedTurn(),
        ...stopped,
        ...turn([
          ...bash(`git commit -am "Change (${id})"`, c.commit),
          ...bash(`bd close ${id}`, c.close),
        ]),
      ],
      () =>
        Effect.gen(function* () {
          yield* quiet
          yield* advance(Duration.minutes(20))
          yield* quiet
          yield* advance("1 second")
          yield* quiet
          yield* advance(Duration.subtract(tasksLimit, Duration.minutes(1)))
          yield* quiet
          expect(yield* texts).not.toContainEqual(expect.stringContaining("stopped them"))
          yield* advance(Duration.minutes(1))
          yield* untilLogged(/stopped them/)
          yield* advance("1 second")
        }),
    )
    expect(workedOf(ran).phase).toEqual(expect.objectContaining({ _tag: "ToMerge" }))
    expect(stops(ran)).toEqual([`${id} b1`])
  })
})
