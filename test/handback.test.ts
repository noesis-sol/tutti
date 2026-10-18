import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { maxHandBacks, type RebaseStop, resolvePrompt } from "../src/run/handback.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
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

/** The default settings with a check command, which a hand-back needs to check a resolution. */
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    },
  },
} satisfies Setup

/** What a hand-back scenario hands back: each ticket's phase, and what the queue kept waiting. */
interface Handed {
  readonly phases: Readonly<Record<string, TicketPhase>>
  readonly waiting: ReadonlyArray<RebaseStop>
}

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

/** Waits until the ticket is in `tag`. */
const until = (id: string, tag: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) => state.tickets.get(id)?.phase._tag === tag),
      Stream.runHead,
    )
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

/** The worker resolving its rebase's conflict, writing `files`, in its worktree. */
const resolving = (world: World, id: string, files: Files) =>
  run(Effect.suspend(() => Effect.asVoid(world.repository.continueRebase(worktreeOf(id), files))))

/** A hand-back turn in which the worker resolves the conflict, writing `files`, and finishes. */
const resolves = (world: World, id: string, files: Files) => turn([resolving(world, id, files)])

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads,
 * Working in the ledger, its session started and saved, and its worker idle (working still when
 * `idle` is false; its session closed when `closed`; not started at all when `started` is false, as
 * a ticket an earlier run left).
 */
const finished = (
  id: string,
  files: Files,
  session: {
    readonly closed?: boolean
    readonly started?: boolean
    readonly idle?: boolean
  } = {},
) =>
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
    yield* ledger.transition(id, Cause.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Cause.Dispatched())
    const sessionId = `session-${id}`
    yield* (yield* Store).saveSession(id, {
      session: sessionId,
      worktree: worktree.path,
      branch: worktree.branch,
    })
    if (session.started !== false) {
      yield* host.start(id, { sessionId, cwd: worktree.path })
      if (session.idle === false) {
        yield* host.state(id).pipe(
          Stream.filter((state) => state._tag === "Working"),
          Stream.runHead,
        )
      } else {
        yield* untilSettled(id)
      }
      if (session.closed === true) yield* host.close(id)
    }
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Another ticket's merge, landing on main while the ticket ran: here, a change to its file. */
const moveMain = (files: Files = { "a.txt": "main's a\n" }) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

/**
 * Runs `body` with a merge queue in a scope of its own, and hands back each ticket's phase and the
 * hand-backs the queue kept waiting.
 */
const withQueue = <E>(
  body: (queue: MergeQueue) => Effect.Effect<void, E, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const queue = yield* makeQueue(options)
    yield* body(queue)
    return {
      phases: phasesOf(yield* (yield* Ledger).current),
      waiting: yield* queue.handBacks.waiting,
    } satisfies Handed
  }).pipe(Effect.provide(Ledger.layer))

/**
 * Finishes ticket a (a.txt), moves main on with a conflicting change, runs `before`, offers it to
 * the queue and waits until the queue settles, `during` running beside it.
 */
