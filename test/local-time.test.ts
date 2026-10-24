// Times as tutti writes them for people (src/run/localTime.ts): a usage limit's reset says its day
// when it isn't today, in the banner, cards, log lines, notification and stop line, the report's
// span its end date when it differs, and the log's stamp its UTC offset.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, SubscriptionRef } from "effect"
import { interviewStatus } from "../src/run/interview.ts"
import {
  clock,
  clockFrom,
  date,
  reportName,
  resetLabel,
  sameDay,
  span,
  stamp,
} from "../src/run/localTime.ts"
import { line } from "../src/run/log.ts"
import { compose, ranFrom } from "../src/run/report.ts"
import { run } from "../src/run/run.ts"
import { type RunView, stateStatus } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { holdNotice, limitStop } from "../src/run/usageLimit.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses, hitsUsageLimit, type SessionScript } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { withVariable } from "./env.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  scenario,
  type World,
} from "./harness.ts"

setDefaultTimeout(30_000)

/** `body` run with the local time Berlin's, whose clocks go back on 2026-10-25 at 03:00. */
const inBerlin = <A>(body: () => A): A => withVariable("TZ", "Europe/Berlin", body)

const minute = 60_000
const hour = 60 * minute

describe("a usage limit's reset", () => {
  test("is its time on the day it is read, and its weekday and date on another", () =>
    inBerlin(() => {
      const now = new Date(2026, 9, 20, 9, 30).getTime() // Tuesday
      expect(resetLabel(new Date(2026, 9, 20, 14, 5).getTime(), now)).toBe("14:05")
      expect(resetLabel(new Date(2026, 9, 20, 23, 59).getTime(), now)).toBe("23:59")
      // A seven-day limit hit on Tuesday, resetting on Friday.
      expect(resetLabel(new Date(2026, 9, 23, 14, 5).getTime(), now)).toBe("Fri Oct 23 14:05")
      // One a week ahead, and one in the new year.
      expect(resetLabel(new Date(2026, 9, 27, 8, 0).getTime(), now)).toBe("Tue Oct 27 08:00")
      expect(resetLabel(new Date(2027, 0, 2, 0, 0).getTime(), now)).toBe("Sat Jan 2 00:00")
    }))

  test("across midnight: a five-hour limit hit late in the evening resets the next day", () =>
    inBerlin(() => {
      const hit = new Date(2026, 9, 22, 22, 40).getTime()
      const reset = hit + 3 * hour
      expect(resetLabel(reset, hit)).toBe("Fri Oct 23 01:40")
      // Read once midnight has passed, it is today's.
      expect(resetLabel(reset, new Date(2026, 9, 23, 0, 5).getTime())).toBe("01:40")
      expect(sameDay(new Date(2026, 9, 22, 23, 59, 59).getTime(), reset)).toBe(false)
    }))

  test("the day is read in local time, not UTC's", () =>
    withVariable("TZ", "America/Los_Angeles", () => {
      // 23:00 and 23:30 in Los Angeles: the next day in UTC, the same day here.
      const now = new Date(2026, 9, 22, 23, 0).getTime()
      expect(resetLabel(now + 30 * minute, now)).toBe("23:30")
      expect(resetLabel(now + 90 * minute, now)).toBe("Fri Oct 23 00:30")
    }))
})

describe("the report's span", () => {
  test("gives the end's date only when it differs from the start's", () =>
    inBerlin(() => {
      const start = new Date(2026, 9, 17, 9, 5, 3).getTime()
      expect(span(start, new Date(2026, 9, 17, 10, 30).getTime())).toBe("2026-10-17 09:05–10:30")
      const late = new Date(2026, 9, 17, 23, 10).getTime()
      expect(span(late, new Date(2026, 9, 18, 1, 40).getTime())).toBe(
        "2026-10-17 23:10–2026-10-18 01:40",
      )
      expect(clockFrom(new Date(2026, 9, 18, 1, 40).getTime(), late)).toBe("2026-10-18 01:40")
      expect(clockFrom(new Date(2026, 9, 17, 23, 55).getTime(), late)).toBe("23:55")
    }))

  test("the report's title gives the end's date when the run crossed midnight", () =>
    inBerlin(() => {
      const report = (started: number, ended: number) =>
        compose({
          started,
          ended,
          base: "main",
          scope: null,
          body: "Done.",
          cost: { calls: 0, costUsd: 0, turns: 0, unknown: 0 },
        }).split("\n")[0]
      expect(
        report(new Date(2026, 9, 17, 23, 10).getTime(), new Date(2026, 9, 18, 1, 40).getTime()),
      ).toBe("# tutti run · 2026-10-17 23:10–2026-10-18 01:40 · main")
      expect(
        report(new Date(2026, 9, 17, 9, 5).getTime(), new Date(2026, 9, 17, 10, 30).getTime()),
      ).toBe("# tutti run · 2026-10-17 09:05–10:30 · main")
    }))

  test("the reviewer's closing line gives the end's date when the run crossed midnight", () =>
    inBerlin(() => {
      const late = new Date(2026, 9, 17, 23, 10).getTime()
      expect(ranFrom(late, new Date(2026, 9, 18, 1, 40).getTime())).toBe(
        "from 23:10 to 2026-10-18 01:40",
      )
      expect(ranFrom(late, new Date(2026, 9, 17, 23, 55).getTime())).toBe("from 23:10 to 23:55")
    }))

  test("the report's name, date and clock are local", () =>
    inBerlin(() => {
      const started = new Date(2026, 9, 17, 9, 5, 3).getTime()
      expect(reportName(started)).toBe("2026-10-17-090503.md")
      expect(date(started)).toBe("2026-10-17")
      expect(clock(started)).toBe("09:05")
    }))
})

