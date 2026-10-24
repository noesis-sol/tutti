import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import type { EventRecord } from "../src/run/events.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { emptyQueue, type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, Outcome, type PhaseTag, TicketPhase } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import {
  carryOnText,
  GoneResume,
  type Lifetime,
  lifetime,
  resume,
  resumeGone,
} from "../src/run/sessions.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  bash,
  claimsAndCloses,
  defers,
  failStart,
  filesQuestion,
  gone,
  run,
  type SessionScript,
  turn,
} from "../src/testing/AgentHost.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import {
  backlog,
  type Env,
  expectLog,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1"
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }
const tiny = backlog().ticket(id, { title: "One ticket" })

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const records = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

/** Whether the ticket's session was closed by tutti. */
const closed = (ran: Ran<unknown>, ticket = id) =>
  ran.sent.some((sent) => sent._tag === "Closed" && sent.ticket === ticket)

/** The tags of what the ticket's worker was sent, in order: Started, Message, Closed, … */
const sentTags = (ran: Ran<unknown>, ticket = id) =>
  ran.sent.filter((sent) => sent.ticket === ticket).map((sent) => sent._tag)

/** The messages the ticket's worker was sent, as text. */
const sentTexts = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id ? [String(sent.message.message.content)] : [],
  )

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

describe("lifetime: § 4.8's table, row by row", () => {
  const rows: ReadonlyArray<readonly [string, TicketPhase, Lifetime]> = [
    ["running", TicketPhase.Working({ activity: "working" }), "open"],
    ["waiting to merge", TicketPhase.ToMerge({ place: 1 }), "open"],
    ["merging", TicketPhase.Merging({ step: "check" }), "open"],
    ["handed back its conflicts", TicketPhase.Resolving({ attempt: 1 }), "open"],
    ["handed back its check", TicketPhase.Fixing({ attempt: 1, afterResolution: false }), "open"],
    ["merged", TicketPhase.Done({ outcome: Outcome.Merged({ commit: "abc1234" }) }), "closed"],
    ["closed with no change", TicketPhase.Done({ outcome: Outcome.NoChange() }), "closed"],
    ["asked", TicketPhase.Asked({ question: "t-9" }), "closed"],
    ["waits for merge", TicketPhase.Waiting({ for: "t-0" }), "closed"],
    ["deferred", TicketPhase.Deferred({ why: "by the worker" }), "closed"],
    ["left for review", TicketPhase.Review({ why: "CLOSED_WITHOUT_COMMIT" }), "closed"],
    ["blocked on its conflicts", TicketPhase.Blocked({ why: "MERGE_CONFLICT" }), "closed"],
    ["stopped the run", TicketPhase.Stopped({ why: "PAUSED" }), "suspended"],
  ]
  for (const [what, phase, expected] of rows) {
    test(`${what}: ${expected}`, () => {
      expect(lifetime(phase)).toBe(expected)
    })
  }

  test("blocked on its conflict with the hand-back waiting for its steered worker: open", () => {
    expect(lifetime(TicketPhase.Blocked({ why: "MERGE_CONFLICT" }), false, true)).toBe("open")
    // Only a conflict's hand-back waits.
    expect(lifetime(TicketPhase.Blocked({ why: "DIRTY_TREE" }), false, true)).toBe("closed")
  })

  test("set aside after a failed check that may be checked again: open until the run ends", () => {
    const aside = TicketPhase.Review({ why: "CHECKS_FAILED" })
    expect(lifetime(aside, true)).toBe("untilRunEnds")
    // One that won't be checked again has nothing left to do.
    expect(lifetime(aside, false)).toBe("closed")
    // Only a failed check is checked again.
    expect(lifetime(TicketPhase.Review({ why: "OFF_BRANCH" }), true)).toBe("closed")
  })
})

// A worker's outcome, read as it settles (work.ts).

