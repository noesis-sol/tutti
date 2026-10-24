// No failed check is handed back to its worker while the run takes no more work (§ 4.7), as
// orchestra's sayNoMore and whyNotFixCheck have it: a stop holds the run (PAUSED, BLOCKED,
// TICKET_LIMIT, ENVIRONMENT, …), the usage limit holds it, or it winds down. The ticket is set
// aside at once, its line saying `not handed back to its worker: the run holds (<stop>)`.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { addStop, noMoreWork, noStops, openGate, type Stops, stopFor } from "../src/run/holds.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { bash, gone, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-check-hand-back-hold-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** The fast check failing, its lines saying what failed. */
const fails = () =>
  new CheckFailed({
    check: "fast",
    command: check,
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: ["error: src/z.test.ts: expected 1"],
    lastLines: ["1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

/** Claims its ticket, and after `takes` commits a change and closes it. */
const works = (world: World, root: string, id: string, takes: Duration.Input): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(takes),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** Claims its ticket and, after `takes`, is gone; resumed, gone again at once: PAUSED. */
const isGoneTwice = (world: World, id: string, takes: Duration.Input) => [
  [
    ...turn([
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(takes),
    ]).slice(0, -2),
    gone("exit 1"),
  ],
  [gone("exit 1")],
]

/** Waits, in real time, until the run has written no log line or record for 30 ms. */
const caughtUp = Effect.gen(function* () {
  const captured = yield* Captured
  let said = -1
  for (let i = 0, still = 0; i < 1000 && still < 6; i++) {
    const now = (yield* texts).length + (yield* captured.records).length
    still = now === said ? still + 1 : 0
    said = now
    yield* Effect.promise(() => Bun.sleep(5))
  }
})

/** Moves TestClock on by `total`, a ready poll at a time, once the run has caught up each time. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const polls = Duration.toMillis(Duration.fromInputUnsafe(total)) / Duration.toMillis(readyPoll)
    for (let i = 0; i < polls; i++) {
      yield* caughtUp
      yield* advance(readyPoll)
    }
  })

/** The check hand-backs ticket `id`'s worker was sent. */
const handBacks = (ran: Ran<unknown>, id: string) =>
  ran.sent.flatMap((item) =>
    item._tag === "Message" &&
    item.ticket === id &&
    String(item.message.message.content).includes("moved on while you worked")
      ? [item.message.message.content as string]
      : [],
  )

/** `text` as a pattern matching it literally. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

describe("a failed check while the run holds", () => {
  test("PAUSED holds the run: b's failed check isn't handed back, Review, the line saying why", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const ran: Ran<Outcome> = await scenario(
      {
        config: {
          repo,
          worktrees: root,
          settings: {
            ...defaults,
            concurrent: 2,
            checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
          },
        },
        backlog: backlog().ticket("a", { priority: 0 }).ticket("b", { priority: 1 }).seeds,
        git: { dir: repo, files: { "README.md": "tutti\n" } },
        worktrees: { root },
        checks: { fast: [fails()] },
        scripts: (world: World) => ({
          a: isGoneTwice(world, "a", "1 minute"),
          b: [works(world, root, "b", "5 minutes")],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["a", "b"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        // Something else lands on main while b runs, so b's branch is rebased and checked.
        yield* passes("2 minutes")
        const repository = yield* Repository
        yield* repository.commit(repo, "Land something else", { "c.txt": "c\n" })
        yield* passes("4 minutes")
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 3)
    expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
    expectPhases(ran, { a: "Stopped", b: "Review" })
    expect(handBacks(ran, "b")).toEqual([])
    expect(ran.log.some((text) => text.includes("FIXING"))).toBe(false)
    const paused = literally(
      "PAUSED: a still in_progress, its worker is gone (exit 1); its session was resumed once in this run already, and the next run resumes it again",
    )
    expectLog(ran, [
      new RegExp(`^HOLD: ${paused} `),
      new RegExp(
        `^ {2}CHECKS_FAILED: b closed, but '${check}' fails on tutti/b rebased onto main; not handed back to its worker: the run holds \\(${paused} \\(worktree .*/a\\); stopping so it can be answered\\); `,
      ),
    ])
  }, 30_000)
})

describe("why the run takes on no more work", () => {
  const stop = (why: "PAUSED" | "BLOCKED" | "TICKET_LIMIT" | "ENVIRONMENT") =>
    stopFor(why, `${why.toLowerCase()} for a reason`)
  const said = (stops: Stops, usageHeld: boolean, windingDown: boolean) =>
    noMoreWork({ ...openGate, stop: stops.first, usageHeld, windingDown })

  for (const why of ["PAUSED", "BLOCKED", "TICKET_LIMIT", "ENVIRONMENT"] as const) {
    test(`a ${why} stop holds it: "the run holds (${why}: …)"`, () => {
      expect(said(addStop(noStops, stop(why)), false, false)).toBe(
        `the run holds (${why}: ${why.toLowerCase()} for a reason)`,
      )
    })
  }

  test("the first stop is the one named, over the usage limit and a drain", () => {
    const stops = addStop(addStop(noStops, stop("BLOCKED")), stop("PAUSED"))
    expect(said(stops, true, true)).toBe("the run holds (BLOCKED: blocked for a reason)")
  })

  test("the usage limit holds it: USAGE_LIMIT, over a drain", () => {
    expect(said(noStops, true, true)).toBe("the run holds (USAGE_LIMIT)")
  })

  test("a drain winds it down", () => {
    expect(said(noStops, false, true)).toBe("the run is winding down")
  })

  test("nothing holds it: it takes work", () => {
    expect(said(noStops, false, false)).toBeUndefined()
  })
})
