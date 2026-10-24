// The sessions of hand-backs (§ 4.7, § 4.8): a session tutti closed, or one that ended unexpectedly
// (Gone), resumed for a hand-back and recorded as sessions.ts records a resume, and the session
// closed once a hand-back is over, as its ticket's phase says.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Ref, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import type { EventRecord } from "../src/run/events.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  failStart,
  gone,
  init,
  result,
  run,
  type SessionScript,
  sessionState,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import {
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

/** The default settings with a check command, which a hand-back needs. */
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    },
  },
} satisfies Setup

/** A failing check, its lines saying what failed. */
const failing = (said: string) =>
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

/**
 * What a scenario hands back: each ticket's phase, how often a's session was resumed, and whether
 * a's one Gone resume of the run is used.
 */
interface Ended {
  readonly phases: Readonly<Record<string, TicketPhase>>
  readonly resumes: number
  readonly goneResumed: boolean
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phasesOf = (state: State): Record<string, TicketPhase> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

const records = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

/** The tags of what a's worker was sent, in order: Started, Message, Closed, Resumed, … */
const sentTags = (ran: Ran<unknown>) =>
  ran.sent.filter((sent) => sent.ticket === "a").map((sent) => sent._tag)

/** Whether a's session is closed at the end: closed by tutti after its last start or resume. */
const closedAtEnd = (ran: Ran<unknown>) => sentTags(ran).at(-1) === "Closed"

/** Whether the ticket's session was closed and its worker ended last, its part in the run over. */
const endedAtEnd = (ran: Ran<unknown>) => sentTags(ran).slice(-2).join() === "Closed,Ended"

const notesOf = (ran: Ran<unknown>) => ran.issues.find((issue) => issue.id === "a")?.notes ?? ""

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

/** A hand-back turn in which the worker resolves the rebase's conflict, writing `files`. */
const resolves = (world: World, files: Files) =>
  turn([
    run(
      Effect.suspend(() => Effect.asVoid(world.repository.continueRebase(worktreeOf("a"), files))),
    ),
  ])

/** A hand-back turn in which the worker commits a fix naming the ticket. */
const fixes = (world: World) =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(
          world.repository.commit(worktreeOf("a"), "Fix the check (a)", { "fix.txt": "fixed\n" }),
        ),
      ),
    ),
  ])

/** A hand-back turn in which the worker commits a fix that doesn't name the ticket: rejected. */
const fixesUnnamed = (world: World) =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(
          world.repository.commit(worktreeOf("a"), "Fix the check", { "fix.txt": "fixed\n" }),
        ),
      ),
    ),
  ])

/** How ticket a's worker is when it reaches the merge queue. */
type Worker = "idle" | "closed" | "gone"

/**
 * Ticket a, finished by its worker: its worktree on tutti/a with a commit naming it changing a.txt,
 * closed in Beads, Working in the ledger, its session started and saved, and its worker `worker`.
 */
