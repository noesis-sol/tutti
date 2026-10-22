// Scheduling scenarios (§ 14 M2): each of orchestra v0.7.7's running and workers guides, as a whole
// run under TestClock. Each asserts the run's log lines, its event records, the phases its tickets
// went through and ended in (with no PHASE_BUG), that it left no fiber or process behind it, and
// its exit code. Nothing to run ends before the run's loop, as main checks it: those scenarios
// assert what main does there: its done line, its records, what it prints and its exit code.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Console, Duration, Effect, Fiber, Queue } from "effect"
import { carriedTickets } from "../src/run/carry.ts"
import type { DrainRequest } from "../src/run/drain.ts"
import { line } from "../src/run/log.ts"
import { endIfNothing, heldAtStart } from "../src/run/nothing.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { stillUnmerged } from "../src/run/unmerged.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { type State, stateVersion, type TicketRecord } from "../src/services/Store.ts"
import {
  bash,
  gone,
  result,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Script as ChecksScript, passed } from "../src/testing/Checks.ts"
import { Captured } from "../src/testing/EventStream.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  type BacklogBuilder,
  backlog,
  type Env,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-scenarios-scheduling-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings
type Settings = typeof defaults

/** Where the run's main checkout and worktrees are, for the workers' scripts. */
interface Places {
  readonly repo: string
  readonly root: string
}

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A ticket whose `files` metadata names `files`, which its footprint holds. */
const touching = (...files: ReadonlyArray<string>) => ({ metadata: { files } })

/** The time `millis` after the epoch, where TestClock starts, as bd's dates are written. */
const at = (millis: number) => new Date(millis).toISOString()

// The workers.

/**
 * Claims its ticket, does `first` (`takes` passing by default), commits `files` and closes it, then
 * does `last`, as a worker does.
 */
const works = (
  world: World,
  places: Places,
  id: string,
  options: {
    readonly files?: Files
    readonly takes?: Duration.Input
    readonly first?: SessionScript
    readonly last?: SessionScript
  } = {},
): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      ...(options.first ?? [sleep(options.takes ?? 0)]),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(
          world.repository.commit(
            join(places.root, id),
            `Change (${id})`,
            options.files ?? { [`${id}.txt`]: `${id}\n` },
          ),
        ),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
      ...(options.last ?? []),
    ],
    result(`Closed ${id}.`),
  )

/** Claims its ticket and, after `takes`, defers it, noting why it can't finish. */
const defers = (world: World, id: string, takes: Duration.Input = 0): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(takes),
      ...bash(`bd defer ${id}`, orDie(world.beads.defer(id, { reason: "needs a design" }))),
    ],
    result(`Deferred ${id}.`),
  )

/**
 * Claims its ticket, edits a file and, after `takes`, closes it without committing: work left for
 * review.
 */
const closesUncommitted = (
  world: World,
  places: Places,
  id: string,
  takes: Duration.Input = 0,
): SessionScript =>
  turn([
    ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
    sleep(takes),
    ...bash(
      `echo ${id} > ${id}.txt`,
      orDie(world.repository.write(join(places.root, id), { [`${id}.txt`]: `${id}\n` })),
    ),
    ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
  ])

/**
 * Claims its ticket, finds it needs `blocker`'s work, links it and stops with the ticket open and
 * nothing done: it started too early.
 */
const needs = (world: World, id: string, blocker: string): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      ...bash(`bd dep add ${id} ${blocker}`, orDie(world.beads.addDependency(id, blocker))),
      ...bash(`bd update ${id} --status open`, orDie(world.beads.update(id, { status: "open" }))),
    ],
    result(`${id} needs ${blocker}'s work first.`),
  )

/**
 * Claims its ticket and, after `takes`, is gone with it in progress; resumed, it is gone again at
 * once: the run stops for it, PAUSED.
 */
const isGoneTwice = (
  world: World,
  id: string,
  takes: Duration.Input,
): ReadonlyArray<SessionScript> => [
  [
    ...turn([
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(takes),
    ]).slice(0, -2),
    gone("exit 1"),
  ],
  [gone("exit 1")],
]

// The checks.

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

/** The settings with a failing check set aside at once, not handed back to its worker. */
const noHandBacks = (settings: Settings): Partial<Settings> => ({
  merge: { ...settings.merge, check_hand_backs: 0 },
})

// The run.

/**
 * Waits, in real time, until the run has caught up: it has written no log line or record for 30 ms.
 * The run reads files for real, so a busy machine can keep it from catching up within a few.
 */
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

interface Plan {
  readonly backlog: BacklogBuilder
  /** Laid over the settings: the defaults with the check command `check` and 2 workers. */
  readonly settings?: (settings: Settings) => Partial<Settings>
  /** --limit. */
  readonly limit?: number
  /** --ticket. */
  readonly ticket?: string
  readonly checks?: ChecksScript
  readonly scripts: (world: World, places: Places) => Scripts
  /** The tickets workers file as the run goes, which it may start: their worktrees are made too. */
  readonly filed?: ReadonlyArray<string>
  readonly drains?: Queue.Dequeue<DrainRequest>
  /** Runs beside the run, before it is joined. */
  readonly during?: (places: Places) => Effect.Effect<void, unknown, Env>
}

