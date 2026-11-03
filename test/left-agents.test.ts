// A background agent a worker left working as its turns ended (task_type local_agent and the other
// agentTaskTypes) isn't stopped after tasksLimit with the dev servers and watches (tutti-1lu8): it
// ends by itself as it finishes. With nothing but agents' work left, it is stopped only after
// agentTasksLimit, a hung agent's bound; a closed ticket still has it stopped at once.

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect } from "effect"
import { read } from "../src/agent/reading.ts"
import {
  agentsOnly,
  initial,
  step,
  tasksOnlySince,
  type Worker,
  WorkerEvent,
} from "../src/agent/WorkerState.ts"
import { agentTasksLimit, tasksLimit } from "../src/run/settle.ts"
import {
  backgroundTasks,
  bash,
  type LiveTask,
  result,
  selfStartedTurn,
  sleep,
  taskEnds,
  turn,
} from "../src/testing/AgentHost.ts"
import { texts } from "../src/testing/Log.ts"
import { advance } from "./harness.ts"
import {
  id,
  quiet,
  stoppedTask,
  stops,
  untilLogged,
  workedOf,
  working,
} from "./leftTasks.ts"

const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ session: "s", reading: read(message as unknown as SDKMessage) })
const init = sdk({ type: "system", subtype: "init", permissionMode: "auto", session_id: "s" })
const idle = sdk({ type: "system", subtype: "session_state_changed", state: "idle" })
const done = sdk({ type: "result", subtype: "success", is_error: false, result: "DONE" })
const tasks = (...live: ReadonlyArray<{ readonly id: string; readonly type: string }>) =>
  sdk({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: live.map(({ id, type }) => ({ task_id: id, task_type: type, description: `run ${id}` })),
  })

/** The worker after `events`, the nth at time n. */
const fold = (events: ReadonlyArray<WorkerEvent>, from = 0): Worker =>
  events.reduce((worker, event, i) => step(worker, event, from + i), initial())

const agent = { id: "a1", type: "local_agent" }
const shell = { id: "b1", type: "local_bash" }

describe("read: background_tasks_changed's agents", () => {
  test("are the counted tasks whose type is an agent's work", () => {
    const reading = read({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "a", task_type: "local_agent", description: "review" },
        { task_id: "w", task_type: "local_workflow", description: "spec" },
        { task_id: "r", task_type: "remote_agent", description: "remote" },
        { task_id: "t", task_type: "in_process_teammate", description: "mate" },
        { task_id: "b", task_type: "local_bash", description: "npm run dev" },
        { task_id: "m", task_type: "monitor_mcp", description: "watch" },
        { task_id: "x", task_type: "local_agent", description: "quiet", ambient: true },
        { task_id: "n" },
      ],
    } as unknown as SDKMessage)
    expect(reading).toEqual(
      expect.objectContaining({
        _tag: "Tasks",
        counted: ["a", "w", "r", "t", "b", "m", "n"],
        agents: ["a", "w", "r", "t"],
      }),
    )
  })
})

describe("agentsOnly: only agents' work keeps the worker Working", () => {
  test("is set with only background agents live, and not with a shell task beside them", () => {
    const agents = fold([init, tasks(agent), done, idle])
    expect(tasksOnlySince(agents.state)).toBe(3)
    expect(agentsOnly(agents.state)).toBe(true)
    const both = fold([init, tasks(agent, shell), done, idle])
    expect(tasksOnlySince(both.state)).toBe(3)
    expect(agentsOnly(both.state)).toBe(false)
  })

  test("isn't set while a turn runs", () => {
    expect(agentsOnly(fold([init, tasks(agent)]).state)).toBe(false)
  })

  test("its clock starts again when the tasks change kind, and not otherwise", () => {
    const agents = fold([init, tasks(agent), done, idle])
    // The agent starts a background command of its own: the shell's clock starts now.
    const both = step(agents, tasks(agent, shell), 10)
    expect(tasksOnlySince(both.state)).toBe(10)
    expect(agentsOnly(both.state)).toBe(false)
    // Another agent starting doesn't move it.
    const more = step(agents, tasks(agent, { id: "a2", type: "local_agent" }), 10)
    expect(tasksOnlySince(more.state)).toBe(3)
    expect(agentsOnly(more.state)).toBe(true)
  })
})

/** The background agent the worker leaves working. */
const reviewer: LiveTask = { id: "a1", description: "Review the change", type: "local_agent" }
const devServer: LiveTask = { id: "b1", description: "npm run dev" }

