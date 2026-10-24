// When the usage-limit hold lifts (§ 4.12): a reset already past is tried again retryEvery later,
// never at once, and lifts are retryEvery apart; an unknown reset lifts once a session says the
// account is under the limit again, or at the next try, with workers still running; and a worker's
// rejection goes with its turn, so a later turn failing for another reason reads as Failed.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Duration, Effect, Exit, Fiber } from "effect"
import { read } from "../src/agent/reading.ts"
import { step as fold, initial, WorkerEvent, WorkerState } from "../src/agent/WorkerState.ts"
import { resetLabel } from "../src/run/localTime.ts"
import { run } from "../src/run/run.ts"
import type { Dashboard } from "../src/run/screen.ts"
import { nudgeText } from "../src/run/settle.ts"
import {
  carryOnText,
  Hold,
  liftAfter,
  liftTime,
  Reset,
  resetOf,
  retryEvery,
} from "../src/run/usageLimit.ts"
import { Git } from "../src/services/Git.ts"
import {
  apiErrorResult,
  claimsAndCloses,
  hitsUsageLimit,
  init,
  rateLimit,
  type Sent,
  type SessionScript,
  sessionState,
  run as step,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

// Whole runs, some waiting out a hold, take up to a second on an idle machine.
setDefaultTimeout(30_000)

const hour = 3600
const minute = 60_000

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-lift-${name}-`)))

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: string): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** A turn ending on a 429 alone: no rate_limit_event says which limit, or when it resets. */
const refusedAlone: SessionScript = [
  wait,
  init(),
  sessionState("running"),
  apiErrorResult("API Error: usage limit reached", 429),
  sessionState("idle"),
]

/** How many log lines match `pattern`. */
const logged = (pattern: RegExp) =>
  Effect.map(texts, (all) => all.filter((text) => pattern.test(text)).length)

/** Waits, in real time, until `count` log lines match `pattern`. */
const untilLogged = (pattern: RegExp, count = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* logged(pattern)) >= count) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no ${count} log lines matched ${pattern}`)
  })

/** Lets the run go as far as it can, in real time, without the clock moving. */
const settle = Effect.promise(() => Bun.sleep(50))

/** A whole run on main with a dashboard, each ticket's worktree made in git first. */
const runs = (plan: {
  readonly tickets: ReadonlyArray<string>
  readonly concurrent?: number
  readonly scripts: (world: World, root: string) => Scripts
  readonly during: Effect.Effect<void, unknown, Env>
}) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = { ...appConfig().settings, concurrent: plan.concurrent ?? 1 }
  return scenario(
    {
      config: { repo, settings },
      backlog: plan.tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const dashboard: Dashboard = () => Effect.void
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [], dashboard }),
      )
      yield* plan.during
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The messages tutti sent `ticket`'s worker, by their text. */
const messagesTo = (sent: ReadonlyArray<Sent>, ticket: string): ReadonlyArray<string> =>
  sent.flatMap((each) =>
    each._tag === "Message" && each.ticket === ticket ? [String(each.message.message.content)] : [],
  )

const lifted = /^USAGE_LIMIT lifted$/
const holds = /^USAGE_LIMIT: the .* limit is reached; no new tickets until it resets/

