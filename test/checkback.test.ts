import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { type CheckStop, fixPrompt, times } from "../src/run/checkback.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type PhaseTag, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed, CheckTimedOut } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  init,
  result,
  run,
  type SessionScript,
  sessionState,
  sleep,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Files } from "../src/testing/Git.ts"
import { Repository } from "../src/testing/Git.ts"
import {
  advance,
  backlog,
  type Env,
  expectLog,
  type Ran,
  type Scripts,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const check = "scripts/check-fast.sh"

/** The default settings with a check command, `merge` laid over the default merge settings. */
const defaults = appConfig().settings
const withCheck = (merge: Partial<typeof defaults.merge> = {}) =>
  ({
    config: {
      settings: {
        ...defaults,
        checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        merge: { ...defaults.merge, ...merge },
      },
    },
  }) satisfies Setup

/** A failing check, its lines saying what failed. */
const failing = (said = "error: a.test.ts: expected 1") =>
  new CheckFailed({
    check: "fast",
    command: check,
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: [said],
    lastLines: ["1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phasesOf = (state: State): Record<string, TicketPhase> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** The `phase` records of the ticket's moves into Fixing. */
const fixingRecords = (ran: Ran<unknown>, id = "a") =>
  ran.events.filter(
    (record) => record.kind === "phase" && record.ticket === id && record.to === "Fixing",
  )

/** Waits until the ticket is in `tag`. */
const until = (id: string, tag: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) => state.tickets.get(id)?.phase._tag === tag),
      Stream.runHead,
    )
  })

/** The ticket's phase once it is in `tag`. */
const phaseIn = (id: string, tag: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const found = yield* ledger.changes.pipe(
      Stream.map((state) => state.tickets.get(id)?.phase),
      Stream.filter((phase) => phase?._tag === tag),
      Stream.runHead,
    )
    return found._tag === "Some" ? found.value : undefined
  })

/** Where the ticket's worktree is, once `finished` has made it: for its worker's script. */
const worktrees = new Map<string, string>()
const worktreeOf = (id: string) => worktrees.get(id) ?? ""

/** The worker's first session: it finished its ticket, idle, then plays `then`. */
const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

/** The worker committing `files` in its worktree, its commit message `message`. */
const committing = (world: World, id: string, message: string, files: Files) =>
  run(Effect.suspend(() => Effect.asVoid(world.repository.commit(worktreeOf(id), message, files))))

/** A hand-back turn in which the worker commits a fix naming the ticket. */
const fixes = (world: World, id: string, files: Files = { "fix.txt": "fixed\n" }) =>
  turn([committing(world, id, `Fix the check (${id})`, files)])

/** A hand-back turn in which the worker resolves the rebase's conflict, writing `files`. */
const resolves = (world: World, id: string, files: Files) =>
  turn([
    run(
      Effect.suspend(() => Effect.asVoid(world.repository.continueRebase(worktreeOf(id), files))),
    ),
  ])

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads,
 * Working in the ledger, its session started and saved, and its worker idle.
 */
const finished = (id: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const host = yield* AgentHost
    const worktree = yield* (yield* Worktrees).prepare(id)
    worktrees.set(id, worktree.path)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
    const sessionId = `session-${id}`
    yield* (yield* Store).saveSession(id, {
      session: sessionId,
      worktree: worktree.path,
      branch: worktree.branch,
    })
    yield* host.start(id, { sessionId, cwd: worktree.path })
    yield* untilSettled(id)
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Another ticket's merge, landing on main while the ticket ran. */
const moveMain = (files: Files = { "b.txt": "b\n" }) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

/** Runs `body` with a merge queue in a scope of its own, and hands back each ticket's phase. */
const withQueue = <E>(
  body: (queue: MergeQueue) => Effect.Effect<void, E, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const queue = yield* makeQueue(options)
    yield* body(queue)
    return phasesOf(yield* (yield* Ledger).current)
  }).pipe(Effect.provide(Ledger.layer))

/**
 * Finishes ticket a (a.txt), moves main on (with `landed`), runs `before`, offers it to the queue
 * and waits until the queue settles, `during` running beside it, then runs `after`.
 */
const merged = (
  setup: Setup,
  scripts: (world: World) => Scripts,
  hooks: {
    readonly landed?: Files
    readonly before?: Effect.Effect<void, unknown, Env | Ledger>
    readonly during?: Effect.Effect<void, unknown, Env | Ledger>
    readonly after?: (ticket: FinishedTicket) => Effect.Effect<void, unknown, Env | Ledger>
  } = {},
) =>
  scenario(
    { backlog: backlog().ticket("a").seeds, ...setup, scripts },
    withQueue((queue) =>
      Effect.gen(function* () {
        const ticket = yield* finished("a", { "a.txt": "a\n" })
        yield* moveMain(hooks.landed)
        yield* hooks.before ?? Effect.void
        const during = yield* Effect.forkChild(hooks.during ?? Effect.void)
        yield* queue.offer(ticket)
        yield* queue.settled
        yield* Fiber.join(during)
        yield* hooks.after?.(ticket) ?? Effect.void
      }),
    ),
  )

