// The end of a run while workers wait on you (D19, § 5 item 14), as whole runs under TestClock:
// with a dashboard the run stays open, showing the end-of-run box, until the workers are answered
// and carry on, or the box's `q` ends it, suspending them; a worker past its ticket limit doesn't
// keep it open; plain, the run waits for them only until a stop holds it, then ends as usual.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Queue, SubscriptionRef } from "effect"
import { Attention } from "../src/agent/Attention.ts"
import { UiCommand } from "../src/run/commands.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { RunView } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store } from "../src/services/Store.ts"
import {
  bash,
  canUseTool,
  result,
  type SessionScript,
  sleep,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import { dashboardHint } from "../src/ui/Dashboard.tsx"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-end-${name}-`)))

/** Claims its ticket, does `first`, commits and closes it, as a worker does. */
const finishes = (
  world: World,
  root: string,
  id: TicketId,
  first: ReadonlyArray<SessionScript[number]>,
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...first,
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

const rm = canUseTool("Bash", { command: "rm -rf build" })

const which = canUseTool("AskUserQuestion", {
  questions: [
    {
      question: "Which cache?",
      header: "Cache",
      options: [{ label: "build" }, { label: "dist" }],
      multiSelect: false,
    },
  ],
})

/** Moves TestClock on by `total`, a minute at a time, letting the run catch up after each. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const minutes = Duration.toMinutes(Duration.fromInputUnsafe(total))
    for (let i = 0; i < minutes; i++) {
      yield* advance("1 minute")
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}: ${(yield* texts).join("\n")}`)
  })

/** What the scenario's `during` can do beside the run. */
interface During {
  /** The dashboard's RunView now. */
  readonly view: Effect.Effect<RunView>
  /** Presses the end-of-run box's `q`. */
  readonly endRun: Effect.Effect<void>
  /** Whether the run has ended. */
  readonly ended: Effect.Effect<boolean>
}

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly concurrent: number
  readonly dashboard: boolean
  readonly ticketLimit?: Duration.Duration
  readonly scripts: (world: World, root: string) => Scripts
  readonly during: (during: During) => Effect.Effect<void, unknown, Env>
}

/** A run's outcome and state.json at its end. */
interface Ended extends Outcome {
  readonly state: State
}

/** A whole run on main, with a dashboard or plain, each ticket's worktree made in git first. */
const runs = (plan: Plan): Promise<Ran<Ended>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: plan.concurrent,
    workers: { ...defaults.workers, ticket_limit: plan.ticketLimit ?? null },
  }
  return scenario(
    {
      config: { repo, settings },
      backlog: plan.tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      // The dashboard the run shows, waited for in real time as the forked run starts.
      const screen = Effect.gen(function* () {
        for (let i = 0; i < 1000 && shown === undefined; i++) {
          yield* Effect.promise(() => Bun.sleep(2))
        }
        if (shown === undefined) throw new Error("the run showed no dashboard")
        return shown
      })
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          ...(plan.dashboard ? { dashboard } : {}),
        }),
      )
      yield* plan.during({
        // RunView is written at most 30 times a second, on the Clock: move it on to see the latest.
        view: Effect.gen(function* () {
          for (let i = 0; i < 3; i++) {
            yield* advance("100 millis")
            yield* Effect.promise(() => Bun.sleep(10))
          }
          return yield* SubscriptionRef.get((yield* screen).view)
        }),
        endRun: Effect.flatMap(screen, (inputs) =>
          Queue.offer(inputs.commands, UiCommand.EndRun()),
        ),
        ended: Effect.sync(() => fiber.pollUnsafe() !== undefined),
      })
      const outcome = yield* Fiber.join(fiber)
      return { ...outcome, state: yield* (yield* Store).state } satisfies Ended
    }),
  )
}

/** The open request of `ticket`'s worker. */
const requestOf = (ticket: string) =>
  Effect.gen(function* () {
    const open = (yield* (yield* Attention).current).find((request) => request.ticket === ticket)
    if (open === undefined) throw new Error(`no request open for ${ticket}`)
    return open.id
  })

const suspendedOf = (ran: Ran<unknown>) =>
  ran.events.flatMap((record) =>
    record.kind === "suspended" ? [{ ticket: record.ticket, why: record.why }] : [],
  )