/** A folder for the worktrees, so a test knows where its ticket's is before it starts. */
const worktreesRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-sessions-")))

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  let places = 0
  return {
    offer: (finished, cause = (place) => Cause.Verified({ place })) =>
      ledger.transition(finished.id, cause(++places)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    held: yield* makeHeld,
    checksAhead: undefined as never,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/** What the worker's commands do to the in-memory Beads and git, its worktree in `root`. */
const commands = (world: World, root: string) => ({
  claim: orDie(world.beads.update(id, { claim: true })),
  commit: (message: string) =>
    orDie(world.repository.commit(join(root, id), message, { "a.txt": "a\n" })),
  close: orDie(world.beads.close(id, "done")),
  defer: orDie(world.beads.defer(id)),
})

type Commands = ReturnType<typeof commands>

/** Dispatches the ticket and runs its fiber, its sessions made from the commands and the world. */
const working = (
  sessions: (c: Commands, world: World) => ReadonlyArray<SessionScript>,
  options: {
    readonly backlog?: typeof tiny
    readonly during?: (fiber: Fiber.Fiber<Worked, unknown>) => Effect.Effect<void, unknown, Env>
  } = {},
): Promise<Ran<Worked>> => {
  const root = worktreesRoot()
  const scripts = (world: World): Scripts => ({ [id]: sessions(commands(world, root), world) })
  return scenario(
    { backlog: (options.backlog ?? tiny).seeds, scripts, worktrees: { root } },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Cause.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Cause.Dispatched())
      const queue = yield* lineOnly
      const fiber = yield* Effect.forkChild(work(ticket, { base: "main", queue }))
      yield* options.during?.(fiber) ?? Effect.void
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  )
}

const phaseOf = (ran: Ran<Worked>) => resultOf(ran).phase

describe("a ticket's session, as its worker's outcome is read", () => {
  test("finished, waiting to merge: open", async () => {
    const ran = await working((c) => [
      claimsAndCloses(id, { claim: c.claim, commit: c.commit(`Change (${id})`), close: c.close }),
    ])
    expect(phaseOf(ran)?._tag).toBe("ToMerge")
    expect(closed(ran)).toBe(false)
  })

  test("closed with no change: closed, its worker ended", async () => {
    const ran = await working((c) => [turn([...bash(`bd close ${id}`, c.close)])])
    expect(phaseOf(ran)?._tag).toBe("Done")
    expect(sentTags(ran).slice(-2)).toEqual(["Closed", "Ended"])
  })

  test("asked, once its turn has ended: closed", async () => {
    const ran = await working((c, world) => [
      filesQuestion(id, {
        claim: c.claim,
        file: orDie(
          Effect.andThen(
            world.beads.create({ title: "Which way?", labels: ["human"], blocks: [id] }),
            world.beads.update(id, { status: "open" }),
          ),
        ),
      }),
    ])
    expect(phaseOf(ran)?._tag).toBe("Asked")
    expect(sentTags(ran).at(-1)).toBe("Closed")
  })

  test("waits for merge: closed", async () => {
    const ran = await working(
      (c, world) => [turn([run(c.claim), run(orDie(world.beads.addDependency(id, "t-0")))])],
      { backlog: backlog().ticket("t-0").ticket(id, { title: "One ticket" }) },
    )
    expect(phaseOf(ran)?._tag).toBe("Waiting")
    expect(sentTags(ran).at(-1)).toBe("Closed")
  })

  test("deferred: closed, its worker ended", async () => {
    const ran = await working((c) => [defers(id, { claim: c.claim, defer: c.defer })])
    expect(phaseOf(ran)?._tag).toBe("Deferred")
    expect(sentTags(ran).slice(-2)).toEqual(["Closed", "Ended"])
  })

  test("left for review: closed, its worker ended", async () => {
    const ran = await working((c) => [
      turn([run(c.commit("Change something (t-10)")), run(c.close)]),
    ])
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CLOSED_WITHOUT_COMMIT" }),
    )
    expect(sentTags(ran).slice(-2)).toEqual(["Closed", "Ended"])
  })

  test("stopped the run: left for the run's end to suspend", async () => {
    // Gone, resumed once, and gone again: PAUSED.
    const ran = await working((c) => [
      [...turn([run(c.claim)]).slice(0, -2), gone("exit 1")],
      [gone("exit 1")],
    ])
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }))
    expect(closed(ran)).toBe(false)
  })
})

// A finished ticket's merge (mergequeue.ts).

const options = { repo: "/repo", base: "main" }

