import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, SubscriptionRef } from "effect"
import { rateLimitOf, UsageLimits } from "../src/agent/UsageLimits.ts"
import { OrganHold } from "../src/organs/Organs.ts"
import { resetLabel } from "../src/run/localTime.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { countdown, type RunView } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { nudgeText, resetText } from "../src/run/told.ts"
import { holdNotice, liftAfter, limitName, limitStop, organHold } from "../src/run/usageLimit.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  claimsAndCloses,
  emit,
  hitsUsageLimit,
  rateLimit,
  result,
  type Sent,
  type SessionScript,
  run as step,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { Reported, scripted, layer as usageLayer } from "../src/testing/UsageLimits.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

// Whole runs, some waiting out a hold, take up to a second on an idle machine: bun's 5 s default
// fails them when other checks run beside this one.
setDefaultTimeout(30_000)

// TestClock starts at the epoch, so a limit resetting at 3600 (seconds, as the API says it) resets
// an hour into the run.
const hour = 3600
const resetsIn = (seconds: number) => resetLabel(seconds * 1000, 0)

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-usage-${name}-`)))

/** A recorded turn ending on the limit (test/fixtures/usage-limit/README.md), as a session's. */
const fixture = (name: string): SessionScript => [
  wait,
  ...readFileSync(resolve(import.meta.dir, "fixtures/usage-limit", name), "utf8")
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as { readonly type: string; user_message_uuids?: unknown })
    // The scripted host speaks for the CLI's lifecycle of its own sends.
    .filter((message) => message.type !== "command_lifecycle")
    .map(({ user_message_uuids: _, ...message }) => emit(message)),
]

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

/**
 * Hits the limit resetting at `at` (seconds), then carries on when told to and finishes; `first`
 * runs as its turn starts, before the limit.
 */
const limitedThenFinishes = (
  world: World,
  root: string,
  id: TicketId,
  at: number,
  first: SessionScript = [],
) => {
  // After its wait for the prompt, which starts the turn.
  const limited = hitsUsageLimit(at)
  return [[...limited.slice(0, 1), ...first, ...limited.slice(1), ...finishes(world, root, id)]]
}

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly concurrent?: number
  readonly usageLimitWait?: Duration.Duration
  /** Laid over the environment hold's settings. */
  readonly environment?: Partial<ReturnType<typeof appConfig>["settings"]["environment_hold"]>
  readonly scripts: (world: World, root: string) => Scripts
  /** Runs beside the run, before it is joined; `view` reads the dashboard's RunView. */
  readonly during?: (view: Effect.Effect<RunView>) => Effect.Effect<void, unknown, Env>
}

/** A whole run on main with a dashboard, each ticket's worktree made in git first. */
const runs = (plan: Plan) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: plan.concurrent ?? 1,
    environment_hold: { ...defaults.environment_hold, ...plan.environment },
  }
  return scenario(
    {
      config: {
        repo,
        settings,
        ...(plan.usageLimitWait === undefined ? {} : { usageLimitWait: plan.usageLimitWait }),
      },
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
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      // RunView is written at most 30 times a second, on the Clock: move it on to see the latest.
      const view = Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          yield* advance("100 millis")
          yield* Effect.promise(() => Bun.sleep(10))
        }
        if (shown === undefined) throw new Error("the run showed no dashboard")
        return yield* SubscriptionRef.get(shown.view)
      })
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
        }),
      )
      if (plan.during !== undefined) yield* plan.during(view)
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The notices other than those of the tickets closed and the run finished (notices.ts). */
const usageNotices = (notices: ReadonlyArray<string>): ReadonlyArray<string> =>
  notices.filter((notice) => !/^(Closed|Finished) /.test(notice))

/** The messages tutti sent `ticket`'s worker, by their text. */
const messagesTo = (sent: ReadonlyArray<Sent>, ticket: string): ReadonlyArray<string> =>
  sent.flatMap((each) =>
    each._tag === "Message" && each.ticket === ticket ? [String(each.message.message.content)] : [],
  )

describe("the usage-limit warning", () => {
  test("shows the usage, is said once per limit, and changes no dispatch", async () => {
    let seen: RunView | undefined
    // The warning comes in the turn that finishes the ticket, after its system/init.
    const warns = (world: World, root: string, id: TicketId): SessionScript => {
      const [taken, init, running, ...rest] = finishes(world, root, id)
      return [
        ...[taken, init, running].flatMap((step) => (step === undefined ? [] : [step])),
        rateLimit("allowed_warning", hour, 0.85),
        ...rest,
      ]
    }
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      concurrent: 2,
      scripts: (world, root) => ({
        "t-1": [warns(world, root, "t-1" as TicketId)],
        "t-2": [warns(world, root, "t-2" as TicketId)],
      }),
      during: (view) =>
        Effect.gen(function* () {
          yield* untilLogged(/^USAGE: /)
          seen = yield* view
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    const warning = `USAGE: 85% of the five-hour limit · resets ${resetsIn(hour)}`
    expect(ran.log.filter((text) => text.startsWith("USAGE"))).toEqual([warning])
    expect(ran.log.filter((text) => text.includes("dispatching"))).toEqual([
      "[1] t-1 dispatching: t-1",
      "[2] t-2 dispatching: t-2",
    ])
    const records = ran.events.filter((record) => record.kind === "usage_limit")
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      status: "warning",
      limit: "five_hour",
      utilization: 0.85,
      text: warning,
    })
    expect(seen?.banners).toEqual([
      { _tag: "Usage", utilization: 0.85, resetsAt: hour * 1000, limit: "five-hour" },
    ])
    expect(usageNotices(ran.notices)).toEqual([])
  })
})

describe("the usage-limit hold", () => {
  test("a rejection holds the run; the reset lifts it and wakes its workers", async () => {
    let held: RunView | undefined
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      concurrent: 2,
      scripts: (world, root) => {
        const started = Deferred.makeUnsafe<void>()
        return {
          // t-1 hits the limit once t-2 has started, so that both are dispatched before the hold.
          "t-1": limitedThenFinishes(world, root, "t-1" as TicketId, hour, [
            step(Deferred.await(started)),
          ]),
          "t-2": limitedThenFinishes(world, root, "t-2" as TicketId, hour, [
            step(Effect.asVoid(Deferred.done(started, Exit.void))),
          ]),
          "t-3": [finishes(world, root, "t-3" as TicketId)],
        }
      },
      during: (view) =>
        Effect.gen(function* () {
          yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
          held = yield* view
          yield* advance("2 hours")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    const resets = resetsIn(hour)
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      "[2] t-2 dispatching: t-2",
      `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at ${resets}`,
      `USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at ${resets}, in 1h`,
      "USAGE_LIMIT lifted",
      /^ {2}t-[12]: the usage limit has reset; its worker carries on$/,
      /^ {2}t-[12]: the usage limit has reset; its worker carries on$/,
      "[3] t-3 dispatching: t-3",
    ])
    // The hold's banner counts down, the warning line names it, the queue is held.
    expect(held?.banners).toContainEqual({
      _tag: "Hold",
      word: "USAGE_LIMIT",
      resetsAt: hour * 1000,
      waiting: true,
    })
    expect(held?.warnings).toContain(
      `usage limit (five-hour) · resets ${resets} · 2 workers wait for it`,
    )
    expect(held?.totals.queueHeld).toBe(true)
    // Each worker waiting for it was told to carry on, once, and never nudged.
    for (const id of ["t-1" as TicketId, "t-2" as TicketId]) {
      expect(messagesTo(ran.sent, id).filter((text) => text === resetText(id))).toHaveLength(1)
      expect(messagesTo(ran.sent, id)).not.toContain(nudgeText(id))
    }
    expect(usageNotices(ran.notices)).toEqual([
      `The five-hour limit is reached; the run holds until it resets at ${resets}`,
    ])
    expectEvents(ran, ["usage_limit", "hold", "usage_limit", "hold", "end"])
    const records = ran.events.filter((r) => r.kind === "usage_limit" || r.kind === "hold")
    expect(records.map((r) => (r.kind === "usage_limit" ? r.status : r.text))).toEqual([
      "rejected",
      `HOLD: USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at ${resets}`,
      "lifted",
      "HOLD: USAGE_LIMIT lifted",
    ])
  })

  test("usage-limited workers settling with nothing done don't hold the run for the environment", async () => {
    // With a window of 3h, two workers ending their turns with nothing done after the reset would
    // be two tickets failing at once, were they not usage-limited in their attempt.
    const givesUp = turn([], result("Nothing to do."))
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      concurrent: 2,
      environment: { window: Duration.hours(3) },
      scripts: () => ({
        "t-1": [[...hitsUsageLimit(hour), ...givesUp]],
        "t-2": [[...hitsUsageLimit(hour), ...givesUp]],
      }),
      during: () =>
        Effect.andThen(untilLogged(/^USAGE_LIMIT: nothing else runs/), advance("2 hours")),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Deferred", "t-2": "Deferred" })
    expect(ran.log.some((text) => text.includes("ENVIRONMENT"))).toBe(false)
    expect(ran.log).toContain("USAGE_LIMIT lifted")
  })

  test("with nothing else running the run waits for the reset, saying its countdown", async () => {
    const at = 5 * hour
    const ran = await runs({
      tickets: ["t-1"],
      scripts: (world, root) => ({
        "t-1": limitedThenFinishes(world, root, "t-1" as TicketId, at),
      }),
      during: () =>
        Effect.gen(function* () {
          yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
          yield* advance("25 minutes")
          yield* untilLogged(/^ {2}the five-hour limit resets at .*, in 4h4\dm$/)
          yield* advance("5 hours")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    const resets = resetsIn(at)
    expectLog(ran, [
      `USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at ${resets}, in 5h`,
      `  the five-hour limit resets at ${resets}, in 4h50m`,
      `  the five-hour limit resets at ${resets}, in 4h40m`,
      "USAGE_LIMIT lifted",
      "  t-1: the usage limit has reset; its worker carries on",
    ])
  })

  test("it ends USAGE_LIMIT (exit 8) when the reset is later than --usage-limit-wait", async () => {
    // The recorded rejection resets in 2026, long after the 6h the run waits by default.
    const ran = await runs({
      tickets: ["t-1"],
      scripts: () => ({ "t-1": [fixture("rejected.jsonl")] }),
    })
    expectExitCode(ran, 8)
    expectPhases(ran, { "t-1": "Stopped" })
    const stop = ran.log.at(-1) ?? ""
    expect(stop).toMatch(
      /^USAGE_LIMIT: the five-hour limit resets at [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d, in \S+, later than --usage-limit-wait \(6h\); 1 worker waits for it; run tutti again once it resets$/,
    )
    const records = ran.events.filter((r) => r.kind === "stop" || r.kind === "suspended")
    expect(records.map((r) => r.kind)).toEqual(["suspended", "stop"])
    expect(records[1]).toMatchObject({ detail: "USAGE_LIMIT", text: stop })
    expect(messagesTo(ran.sent, "t-1")).not.toContain(resetText("t-1" as TicketId))
  })

  test("a shorter --usage-limit-wait ends a run a reset within 6h would hold", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      usageLimitWait: Duration.minutes(30),
      scripts: (world, root) => ({
        "t-1": limitedThenFinishes(world, root, "t-1" as TicketId, hour),
      }),
    })
    expectExitCode(ran, 8)
    expect(ran.log.at(-1)).toBe(
      `USAGE_LIMIT: the five-hour limit resets at ${resetsIn(hour)}, in 1h, later than --usage-limit-wait (30m); 1 worker waits for it; run tutti again once it resets`,
    )
  })

  test("it ends USAGE_LIMIT (exit 8) when when the limit resets is unknown", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      scripts: () => ({ "t-1": [fixture("result-429.jsonl")] }),
    })
    expectExitCode(ran, 8)
    expectPhases(ran, { "t-1": "Stopped" })
    expectLog(ran, [
      "USAGE_LIMIT: the account's usage limit is reached; no new tickets until it resets",
      "USAGE_LIMIT: the account's usage limit is reached and when it resets is unknown; 1 worker waits for it; run tutti again once it resets",
    ])
    const rejected = ran.events.find((r) => r.kind === "usage_limit")
    expect(rejected).toMatchObject({ status: "rejected", limit: "unknown" })
  })
})

describe("UsageLimits", () => {
  test("a rate_limit_event's info, its reset in milliseconds and its overage", () => {
    expect(
      rateLimitOf({
        status: "rejected",
        resetsAt: 1_792_222_200,
        rateLimitType: "seven_day",
        utilization: 1,
        isUsingOverage: true,
      }),
    ).toEqual({
      status: "rejected",
      limit: "seven_day",
      resetsAt: 1_792_222_200_000,
      utilization: 1,
      overage: true,
    })
    expect(rateLimitOf({ status: "allowed" })).toEqual({
      status: "allowed",
      limit: null,
      resetsAt: null,
      utilization: null,
      overage: false,
    })
  })

  test("organ calls are held while the hold is on", async () => {
    const held = await Effect.runPromise(
      Effect.gen(function* () {
        const usage = yield* UsageLimits
        const hold = yield* OrganHold
        yield* scripted([{ status: "rejected", rateLimitType: "five_hour" }])
        const before = yield* hold.held
        yield* usage.hold(true)
        const during = yield* hold.held
        yield* usage.hold(false)
        return {
          before,
          during,
          after: yield* hold.held,
          reported: yield* (yield* Reported).events,
        }
      }).pipe(Effect.provide(organHold.pipe(Layer.provideMerge(usageLayer)))),
    )
    expect(held).toMatchObject({ before: false, during: true, after: false })
    expect(held.reported.map((event) => event.limit)).toEqual(["five_hour"])
  })
})

describe("what the hold says", () => {
  test("a limit's name, the notice and the stop", () => {
    expect(limitName("five_hour")).toBe("five-hour")
    expect(limitName("seven_day_opus")).toBe("seven-day-opus")
    expect(limitName(null)).toBe("account's usage")
    expect(holdNotice("five_hour", 3_600_000, 3, 0)).toBe(
      `usage limit (five-hour) · resets ${resetLabel(3_600_000, 0)} · 3 workers wait for it`,
    )
    expect(holdNotice("five_hour", null, 1, 0)).toBe(
      "usage limit (five-hour) · 1 worker waits for it",
    )
    expect(holdNotice(null, null, 0, 0)).toBe("usage limit (account's usage)")
    expect(
      String(
        limitStop({ limit: null, resetsAt: null, now: 0, wait: Duration.hours(6), waiting: 0 })
          .text,
      ),
    ).toBe(
      "USAGE_LIMIT: the account's usage limit is reached and when it resets is unknown; run tutti again once it resets",
    )
    expect(
      limitStop({ limit: null, resetsAt: null, now: 0, wait: Duration.hours(6), waiting: 0 }).code,
    ).toBe(8)
    expect(countdown(3_600_000, 0)).toBe("1h")
    expect(countdown(61_000, 0)).toBe("2m")
    expect(countdown(0, 0)).toBe("1m")
    expect(Duration.toMillis(liftAfter)).toBe(60_000)
  })

  test("the title line: the usage with its limit and overage, the hold counting down", () => {
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
    const title = {
      version: "0.1.0",
      branch: "",
      scope: null,
      began: 0,
      stopping: false,
      quitting: null,
      solo: null,
      shared: 0,
      keepAwake: false,
      autoAnswer: null,
    }
    const text = (banners: Parameters<typeof titleSegments>[1], now: number) =>
      titleSegments(title, banners, now, theme, 120)
        .map((segment) => segment.text)
        .join("")
        .trimEnd()
    const at = 3_600_000
    expect(
      text(
        [{ _tag: "Usage", utilization: 0.85, resetsAt: at, limit: "five-hour", overage: true }],
        0,
      ),
    ).toEndWith(`usage 85% of the five-hour limit · resets ${resetLabel(at, 0)} · overage`)
    expect(
      text([{ _tag: "Hold", word: "USAGE_LIMIT", resetsAt: at, waiting: true }], 1_800_000),
    ).toEndWith(`USAGE_LIMIT · resets ${resetLabel(at, 1_800_000)} · in 30m`)
    expect(text([{ _tag: "Hold", word: "USAGE_LIMIT", resetsAt: at }], 1_800_000)).toEndWith(
      `USAGE_LIMIT · resets ${resetLabel(at, 1_800_000)}`,
    )
  })
})