const conflicted = (
  setup: Setup,
  scripts: (world: World) => Scripts,
  session: Parameters<typeof finished>[2] = {},
  hooks: {
    readonly before?: Effect.Effect<void, unknown, Env | Ledger>
    readonly during?: Effect.Effect<void, unknown, Env | Ledger>
    readonly after?: (ticket: FinishedTicket) => Effect.Effect<void, unknown, Env | Ledger>
  } = {},
) =>
  scenario(
    { backlog: backlog().ticket("a").seeds, ...withCheck, ...setup, scripts },
    withQueue((queue) =>
      Effect.gen(function* () {
        const ticket = yield* finished("a", { "a.txt": "a\n" }, session)
        yield* moveMain()
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

const resolvingLine =
  "  RESOLVING: tutti/a conflicts with main in a.txt; handed back to its worker to resolve (up to 20m)"

describe("a resolution accepted", () => {
  test("is verified, checked, and merges: Merging → Resolving → ToMerge → Done", async () => {
    let tip = ""
    const ran = await conflicted(
      {},
      (world) => ({ a: [finishedSession(resolves(world, "a", { "a.txt": "both\n" }))] }),
      {},
      {
        after: () =>
          Effect.gen(function* () {
            const repository = yield* Repository
            tip = yield* repository.head("main")
            expect((yield* repository.tree("main")).get("a.txt")).toBe("both\n")
          }),
      },
    )
    const handed = resultOf(ran)
    expect(handed.phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(pathOf(ran, "a")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "ToMerge",
      "Merging",
      "Done",
    ])
    const resolvingRecord = ran.events.find(
      (record) => record.kind === "phase" && record.to === "Resolving",
    )
    expect(resolvingRecord).toMatchObject({ cause: "ConflictsHandedBack", attempt: 1 })
    expectLog(ran, [
      resolvingLine,
      "  a's worker finished the rebase; checking it with 'scripts/check-fast.sh'",
      /^ {2}a closed \([0-9a-f]{7} Do a \(a\)\); merged into main, worktree and branch removed$/,
    ])
    // The hand-back is orchestra's instructions, sent client_composed.
    const sent = composed(ran)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("rebasing tutti/a onto it stopped on conflicts in a.txt")
    expect(sent[0]).toContain(`run '${check}' in the foreground until it passes`)
    // The resolution is checked once, in its worktree, before it goes back in line.
    expect(ran.checkRuns).toHaveLength(1)
    expect(ran.checkRuns[0]?.cwd).toBe(worktreeOf("a"))
    expect(tip).not.toBe("")
  })

  test("the queue goes on with the tickets behind it while the worker resolves", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck,
        scripts: (world) => ({
          a: [
            finishedSession([
              wait,
              init(),
              sessionState("running"),
              sleep("1 minute"),
              resolving(world, "a", { "a.txt": "both\n" }),
              result(),
              sessionState("idle"),
            ]),
          ],
          b: [finishedSession()],
        }),
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          const b = yield* finished("b", { "b.txt": "b\n" })
          yield* moveMain()
          const during = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* until("b", "Done")
              expect((yield* (yield* Ledger).current).tickets.get("a")?.phase._tag).toBe(
                "Resolving",
              )
              yield* advance("1 minute")
            }),
          )
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
          yield* Fiber.join(during)
        }),
      ),
    )
    const handed = resultOf(ran)
    expect(handed.phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(handed.phases.b).toEqual(expect.objectContaining({ _tag: "Done" }))
    const done = ran.events.flatMap((record) =>
      record.kind === "phase" && record.to === "Done" ? [record.ticket] : [],
    )
    expect(done).toEqual(["b", "a"])
    // a, resolved on top of main as it was, is rebased onto b's merge and checked again.
    expect(ran.checkRuns.map((each) => each.cwd)).toEqual([
      worktreeOf("b"),
      worktreeOf("a"),
      worktreeOf("a"),
    ])
  })

  test("each hand-back is an attempt; after the last, the next conflict is Blocked", async () => {
    const again = (world: World, files: Files, then: Files) =>
      turn([
        resolving(world, "a", files),
        // Another ticket lands meanwhile, changing the same file once more.
        run(Effect.asVoid(world.repository.commit(world.repository.dir, "Land more", then))),
      ])
    const ran = await conflicted({}, (world) => ({
      a: [
        finishedSession([
          ...again(world, { "a.txt": "both\n" }, { "a.txt": "main again\n" }),
          ...again(world, { "a.txt": "all\n" }, { "a.txt": "main once more\n" }),
        ]),
      ],
    }))
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    const attempts = ran.events.flatMap((record) =>
      record.kind === "phase" && record.to === "Resolving" ? [record.attempt] : [],
    )
    expect(attempts).toEqual([1, 2])
    expect(composed(ran)).toHaveLength(maxHandBacks)
    expectLog(ran, [
      resolvingLine,
      resolvingLine,
      /^ {2}MERGE_CONFLICT: .*\(not handed back to its worker: it was handed back to its worker 2 times already\)/,
    ])
  })
})