const endedOf = (ran: Ran<Ended>): Ended => {
  if (ran.exit._tag === "Failure") throw new Error(`the run failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("with a dashboard, the run waits for you (D19)", () => {
  test("it shows the end-of-run box; answering lets the workers carry on and merge", async () => {
    let boxed: RunView | undefined
    let answered: RunView | undefined
    const ran = await runs({
      tickets: ["a", "b", "c"],
      concurrent: 3,
      dashboard: true,
      scripts: (world, root) => ({
        a: [finishes(world, root, "a" as TicketId, [rm])],
        b: [finishes(world, root, "b" as TicketId, [which])],
        c: [finishes(world, root, "c" as TicketId, [sleep("2 minutes")])],
      }),
      during: ({ view, ended }) =>
        Effect.gen(function* () {
          yield* passes("3 minutes")
          yield* untilLogged(/^ {2}c closed .*; merged into main/)
          boxed = yield* view
          // BLOCKED holds the run at 4 minutes; it stays open all the same.
          yield* passes("20 minutes")
          yield* untilLogged(/^HOLD: BLOCKED/)
          expect(yield* ended).toBe(false)
          const attention = yield* Attention
          yield* attention.answer(yield* requestOf("a"), { _tag: "Allow" }, "screen")
          yield* attention.answer(
            yield* requestOf("b"),
            { _tag: "Choose", answers: ["build"] },
            "screen",
          )
          answered = yield* view
          yield* passes("5 minutes")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expect(boxed?.endOfRun).toEqual([
      { ticket: "a", asks: ["Allow Bash(rm -rf build)?"] },
      { ticket: "b", asks: ["a question"] },
    ])
    expect(boxed === undefined ? [] : dashboardHint(boxed, false).map((key) => key.keys)).toContain(
      "q",
    )
    expect(answered?.endOfRun).toBeNull()
    expectLog(ran, [
      /^ {2}c closed .*; merged into main/,
      /^HOLD: BLOCKED >4min: a needs you/,
      "HOLD lifted: a's requests were answered",
      /^ {2}(a|b) closed .*; merged into main/,
      /^ {2}(a|b) closed .*; merged into main/,
      "READY_EMPTY after 3 tickets",
    ])
    expect(suspendedOf(ran)).toEqual([])
  }, 30_000)

  test("q ends the run as usual, suspending the workers waiting on you", async () => {
    let boxed: RunView | undefined
    const ran = await runs({
      tickets: ["a", "b"],
      concurrent: 2,
      dashboard: true,
      scripts: (world, root) => ({
        a: [finishes(world, root, "a" as TicketId, [rm])],
        b: [finishes(world, root, "b" as TicketId, [sleep("1 minute")])],
      }),
      during: ({ view, endRun, ended }) =>
        Effect.gen(function* () {
          // A `q` before the box is shown ends nothing.
          yield* endRun
          yield* passes("2 minutes")
          yield* untilLogged(/^ {2}b closed .*; merged into main/)
          boxed = yield* view
          yield* passes("1 minute")
          expect(yield* ended).toBe(false)
          yield* endRun
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Stopped", b: "Done" })
    expect(boxed?.endOfRun).toEqual([{ ticket: "a", asks: ["Allow Bash(rm -rf build)?"] }])
    expectLog(ran, [/^ {2}b closed .*; merged into main/, "READY_EMPTY after 2 tickets"])
    expect(suspendedOf(ran)).toEqual([{ ticket: "a", why: "waiting on you" }])
    expect(endedOf(ran).state.tickets.a?.suspended).toBe("waiting on you")
    expect(ran.sent.filter((s) => s.ticket === "a").map((s) => s._tag)).toEqual([
      "Started",
      "Message",
      "Closed",
    ])
  }, 30_000)

  test("a worker past its ticket limit doesn't keep it open", async () => {
    const ran = await runs({
      tickets: ["a"],
      concurrent: 1,
      dashboard: true,
      ticketLimit: Duration.hours(1),
      scripts: (world, root) => ({
        a: [finishes(world, root, "a" as TicketId, [sleep("30 minutes"), rm])],
      }),
      during: ({ view, ended }) =>
        Effect.gen(function* () {
          yield* passes("40 minutes")
          expect((yield* view).endOfRun).toEqual([
            { ticket: "a", asks: ["Allow Bash(rm -rf build)?"] },
          ])
          expect(yield* ended).toBe(false)
          yield* passes("25 minutes")
        }),
    })
    expectExitCode(ran, 3)
    expectPhases(ran, { a: "Stopped" })
    expect(suspendedOf(ran)).toEqual([{ ticket: "a", why: "TICKET_LIMIT" }])
  }, 30_000)
})

describe("in plain mode, the run ends as usual (D19)", () => {
  test("it waits for a worker waiting on you until BLOCKED holds it, then suspends it", async () => {
    const ran = await runs({
      tickets: ["a"],
      concurrent: 1,
      dashboard: false,
      scripts: (world, root) => ({ a: [finishes(world, root, "a" as TicketId, [rm])] }),
      during: ({ ended }) =>
        Effect.gen(function* () {
          yield* passes("3 minutes")
          expect(yield* ended).toBe(false)
          yield* passes("2 minutes")
        }),
    })
    expectExitCode(ran, 3)
    expectPhases(ran, { a: "Stopped" })
    expectLog(ran, [/^BLOCKED >4min: a needs you: Bash\(rm -rf build\)/])
    expect(suspendedOf(ran)).toEqual([{ ticket: "a", why: "waiting on you" }])
    expect(endedOf(ran).state.tickets.a?.suspended).toBe("waiting on you")
  }, 30_000)

  test("once the rest has merged under BLOCKED, it ends, suspending the worker", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      concurrent: 2,
      dashboard: false,
      scripts: (world, root) => ({
        a: [finishes(world, root, "a" as TicketId, [rm])],
        b: [finishes(world, root, "b" as TicketId, [sleep("10 minutes")])],
      }),
      during: ({ ended }) =>
        Effect.gen(function* () {
          yield* passes("9 minutes")
          yield* untilLogged(/^HOLD: BLOCKED/)
          expect(yield* ended).toBe(false)
          yield* passes("2 minutes")
        }),
    })
    expectExitCode(ran, 3)
    expectPhases(ran, { a: "Stopped", b: "Done" })
    expectLog(ran, [
      /^HOLD: BLOCKED >4min: a needs you: Bash\(rm -rf build\); no new tickets while the 2 running finish$/,
      /^ {2}b closed .*; merged into main/,
      /^BLOCKED >4min: a needs you: Bash\(rm -rf build\)/,
    ])
    expect(suspendedOf(ran)).toEqual([{ ticket: "a", why: "waiting on you" }])
  }, 30_000)
})
