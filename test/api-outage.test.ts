// The API-outage hold (§ 4.2, apiOutage.ts), over whole runs: a turn failing with a 529 after
// Claude Code's retries leaves its worker waiting, not settled, so its fresh ticket isn't deferred
// or triaged; no new ticket starts while the run holds; a probe that gets no answer is tried again
// after a doubled wait; and once one is answered, the hold lifts and the worker carries on.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { ProbeAnswer } from "../src/organs/UsageProbe.ts"
import { run } from "../src/run/run.ts"
import type { Dashboard } from "../src/run/screen.ts"
import { apiBackText, nudgeText } from "../src/run/told.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  apiErrorResult,
  apiRetry,
  claimsAndCloses,
  init,
  type Sent,
  type SessionScript,
  sessionState,
  run as step,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import type { Scripted } from "../src/testing/UsageProbe.ts"
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

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-outage-${name}-`)))

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** A turn that fails with a 529 after Claude Code's retries, as the API overloaded gives it. */
const overloaded: SessionScript = [
  init(),
  sessionState("running"),
  apiRetry(1, 529),
  apiRetry(2, 529),
  apiErrorResult("API Error: 529 Overloaded", 529),
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
  readonly probes?: ReadonlyArray<Scripted>
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
      ...(plan.probes === undefined ? {} : { usageProbe: plan.probes }),
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

const holds = /^API_UNAVAILABLE: t-1's turn failed as Claude's API was unavailable/
const lifted = /^API_UNAVAILABLE: lifted: /

describe("a turn failing as Claude's API is unavailable", () => {
  test("holds the run, probes it with backoff, and carries its worker on once it answers", async () => {
    const t2Started = Deferred.makeUnsafe<void>()
    const held = Deferred.makeUnsafe<void>()
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      concurrent: 2,
      probes: [
        ProbeAnswer.Unanswered({ reason: "API Error: 529 Overloaded" }),
        ProbeAnswer.Unanswered({ reason: "API Error: 529 Overloaded" }),
      ],
      scripts: (world, root) => {
        // Its prompt, system/init and running: its turn under way.
        const t2 = finishes(world, root, "t-2" as TicketId)
        const [begun, rest] = [t2.slice(0, 3), t2.slice(3)]
        return {
          // A fresh ticket, never claimed: its first turn fails on the API once t-2 has started,
          // so that both are dispatched before the hold. The carry-on has it finish.
          "t-1": [
            [
              wait,
              step(Deferred.await(t2Started)),
              ...overloaded,
              ...finishes(world, root, "t-1" as TicketId),
            ],
          ],
          // t-2 runs on through the hold and finishes in it: its slot frees, but t-3 waits.
          "t-2": [
            [
              ...begun,
              step(Effect.asVoid(Deferred.done(t2Started, Exit.void))),
              step(Deferred.await(held)),
              ...rest,
            ],
          ],
          "t-3": [finishes(world, root, "t-3" as TicketId)],
        }
      },
      during: Effect.gen(function* () {
        yield* untilLogged(holds)
        yield* Effect.asVoid(Deferred.done(held, Exit.void))
        yield* untilLogged(/^ {2}t-2 closed /)
        yield* settle
        // The first probe, a minute after the hold, gets no answer: the next is due 2m later.
        yield* advance("1 minute")
        yield* untilLogged(/^API_UNAVAILABLE: a probe of Claude's API got no answer either/)
        yield* advance("1 minute")
        yield* settle
        expect(yield* logged(/got no answer either/)).toBe(1)
        yield* advance("1 minute")
        yield* untilLogged(/got no answer either/, 2)
        expect(yield* logged(/dispatching: t-3/)).toBe(0)
        // The third, 4m after the second, is answered: the hold lifts.
        yield* advance("4 minutes")
        yield* untilLogged(lifted)
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      "API_UNAVAILABLE: t-1's turn failed as Claude's API was unavailable (API Error: 529 Overloaded), after Claude Code's own retries; no new tickets until it answers again, and tutti asks it in 1m",
      "API_UNAVAILABLE: a probe of Claude's API got no answer either (API Error: 529 Overloaded); tutti asks it again in 2m",
      "API_UNAVAILABLE: a probe of Claude's API got no answer either (API Error: 529 Overloaded); tutti asks it again in 4m",
      "API_UNAVAILABLE: lifted: Claude's API answered a probe 7m after the hold",
      "  t-1: Claude's API answers again; its worker carries on",
      /dispatching: t-3/,
    ])
    // The hold's line and its lift, as hold records.
    const records = ran.events.flatMap((event) => (event.kind === "hold" ? [event] : []))
    expect(records.map((event) => event.lifted === true)).toEqual([false, true])
    // Carried on, not nudged, deferred or set aside.
    const told = messagesTo(ran.sent, "t-1")
    expect(told).toContain(apiBackText)
    expect(told).not.toContain(nudgeText("t-1" as TicketId))
    expect(ran.log.some((text) => /deferred|ENVIRONMENT|PAUSED/.test(text))).toBe(false)
  })

  test("a second outage holds the run again, its probes from the first wait afresh", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      scripts: (world, root) => ({
        "t-1": [
          [wait, ...overloaded, wait, ...overloaded, ...finishes(world, root, "t-1" as TicketId)],
        ],
      }),
      during: Effect.gen(function* () {
        yield* untilLogged(holds)
        yield* advance("1 minute")
        yield* untilLogged(lifted)
        yield* untilLogged(holds, 2)
        yield* advance("1 minute")
        yield* untilLogged(lifted, 2)
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(messagesTo(ran.sent, "t-1").filter((text) => text === apiBackText)).toHaveLength(2)
    expect(ran.log.filter((text) => holds.test(text))).toEqual([
      expect.stringContaining("tutti asks it in 1m"),
      expect.stringContaining("tutti asks it in 1m"),
    ])
  })
})
