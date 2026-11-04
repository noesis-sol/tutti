// A conflict fixed by hand and taken back (takenBack.ts, § 5 item 8, § 5.1's Blocked{MERGE_CONFLICT}
// → ToMerge): whole runs where a's branch conflicts with main and is Blocked, what a person then does
// in its worktree, and what the next look makes of it. c keeps the run going until `during` is over.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber, type Scope } from "effect"
import { emptyTallies, Ledger, type State } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import type { FinishedTicket, GivenMergeOptions } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type PhaseTag, TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { emptyStatus, project } from "../src/run/runView.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { unmergedLabel } from "../src/run/scope.ts"
import { conflictHeadKey, fixedLeft, keepConflictHead } from "../src/run/takenBack.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { bash, result, type SessionScript, run as step, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-taken-back-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

interface Places {
  readonly repo: string
  readonly root: string
  readonly a: string
}

/** Claims its ticket, does `first`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  root: string,
  id: TicketId,
  files: Files,
  first: SessionScript = [],
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...first,
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  }).pipe(Effect.orDie)

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

/** One more look: the run caught up, then a ready poll, then caught up with what it did. */
const look = Effect.gen(function* () {
  yield* caughtUp
  yield* advance(readyPoll)
  yield* caughtUp
})

/** a's rebase stopped on shared.txt, and it Blocked with no hand-back. */
const conflictLine =
  /^ {2}MERGE_CONFLICT: a closed, but tutti\/a conflicts with main in shared\.txt/

/** The branch rebased onto main in its worktree, the conflict resolved: as a person does. */
const fixByHand = (places: Places) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    yield* Effect.exit(git.rebase(places.a, "main"))
    yield* repository.continueRebase(places.a, { "shared.txt": "both\n" })
  })

interface Plan {
  /** What is done once a is Blocked, before c finishes. */
  readonly during: (places: Places) => Effect.Effect<void, unknown, Env>
  /** The slots; 2 by default. Hand-backs are off, for a to be Blocked at once. */
  readonly concurrent?: number
}