/** A check that fails, its output saying `said`. */
const failing = (said: ReadonlyArray<string>) =>
  new CheckFailed({
    check: "fast",
    command: "scripts/check-fast.sh",
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: said,
    lastLines: [...said, "1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

/**
 * A ticket its worker finished, its session open: its worktree on tutti/<id> with a commit naming
 * it, closed in Beads, Working.
 */
const finished = (ticket: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const host = yield* AgentHost
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(ticket)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${ticket} (${ticket})`, files)
    yield* (yield* Beads).close(ticket, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(ticket, Cause.Ready(), { title: `Ticket ${ticket}` })
    yield* ledger.transition(ticket, Cause.Dispatched())
    yield* host.start(ticket, { sessionId: `session-${ticket}`, cwd: worktree.path })
    return {
      id: ticket,
      title: `Ticket ${ticket}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Waits until the ticket is in `phase` and the merge queue has settled. */
const until = (queue: MergeQueue, ticket: string, phase: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) => state.tickets.get(ticket)?.phase._tag === phase),
      Stream.runHead,
    )
    yield* queue.settled
  })

/** The ticket finishes with `files` (after main moved, when `moved`) and merges as it can. */
const merging = (
  files: Files,
  phase: PhaseTag,
  setup: { readonly checks?: ReadonlyArray<CheckFailed>; readonly moved?: boolean } = {},
) =>
  scenario(
    {
      backlog: tiny.seeds,
      scripts: { [id]: [[]] },
      checks: { fast: setup.checks ?? [] },
    },
    Effect.gen(function* () {
      const queue = yield* makeQueue(options)
      const done = yield* finished(id, files)
      if (setup.moved === true) {
        const repository = yield* Repository
        yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      }
      yield* queue.offer(done)
      yield* until(queue, id, phase)
      return (yield* (yield* Ledger).current).tickets.get(id)?.phase
    }).pipe(Effect.provide(Ledger.layer)),
  )

describe("a ticket's session, as its merge is over", () => {
  test("merged: closed, its worker ended", async () => {
    const ran = await merging({ "a/a.go": "a\n" }, "Done")
    expect(resultOf(ran)?._tag).toBe("Done")
    expect(sentTags(ran)).toEqual(["Started", "Closed", "Ended"])
  })

  test("set aside after a failed check that may be checked again: open", async () => {
    const ran = await merging({ "a/a.go": "a\n" }, "Review", {
      checks: [failing(["shared/b.go:12: expected 1"])],
      moved: true,
    })
    expect(resultOf(ran)).toEqual(expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }))
    expect(closed(ran)).toBe(false)
  })

  test("set aside after a failed check in its own code, not to be checked again: closed", async () => {
    const ran = await merging({ "a/a.go": "a\n" }, "Review", {
      checks: [failing(["a/a.go:3: expected 1"])],
      moved: true,
    })
    expect(resultOf(ran)).toEqual(expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }))
    expect(closed(ran)).toBe(true)
  })
})

// Resume limits.