/** The repository's files on main, which footprints are resolved against. */
const files = { "README.md": "tutti\n", "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n" }

/**
 * A whole run on main, each ticket's worktree made in git first (the Worktrees test layer makes
 * only folders), and where it ran.
 */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const base: Settings = {
    ...defaults,
    concurrent: 2,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  }
  const seeds = plan.backlog.seeds
  const tickets = [
    ...seeds.filter((seed) => seed.type !== "epic" && seed.status !== "closed").map((s) => s.id),
    ...(plan.filed ?? []),
  ]
  return scenario(
    {
      config: {
        repo: places.repo,
        worktrees: places.root,
        settings: { ...base, ...plan.settings?.(base) },
        ...(plan.limit === undefined ? {} : { limit: plan.limit }),
        ...(plan.ticket === undefined ? {} : { ticket: plan.ticket }),
      },
      backlog: seeds,
      git: { dir: places.repo, files },
      worktrees: { root: places.root },
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) => plan.scripts(world, places),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          ...(plan.drains === undefined ? {} : { drains: plan.drains }),
        }),
      )
      if (plan.during !== undefined) yield* plan.during(places)
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

// What each scenario asserts.

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** The path of a ticket dispatched once, merged at once. */
const straight = ["Queued", "Working", "ToMerge", "Merging", "Done"]

/** The path of a ticket held back first, then dispatched and merged. */
const heldThenStraight = ["Queued", "HeldBack", ...straight]

/** Each `phase` record taking the ticket to HeldBack: why it was held back. */
const heldFor = (ran: Ran<unknown>, id: string): ReadonlyArray<unknown> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id && record.to === "HeldBack" ? [record.why] : [],
  )

/** The tickets dispatched, in order, with when: the minute since the run began. */
const dispatches = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "dispatch"
      ? [`${record.ticket} ${Math.floor(Date.parse(record.time) / 60_000)}m`]
      : [],
  )

/**
 * The run ended with `code` and its end record, with no PHASE_BUG logged and nothing left behind:
 * no fiber in a FiberSet of the run's, and no process group.
 */
const expectClean = (ran: Ran<Outcome>, code: number) => {
  expectExitCode(ran, code)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
  expect(ran.events.at(-1)).toMatchObject({ kind: "end", code })
}

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

const settledLine = (id: string) => `  ${id} settled: its worker is idle`

const notesOf = (ran: Ran<unknown>, id: string) =>
  ran.issues.find((issue) => issue.id === id)?.notes ?? ""