describe("a resolution rejected", () => {
  test("a rebase left unfinished: Blocked, the rebase aborted, the notes saying why", async () => {
    let tip = ""
    const ran = await conflicted(
      {},
      () => ({ a: [finishedSession(turn([]))] }),
      {},
      {
        before: Effect.gen(function* () {
          tip = yield* (yield* Repository).head("tutti/a")
        }),
        after: (ticket) =>
          Effect.gen(function* () {
            expect(yield* (yield* Git).rebaseInProgress(ticket.worktree)).toBe(false)
            expect(yield* (yield* Repository).head(ticket.branch)).toBe(tip)
          }),
      },
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(pathOf(ran, "a").slice(-2)).toEqual(["Resolving", "Blocked"])
    expectLog(ran, [
      resolvingLine,
      `  MERGE_CONFLICT: a closed, but tutti/a conflicts with main in a.txt, which moved on while it ran (handed back to its worker, but its worker left the rebase unfinished; the rebase was aborted); worktree ${worktreeOf("a")} left for review (rebase onto main, check, merge)`,
    ])
    const notes = ran.issues.find((issue) => issue.id === "a")?.notes ?? ""
    expect(notes).toContain(
      "tutti: tutti/a conflicted with main in a.txt; its worker was asked to resolve the rebase, but its worker left the rebase unfinished, so a was set aside for review; the rebase was aborted.",
    )
    expect(ran.checkRuns).toEqual([])
  })

  test("a commit made besides the rebase: rejected, the branch reset to where it was", async () => {
    let tip = ""
    const ran = await conflicted(
      {},
      (world) => ({
        a: [
          finishedSession(
            turn([
              resolving(world, "a", { "a.txt": "both\n" }),
              run(
                Effect.suspend(() =>
                  Effect.asVoid(
                    world.repository.commit(worktreeOf("a"), "More (a)", { "c.txt": "c\n" }),
                  ),
                ),
              ),
            ]),
          ),
        ],
      }),
      {},
      {
        before: Effect.gen(function* () {
          tip = yield* (yield* Repository).head("tutti/a")
        }),
        after: (ticket) =>
          Effect.gen(function* () {
            expect(yield* (yield* Repository).head(ticket.branch)).toBe(tip)
          }),
      },
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expectLog(ran, [
      resolvingLine,
      new RegExp(
        `^ {2}MERGE_CONFLICT: .*\\(handed back to its worker, but tutti/a has 2 commits where the ticket had 1 \\(a commit made besides the rebase\\?\\); tutti/a was reset to ${tip.slice(0, 10)}, where it was before the rebase \\(its worker's attempt is [0-9a-f]{10}\\)\\)`,
      ),
    ])
  })

  test("a resolution whose check fails, not handed back: Blocked, the branch reset", async () => {
    const failed = new CheckFailed({
      check: "fast",
      command: check,
      exitCode: 1,
      outputFile: "/dev/fd/9",
      failingLines: ["error: a.test.ts: expected 1"],
      lastLines: ["1 fail"],
      suites: [],
      suite: null,
      flaky: [],
      flakyCount: 0,
    })
    const ran = await conflicted(
      {
        checks: { fast: [failed] },
        config: {
          settings: {
            ...withCheck.config.settings,
            merge: { ...defaults.merge, check_hand_backs: 0 },
          },
        },
      },
      (world) => ({ a: [finishedSession(resolves(world, "a", { "a.txt": "both\n" }))] }),
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expectLog(ran, [
      resolvingLine,
      "  a's worker finished the rebase; checking it with 'scripts/check-fast.sh'",
      /^ {2}MERGE_CONFLICT: .*\(handed back to its worker, but 'scripts\/check-fast\.sh' fails on the resolved tutti\/a \(output is in .*check\.log\); tutti\/a was reset to [0-9a-f]{10}, where it was before the rebase/,
    ])
  })
})

describe("a resolution not done in time", () => {
  test("resolve_timeout counts from the push, under TestClock: Blocked, the rebase aborted", async () => {
    const ran = await conflicted(
      {},
      () => ({ a: [finishedSession([wait, init(), sessionState("running"), sleep("2 hours")])] }),
      {},
      {
        during: Effect.gen(function* () {
          yield* until("a", "Resolving")
          yield* advance("19 minutes")
          expect((yield* (yield* Ledger).current).tickets.get("a")?.phase._tag).toBe("Resolving")
          yield* advance("1 minute")
        }),
        after: (ticket) =>
          Effect.gen(function* () {
            expect(yield* (yield* Git).rebaseInProgress(ticket.worktree)).toBe(false)
          }),
      },
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expectLog(ran, [
      resolvingLine,
      /^ {2}MERGE_CONFLICT: .*\(handed back to its worker, but its worker is working after 20m, with the hand-back not done; the rebase was aborted\)/,
    ])
    expect(ran.checkRuns).toEqual([])
  })
})

describe("a worker that can't take it", () => {
  test("a steered worker isn't sent it: the hand-back waits, and the line says why", async () => {
    const ran = await conflicted(
      {},
      () => ({ a: [finishedSession()] }),
      {},
      {
        before: Effect.gen(function* () {
          yield* (yield* Ledger).steer("a", "message")
        }),
        after: (ticket) =>
          Effect.gen(function* () {
            expect(yield* (yield* Git).rebaseInProgress(ticket.worktree)).toBe(false)
          }),
      },
    )
    const handed = resultOf(ran)
    expect(handed.phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(handed.waiting.map((stop) => [stop.ticket.id, stop.files])).toEqual([["a", ["a.txt"]]])
    expect(composed(ran)).toEqual([])
    expectLog(ran, [
      `  MERGE_CONFLICT: a closed, but tutti/a conflicts with main in a.txt, which moved on while it ran (not handed back to its worker: you have steered its worker, so the hand-back waits in its view); worktree ${worktreeOf("a")} left for review (rebase onto main, check, merge)`,
    ])
  })

  test("a working worker isn't sent it, and the line says why", async () => {
    const ran = await conflicted(
      {},
      () => ({ a: [[init(), sessionState("running"), sleep("1 hour")]] }),
      { idle: false },
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(composed(ran)).toEqual([])
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: a closed, but tutti\/a conflicts with main in a\.txt, which moved on while it ran \(not handed back to its worker: its worker is working\); /,
    ])
  })

  test("with hand-backs turned off, nothing is sent, and the line says so", async () => {
    const ran = await conflicted(
      {
        config: {
          settings: {
            ...withCheck.config.settings,
            merge: { ...defaults.merge, resolve_conflicts: false },
          },
        },
      },
      () => ({ a: [finishedSession()] }),
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(composed(ran)).toEqual([])
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: .*\(not handed back to its worker: resolving conflicts is turned off\); /,
    ])
  })
})

describe("a session tutti closed", () => {
  test("is resumed for the hand-back, which counts toward no resume limit", async () => {
    const ran = await conflicted(
      {},
      (world) => ({
        a: [finishedSession(), resolves(world, "a", { "a.txt": "both\n" })],
      }),
      { closed: true },
    )
    expect(resultOf(ran).phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    const resumed = ran.sent.filter((item) => item._tag === "Resumed")
    expect(resumed).toEqual([
      expect.objectContaining({
        ticket: "a",
        session: { sessionId: "session-a", cwd: worktreeOf("a") },
      }),
    ])
    expect(composed(ran)[0]).toContain("stopped on conflicts in a.txt")
  })

  test("a session an earlier run left is resumed too", async () => {
    const ran = await conflicted(
      {},
      (world) => ({ a: [resolves(world, "a", { "a.txt": "both\n" })] }),
      { started: false },
    )
    expect(resultOf(ran).phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ran.sent.filter((item) => item._tag === "Resumed")).toHaveLength(1)
  })
})

describe("the prompt", () => {
  test("names the files and the check, as orchestra's does", () => {
    const stop: RebaseStop = {
      ticket: { id: "a", title: "A", branch: "tutti/a", worktree: "/w/a" },
      onto: "abc",
      fork: "123",
      head: "def",
      own: 1,
      files: ["a.ts", "b.ts"],
    }
    const prompt = resolvePrompt(stop, "main", check)
    expect(prompt).toStartWith(
      "tutti: main moved on while you worked; rebasing tutti/a onto it stopped on conflicts in a.ts, b.ts. ",
    )
    expect(prompt).toEndWith("Say DONE when the rebase is complete and the check passes.")
  })
})