describe("a session that ended unexpectedly (Gone)", () => {
  test("is resumed once, told to carry on, and the ticket goes on", async () => {
    const ran = await working((c) => [
      [...turn([run(c.claim)]).slice(0, -2), gone("exit 1")],
      claimsAndCloses(id, { commit: c.commit(`Change (${id})`), close: c.close }),
    ])
    expect(phaseOf(ran)?._tag).toBe("ToMerge")
    const sessions = ran.sent.flatMap((sent) =>
      sent._tag === "Started" || sent._tag === "Resumed" ? [sent.session] : [],
    )
    // The same session, by its saved ID, in the same worktree.
    expect(sessions).toHaveLength(2)
    expect(sessions[1]).toEqual(sessions[0])
    expect(sentTags(ran)).toEqual(["Started", "Message", "Resumed", "Message"])
    expect(sentTexts(ran).at(-1)).toBe(carryOnText(id))
    expect(records(ran, "resumed")).toEqual([
      expect.objectContaining({ ticket: id, why: "gone", session: expect.any(String) }),
    ])
    expectLog(ran, [
      /^ {2}RESUMED: t-1's worker is gone \(exit 1\) with the ticket in progress; resuming its session \S+ \(worktree .*t-1\)$/,
    ])
    const issue = ran.issues.find((each) => each.id === id)
    expect(issue?.notes).toContain("its worker's session ended unexpectedly (exit 1)")
  })

  test("whose resume fails, the transcript gone: WORKER_GONE, noted and dropped", async () => {
    const ran = await working((c) => [
      [...turn([run(c.claim)]).slice(0, -2), gone("exit 1")],
      [failStart("No conversation found with session ID")],
    ])
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Review", why: "WORKER_GONE" }))
    expect(records(ran, "resumed")).toEqual([])
    expect(records(ran, "warn")).toEqual([
      expect.objectContaining({ ticket: id, aside: true, detail: "in progress, its worker gone" }),
    ])
    expectLog(ran, [
      /^ {2}WORKER_GONE: t-1 is in progress, but its worker is gone and its session could not be resumed \(No conversation found with session ID\); worktree .*t-1 left for review, no longer followed; reopen it to run it again \(bd update t-1 --status open\), or finish it by hand$/,
    ])
    const issue = ran.issues.find((each) => each.id === id)
    expect(issue?.status).toBe("in_progress")
    expect(issue?.notes).toContain("WORKER_GONE: t-1 is in progress")
  })

  test("whose resume fails on a startup_failure_reason: WORKER_GONE", async () => {
    const ran = await working((c) => [
      [...turn([run(c.claim)]).slice(0, -2), gone("exit 1")],
      [failStart("Claude Code refused to start: cwd_unavailable", "cwd_unavailable")],
    ])
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Review", why: "WORKER_GONE" }))
    expectLog(ran, [
      /WORKER_GONE: .*could not be resumed \(Claude Code refused to start: cwd_unavailable\)/,
    ])
  })

  test("is resumed once per ticket per run", async () => {
    const ran = await scenario(
      { backlog: tiny.seeds, scripts: { [id]: [[], []] } },
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveSession(id, { session: "s-1", worktree: "/w/t-1", branch: "tutti/t-1" })
        const first = yield* resumeGone(id, "exit 1")
        const second = yield* resumeGone(id, "exit 1")
        return [first._tag, second._tag]
      }).pipe(Effect.provide(Ledger.layer)),
    )
    expect(resultOf(ran)).toEqual(["Resumed", "Spent"])
    expect(sentTags(ran)).toEqual(["Resumed", "Message"])
  })
})

describe("a session tutti closed", () => {
  test("is resumed any number of times, and doesn't use up the Gone resume", async () => {
    const ran = await scenario(
      { backlog: tiny.seeds, scripts: { [id]: [[], [], [], [], []] } },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const store = yield* Store
        yield* store.saveSession(id, { session: "s-1", worktree: "/w/t-1", branch: "tutti/t-1" })
        yield* host.start(id, { sessionId: "s-1", cwd: "/w/t-1" })
        for (let i = 0; i < 3; i++) {
          yield* host.close(id)
          yield* resume(id, "hand_back", "Resolve the conflicts.", line`${id}'s session is closed`)
        }
        yield* host.close(id)
        const gone = yield* resumeGone(id, "exit 1")
        return { gone, resumes: (yield* store.ticket(id))?.resumes }
      }).pipe(Effect.provide(Ledger.layer)),
    )
    const { gone, resumes } = resultOf(ran)
    expect(gone).toEqual(GoneResume.Resumed({ message: expect.any(String) }))
    expect(resumes).toBe(4)
    expect(sentTags(ran).filter((tag) => tag === "Resumed")).toHaveLength(4)
    expect(
      records(ran, "resumed").map((record) => record.kind === "resumed" && record.why),
    ).toEqual(["hand_back", "hand_back", "hand_back", "gone"])
    for (const sent of ran.sent) {
      if (sent._tag === "Resumed") expect(sent.session).toEqual({ sessionId: "s-1", cwd: "/w/t-1" })
    }
  })

  test("with no session saved isn't resumed", async () => {
    const ran = await scenario(
      { backlog: tiny.seeds, scripts: { [id]: [[]] } },
      Effect.flip(
        resume(id, "answered", "Your question is answered.", line`${id}'s question is answered`),
      ),
    )
    expect(resultOf(ran).reason).toBe("it has no session to resume")
    expect(ran.sent).toEqual([])
  })
})