describe("the log's stamp", () => {
  test("carries the UTC offset, so the hour the clocks go back over reads twice apart", () =>
    inBerlin(() => {
      expect(stamp(Date.UTC(2026, 9, 25, 0, 30))).toBe("2026-10-25 02:30:00 +02:00")
      expect(stamp(Date.UTC(2026, 9, 25, 1, 30))).toBe("2026-10-25 02:30:00 +01:00")
      expect(stamp(Date.UTC(2026, 6, 1, 12, 0, 9))).toBe("2026-07-01 14:00:09 +02:00")
    }))

  test("west of UTC, and at UTC itself", () => {
    withVariable("TZ", "America/New_York", () => {
      expect(stamp(Date.UTC(2026, 9, 22, 4, 5, 6))).toBe("2026-10-22 00:05:06 -04:00")
    })
    withVariable("TZ", "UTC", () => {
      expect(stamp(Date.UTC(2026, 9, 22, 4, 5, 6))).toBe("2026-10-22 04:05:06 +00:00")
    })
  })
})

describe("where the reset is shown", () => {
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
  }
  const banner = (banners: Parameters<typeof titleSegments>[1], now: number) =>
    titleSegments(title, banners, now, theme, 140)
      .map((segment) => segment.text)
      .join("")
      .trimEnd()

  test("the banner, card, notice and stop line say a seven-day reset's day", () =>
    inBerlin(() => {
      const now = new Date(2026, 9, 20, 9, 30).getTime()
      const at = new Date(2026, 9, 23, 14, 5).getTime()
      expect(
        banner([{ _tag: "Usage", utilization: 0.85, resetsAt: at, limit: "seven-day" }], now),
      ).toEndWith("usage 85% of the seven-day limit · resets Fri Oct 23 14:05")
      expect(banner([{ _tag: "Hold", word: "USAGE_LIMIT", resetsAt: at }], now)).toEndWith(
        "USAGE_LIMIT · resets Fri Oct 23 14:05",
      )
      const limited = { _tag: "UsageLimited", resetsAt: at } as const
      expect(stateStatus(limited, [], "working", now)).toBe("usage limit · resets Fri Oct 23 14:05")
      expect(interviewStatus(limited, [], now)).toBe("usage limit · resets Fri Oct 23 14:05")
      // On the reset's own day, and with no time to read it against, its time alone.
      expect(stateStatus(limited, [], "working", at - hour)).toBe("usage limit · resets 14:05")
      expect(stateStatus(limited, [], "working")).toBe("usage limit · resets 14:05")
      expect(holdNotice("seven_day", at, 2, now)).toBe(
        "usage limit (seven-day) · resets Fri Oct 23 14:05 · 2 workers wait for it",
      )
      expect(
        String(
          limitStop({ limit: "seven_day", resetsAt: at, now, wait: Duration.hours(6), waiting: 1 })
            .text,
        ),
      ).toBe(
        "USAGE_LIMIT: the seven-day limit resets at Fri Oct 23 14:05, in 76h35m, later than --usage-limit-wait (6h); 1 worker waits for it; run tutti again once it resets",
      )
    }))
})

/** Claims, commits and closes its ticket once the limit has reset, as a worker does. */
const limitedThenFinishes = (
  world: World,
  root: string,
  id: string,
  at: number,
): ReadonlyArray<SessionScript> => [
  [
    ...hitsUsageLimit(at),
    ...claimsAndCloses(id, {
      claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      commit: Effect.asVoid(
        Effect.orDie(
          world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
        ),
      ),
      close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
    }),
  ],
]

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-time-${name}-`)))

describe("a hold across midnight", () => {
  test("its log lines, notification, notice and card say the reset's day", async () => {
    // The run starts at 23:30 local time; the five-hour limit resets an hour later, tomorrow.
    const start = new Date(2026, 9, 22, 23, 30).getTime()
    const reset = start + hour
    const resets = resetLabel(reset, start)
    expect(resets).toBe(`Fri Oct 23 ${clock(reset)}`)
    const repo = folder("repo")
    const root = folder("worktrees")
    let held: RunView | undefined
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => ({
          "t-1": limitedThenFinishes(world, root, "t-1", Math.round(reset / 1000)),
        }),
      },
      Effect.gen(function* () {
        yield* advance(Duration.millis(start))
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard,
          }),
        )
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        // RunView is written at most 30 times a second, on the Clock: move it on to see the latest.
        for (let i = 0; i < 3; i++) {
          yield* advance("100 millis")
          yield* Effect.promise(() => Bun.sleep(10))
        }
        if (shown !== undefined) held = yield* SubscriptionRef.get(shown.view)
        yield* advance("2 hours")
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at ${resets}`,
      `USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at ${resets}, in 1h`,
      "USAGE_LIMIT lifted",
    ])
    expect(ran.notices).toContain(
      `The five-hour limit is reached; the run holds until it resets at ${resets}`,
    )
    expect(held?.warnings).toContain(
      `usage limit (five-hour) · resets ${resets} · 1 worker waits for it`,
    )
    expect(held?.cards.find((card) => card.ticket === "t-1")?.status).toBe(
      `usage limit · resets ${resets}`,
    )
  })
})
