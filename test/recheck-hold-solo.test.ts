// A ticket set aside for a failed check is checked once more after the base moves on (recheck.ts),
// as orchestra's recheckTickets has it: not while the run holds, nor while a solo ticket runs or is
// next, and in a slot of its own, as a running ticket's, until its merge is over.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { bash, gone, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  type BacklogBuilder,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-recheck-hold-solo-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** The fast check failing on a file no ticket here changes: its ticket may be checked again. */
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
const works = (world: World, root: string, id: string, takes: Duration.Input = 0): SessionScript =>
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

/** Moves TestClock on by `minutes`, a ready poll at a time, once the run has caught up each time. */
const passes = (minutes: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < (minutes * 60_000) / 30_000; i++) {
      yield* caughtUp
      yield* advance(readyPoll)
    }
  })

/**
 * A whole run of `tickets` on main with `concurrent` workers, a failed check set aside at once (no
 * hand-back), the fast check failing first as `checks` says; TestClock moved on `minutes`.
 */
const runs = (
  tickets: BacklogBuilder,
  concurrent: number,
  scripts: (world: World, root: string) => Scripts,
  minutes: number,
): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const seeds = tickets.seeds
  return scenario(
    {
      config: {
        repo,
        worktrees: root,
        settings: {
          ...defaults,
          concurrent,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
          merge: { ...defaults.merge, check_hand_backs: 0 },
        },
      },
      backlog: seeds,
      git: { dir: repo, files: { "README.md": "tutti\n" } },
      worktrees: { root },
      // x, on top of main, passes; a, rebased onto it, fails.
      checks: { fast: [passed("fast"), fails()] },
      scripts: (world: World) => scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const seed of seeds) {
        yield* git.addWorktree(repo, join(root, seed.id), {
          branch: `tutti/${seed.id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* passes(minutes)
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

const checksFailed =
  /^ {2}CHECKS_FAILED: a closed, .*; checked once more if main moves on in this run$/
const recheckLine =
  /^ {2}RECHECK: a's check failed on main at [0-9a-f]{7}, which has moved on since/

/** Set aside, then checked once more and merged. */
const rechecked = [
  "Queued",
  "Working",
  "ToMerge",
  "Merging",
  "Review",
  "ToMerge",
  "Merging",
  "Done",
]

/** The tickets Working at any time from a's RECHECK record until a is Done. */
const workingBeside = (ran: Ran<unknown>): ReadonlyArray<string> => {
  const phases = new Map<string, string>()
  const beside = new Set<string>()
  let checking = false
  for (const record of ran.events) {
    if (record.kind === "phase" && record.ticket !== undefined) {
      phases.set(record.ticket, record.to ?? "outside")
      if (record.ticket === "a" && record.to === "Done") checking = false
    }
    if (record.kind === "info" && record.ticket === "a" && record.text.includes("RECHECK")) {
      checking = true
    }
    if (checking) {
      for (const [id, phase] of phases) if (phase === "Working") beside.add(id)
    }
  }
  return [...beside]
}

describe("no recheck while the run holds", () => {
  test("PAUSED holds the run: b's merge moves main on, and a stays set aside", async () => {
    // x lands at once; a's check fails on main at x; p is gone twice at 90s, PAUSED; b lands at 3m.
    const ran = await runs(
      backlog()
        .ticket("x", { priority: 0 })
        .ticket("a", { priority: 1 })
        .ticket("p", { priority: 2 })
        .ticket("b", { priority: 3 }),
      4,
      (world, root) => ({
        x: [works(world, root, "x")],
        a: [works(world, root, "a", "1 minute")],
        p: isGoneTwice(world, "p", "90 seconds"),
        b: [works(world, root, "b", "3 minutes")],
      }),
      5,
    )
    expectExitCode(ran, 3)
    expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
    expectPhases(ran, { x: "Done", a: "Review", p: "Stopped", b: "Done" })
    expectLog(ran, [closedLine("x"), checksFailed, /^HOLD: PAUSED: p /, closedLine("b")])
    expect(ran.log.filter((text) => recheckLine.test(text))).toEqual([])
    expect(pathOf(ran, "a")).toEqual(["Queued", "Working", "ToMerge", "Merging", "Review"])
  }, 30_000)
})

describe("no recheck beside a solo ticket", () => {
  test("next, then running: a is checked once more only once the solo ticket is done", async () => {
    // x lands at once, c starts in its slot; a's check fails at 1m; the solo s is next from then,
    // as b lands at 2m; it starts once c is done at 5m, and is done at 7m.
    const ran = await runs(
      backlog()
        .ticket("x", { priority: 0 })
        .ticket("a", { priority: 1 })
        .ticket("b", { priority: 2 })
        .ticket("c", { priority: 3 })
        .ticket("s", { priority: 4, labels: ["solo"] }),
      3,
      (world, root) => ({
        x: [works(world, root, "x")],
        a: [works(world, root, "a", "1 minute")],
        b: [works(world, root, "b", "2 minutes")],
        c: [works(world, root, "c", "5 minutes")],
        s: [works(world, root, "s", "2 minutes")],
      }),
      9,
    )
    expectExitCode(ran, 0)
    expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
    expectPhases(ran, { x: "Done", a: "Done", b: "Done", c: "Done", s: "Done" })
    expectLog(ran, [
      checksFailed,
      closedLine("b"),
      /^\[\d+\] s dispatching solo: s$/,
      recheckLine,
      closedLine("a"),
    ])
    expect(pathOf(ran, "a")).toEqual(rechecked)
    // Not while s runs: its worker is done before a is checked once more.
    expect(workingBeside(ran)).toEqual([])
  }, 30_000)
})

describe("a recheck takes a slot", () => {
  test("with one worker, nothing runs beside a ticket checked once more", async () => {
    // x lands at once; a's check fails on main at x; b lands at 2m; c and d wait for the slot.
    const ran = await runs(
      backlog()
        .ticket("x", { priority: 0 })
        .ticket("a", { priority: 1 })
        .ticket("b", { priority: 2 })
        .ticket("c", { priority: 3 })
        .ticket("d", { priority: 4 }),
      1,
      (world, root) => ({
        x: [works(world, root, "x")],
        a: [works(world, root, "a", "1 minute")],
        b: [works(world, root, "b", "1 minute")],
        c: [works(world, root, "c", "3 minutes")],
        d: [works(world, root, "d")],
      }),
      8,
    )
    expectExitCode(ran, 0)
    expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
    expectPhases(ran, { x: "Done", a: "Done", b: "Done", c: "Done", d: "Done" })
    expectLog(ran, [checksFailed, closedLine("b"), recheckLine, closedLine("a")])
    expect(pathOf(ran, "a")).toEqual(rechecked)
    expect(workingBeside(ran)).toEqual([])
  }, 30_000)
})