describe("a worker that leaves a background agent working as its turns end", () => {
  test("the agent isn't stopped after tasksLimit, and the worker goes on after it ends", async () => {
    const ran = await working(
      (c) => [
        ...turn(
          [...bash(`bd update ${id} --claim`, c.claim), backgroundTasks(reviewer)],
          result("Started a reviewer."),
        ),
        // The agent finishes an hour in, and its report starts a turn that closes the ticket.
        sleep("1 hour"),
        ...taskEnds("a1"),
        ...selfStartedTurn([
          ...bash(`git commit -am "Change (${id})"`, c.commit),
          ...bash(`bd close ${id}`, c.close),
        ]),
      ],
      () =>
        Effect.gen(function* () {
          yield* quiet
          yield* advance(Duration.sum(tasksLimit, Duration.seconds(1)))
          yield* quiet
          expect(yield* texts).not.toContainEqual(expect.stringContaining("stopped them"))
          yield* advance(Duration.subtract(Duration.hours(1), tasksLimit))
          yield* quiet
          yield* advance("1 second")
          yield* quiet
        }),
    )
    expect(workedOf(ran).phase).toEqual(expect.objectContaining({ _tag: "ToMerge" }))
    expect(stops(ran)).toEqual([])
  })

  test("a hung agent is stopped after agentTasksLimit with no turn", async () => {
    const ran = await working(
      (c) => [
        ...turn(
          [...bash(`bd update ${id} --claim`, c.claim), backgroundTasks(reviewer)],
          result("Started a reviewer."),
        ),
        ...stoppedTask("a1"),
        ...turn([
          ...bash(`git commit -am "Change (${id})"`, c.commit),
          ...bash(`bd close ${id}`, c.close),
        ]),
      ],
      () =>
        Effect.gen(function* () {
          yield* quiet
          yield* advance(Duration.subtract(agentTasksLimit, Duration.seconds(1)))
          yield* quiet
          expect(yield* texts).not.toContainEqual(expect.stringContaining("stopped them"))
          yield* advance(Duration.seconds(1))
          yield* untilLogged(/stopped them/)
          yield* advance("1 second")
        }),
    )
    expect(workedOf(ran).phase).toEqual(expect.objectContaining({ _tag: "ToMerge" }))
    expect(stops(ran)).toEqual([`${id} a1`])
    expect(ran.log).toContain(
      `  ${id}'s worker's turns have been over for 2h, but background tasks it left running kept it from settling; stopped them: Review the change`,
    )
  })

  test("beside a dev server, only the dev server is stopped after tasksLimit", async () => {
    const ran = await working(
      (c) => [
        ...turn(
          [...bash(`bd update ${id} --claim`, c.claim), backgroundTasks(reviewer, devServer)],
          result("Started a reviewer and the dev server."),
        ),
        // The dev server's stop leaves the agent working; it finishes 10 minutes later.
        ...stoppedTask("b1", reviewer),
        sleep("10 minutes"),
        ...taskEnds("a1"),
        ...selfStartedTurn([
          ...bash(`git commit -am "Change (${id})"`, c.commit),
          ...bash(`bd close ${id}`, c.close),
        ]),
      ],
      () =>
        Effect.gen(function* () {
          yield* quiet
          yield* advance(tasksLimit)
          yield* untilLogged(/stopped them/)
          yield* advance("1 second")
          yield* quiet
          yield* advance(Duration.minutes(10))
          yield* quiet
          yield* advance("1 second")
          yield* quiet
        }),
    )
    expect(workedOf(ran).phase).toEqual(expect.objectContaining({ _tag: "ToMerge" }))
    expect(stops(ran)).toEqual([`${id} b1`])
    expect(ran.log).toContain(
      `  ${id}'s worker's turns have been over for 30m, but background tasks it left running kept it from settling; stopped them: npm run dev`,
    )
  })

  test("its ticket closed: the agent is stopped at once", async () => {
    const ran = await working(
      (c) =>
        turn(
          [
            ...bash(`bd update ${id} --claim`, c.claim),
            backgroundTasks(reviewer),
            ...bash(`git commit -am "Change (${id})"`, c.commit),
            ...bash(`bd close ${id}`, c.close),
          ],
          result(`Closed ${id}.`),
        ).concat(stoppedTask("a1")),
      () => Effect.andThen(untilLogged(/stopped them/), advance("1 second")),
    )
    expect(workedOf(ran).phase).toEqual(expect.objectContaining({ _tag: "ToMerge" }))
    expect(stops(ran)).toEqual([`${id} a1`])
  })
})
