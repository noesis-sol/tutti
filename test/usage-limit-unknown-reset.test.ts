// An unknown reset with nothing else running (§ 4.12): a 429 with no reset, or one whose reset has
// passed, is tried again retryEvery after the hold began, behind the usage probe, rather than end
// the run; a probe refused at every try ends it USAGE_LIMIT once the next try is later than
// --usage-limit-wait after the hold began, not every retryEvery past it.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { ProbeAnswer } from "../src/agent/UsageProbe.ts"
import { resetLabel } from "../src/core/localTime.ts"
import { run } from "../src/run/run.ts"
import type { Dashboard } from "../src/run/screen.ts"
import { resetText } from "../src/run/told.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  apiErrorResult,
  claimsAndCloses,
  hitsUsageLimit,
  init,
  type Sent,
  type SessionScript,
  sessionState,
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

const minute = 60_000

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-unknown-${name}-`)))

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

/** A whole run of t-1 on main with a dashboard, its worktree made in git first. */
const runs = (plan: {
  readonly usageLimitWait?: Duration.Duration
  readonly probes?: ReadonlyArray<Scripted>
  readonly scripts: (world: World, root: string) => Scripts
  readonly during: Effect.Effect<void, unknown, Env>
}) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: {
        repo,
        settings: { ...appConfig().settings, concurrent: 1 },
        ...(plan.usageLimitWait === undefined ? {} : { usageLimitWait: plan.usageLimitWait }),
      },
      backlog: backlog().ticket("t-1").seeds,
      git: { dir: repo },
      worktrees: { root },
      ...(plan.probes === undefined ? {} : { usageProbe: plan.probes }),
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
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
const refusedProbe = /^USAGE_LIMIT: a probe is refused for the .* limit still; /

/** Moves the clock a try at a time until `count` probes are refused. */
const refusedTries = (count: number) =>
  Effect.gen(function* () {
    for (let i = 1; i <= count; i++) {
      yield* advance("15 minutes")
      yield* untilLogged(refusedProbe, i)
    }
  })

describe("an unknown reset with nothing else running", () => {
  test("a 429 with no reset is tried again retryEvery after the hold began, not the run's end", async () => {
    const ran = await runs({
      scripts: (world, root) => ({
        "t-1": [[...refusedAlone, ...finishes(world, root, "t-1" as TicketId)]],
      }),
      during: Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        yield* advance("14 minutes")
        yield* settle
        expect(yield* logged(lifted)).toBe(0)
        // The probe at the try finds the account under the limit (Allowed, its script empty).
        yield* advance("1 minute")
        yield* untilLogged(lifted)
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      "USAGE_LIMIT: the account's usage limit is reached; no new tickets until it resets",
      `USAGE_LIMIT: nothing else runs; when the account's usage limit resets is unknown; tutti tries again at ${resetLabel(15 * minute, 0)}, in 15m`,
      "USAGE_LIMIT lifted",
      "  t-1: the usage limit has reset; its worker carries on",
    ])
    expect(
      messagesTo(ran.sent, "t-1").filter((text) => text === resetText("t-1" as TicketId)),
    ).toHaveLength(1)
  })

  test("a probe refused at every try ends the run once the next try is past --usage-limit-wait", async () => {
    const refused = ProbeAnswer.Refused({ limit: null, resetsAt: null })
    const ran = await runs({
      usageLimitWait: Duration.hours(1),
      probes: Array.from({ length: 10 }, () => refused),
      scripts: () => ({ "t-1": [refusedAlone] }),
      during: Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        // Tries at 15, 30, 45 and 60 minutes, each refused: the next, at 75, is past the hour.
        yield* refusedTries(4)
      }),
    })
    expectExitCode(ran, 8)
    expectPhases(ran, { "t-1": "Stopped" })
    expect(ran.log.filter((text) => refusedProbe.test(text))).toHaveLength(4)
    expect(ran.log.filter((text) => lifted.test(text))).toHaveLength(0)
    expect(ran.log.at(-1)).toBe(
      `USAGE_LIMIT: the account's usage limit is reached and when it resets is unknown; it has held the run since ${resetLabel(0, 60 * minute)}, and its next try, at ${resetLabel(75 * minute, 60 * minute)}, is later than --usage-limit-wait (1h) allows; 1 worker waits for it; run tutti again once it resets`,
    )
    expect(messagesTo(ran.sent, "t-1")).not.toContain(resetText("t-1" as TicketId))
  })

  test("a reset the server keeps giving as passed is tried no longer than --usage-limit-wait", async () => {
    // The worker's rejection and each probe's give a reset at the epoch, which TestClock has
    // passed: as a clock running ahead of the server's would see it.
    const refused = ProbeAnswer.Refused({ limit: "five_hour", resetsAt: 0 })
    const ran = await runs({
      usageLimitWait: Duration.hours(1),
      probes: Array.from({ length: 10 }, () => refused),
      scripts: () => ({ "t-1": [hitsUsageLimit(0)] }),
      during: Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        yield* refusedTries(4)
      }),
    })
    expectExitCode(ran, 8)
    expectPhases(ran, { "t-1": "Stopped" })
    expectLog(ran, [
      `USAGE_LIMIT: nothing else runs; the five-hour limit was to reset at ${resetLabel(0, 0)}; tutti tries again at ${resetLabel(15 * minute, 0)}, in 15m`,
    ])
    expect(ran.log.filter((text) => refusedProbe.test(text))).toHaveLength(4)
    expect(ran.log.at(-1)).toBe(
      `USAGE_LIMIT: the five-hour limit is reached and when it resets is unknown; it has held the run since ${resetLabel(0, 60 * minute)}, and its next try, at ${resetLabel(75 * minute, 60 * minute)}, is later than --usage-limit-wait (1h) allows; 1 worker waits for it; run tutti again once it resets`,
    )
  })
})