const finished = (worker: Worker) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const host = yield* AgentHost
    const worktree = yield* (yield* Worktrees).prepare("a")
    worktrees.set("a", worktree.path)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
    yield* (yield* Beads).close("a", "done")
    const ledger = yield* Ledger
    yield* ledger.transition("a", Cause.Ready(), { title: "Ticket a" })
    yield* ledger.transition("a", Cause.Dispatched())
    yield* (yield* Store).saveSession("a", {
      session: "session-a",
      worktree: worktree.path,
      branch: worktree.branch,
    })
    yield* host.start("a", { sessionId: "session-a", cwd: worktree.path })
    if (worker === "gone") {
      yield* host.state("a").pipe(
        Stream.filter((state) => state._tag === "Gone"),
        Stream.runHead,
      )
    } else {
      yield* untilSettled("a")
    }
    if (worker === "closed") yield* host.close("a")
    return {
      id: "a",
      title: "Ticket a",
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/**
 * Finishes ticket a, its worker `worker`, moves main on with `landed` (a change to a.txt, which
 * conflicts, by default), runs `before`, offers it to a merge queue and waits until the queue
 * settles.
 */
const handedBack = (
  setup: Setup,
  scripts: (world: World) => Scripts,
  worker: Worker,
  hooks: {
    readonly landed?: Files
    readonly before?: Effect.Effect<void, unknown, Env | Ledger>
  } = {},
) =>
  scenario(
    { backlog: backlog().ticket("a").seeds, ...withCheck, ...setup, scripts },
    Effect.gen(function* () {
      // A ticket merged is forgotten in state.json, so a's resumes are counted as they are saved.
      const store = yield* Store
      const resumes = yield* Ref.make(0)
      const counting = Store.of({
        ...store,
        resumed: (id) =>
          Effect.andThen(
            store.resumed(id),
            id === "a" ? Ref.update(resumes, (n) => n + 1) : Effect.void,
          ),
      })
      return yield* Effect.provideService(merged(worker, hooks, resumes), Store, counting)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Ended, unknown, Env | Scope.Scope>,
  )

/** The rest of handedBack, a's resumes counted in `resumes`. */
const merged = (
  worker: Worker,
  hooks: {
    readonly landed?: Files
    readonly before?: Effect.Effect<void, unknown, Env | Ledger>
  },
  resumes: Ref.Ref<number>,
) =>
  Effect.gen(function* () {
    const queue: MergeQueue = yield* makeQueue(options)
    const ticket = yield* finished(worker)
    const repository = yield* Repository
    yield* repository.commit(
      repository.dir,
      "Land something else",
      hooks.landed ?? { "a.txt": "main's a\n" },
    )
    yield* hooks.before ?? Effect.void
    yield* queue.offer(ticket)
    yield* queue.settled
    return {
      phases: phasesOf(yield* (yield* Ledger).current),
      resumes: yield* Ref.get(resumes),
      goneResumed: yield* (yield* Ledger).goneResumed("a"),
    } satisfies Ended
  })

/** A check failing in a.txt, which the ticket changes: it isn't checked again (recheck.ts). */
const ownFailure = failing("a.txt:1: expected 1")

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const resumedLine = (what: string) =>
  new RegExp(`^ {2}RESUMED: ${escaped(what)}; resuming its session session-a \\(worktree .*/a\\)$`)

describe("a hand-back to a session tutti closed", () => {
  test("of conflicts: resumed and recorded, RESUMED, `resumed` hand_back, one more resume", async () => {
    const ran = await handedBack(
      {},
      (world) => ({ a: [finishedSession(), resolves(world, { "a.txt": "both\n" })] }),
      "closed",
    )
    const ended = resultOf(ran)
    expect(ended.phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ended.resumes).toBe(1)
    // A session tutti closed counts toward no resume limit.
    expect(ended.goneResumed).toBe(false)
    expect(records(ran, "resumed")).toEqual([
      expect.objectContaining({ ticket: "a", session: "session-a", why: "hand_back" }),
    ])
    expectLog(ran, [resumedLine("a's conflicts with main are handed back to its worker")])
  })

  test("of a failed check: resumed and recorded, `resumed` hand_back", async () => {
    const ran = await handedBack(
      { checks: { fast: [ownFailure] } },
      (world) => ({ a: [finishedSession(), fixes(world)] }),
      "closed",
      { landed: { "b.txt": "b\n" } },
    )
    const ended = resultOf(ran)
    expect(ended.phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ended.resumes).toBe(1)
    expect(ended.goneResumed).toBe(false)
    expect(records(ran, "resumed")).toEqual([
      expect.objectContaining({ ticket: "a", why: "hand_back" }),
    ])
    expectLog(ran, [resumedLine("a's failed check is handed back to its worker")])
  })
})

describe("a hand-back to a worker that is gone (Gone)", () => {
  test("its session is resumed for it, once per run: `resumed` gone, and the ticket merges", async () => {
    const ran = await handedBack(
      {},
      (world) => ({
        a: [finishedSession([gone("exit 1")]), resolves(world, { "a.txt": "both\n" })],
      }),
      "gone",
    )
    const ended = resultOf(ran)
    expect(ended.phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ended.resumes).toBe(1)
    // The hand-back's resume is the ticket's one Gone resume of the run.
    expect(ended.goneResumed).toBe(true)
    expect(sentTags(ran)).toEqual(["Started", "Resumed", "Message", "Closed", "Ended"])
    expect(records(ran, "resumed")).toEqual([
      expect.objectContaining({ ticket: "a", session: "session-a", why: "gone" }),
    ])
    expectLog(ran, [
      resumedLine("a's conflicts with main are handed back to its worker, which is gone (exit 1)"),
    ])
  })

  test("of a failed check: resumed for it too", async () => {
    const ran = await handedBack(
      { checks: { fast: [ownFailure] } },
      (world) => ({ a: [finishedSession([gone("exit 1")]), fixes(world)] }),
      "gone",
      { landed: { "b.txt": "b\n" } },
    )
    const ended = resultOf(ran)
    expect(ended.phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(ended.goneResumed).toBe(true)
    expect(records(ran, "resumed")).toEqual([expect.objectContaining({ ticket: "a", why: "gone" })])
  })

  test("whose Gone resume is spent: not handed back, and the line says why", async () => {
    const ran = await handedBack({}, () => ({ a: [finishedSession([gone("exit 1")])] }), "gone", {
      before: Effect.gen(function* () {
        yield* (yield* Ledger).claimGoneResume("a")
      }),
    })
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(sentTags(ran)).toEqual(["Started"])
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: .*\(not handed back to its worker: its worker is gone \(exit 1\) and its session was resumed once in this run already\); /,
    ])
  })

  test("whose session can't be resumed: WORKER_GONE, Blocked, the rebase aborted", async () => {
    const reason = "No conversation found with session ID"
    const ran = await handedBack(
      {},
      () => ({ a: [finishedSession([gone("exit 1")]), [failStart(reason)]] }),
      "gone",
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(records(ran, "resumed")).toEqual([])
    expect(records(ran, "warn")).toContainEqual(
      expect.objectContaining({ ticket: "a", detail: "its worker gone" }),
    )
    expectLog(ran, [
      `  WORKER_GONE: a's worker is gone (exit 1), and its session could not be resumed for its hand-back (${reason})`,
      /^ {2}MERGE_CONFLICT: .*\(handed back to its worker, but its worker is gone \(exit 1\) and its session could not be resumed: No conversation found with session ID; the rebase was aborted\); /,
    ])
    expect(notesOf(ran)).toContain(
      `its worker is gone (exit 1) and its session could not be resumed: ${reason}`,
    )
  })
})

describe("the session, once a hand-back is over", () => {
  test("conflicts resolved and merged: closed, its worker ended", async () => {
    const ran = await handedBack(
      {},
      (world) => ({ a: [finishedSession(resolves(world, { "a.txt": "both\n" }))] }),
      "idle",
    )
    expect(resultOf(ran).phases.a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(endedAtEnd(ran)).toBe(true)
  })

  test("a resolution rejected, Blocked: closed", async () => {
    // The worker answers without resolving: the rebase is left unfinished.
    const ran = await handedBack({}, () => ({ a: [finishedSession(turn([]))] }), "idle")
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(closedAtEnd(ran)).toBe(true)
  })

  test("a fix rejected, Review not to be checked again: closed, its worker ended", async () => {
    // The worker's fix doesn't name the ticket.
    const ran = await handedBack(
      { checks: { fast: [ownFailure] } },
      (world) => ({ a: [finishedSession(fixesUnnamed(world))] }),
      "idle",
      { landed: { "b.txt": "b\n" } },
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expect(endedAtEnd(ran)).toBe(true)
  })

  test("a fix whose check fails again, Review to be checked again: open", async () => {
    const elsewhere = failing("shared/b.go:12: expected 1")
    const ran = await handedBack(
      {
        config: {
          settings: {
            ...withCheck.config.settings,
            merge: { ...defaults.merge, check_hand_backs: 1 },
          },
        },
        checks: { fast: [elsewhere, elsewhere] },
      },
      (world) => ({ a: [finishedSession(fixes(world))] }),
      "idle",
      { landed: { "b.txt": "b\n" } },
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expect(sentTags(ran)).not.toContain("Closed")
  })

  test("a resolution's fix rejected, Blocked: closed", async () => {
    const ran = await handedBack(
      { checks: { fast: [ownFailure] } },
      (world) => ({
        a: [finishedSession([...resolves(world, { "a.txt": "both\n" }), ...fixesUnnamed(world)])],
      }),
      "idle",
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(closedAtEnd(ran)).toBe(true)
  })
})