/** The client_composed messages ticket a's worker was sent. */
const composed = (ran: Ran<unknown>) =>
  ran.sent.flatMap((item) =>
    item._tag === "Message" && item.ticket === "a" && item.message.client_composed === true
      ? [item.message.message.content as string]
      : [],
  )

const fixingLine = (attempt: number) =>
  `  FIXING: '${check}' fails on tutti/a rebased onto main; handed back to its worker to fix (${attempt} of 2, up to 20m)`

describe("a fix accepted", () => {
  test("on the first attempt: Merging → Fixing → ToMerge → Done, the fix merged", async () => {
    let files: ReadonlyMap<string, string> = new Map()
    const ran = await merged(
      { ...withCheck(), checks: { fast: [failing()] } },
      (world) => ({ a: [finishedSession(fixes(world, "a"))] }),
      {
        after: () =>
          Effect.gen(function* () {
            files = yield* (yield* Repository).tree("main")
          }),
      },
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(pathOf(ran, "a")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Fixing",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expect(fixingRecords(ran)).toEqual([
      expect.objectContaining({ cause: "CheckHandedBack", attempt: 1, from: "Merging" }),
    ])
    expectLog(ran, [
      "  rebased tutti/a onto main, which moved on while it ran",
      fixingLine(1),
      `  '${check}' passes on tutti/a as its worker fixed it`,
      /^ {2}a closed \([0-9a-f]{7} .*\); merged into main, worktree and branch removed$/,
    ])
    // The hand-back is orchestra's instructions, sent client_composed: what failed, what it said,
    // and what landed.
    const sent = composed(ran)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(
      `main moved on while you worked, and tutti/a was rebased onto it; now '${check}' fails on it.`,
    )
    expect(sent[0]).toContain("these lines say what failed:\nerror: a.test.ts: expected 1")
    expect(sent[0]).toMatch(/\n[0-9a-f]{7} Land something else\n/)
    expect(sent[0]).toContain("with a in the commit message")
    // The check ran twice in its worktree: as it failed, and on the fix.
    expect(ran.checkRuns.map((each) => each.cwd)).toEqual([worktreeOf("a"), worktreeOf("a")])
    expect(files.get("fix.txt")).toBe("fixed\n")
    // Its check records (§ 10): the merge check that failed, then the fix's.
    expect(
      ran.events.flatMap((r) => (r.kind === "check" ? [[r.suite, r.result, r.ticket]] : [])),
    ).toEqual([
      ["merge", "failed", "a"],
      ["fix", "passed", "a"],
    ])
  })

  test("after a resolution: Resolving → Fixing{afterResolution} → ToMerge → Done", async () => {
    let fixingPhase: TicketPhase | undefined
    const ran = await merged(
      { ...withCheck(), checks: { fast: [failing()] } },
      (world) => ({
        a: [
          finishedSession([...resolves(world, "a", { "a.txt": "both\n" }), ...fixes(world, "a")]),
        ],
      }),
      {
        landed: { "a.txt": "main's a\n" },
        during: Effect.gen(function* () {
          fixingPhase = yield* phaseIn("a", "Fixing")
        }),
      },
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(fixingPhase).toEqual(
      expect.objectContaining({ _tag: "Fixing", attempt: 1, afterResolution: true }),
    )
    expect(pathOf(ran, "a")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "Fixing",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expect(fixingRecords(ran)).toEqual([
      expect.objectContaining({ cause: "CheckHandedBack", attempt: 1, from: "Resolving" }),
    ])
    expectLog(ran, [
      /^ {2}RESOLVING: /,
      "  a's worker finished the rebase; checking it with 'scripts/check-fast.sh'",
      fixingLine(1),
      `  '${check}' passes on tutti/a as its worker fixed it`,
      /^ {2}a closed /,
    ])
    expect(composed(ran)).toHaveLength(2)
  })
})

describe("the attempts used up", () => {
  test("after check_hand_backs attempts: Fixing → Fixing → Review, the notes saying each", async () => {
    let tip = ""
    const ran = await merged(
      { ...withCheck(), checks: { fast: [failing(), failing(), failing()] } },
      (world) => ({
        a: [
          finishedSession([
            ...fixes(world, "a", { "fix.txt": "one\n" }),
            ...fixes(world, "a", { "fix.txt": "two\n" }),
          ]),
        ],
      }),
      {
        after: (ticket) =>
          Effect.gen(function* () {
            tip = yield* (yield* Repository).head(ticket.branch)
          }),
      },
    )
    expect(resultOf(ran).a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expect(pathOf(ran, "a").slice(-4)).toEqual(["Merging", "Fixing", "Fixing", "Review"])
    expect(fixingRecords(ran).map((record) => record.kind === "phase" && record.attempt)).toEqual([
      1, 2,
    ])
    expect(composed(ran)).toHaveLength(2)
    expectLog(ran, [
      fixingLine(1),
      fixingLine(2),
      new RegExp(
        `^ {2}CHECKS_FAILED: a closed, but '${check}' fails on tutti/a rebased onto main, after it was handed back to its worker to fix twice \\(see its notes\\); worktree ${worktreeOf("a")} left for review`,
      ),
    ])
    const notes = ran.issues.find((issue) => issue.id === "a")?.notes ?? ""
    expect(notes).toContain(
      `it was handed back to its worker to fix twice: (1) its worker committed 1 commit, but '${check}' fails still`,
    )
    expect(notes).toContain("; (2) its worker committed 1 commit, but")
    expect(notes).toContain("not handed back again: it was handed back to its worker twice already")
    // The worker's fixes are kept: the check failed on them.
    expect(ran.checkRuns).toHaveLength(3)
    expect(tip).not.toBe("")
  })

  test("a fix rejected: Review, the branch reset to where the check failed", async () => {
    let failedAt = ""
    let tip = ""
    const ran = await merged(
      { ...withCheck(), checks: { fast: [failing()] } },
      (world) => ({
        a: [
          finishedSession(
            turn([committing(world, "a", "A fix naming nothing", { "fix.txt": "fixed\n" })]),
          ),
        ],
      }),
      {
        during: Effect.gen(function* () {
          yield* until("a", "Fixing")
          failedAt = yield* (yield* Repository).head("tutti/a")
        }),
        after: (ticket) =>
          Effect.gen(function* () {
            tip = yield* (yield* Repository).head(ticket.branch)
          }),
      },
    )
    expect(resultOf(ran).a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expect(pathOf(ran, "a").slice(-3)).toEqual(["Merging", "Fixing", "Review"])
    expect(tip).toBe(failedAt)
    const notes = ran.issues.find((issue) => issue.id === "a")?.notes ?? ""
    expect(notes).toMatch(
      new RegExp(
        `\\(1\\) its worker's commit [0-9a-f]{10} does not name a; tutti/a was reset to ${failedAt.slice(0, 10)}, where the check failed`,
      ),
    )
    // Nothing more is checked or handed back.
    expect(ran.checkRuns).toHaveLength(1)
    expect(composed(ran)).toHaveLength(1)
  })

  test("a fix not done within resolve_timeout: Review", async () => {
    const ran = await merged(
      { ...withCheck(), checks: { fast: [failing()] } },
      () => ({ a: [finishedSession([wait, init(), sessionState("running"), sleep("2 hours")])] }),
      {
        during: Effect.gen(function* () {
          yield* until("a", "Fixing")
          yield* advance("20 minutes")
        }),
      },
    )
    expect(resultOf(ran).a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    const notes = ran.issues.find((issue) => issue.id === "a")?.notes ?? ""
    expect(notes).toContain("(1) its worker is working after 20m, with the hand-back not done")
  })

  test("after a resolution, attempts used up: Fixing{afterResolution} → Blocked, branch put back", async () => {
    let closedAt = ""
    let tip = ""
    const ran = await merged(
      { ...withCheck({ check_hand_backs: 1 }), checks: { fast: [failing(), failing()] } },
      (world) => ({
        a: [
          finishedSession([...resolves(world, "a", { "a.txt": "both\n" }), ...fixes(world, "a")]),
        ],
      }),
      {
        landed: { "a.txt": "main's a\n" },
        before: Effect.gen(function* () {
          closedAt = yield* (yield* Repository).head("tutti/a")
        }),
        after: (ticket) =>
          Effect.gen(function* () {
            tip = yield* (yield* Repository).head(ticket.branch)
          }),
      },
    )
    expect(resultOf(ran).a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(pathOf(ran, "a").slice(-3)).toEqual(["Resolving", "Fixing", "Blocked"])
    expect(tip).toBe(closedAt)
    expectLog(ran, [
      `  FIXING: '${check}' fails on tutti/a rebased onto main; handed back to its worker to fix (1 of 1, up to 20m)`,
      new RegExp(
        `^ {2}MERGE_CONFLICT: .*\\(handed back to its worker, but '${check}' fails on the resolved tutti/a \\(output is in .*\\), and was handed back to its worker to fix once: \\(1\\) its worker committed 1 commit, but .*; not handed back again: it was handed back to its worker once already; tutti/a was reset to ${closedAt.slice(0, 10)}, where it was before the rebase`,
      ),
    ])
  })
})

describe("a failure not handed back", () => {
  test("a timed-out check: Review at once, the line saying why", async () => {
    const timedOut = new CheckTimedOut({
      check: "fast",
      command: check,
      timeLimit: Duration.minutes(15),
      outputFile: "/dev/fd/9",
      failingLines: [],
      lastLines: [],
      suites: [],
      suite: null,
      flaky: [],
      flakyCount: 0,
    })
    const ran = await merged({ ...withCheck(), checks: { fast: [timedOut] } }, () => ({
      a: [finishedSession()],
    }))
    expect(resultOf(ran).a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expect(pathOf(ran, "a").slice(-2)).toEqual(["Merging", "Review"])
    expect(composed(ran)).toEqual([])
    expectLog(ran, [
      new RegExp(
        `^ {2}CHECKS_FAILED: a closed, but '${check}' did not finish within 15m on tutti/a rebased onto main; not handed back to its worker: it did not finish, so there is no failure to show its worker; worktree `,
      ),
    ])
  })

  test("with check_hand_backs 0: Review, as before hand-backs", async () => {
    const ran = await merged(
      { ...withCheck({ check_hand_backs: 0 }), checks: { fast: [failing()] } },
      () => ({ a: [finishedSession()] }),
    )
    expect(resultOf(ran).a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expect(composed(ran)).toEqual([])
    expectLog(ran, [
      new RegExp(
        `^ {2}CHECKS_FAILED: a closed, but '${check}' fails on tutti/a rebased onto main; worktree `,
      ),
    ])
  })

  test("while the run winds down: Review, the line saying why", async () => {
    const ran = await merged(
      { ...withCheck(), checks: { fast: [failing()] } },
      () => ({ a: [finishedSession()] }),
      {
        before: Effect.gen(function* () {
          yield* (yield* Ledger).windDown
        }),
      },
    )
    expect(resultOf(ran).a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expect(composed(ran)).toEqual([])
    expectLog(ran, [/; not handed back to its worker: the run is winding down; worktree /])
  })
})

describe("the prompt", () => {
  const stop: CheckStop = {
    ticket: { id: "a", title: "A", branch: "tutti/a", worktree: "/w/a" },
    onto: "1111111111",
    fork: "0000000000",
    head: "2222222222",
    at: "3333333333",
    error: failing(),
    output: "/w/a/.tutti/run/check.log",
  }

  test("names what failed, where its output is, what landed and what to run, as orchestra's does", () => {
    const prompt = fixPrompt(stop, "main", check, [
      { hash: "4444444444", subject: "Land b", message: "Land b" },
    ])
    expect(prompt).toStartWith(
      `tutti: main moved on while you worked, and tutti/a was rebased onto it; now '${check}' fails on it. Its whole output is in /w/a/.tutti/run/check.log; these lines say what failed:\nerror: a.test.ts: expected 1\n\n`,
    )
    expect(prompt).toContain(
      "What landed on main since your branch was cut (git log --oneline 2222222..1111111):\n4444444 Land b\n\n",
    )
    expect(prompt).toContain(
      "Run what failed (the tests or other checks the output names) and the tests of the code you changed in the foreground until they pass, then commit the fix on tutti/a with a in the commit message. ",
    )
    expect(prompt).toContain(
      `Leave the whole check, '${check}', to tutti: it runs it on the branch next.`,
    )
    expect(prompt).not.toContain("until it passes")
    expect(prompt).toEndWith(
      "If what failed passes without a change, the failure not coming from tutti/a, commit nothing and say DONE: tutti runs the check again.",
    )
  })

  test("lists at most 30 of what landed", () => {
    const landed = Array.from({ length: 32 }, (_, i) => ({
      hash: `${i}`.padStart(10, "0"),
      subject: `Land ${i}`,
      message: `Land ${i}`,
    }))
    const prompt = fixPrompt(stop, "main", check, landed)
    expect(prompt).toContain("Land 29\n… and 2 more\n\n")
    expect(prompt).not.toContain("Land 30")
    expect(fixPrompt(stop, "main", check, undefined)).toContain("(git could not list them)")
  })

  test("says how many times, as orchestra does", () => {
    expect([1, 2, 3].map(times)).toEqual(["once", "twice", "3 times"])
  })
})