describe("when the hold lifts", () => {
  test("a reset already past is tried again retryEvery later, and lifts stay that far apart", async () => {
    // The worker is refused twice with a reset at the epoch, which TestClock has passed: as a
    // clock running ahead of the server's would see it.
    const ran = await runs({
      tickets: ["t-1"],
      scripts: (world, root) => ({
        "t-1": [[...hitsUsageLimit(0), ...hitsUsageLimit(0), ...finishes(world, root, "t-1")]],
      }),
      during: Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        yield* advance("14 minutes")
        yield* settle
        expect(yield* logged(lifted)).toBe(0)
        yield* advance("2 minutes")
        yield* untilLogged(lifted)
        // Its carry-on is refused again: the hold is back, and lifts no sooner than before.
        // The first lift was at 15 minutes, the clock is at 16: the next is due at 30.
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/, 2)
        yield* advance("13 minutes")
        yield* settle
        expect(yield* logged(lifted)).toBe(1)
        yield* advance("2 minutes")
        yield* untilLogged(lifted, 2)
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    const passed = resetLabel(0, 0)
    expectLog(ran, [
      "USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets",
      new RegExp(
        `^USAGE_LIMIT: nothing else runs; the five-hour limit was to reset at ${passed}; tutti tries again at \\d\\d:\\d\\d, in 15m$`,
      ),
      "USAGE_LIMIT lifted",
      "  t-1: the usage limit has reset; its worker carries on",
      "USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets",
      /^USAGE_LIMIT: nothing else runs; the five-hour limit was to reset at .*, in 1[45]m$/,
      "USAGE_LIMIT lifted",
      "  t-1: the usage limit has reset; its worker carries on",
    ])
    expect(messagesTo(ran.sent, "t-1").filter((text) => text === carryOnText("t-1"))).toHaveLength(
      2,
    )
  })

  test("an unknown reset lifts, with workers still running, once a session says it is allowed", async () => {
    const started = Deferred.makeUnsafe<void>()
    const allowed = Deferred.makeUnsafe<void>()
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      concurrent: 2,
      scripts: (world, root) => {
        // Its prompt, system/init and running: its turn under way.
        const t2 = finishes(world, root, "t-2")
        const [begun, rest] = [t2.slice(0, 3), t2.slice(3)]
        return {
          // t-1 is refused once t-2 has started, so that both are dispatched before the hold.
          "t-1": [
            [
              wait,
              step(Deferred.await(started)),
              ...refusedAlone.slice(1),
              ...finishes(world, root, "t-1"),
            ],
          ],
          // t-2 runs on through the hold, and hears from the account that it is under the limit.
          "t-2": [
            [
              ...begun,
              step(Effect.asVoid(Deferred.done(started, Exit.void))),
              step(Deferred.await(allowed)),
              rateLimit("allowed", undefined, 0.4),
              ...rest,
            ],
          ],
          "t-3": [finishes(world, root, "t-3")],
        }
      },
      during: Effect.gen(function* () {
        yield* untilLogged(holds)
        yield* advance("2 minutes")
        yield* Effect.asVoid(Deferred.done(allowed, Exit.void))
        // Lifted by what t-2's session said, long before the next try.
        yield* untilLogged(lifted)
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      "USAGE_LIMIT: the account's usage limit is reached; no new tickets until it resets",
      "USAGE_LIMIT lifted",
      "  t-1: the usage limit has reset; its worker carries on",
      "[3] t-3 dispatching: t-3",
    ])
    expect(ran.log.filter((text) => holds.test(text))).toHaveLength(1)
  })

  test("an unknown reset with workers still running and nothing said is tried retryEvery later", async () => {
    const started = Deferred.makeUnsafe<void>()
    const go = Deferred.makeUnsafe<void>()
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      concurrent: 2,
      scripts: (world, root) => {
        // Its prompt, system/init and running: its turn under way.
        const t2 = finishes(world, root, "t-2")
        const [begun, rest] = [t2.slice(0, 3), t2.slice(3)]
        return {
          "t-1": [
            [
              wait,
              step(Deferred.await(started)),
              ...refusedAlone.slice(1),
              ...finishes(world, root, "t-1"),
            ],
          ],
          "t-2": [
            [
              ...begun,
              step(Effect.asVoid(Deferred.done(started, Exit.void))),
              step(Deferred.await(go)),
              ...rest,
            ],
          ],
        }
      },
      during: Effect.gen(function* () {
        yield* untilLogged(holds)
        yield* advance("14 minutes")
        yield* settle
        expect(yield* logged(lifted)).toBe(0)
        yield* advance("2 minutes")
        yield* untilLogged(lifted)
        yield* Effect.asVoid(Deferred.done(go, Exit.void))
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expectLog(ran, [
      "USAGE_LIMIT: the account's usage limit is reached; no new tickets until it resets",
      "USAGE_LIMIT lifted",
      "  t-1: the usage limit has reset; its worker carries on",
    ])
  })

  test("a turn failing for another reason after the lift is a failed turn, not the limit", async () => {
    const serverError = apiErrorResult("API Error: 500 Internal server error", 500)
    const limited = hitsUsageLimit(hour)
    const ran = await runs({
      tickets: ["t-1"],
      scripts: (world, root) => ({
        // It claims its ticket, so that its failed turn leaves it in progress, to be nudged.
        "t-1": [
          [
            ...limited.slice(0, 3),
            step(Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true })))),
            ...limited.slice(3),
            ...turn([], serverError),
            ...finishes(world, root, "t-1"),
          ],
        ],
      }),
      during: Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        yield* advance("61 minutes")
        yield* untilLogged(lifted)
        // Its failed turn settles it; the nudge has it finish.
        yield* untilLogged(/^ {2}t-1 closed /)
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    // Held once: the failed turn after the lift doesn't hold the run again, and gets a nudge.
    expect(ran.log.filter((text) => holds.test(text))).toHaveLength(1)
    expect(ran.log.filter((text) => lifted.test(text))).toHaveLength(1)
    expect(messagesTo(ran.sent, "t-1")).toContain(nudgeText("t-1"))
  })
})

describe("the hold's reset", () => {
  test("a reset at or before now is unknown, tried again retryEvery later", () => {
    const every = Duration.toMillis(retryEvery)
    expect(every).toBe(15 * minute)
    expect(resetOf(5 * minute, minute)).toEqual(Reset.Known({ at: 5 * minute }))
    expect(resetOf(minute, minute)).toEqual(
      Reset.Unknown({ nextTry: minute + every, passed: minute }),
    )
    expect(resetOf(0, minute)).toEqual(Reset.Unknown({ nextTry: minute + every, passed: 0 }))
    expect(resetOf(null, minute)).toEqual(Reset.Unknown({ nextTry: minute + every, passed: null }))
  })

  test("it lifts at its reset plus liftAfter, its next try, or once allowed, retryEvery apart", () => {
    const held = (reset: Reset, lifted: number | null = null) =>
      Hold.Held({ since: 0, limit: "five_hour", reset, lifted }) as Hold & { _tag: "Held" }
    const after = Duration.toMillis(liftAfter)
    expect(liftTime(held(Reset.Known({ at: hour * 1000 })))).toBe(hour * 1000 + after)
    expect(liftTime(held(Reset.Unknown({ nextTry: 20 * minute, passed: null })))).toBe(20 * minute)
    expect(liftTime(held(Reset.Allowed({ at: 3 * minute })))).toBe(3 * minute)
    // The last lift was at 10 minutes: the next is no sooner than 25.
    expect(liftTime(held(Reset.Allowed({ at: 12 * minute }), 10 * minute))).toBe(25 * minute)
    expect(liftTime(held(Reset.Known({ at: 11 * minute }), 10 * minute))).toBe(25 * minute)
    expect(liftTime(held(Reset.Known({ at: hour * 1000 }), 10 * minute))).toBe(hour * 1000 + after)
  })
})

describe("a worker's rejection", () => {
  const sdk = (message: object): WorkerEvent =>
    WorkerEvent.Message({ session: "s", reading: read(message as unknown as SDKMessage) })
  const begins = [
    sdk({ type: "system", subtype: "session_state_changed", state: "running" }),
    sdk({ type: "system", subtype: "init", permissionMode: "auto", session_id: "s" }),
  ]
  const idle = sdk({ type: "system", subtype: "session_state_changed", state: "idle" })
  const rejected = sdk({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: hour },
  })
  const errorResult = (status: number, text: string) =>
    sdk({
      type: "result",
      subtype: "success",
      is_error: true,
      result: text,
      api_error_status: status,
      num_turns: 1,
    })
  const stateAfter = (...events: ReadonlyArray<WorkerEvent>): WorkerState =>
    events.reduce((worker, event, i) => fold(worker, event, i + 1), initial()).state

  test("goes with its turn: a later turn failing otherwise is Failed", () => {
    const limited = [...begins, rejected, errorResult(429, "API Error: limit"), idle]
    expect(stateAfter(...limited)).toEqual(WorkerState.UsageLimited({ resetsAt: hour * 1000 }))
    const failed = stateAfter(...limited, ...begins, errorResult(529, "API Error: 529"), idle)
    expect(failed._tag).toBe("Failed")
    expect(failed).toMatchObject({ error: "API Error: 529", interrupted: false })
  })
})