/** `text` as a pattern matching it literally. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

describe("several tickets at once", () => {
  test("the slots fill as the run starts, and each refills at once as its ticket ends", async () => {
    // Two at a time: a takes 10m; b ends at 1m, c starts then and ends at 3m, d starts then.
    const ran = await runs({
      backlog: backlog().ticket("a").ticket("b").ticket("c").ticket("d"),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { takes: "10 minutes" })],
        b: [works(world, places, "b", { takes: "1 minute" })],
        c: [works(world, places, "c", { takes: "2 minutes" })],
        d: [works(world, places, "d")],
      }),
      during: () => passes("11 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done", d: "Done" })
    for (const id of ["a", "b", "c", "d"]) expect(pathOf(ran, id)).toEqual(straight)
    // No ticket twice, and never more than two at once.
    expect(dispatches(ran)).toEqual(["a 0m", "b 0m", "c 1m", "d 3m"])
    // A ticket past its work takes no slot as it merges, so the next may dispatch before or after
    // it closes.
    expectLog(ran, [
      "START tutti 0.1.0-test",
      "[1] a dispatching: a",
      "[2] b dispatching: b",
      "[3] c dispatching: c",
      "[4] d dispatching: d",
      closedLine("a"),
      "  Completed 4 · Set aside 0 · Needs you 0",
      "READY_EMPTY after 4 tickets",
    ])
    expectLog(ran, [closedLine("b"), closedLine("c"), closedLine("d")])
    expectLog(ran, [closedLine("b"), "[4] d dispatching: d", closedLine("d")])
    expectEvents(ran, [
      "dispatch",
      "dispatch",
      "dispatch",
      "dispatch",
      "closed",
      "closed",
      "done",
      "end",
    ])
    expect(ran.events.filter((record) => record.kind === "closed")).toHaveLength(4)
  }, 30_000)

  test("the ready poll every 30 s gives a free slot to a ticket that became ready meanwhile", async () => {
    // b is deferred until 1m10s: the poll at 1m30s finds it ready.
    let atOneMinute: ReadonlyArray<string> = []
    const ran = await runs({
      backlog: backlog()
        .ticket("a")
        .ticket("b", { status: "deferred", deferUntil: at(70_000) }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { takes: "3 minutes" })],
        b: [works(world, places, "b")],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* passes("1 minute")
          atOneMinute = yield* texts
          yield* passes("3 minutes")
        }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(atOneMinute.some((text) => text.includes("b dispatching"))).toBe(false)
    expect(dispatches(ran)).toEqual(["a 0m", "b 1m"])
    const b = ran.events.find((r) => r.kind === "dispatch" && r.ticket === "b")
    expect(Date.parse(b?.time ?? "")).toBeGreaterThanOrEqual(90_000)
    expect(pathOf(ran, "b")).toEqual(straight)
    expectLog(ran, [
      "[1] a dispatching: a",
      "[2] b dispatching: b",
      closedLine("b"),
      closedLine("a"),
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "closed", "done", "end"])
  }, 30_000)
})

describe("footprints", () => {
  test("a ticket touching a running one's file is skipped for the next, and runs once it ends", async () => {
    // Three slots: the third stays empty while b overlaps a.
    const ran = await runs({
      settings: () => ({ concurrent: 3 }),
      backlog: backlog()
        .ticket("a", { priority: 0, ...touching("src/a.ts") })
        .ticket("b", { priority: 1, ...touching("src/a.ts") })
        .ticket("c", { priority: 2, ...touching("src/c.ts") }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { takes: "2 minutes", files: { "src/a.ts": "a2\n" } })],
        b: [works(world, places, "b")],
        c: [works(world, places, "c", { takes: "5 minutes" })],
      }),
      during: () => passes("6 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expect(pathOf(ran, "b")).toEqual(heldThenStraight)
    expect(heldFor(ran, "b")).toEqual(["overlap"])
    expect(dispatches(ran)).toEqual(["a 0m", "c 0m", "b 2m"])
    // Said once, though each fill and poll meanwhile looks again.
    expect(ran.log.filter((text) => text.startsWith("  skipping"))).toEqual([
      "  skipping b: touches src/a.ts, like running a",
    ])
    expectLog(ran, [
      "[1] a dispatching: a",
      "  skipping b: touches src/a.ts, like running a",
      "[2] c dispatching: c",
      settledLine("a"),
      "[3] b dispatching: b",
      closedLine("b"),
      closedLine("c"),
      "READY_EMPTY after 3 tickets",
    ])
    // b is held back as c takes the second slot, and released as a merges.
    expectEvents(ran, [
      "dispatch",
      "dispatch",
      "queue",
      "closed",
      "queue",
      "dispatch",
      "closed",
      "closed",
      "done",
      "end",
    ])
  }, 30_000)

  test("a running ticket's footprint grows with the files its worktree changed", async () => {
    // a names src/a.ts but edits src/b.ts; b, naming src/b.ts, becomes ready at 1m, while a runs.
    const ran = await runs({
      backlog: backlog()
        .ticket("a", { priority: 0, ...touching("src/a.ts") })
        .ticket("b", {
          priority: 1,
          status: "deferred",
          deferUntil: at(60_000),
          ...touching("src/b.ts"),
        }),
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", {
            first: [
              ...bash(
                "edit src/b.ts",
                orDie(world.repository.write(join(places.root, "a"), { "src/b.ts": "b2\n" })),
              ),
              sleep("3 minutes"),
            ],
            files: { "src/a.ts": "a2\n" },
          }),
        ],
        b: [works(world, places, "b")],
      }),
      during: () => passes("4 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(pathOf(ran, "b")).toEqual(heldThenStraight)
    expect(heldFor(ran, "b")).toEqual(["overlap"])
    expect(dispatches(ran)).toEqual(["a 0m", "b 3m"])
    // a, past its work, still holds b back until it merges.
    expectLog(ran, [
      "[1] a dispatching: a",
      "  skipping b: touches src/b.ts, like running a",
      settledLine("a"),
      closedLine("a"),
      "[2] b dispatching: b",
      closedLine("b"),
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "queue", "closed", "dispatch", "closed", "done", "end"])
  }, 30_000)
})

describe("solo", () => {
  test("a solo ticket next waits for the running ones, then runs alone, holding back the rest", async () => {
    const ran = await runs({
      backlog: backlog()
        .ticket("a", { priority: 0 })
        .ticket("s", { priority: 1, labels: ["solo"] })
        .ticket("c", { priority: 2 }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { takes: "2 minutes" })],
        s: [works(world, places, "s", { takes: "2 minutes" })],
        c: [works(world, places, "c")],
      }),
      during: () => passes("5 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", s: "Done", c: "Done" })
    // A slot is free from the start, but c doesn't take it: s isn't starved.
    expect(dispatches(ran)).toEqual(["a 0m", "s 2m", "c 4m"])
    expect(pathOf(ran, "s")).toEqual(heldThenStraight)
    expect(pathOf(ran, "c")).toEqual(heldThenStraight)
    expect(heldFor(ran, "s")).toEqual(["solo"])
    expect(heldFor(ran, "c")).toEqual(["solo"])
    expectLog(ran, [
      "[1] a dispatching: a",
      "  solo ticket s is next: no new tickets start until the running ones finish, then it runs alone",
      settledLine("a"),
      closedLine("a"),
      "[2] s dispatching solo: s",
      "  waiting for solo ticket s to finish",
      settledLine("s"),
      closedLine("s"),
      "[3] c dispatching: c",
      closedLine("c"),
      "READY_EMPTY after 3 tickets",
    ])
    // Each waits for the one before it to merge, not only for its worker.
    expectEvents(ran, ["dispatch", "closed", "dispatch", "closed", "dispatch", "closed", "end"])
    expect(ran.events.find((r) => r.kind === "dispatch" && r.ticket === "s")).toMatchObject({
      solo: { ticket: "s" },
    })
  }, 30_000)
})

describe("parents and epics", () => {
  test("a parent runs last, once its subtickets are closed and merged", async () => {
    const ran = await runs({
      backlog: backlog()
        .ticket("p", { priority: 0 })
        .ticket("p.1", { parent: "p", priority: 1 })
        .ticket("p.2", { parent: "p", priority: 1 }),
      scripts: (world, places) => ({
        p: [works(world, places, "p")],
        "p.1": [works(world, places, "p.1", { takes: "1 minute" })],
        "p.2": [works(world, places, "p.2", { takes: "2 minutes" })],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { p: "Done", "p.1": "Done", "p.2": "Done" })
    expect(pathOf(ran, "p")).toEqual(heldThenStraight)
    expect(heldFor(ran, "p")).toEqual(["parent"])
    expect(dispatches(ran)).toEqual(["p.1 0m", "p.2 0m", "p 2m"])
    expectLog(ran, [
      "  p waits: its subtickets are not all closed and merged",
      "[1] p.1 dispatching: p.1",
      "[2] p.2 dispatching: p.2",
      closedLine("p.1"),
      closedLine("p.2"),
      "[3] p dispatching: p",
      closedLine("p"),
      "READY_EMPTY after 3 tickets",
    ])
    expect(ran.log.filter((text) => text.includes("p waits"))).toHaveLength(1)
    expectEvents(ran, ["dispatch", "dispatch", "closed", "closed", "dispatch", "closed", "end"])
  }, 30_000)

  test("epics are never dispatched, and close up the tree as their last subticket merges", async () => {
    // e holds e.2 and the epic e.1, which holds e.1.1, the last to merge.
    const ran = await runs({
      backlog: backlog().epic("e", ["e.2"]).epic("e.1", ["e.1.1"], { parent: "e" }),
      scripts: (world, places) => ({
        "e.2": [works(world, places, "e.2", { takes: "1 minute" })],
        "e.1.1": [works(world, places, "e.1.1", { takes: "2 minutes" })],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { "e.2": "Done", "e.1.1": "Done" })
    expectLog(ran, [
      "[1] e.2 dispatching: e.2",
      "[2] e.1.1 dispatching: e.1.1",
      closedLine("e.2"),
      closedLine("e.1.1"),
      "  closed epic e.1: its 1 subticket is merged",
      "  closed epic e: all 2 subtickets are merged",
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "closed", "info", "info", "done", "end"])
    const closed = (id: string) => ran.issues.find((issue) => issue.id === id)
    expect(closed("e.1")).toMatchObject({
      status: "closed",
      closeReason: "Its 1 subticket is merged; closed by tutti after e.1.1",
    })
    expect(closed("e")).toMatchObject({
      status: "closed",
      closeReason: "All 2 subtickets are merged; closed by tutti after e.1.1",
    })
  }, 30_000)
})

describe("blockers and follow-ups", () => {
  test("a blocked ticket and a follow-up wait for the ticket before them to merge, not to close", async () => {
    // a closes its ticket, then works on for 2m: bd ready lists b from then, but a isn't merged.
    const ran = await runs({
      backlog: backlog()
        .ticket("a", { priority: 0 })
        .ticket("b", { priority: 1, blockedBy: ["a"] })
        .ticket("f", { priority: 2, dependencies: [{ id: "a", type: "discovered-from" }] }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { last: [sleep("2 minutes")] })],
        b: [works(world, places, "b", { takes: "1 minute" })],
        f: [works(world, places, "f", { takes: "2 minutes" })],
      }),
      during: () => passes("5 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", f: "Done" })
    expect(dispatches(ran)).toEqual(["a 0m", "b 2m", "f 2m"])
    for (const id of ["b", "f"]) {
      expect(pathOf(ran, id)).toEqual(heldThenStraight)
      expect(heldFor(ran, id)).toEqual(["merge"])
    }
    expectLog(ran, [
      "[1] a dispatching: a",
      "  f waits: filed by a's worker; waiting for it to merge",
      "  b waits: waiting for a to merge",
      settledLine("a"),
      "  b waits: a closed but not merged (waiting to merge)",
      "  f waits: filed by a's worker; a closed but not merged (waiting to merge)",
      closedLine("a"),
      "[2] b dispatching: b",
      "[3] f dispatching: f",
      "READY_EMPTY after 3 tickets",
    ])
    expectEvents(ran, ["dispatch", "closed", "dispatch", "dispatch", "closed", "closed", "end"])
  }, 30_000)

  test("a follow-up its worker files is picked up by the ready poll, and waits for it to merge", async () => {
    // a files test-2, discovered from it, and works on for 2m.
    const ran = await runs({
      backlog: backlog().ticket("a"),
      filed: ["test-2"],
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", {
            first: [
              ...bash(
                'bd create --deps discovered-from:a --title "Follow-up"',
                orDie(world.beads.create({ title: "Follow-up", discoveredFrom: ["a"] })),
              ),
              sleep("2 minutes"),
            ],
          }),
        ],
        "test-2": [works(world, places, "test-2")],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", "test-2": "Done" })
    expect(pathOf(ran, "test-2")).toEqual(heldThenStraight)
    expect(dispatches(ran)).toEqual(["a 0m", "test-2 2m"])
    expectLog(ran, [
      "[1] a dispatching: a",
      "  test-2 waits: filed by a's worker; waiting for it to merge",
      settledLine("a"),
      "  test-2 waits: filed by a's worker; a closed but not merged (waiting to merge)",
      closedLine("a"),
      "[2] test-2 dispatching: Follow-up",
      closedLine("test-2"),
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "queue", "closed", "dispatch", "closed", "done", "end"])
  }, 30_000)
})

describe("waits for merge", () => {
  test("a ticket that started too early goes back in the queue, and counts once", async () => {
    // b's worker finds it needs a's work, links a as its blocker and stops with nothing done.
    const ran = await runs({
      backlog: backlog().ticket("a", { priority: 0 }).ticket("b", { priority: 1 }),
      limit: 2,
      scripts: (world, places) => ({
        a: [works(world, places, "a", { takes: "3 minutes" })],
        b: [needs(world, "b", "a"), works(world, places, "b")],
      }),
      during: () => passes("4 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(pathOf(ran, "b")).toEqual([
      "Queued",
      "Working",
      "Waiting",
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expect(dispatches(ran)).toEqual(["a 0m", "b 0m", "b 3m"])
    expectLog(ran, [
      "[1/2] a dispatching: a",
      "[2/2] b dispatching: b",
      settledLine("b"),
      "  WAITS_FOR_MERGE: b waits for a to merge; its worker stopped with nothing done, so it is back in the queue until it does; worktree and branch removed",
      closedLine("a"),
      "  b: a merged; back in the queue",
      // It counts toward --limit once, as it starts again.
      "[2/2] b dispatching: b",
      closedLine("b"),
      "LIMIT_REACHED at 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "waits", "closed", "dispatch", "closed", "end"])
    expect(ran.events.find((r) => r.kind === "waits")).toMatchObject({ ticket: "b" })
    expect(ran.events.find((r) => r.kind === "phase" && r.to === "Waiting")).toMatchObject({
      ticket: "b",
      cause: "WaitsForMerge",
    })
    expect(notesOf(ran, "b")).toContain("started before a merged; back in the queue until it does")
    // Its worktree held nothing: removed, and made again as it started again.
    expect(ran.worktreeCalls.filter((call) => "id" in call && call.id === "b")).toEqual([
      { op: "prepare", id: "b" },
      { op: "remove", id: "b", force: false },
      { op: "prepare", id: "b" },
      { op: "remove", id: "b", force: false },
    ])
  }, 30_000)

  test("under --limit, its place goes to the next ready ticket until it starts again", async () => {
    // As orchestra's: b doesn't count toward --limit while it waits, so c starts in its place. a
    // closes without a commit and is left for review, so b never starts again.
    const ran = await runs({
      backlog: backlog()
        .ticket("a", { priority: 0 })
        .ticket("b", { priority: 1 })
        .ticket("c", { priority: 2 }),
      limit: 2,
      scripts: (world, places) => ({
        a: [closesUncommitted(world, places, "a", "1 minute")],
        b: [needs(world, "b", "a")],
        c: [works(world, places, "c", { takes: "2 minutes" })],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Review", b: "Waiting", c: "Done" })
    expect(pathOf(ran, "b")).toEqual(["Queued", "Working", "Waiting"])
    expect(dispatches(ran)).toEqual(["a 0m", "b 0m", "c 0m"])
    expectLog(ran, [
      "[1/2] a dispatching: a",
      "[2/2] b dispatching: b",
      /^ {2}WAITS_FOR_MERGE: b waits for a to merge; /,
      "[2/2] c dispatching: c",
      /^ {2}CLOSED_WITHOUT_COMMIT: no commit on tutti\/a names a; /,
      closedLine("c"),
      "LIMIT_REACHED at 2 tickets",
    ])
    expectEvents(ran, [
      "dispatch",
      "dispatch",
      "waits",
      "dispatch",
      "warn",
      "closed",
      "done",
      "end",
    ])
  }, 30_000)
})

describe("--limit", () => {
  test("counts the tickets the run starts, and the run ends LIMIT_REACHED, exit 0", async () => {
    const ran = await runs({
      backlog: backlog().ticket("a").ticket("b").ticket("c"),
      limit: 2,
      settings: () => ({ concurrent: 1 }),
      scripts: (world, places) => ({
        a: [works(world, places, "a")],
        b: [works(world, places, "b")],
      }),
    })
    expectClean(ran, 0)
    // c was queued, and never started.
    expectPhases(ran, { a: "Done", b: "Done", c: "Queued" })
    expect(pathOf(ran, "c")).toEqual(["Queued"])
    // a frees its slot as it goes to merge: b may start before a has merged, or after.
    expectLog(ran, [
      "[1/2] a dispatching: a",
      "[2/2] b dispatching: b",
      closedLine("b"),
      "LIMIT_REACHED at 2 tickets",
    ])
    expect(ran.log.filter((text) => closedLine("a").test(text))).toHaveLength(1)
    expect(ran.log.some((text) => text.includes("c dispatching"))).toBe(false)
    expectEvents(ran, ["dispatch", "closed", "closed", "done", "end"])
    expect(ran.events.filter((r) => r.kind === "dispatch")).toHaveLength(2)
    expect(ran.events.find((r) => r.kind === "done")).toMatchObject({
      text: "LIMIT_REACHED at 2 tickets",
    })
  })
})

describe("the scope", () => {
  test("--ticket runs that ticket's subtickets only: SCOPE_DONE, tutti closing its epic", async () => {
    const ran = await runs({
      backlog: backlog().epic("e", ["e.1", "e.2"]).ticket("other"),
      ticket: "e",
      scripts: (world, places) => ({
        "e.1": [works(world, places, "e.1", { takes: "1 minute" })],
        "e.2": [works(world, places, "e.2", { takes: "2 minutes" })],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { "e.1": "Done", "e.2": "Done" })
    expect(ran.log.some((text) => text.includes("other"))).toBe(false)
    expectLog(ran, [
      "[1] e.1 dispatching: e.1",
      "[2] e.2 dispatching: e.2",
      closedLine("e.1"),
      closedLine("e.2"),
      "  closed epic e: all 2 subtickets are merged",
      /^tutti 0\.1\.0-test on main · ticket e · /,
      "READY_EMPTY after 2 tickets; SCOPE_DONE: e's 2 subtickets are merged; tutti closed e",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "closed", "info", "done", "end"])
  })

  test("SCOPE_OPEN names each subticket not done and why, and exits 0", async () => {
    // e.2 waits on x, outside the scope; e.3's worker defers it.
    const ran = await runs({
      backlog: backlog()
        .ticket("x")
        .epic("e", ["e.1"])
        .ticket("e.2", { parent: "e", blockedBy: ["x"] })
        .ticket("e.3", { parent: "e" }),
      ticket: "e",
      scripts: (world, places) => ({
        "e.1": [works(world, places, "e.1", { takes: "2 minutes" })],
        "e.3": [defers(world, "e.3", "1 minute")],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { "e.1": "Done", "e.3": "Deferred" })
    expect(pathOf(ran, "e.3")).toEqual(["Queued", "Working", "Deferred"])
    expectLog(ran, [
      "[1] e.1 dispatching: e.1",
      "[2] e.3 dispatching: e.3",
      "  e.3 deferred by its worker; nothing done, so its worktree and branch are removed",
      closedLine("e.1"),
      "READY_EMPTY after 2 tickets; SCOPE_OPEN: e: 2 of its 3 subtickets not done: e.3 (set aside in this run), e.2 (blocked by x outside the scope)",
    ])
    expect(ran.log.some((text) => text.includes("x dispatching"))).toBe(false)
    expectEvents(ran, ["dispatch", "dispatch", "deferred", "closed", "done", "end"])
  })
})

describe("set aside and review", () => {
  test("tickets deferred or left for review don't stop the run, which ends READY_EMPTY", async () => {
    const ran = await runs({
      backlog: backlog().ticket("a").ticket("b").ticket("c"),
      settings: () => ({ concurrent: 3 }),
      scripts: (world, places) => ({
        a: [defers(world, "a")],
        b: [closesUncommitted(world, places, "b", "1 minute")],
        c: [works(world, places, "c", { takes: "2 minutes" })],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Deferred", b: "Review", c: "Done" })
    expect(pathOf(ran, "a")).toEqual(["Queued", "Working", "Deferred"])
    expect(pathOf(ran, "b")).toEqual(["Queued", "Working", "Review"])
    expectLog(ran, [
      "  a deferred by its worker; nothing done, so its worktree and branch are removed",
      /^ {2}CLOSED_WITHOUT_COMMIT: no commit on tutti\/b names b; worktree .*\/b left for review$/,
      closedLine("c"),
      "  b is closed but not merged, labelled 'unmerged': tickets it blocks wait until tutti/b is merged into main, in later runs too",
      "  Completed 1 · Set aside 2 · Needs you 0",
      /^ {2}↷ a deferred: /,
      /^ {2}! b review: /,
      "READY_EMPTY after 3 tickets",
    ])
    expectEvents(ran, ["deferred", "warn", "closed", "done", "end"])
    expect(ran.events.find((r) => r.kind === "warn")).toMatchObject({ ticket: "b", aside: true })
    expect(ran.events.find((r) => r.kind === "phase" && r.to === "Review")).toMatchObject({
      ticket: "b",
      why: "CLOSED_WITHOUT_COMMIT",
    })
  })
})

describe("recheck", () => {
  test("a ticket set aside for a failed check is checked once more after the base moves on", async () => {
    // x lands at once; a's check fails on main at x; b lands at 2m, and a is checked again.
    const ran = await runs({
      backlog: backlog()
        .ticket("x", { priority: 0 })
        .ticket("a", { priority: 1 })
        .ticket("b", { priority: 2 }),
      settings: (settings) => ({ concurrent: 3, ...noHandBacks(settings) }),
      checks: { fast: [passed("fast"), fails()] },
      scripts: (world, places) => ({
        x: [works(world, places, "x")],
        a: [works(world, places, "a", { takes: "1 minute" })],
        b: [works(world, places, "b", { takes: "2 minutes" })],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { x: "Done", a: "Done", b: "Done" })
    expect(pathOf(ran, "a")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Review",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expectLog(ran, [
      closedLine("x"),
      /^ {2}CHECKS_FAILED: a closed, but 'scripts\/check-fast\.sh' fails on tutti\/a rebased onto main; worktree .*\/a left for review \(output is in .*\/a\/\.tutti\/run\/check\.log\); checked once more if main moves on in this run$/,
      closedLine("b"),
      /^ {2}RECHECK: a's check failed on main at [0-9a-f]{7}, which has moved on since; rebasing tutti\/a and checking it once more$/,
      closedLine("a"),
      "READY_EMPTY after 3 tickets",
    ])
    expectEvents(ran, ["warn", "closed", "info", "closed", "done", "end"])
    expect(ran.events.find((r) => r.kind === "phase" && r.to === "Review")).toMatchObject({
      ticket: "a",
      why: "CHECKS_FAILED",
    })
    // a was checked twice, b once, and x once, on top of main.
    expect(ran.checkRuns.map((each) => each.cwd)).toEqual([
      join(ran.root, "x"),
      join(ran.root, "a"),
      join(ran.root, "b"),
      join(ran.root, "a"),
    ])
  }, 30_000)
})

describe("unmerged at the end", () => {
  test("a ticket closed and not merged is labelled, and the ticket it blocks waits for it", async () => {
    // b's check fails on main at x and nothing lands after it, so it isn't checked again.
    const ran = await runs({
      backlog: backlog()
        .ticket("x", { priority: 0 })
        .ticket("b", { priority: 1 })
        .ticket("c", { priority: 2, blockedBy: ["b"] }),
      settings: noHandBacks,
      checks: { fast: [passed("fast"), fails()] },
      scripts: (world, places) => ({
        x: [works(world, places, "x", { takes: "1 minute" })],
        b: [works(world, places, "b", { takes: "2 minutes" })],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { x: "Done", b: "Review", c: "HeldBack" })
    expect(pathOf(ran, "c")).toEqual(["Queued", "HeldBack"])
    expectLog(ran, [
      closedLine("x"),
      "  c waits: b closed but not merged (waiting to merge)",
      /^ {2}CHECKS_FAILED: b closed, but /,
      "  c waits: b closed but not merged (CHECKS_FAILED)",
      "  b is closed but not merged, labelled 'unmerged': tickets it blocks wait until tutti/b is merged into main, in later runs too",
      "READY_EMPTY after 2 tickets",
    ])
    expect(ran.log.some((text) => text.includes("c dispatching"))).toBe(false)
    expectEvents(ran, ["dispatch", "dispatch", "closed", "warn", "info", "done", "end"])
    const b = ran.issues.find((issue) => issue.id === "b")
    expect(b?.labels).toEqual(["unmerged"])
    // Where its branch was cut, so a later run knows a merge by hand from older commits.
    expect(b?.metadata.unmerged_fork).toMatch(/^[0-9a-f]{40}$/)
  }, 30_000)
})

describe("stopping drains", () => {
  test("a stop holds the run: nothing new starts, the running ticket finishes and merges", async () => {
    const ran = await runs({
      backlog: backlog()
        .ticket("a", { priority: 0 })
        .ticket("b", { priority: 1 })
        .ticket("c", { priority: 2 }),
      scripts: (world, places) => ({
        a: isGoneTwice(world, "a", "1 minute"),
        b: [works(world, places, "b", { takes: "5 minutes" })],
      }),
      during: () => passes("6 minutes"),
    })
    expectClean(ran, 3)
    expectPhases(ran, { a: "Stopped", b: "Done", c: "Queued" })
    expect(pathOf(ran, "a")).toEqual(["Queued", "Working", "Stopped"])
    const paused = literally(
      "PAUSED: a still in_progress, its worker is gone (exit 1); its session was resumed once in this run already, and the next run resumes it again",
    )
    expectLog(ran, [
      "[1] a dispatching: a",
      "[2] b dispatching: b",
      new RegExp(
        `^HOLD: ${paused} \\(worktree .*/a\\); stopping so it can be answered; no new tickets while the 1 running finish$`,
      ),
      closedLine("b"),
      "  Completed 1 · Set aside 0 · Needs you 0",
      new RegExp(`^${paused} \\(worktree .*/a\\); stopping so it can be answered$`),
    ])
    expect(ran.log.some((text) => text.includes("c dispatching"))).toBe(false)
    expectEvents(ran, ["dispatch", "dispatch", "resumed", "stop", "hold", "closed", "end"])
    expect(ran.events.filter((r) => r.kind === "stop")).toEqual([
      expect.objectContaining({ detail: "PAUSED", ticket: "a" }),
    ])
    expect(ran.events.find((r) => r.kind === "hold")).toMatchObject({ ticket: "a" })
    expect(ran.events.find((r) => r.kind === "suspended")).toMatchObject({
      ticket: "a",
      why: "PAUSED",
    })
  }, 30_000)

  test("winding down: nothing new starts, the running tickets finish, DRAINED, exit 0", async () => {
    const drains = Effect.runSync(Queue.unbounded<DrainRequest>())
    const ran = await runs({
      backlog: backlog().ticket("a").ticket("b").ticket("c"),
      drains,
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", {
            first: [
              sleep("1 minute"),
              step(Effect.asVoid(Queue.offer(drains, { on: true, how: "by SIGUSR1" }))),
            ],
          }),
        ],
        b: [works(world, places, "b", { takes: "2 minutes" })],
      }),
      during: () => passes("3 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Queued" })
    expectLog(ran, [
      "[1] a dispatching: a",
      "[2] b dispatching: b",
      "DRAIN: stopping after the 2 running tickets finish (a, b): no new tickets will start, asked by SIGUSR1",
      closedLine("a"),
      closedLine("b"),
      "DRAINED after 2 tickets",
    ])
    expect(ran.log.some((text) => text.includes("c dispatching"))).toBe(false)
    expectEvents(ran, ["dispatch", "dispatch", "drain", "closed", "closed", "done", "end"])
  }, 30_000)
})

describe("nothing to run", () => {
  /** A console keeping what is printed to it. */
  const capturing = () => {
    const printed: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    })
    return { printed, console }
  }

  /**
   * What main does before the run's loop: it reads the tickets left unmerged and the workers the
   * last run left, then checks for something to run, and ends with exit 0 when there is none.
   */
  const starts = async (seeds: BacklogBuilder, state?: State) => {
    const repo = folder("repo")
    const { printed, console } = capturing()
    const ran = await scenario(
      {
        config: { repo },
        backlog: seeds.seeds,
        git: { dir: repo },
        ...(state === undefined ? {} : { state }),
      },
      Effect.gen(function* () {
        const unmerged = yield* stillUnmerged({ repo, base: "main" })
        const exitCode = yield* endIfNothing(
          {
            scope: null,
            filter: { excludeTypes: ["epic"] },
            repo,
            base: "main",
            carried: yield* carriedTickets,
            unmerged,
            held: heldAtStart(yield* Beads, unmerged),
          },
          { _tag: "Plain" },
        )
        return { exitCode, records: yield* (yield* Captured).records }
      }).pipe(Effect.provideService(Console.Console, console)),
    )
    if (ran.exit._tag === "Failure") throw new Error(`the check failed: ${ran.exit.cause}`)
    const time = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d /
    return {
      ...ran.exit.value,
      log: ran.log,
      printed: printed.map((each) => each.replace(time, "")),
    }
  }

  test("everything closed is all done: the run says so and ends, its epics left to close", async () => {
    const ran = await starts(
      backlog()
        .epic("e", [])
        .ticket("e.1", { parent: "e", status: "closed" })
        .ticket("k", { status: "closed" }),
    )
    // The run ends there, exit 0, without its loop.
    expect(ran.exitCode).toBe(0)
    expect(ran.printed).toEqual(["✓ All done", "  Still open: e (bd close e)"])
    expect(ran.log).toEqual(["READY_EMPTY after 0 tickets: everything is done"])
    expect(ran.records).toEqual([
      expect.objectContaining({ kind: "done" }),
      expect.objectContaining({ kind: "end", code: 0 }),
    ])
  })

  test("every ready ticket held back: nothing ready, each hold with its count", async () => {
    // u, left unmerged by an earlier run, holds back its parent, the ticket it blocks and the
    // follow-up filed from it, all of which bd ready lists.
    const ran = await starts(
      backlog()
        .ticket("p")
        .ticket("u", { parent: "p", status: "closed", labels: ["unmerged"] })
        .ticket("b", { blockedBy: ["u"] })
        .ticket("f", { dependencies: [{ id: "u", type: "discovered-from" }] }),
    )
    expect(ran.exitCode).toBe(0)
    expect(ran.printed).toEqual([
      "○ Nothing ready to run",
      "  1 ticket waits for its subtickets to merge",
      "  1 ticket waits for its blocker to merge",
      "  1 follow-up waits for the ticket it was filed from to merge",
      "  1 closed but not merged: bd list --label unmerged",
    ])
    expect(ran.log).toEqual(["READY_EMPTY after 0 tickets: nothing ready"])
    expect(ran.records).toEqual([
      expect.objectContaining({ kind: "done", text: "READY_EMPTY after 0 tickets: nothing ready" }),
      expect.objectContaining({ kind: "end", code: 0 }),
    ])
  })

  test("a ticket a run would start, or a worker the last run left, is something to run", async () => {
    const ready = await starts(backlog().ticket("k"))
    // The run goes on to its loop: no exit code yet, and nothing said.
    expect(ready.exitCode).toBeNull()
    expect(ready.records).toEqual([])
    const left: TicketRecord = {
      session: "session-k",
      worktree: "/worktrees/k",
      branch: "tutti/k",
      suspended: "quit",
      phase: "Stopped",
      resumes: 0,
      metadata: {},
    }
    const carried = await starts(backlog().ticket("k", { status: "in_progress" }), {
      version: stateVersion,
      tickets: { k: left },
    })
    expect(carried.exitCode).toBeNull()
    expect(carried.printed).toEqual([])
    expect(carried.log).toEqual([])
  })
})