/** A whole run on main with a conflicting and Blocked, c working until `during` is over. */
const blocked = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const places = { repo, root, a: join(root, "a") }
  mkdirSync(places.a)
  const free = Effect.runSync(Deferred.make<void>())
  const settings = {
    ...defaults,
    concurrent: plan.concurrent ?? 2,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    merge: { ...defaults.merge, check_hand_backs: 0, resolve_conflicts: false },
  }
  return scenario(
    {
      config: { repo, settings },
      backlog: backlog().ticket("a").ticket("c").seeds,
      git: { dir: repo, files: { "shared.txt": "start\n" } },
      worktrees: { root },
      checks: { fast: [passed("fast"), passed("fast"), passed("fast"), passed("fast")] },
      scripts: (world: World) => ({
        a: [works(world, root, "a" as TicketId, { "shared.txt": "a\n" })],
        c: [works(world, root, "c" as TicketId, { "c.txt": "c\n" }, [step(Deferred.await(free))])],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      for (const id of ["a", "c"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      yield* repository.commit(repo, "Main moves", { "shared.txt": "main\n" })
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* untilLogged(conflictLine)
      yield* plan.during(places)
      yield* Deferred.succeed(free, undefined)
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

const takenBack = (ran: Ran<unknown>) => ran.log.filter((text) => text.includes("TAKEN_BACK"))

/** The line of a branch taken back. */
const backLine =
  /^ {2}TAKEN_BACK: tutti\/a moved on to [0-9a-f]{7} since its conflict and rebases cleanly onto main now: back in the merge queue$/

describe("a ticket blocked on its conflict, its branch fixed by hand", () => {
  test("is taken back at the next look and merges", async () => {
    const ran = await blocked({
      during: (places) =>
        Effect.gen(function* () {
          yield* fixByHand(places)
          yield* look
          yield* untilLogged(backLine)
        }),
    })
    expectPhases(ran, { a: "Done", c: "Done" })
    expectLog(ran, [conflictLine, backLine])
    const moves = ran.events.flatMap((record) =>
      record.kind === "phase" && record.ticket === "a" ? [record] : [],
    )
    expect(moves.map((record) => record.cause)).toContain("TakenBack")
    const back = moves.find((record) => record.cause === "TakenBack")
    expect([back?.from, back?.to]).toEqual(["Blocked", "ToMerge"])
    expect(ran.events).toContainEqual(
      expect.objectContaining({
        kind: "info",
        ticket: "a",
        text: expect.stringContaining("TAKEN_BACK"),
      }),
    )
  })

  test("a slot is what it waits for, as a recheck", async () => {
    // One slot: c holds it while a is fixed, so a waits until c has merged, then merges.
    const ran = await blocked({
      concurrent: 1,
      during: (places) =>
        Effect.gen(function* () {
          yield* fixByHand(places)
          yield* look
          yield* look
          expect((yield* texts).filter((text) => backLine.test(text))).toEqual([])
        }),
    })
    expectPhases(ran, { a: "Done", c: "Done" })
    expectLog(ran, [conflictLine, /^ {2}c /, backLine])
  })
})

describe("a ticket blocked on its conflict is left Blocked", () => {
  /** Whatever `during` leaves, a look, c's merge and the look after it take nothing back. */
  const left = async (during: Plan["during"]) => {
    const ran = await blocked({
      during: (places) => Effect.andThen(during(places), look),
    })
    expectPhases(ran, { a: "Blocked", c: "Done" })
    expect(ran.log.filter((text) => backLine.test(text))).toEqual([])
    return ran
  }

  test("when its branch hasn't moved", async () => {
    const ran = await left(() => Effect.void)
    expect(takenBack(ran)).toEqual([])
  })

  test("mid-rebase", async () => {
    const ran = await left((places) =>
      Effect.flatMap(Git, (git) => Effect.exit(git.rebase(places.a, "main"))),
    )
    expect(takenBack(ran)).toEqual([])
  })

  test("with its branch moved and a rebase begun again", async () => {
    const ran = await left((places) =>
      Effect.gen(function* () {
        const repository = yield* Repository
        const git = yield* Git
        yield* repository.commit(places.a, "More (a)", { "more.txt": "more\n" })
        yield* Effect.exit(git.rebase(places.a, "main"))
      }),
    )
    expect(takenBack(ran)).toEqual([])
  })

  for (const mark of ["MERGE_HEAD", "CHERRY_PICK_HEAD"] as const) {
    test(`with a merge or cherry-pick in progress (${mark})`, async () => {
      const ran = await left((places) =>
        Effect.gen(function* () {
          yield* fixByHand(places)
          yield* (yield* Repository).leaveMark(places.a, mark)
        }),
      )
      expect(takenBack(ran)).toEqual([])
    })
  }

  test("with uncommitted changes to tracked files", async () => {
    const ran = await left((places) =>
      Effect.gen(function* () {
        yield* fixByHand(places)
        yield* (yield* Repository).write(places.a, { "shared.txt": "half done\n" })
      }),
    )
    expect(takenBack(ran)).toEqual([])
  })

  test("off its branch", async () => {
    const ran = await left((places) =>
      Effect.gen(function* () {
        yield* fixByHand(places)
        yield* (yield* Repository).checkout(places.a, "main~0")
      }),
    )
    expect(takenBack(ran)).toEqual([])
  })

  test("while it still conflicts: said once for its commit", async () => {
    const ran = await left((places) =>
      Effect.gen(function* () {
        // A commit on the branch as it was, not rebased: it moved, but shared.txt still conflicts.
        yield* (yield* Repository).commit(places.a, "More (a)", { "more.txt": "more\n" })
        yield* look
        yield* look
      }),
    )
    expect(takenBack(ran)).toHaveLength(1)
    expectLog(ran, [
      /^ {2}TAKEN_BACK: tutti\/a moved on to [0-9a-f]{7} since its conflict, but still conflicts with main in shared\.txt; it stays blocked$/,
    ])
  })
})

const ofResult = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** a's branch committed, kept as it was blocked; main moved on. Its record has its worktree. */
const branched = (id: TicketId, phase?: "Blocked") =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const store = yield* Store
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}.txt`]: "work\n" })
    yield* store.updateTicket(id, (record) => ({
      ...record,
      session: `session-${id}`,
      worktree: worktree.path,
      branch: worktree.branch,
      ...(phase === undefined ? {} : { phase }),
    }))
    const { repo, base } = options
    yield* keepConflictHead({ id, branch: worktree.branch }, { repo })
    yield* repository.commit(repo, "Land something else", { [`main-${base}.txt`]: "moved\n" })
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

const options = { repo: "/repo", base: "main" }

/** Fixed by hand: a commit on the branch, its worktree left clean. */
const fix = (ticket: FinishedTicket) =>
  Effect.flatMap(Repository, (repository) =>
    repository.commit(ticket.worktree, `Fix ${ticket.id} (${ticket.id})`, { "fix.txt": "fix\n" }),
  )

/** a Blocked on its conflict in this run, closed, its branch kept as it was. */
const blockedHere = Effect.gen(function* () {
  const ledger = yield* Ledger
  const id = "a" as TicketId
  const ticket = yield* branched(id)
  yield* (yield* Beads).close(id, "done")
  yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
  yield* ledger.transition(id, Move.Dispatched())
  yield* ledger.transition(id, Move.Verified({ place: 1 }))
  yield* ledger.transition(id, Move.ItsTurn())
  yield* ledger.transition(id, Move.Block({ why: "MERGE_CONFLICT" }))
  return ticket
})

const phaseOf = (state: State, id: string) => state.tickets.get(id as TicketId)?.phase._tag

/** A queue's look at a, Blocked and fixed by hand after `before`, under `given`. */
const looked = (
  before: (ticket: FinishedTicket) => Effect.Effect<void, unknown, Env | Ledger> = () =>
    Effect.void,
  given: Partial<GivenMergeOptions> = {},
) =>
  scenario(
    { backlog: backlog().ticket("a").seeds },
    Effect.gen(function* () {
      const ticket = yield* blockedHere
      const queue = yield* makeQueue({ ...options, ...given })
      yield* fix(ticket)
      yield* before(ticket)
      const back = yield* queue.recheck
      yield* queue.settled
      return { back, phase: phaseOf(yield* (yield* Ledger).current, "a") }
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
      { readonly back: ReadonlyArray<string>; readonly phase: PhaseTag | undefined },
      unknown,
      Env | Scope.Scope
    >,
  ).then(ofResult)

describe("a look at a ticket fixed by hand", () => {
  test("takes it back in a slot, held until its merge is over", async () => {
    const slots: Array<string> = []
    const seen = await looked(undefined, {
      recheckSlot: (id, work) =>
        Effect.gen(function* () {
          slots.push(id)
          yield* Effect.forkDetach(
            Effect.andThen(
              work,
              Effect.sync(() => void slots.push("over")),
            ),
          )
          return true
        }),
    })
    expect(seen).toEqual({ back: ["a"], phase: "Done" })
    await Bun.sleep(0)
    expect(slots).toEqual(["a", "over"])
  })

  test("waits for a slot: none free or a solo ticket, it stays Blocked", async () => {
    expect(await looked(undefined, { recheckSlot: () => Effect.succeed(false) })).toEqual({
      back: [],
      phase: "Blocked",
    })
  })

  test("takes nothing back while the run holds", async () => {
    expect(await looked(undefined, { noMore: Effect.succeed("the run holds") })).toEqual({
      back: [],
      phase: "Blocked",
    })
  })

  test("takes nothing back while the run winds down", async () => {
    const seen = await looked(() => Effect.flatMap(Ledger, (ledger) => ledger.windDown))
    expect(seen).toEqual({ back: [], phase: "Blocked" })
  })

  test("leaves one whose hand-back waits for its steered worker", async () => {
    const seen = await looked(() =>
      Effect.flatMap(Ledger, (ledger) => ledger.handBackWaits("a" as TicketId)),
    )
    expect(seen).toEqual({ back: [], phase: "Blocked" })
  })

  test("leaves one reopened since", async () => {
    const seen = await looked(() =>
      Effect.flatMap(Beads, (beads) => beads.update("a" as TicketId, { status: "open" })),
    )
    expect(seen).toEqual({ back: [], phase: "Blocked" })
  })

  test("leaves one whose worktree is gone", async () => {
    const seen = await looked((ticket) =>
      Effect.flatMap(Repository, (repository) => repository.removeFolder(ticket.worktree)),
    )
    expect(seen).toEqual({ back: [], phase: "Blocked" })
  })

  test("git failing to say, asks again at the next look", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      Effect.gen(function* () {
        const ticket = yield* blockedHere
        const queue = yield* makeQueue(options)
        yield* fix(ticket)
        // The first is the look for a hand merge's, then this one's.
        yield* (yield* Repository).fail("merge-tree", { times: 2 })
        const first = yield* queue.recheck
        const second = yield* queue.recheck
        yield* queue.settled
        return { first, second }
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
        { readonly first: ReadonlyArray<string>; readonly second: ReadonlyArray<string> },
        unknown,
        Env | Scope.Scope
      >,
    )
    expect(ofResult(ran)).toEqual({ first: [], second: ["a"] })
  })

  test("says a branch still conflicts once for each commit, and takes it back once it doesn't", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, git: { files: { "shared.txt": "start\n" } } },
      Effect.gen(function* () {
        const repository = yield* Repository
        const ticket = yield* blockedHere
        const queue = yield* makeQueue(options)
        yield* repository.commit(options.repo, "Main's", { "shared.txt": "main\n" })
        yield* repository.commit(ticket.worktree, "Mine (a)", { "shared.txt": "a\n" })
        yield* queue.recheck
        yield* queue.recheck
        // The base moves on: asked again, not said again.
        yield* repository.commit(options.repo, "More", { "other.txt": "x\n" })
        yield* queue.recheck
        // A new commit, conflicting still, is said.
        yield* repository.commit(ticket.worktree, "More (a)", { "shared.txt": "a again\n" })
        yield* queue.recheck
        // Fixed now, with what main has.
        yield* repository.commit(ticket.worktree, "Fix (a)", { "shared.txt": "main\n" })
        const back = yield* queue.recheck
        yield* queue.settled
        return back
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
        ReadonlyArray<string>,
        unknown,
        Env | Scope.Scope
      >,
    )
    expect(ofResult(ran)).toEqual(["a"])
    expect(ran.log.filter((text) => text.includes("still conflicts"))).toHaveLength(2)
  })
})

/** A ticket an earlier run left Blocked and labelled, fixed since, then `body`. */
const leftBehind = <A>(
  fields: { readonly labels?: ReadonlyArray<string>; readonly fixed?: boolean } = {},
  config: { readonly ticket?: TicketId } = {},
  body: (ticket: FinishedTicket) => Effect.Effect<A, unknown, Env | Ledger | Scope.Scope>,
) =>
  scenario(
    {
      backlog: backlog()
        .ticket("root", { type: "epic" })
        .ticket("t-1", {
          status: "closed",
          labels: fields.labels ?? [unmergedLabel],
          ...(config.ticket === undefined ? {} : { parent: "elsewhere" as TicketId }),
        }).seeds,
      ...(config.ticket === undefined ? {} : { config }),
    },
    Effect.gen(function* () {
      const ticket = yield* branched("t-1" as TicketId, "Blocked")
      if (fields.fixed !== false) yield* fix(ticket)
      return yield* body(ticket)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<A, unknown, Env | Scope.Scope>,
  )

describe("a ticket an earlier run left unmerged on its conflict", () => {
  const queued = Effect.gen(function* () {
    const queue = yield* makeQueue(options)
    const back = yield* queue.recheck
    yield* queue.settled
    return back
  })

  test("is taken back, entering the run, and merges", async () => {
    const ran = await leftBehind({}, {}, () =>
      Effect.gen(function* () {
        const back = yield* queued
        const state = yield* (yield* Ledger).current
        return {
          back,
          phase: phaseOf(state, "t-1"),
          record: yield* (yield* Store).ticket("t-1" as TicketId),
        }
      }),
    )
    expect(ofResult(ran)).toEqual({ back: ["t-1"], phase: "Done", record: undefined })
    expect(ran.issues.find((issue) => issue.id === "t-1")?.labels).toEqual([])
    const moves = ran.events.flatMap((record) => (record.kind === "phase" ? [record] : []))
    expect(moves[0]?.cause).toBe("TakenBack")
    expect(moves[0]?.from).toBeUndefined()
  })

  test("not labelled any more, is let be", async () => {
    const ran = await leftBehind({ labels: [] }, {}, () => queued)
    expect(ofResult(ran)).toEqual([])
  })

  test("outside the run's scope, is let be", async () => {
    const ran = await leftBehind({}, { ticket: "root" as TicketId }, () => queued)
    expect(ofResult(ran)).toEqual([])
    expect(takenBack(ran)).toEqual([])
  })

  test("with no commit kept, can't be told from one left as it was", async () => {
    const ran = await leftBehind({}, {}, () =>
      Effect.andThen(
        Effect.flatMap(Store, (store) => store.unsetMetadata("t-1" as TicketId, conflictHeadKey)),
        queued,
      ),
    )
    expect(ofResult(ran)).toEqual([])
  })

  test("is something to run: fixedLeft names it, once fixed and clean", async () => {
    const fixedNow = fixedLeft(options)
    const fixed = await leftBehind({}, {}, () => fixedNow)
    expect([...ofResult(fixed)] as ReadonlyArray<string>).toEqual(["t-1"])
    const notFixed = await leftBehind({ fixed: false }, {}, () => fixedNow)
    expect([...ofResult(notFixed)]).toEqual([])
    const unlabelled = await leftBehind({ labels: [] }, {}, () => fixedNow)
    expect([...ofResult(unlabelled)]).toEqual([])
  })

  test("conflicting again: Blocked with no hand-back, its new commit kept", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const id = "t-1" as TicketId
    const ran = await scenario(
      {
        backlog: backlog().ticket("t-1", { status: "closed", labels: [unmergedLabel] }).seeds,
        config: {
          repo,
          settings: {
            ...defaults,
            checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
          },
        },
        git: { dir: repo },
        worktrees: { root },
      },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        const store = yield* Store
        const worktree = join(root, "t-1")
        mkdirSync(worktree)
        yield* git.addWorktree(repo, worktree, { branch: "tutti/t-1", base: "main" })
        yield* repository.commit(worktree, "Do it (t-1)", { "t.txt": "t\n" })
        yield* store.updateTicket(id, (record) => ({
          ...record,
          session: "session-t-1",
          worktree,
          branch: "tutti/t-1",
          phase: "Blocked" as const,
        }))
        yield* keepConflictHead({ id, branch: "tutti/t-1" }, { repo })
        yield* repository.commit(repo, "Main moves", { "m.txt": "m\n" })
        const fixed = yield* repository.commit(worktree, "Fix (t-1)", { "fix.txt": "fix\n" })
        // merge-tree finds no conflict, but the rebase stops on one.
        yield* repository.conflict("tutti/t-1", ["t.txt"])
        const outcome = yield* Effect.scoped(run({ version: "0.1.0-test", base: "main" }))
        const kept = (yield* store.metadata(id))[conflictHeadKey]
        const again = yield* fixedLeft({ repo, base: "main" })
        return { outcome, fixed, kept, again: [...again] }
      }),
    )
    const seen = ofResult(ran)
    expect(seen.outcome.phases["t-1"]?._tag).toBe("Blocked")
    expect(seen.kept).toBe(seen.fixed)
    expect(seen.again).toHaveLength(0)
    expect(ran.sent).toEqual([])
    expectLog(ran, [
      /^ {2}TAKEN_BACK: tutti\/t-1 moved on to [0-9a-f]{7} since its conflict and rebases cleanly onto main now: back in the merge queue$/,
      /^ {2}MERGE_CONFLICT: t-1 closed, but tutti\/t-1 conflicts with main in t\.txt, which moved on while it ran \(not handed back to its worker: you fixed its branch by hand, so its worker isn't handed it\)/,
    ])
    expect(ran.issues.find((issue) => issue.id === "t-1")?.labels).toEqual([unmergedLabel])
  })
})

describe("Needs you", () => {
  const needs = (phase: TicketPhase) =>
    project({
      ledger: {
        tickets: new Map([
          [
            "a" as TicketId,
            {
              ticket: "a" as TicketId,
              title: "Title",
              phase,
              since: 0,
              worker: null,
              row: 0,
              rechecking: false,
              steered: false,
              lastMessage: null,
              tallies: emptyTallies,
            },
          ],
        ]),
        rows: 1,
        windDown: null,
        bugs: [],
      },
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, concurrency: 1 },
    }).needs.map((need) => need.ticket)

  test("drops the ticket as it leaves Blocked", () => {
    expect(needs(TicketPhase.Blocked({ why: "MERGE_CONFLICT" }))).toEqual(["a" as TicketId])
    expect(needs(TicketPhase.ToMerge({ place: 1 }))).toEqual([])
  })
})
