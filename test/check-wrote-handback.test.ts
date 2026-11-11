// What a hand-back, and a check once more, make of untracked files tutti's own check wrote in the
// worktree (checkWrote.ts' leftUntracked): a coverage report the project doesn't git-ignore, left
// by the merge check that failed, by a check ahead of the ticket's turn, or by an earlier turn's.
// The check would see them but the merge not bring them in, so a fix or resolution is refused for
// an untracked file its worker left (handback-untracked.test.ts); one tutti's check left is tutti's
// own, and doesn't count. Each scenario runs a merge queue with scripted workers and checks; a
// worker commits its own paths alone (git commit --only), as a real one does, so what the check
// wrote stays untracked.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git, type StatusEntry } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  init,
  result,
  run,
  type SessionScript,
  sessionState,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Scripted } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, type Scripts, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** The default settings with a check command, `merge` laid over the default merge settings. */
const settings = (merge: Partial<typeof defaults.merge> = {}) => ({
  ...defaults,
  checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  merge: { ...defaults.merge, ...merge },
})

/** A failing check, its lines saying what failed: in a's file by default. */
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

/** The file the project's check writes and doesn't git-ignore. */
const coverage: Files = { "coverage/lcov.info": "TN:\nSF:a.ts\n" }

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** Which ticket a check ran for: its worktree's name. */
const whose = (run: CheckRun): string => run.cwd.split("/").at(-1) ?? ""

/** Where each ticket's worktree is, once `finished` has made it: for the scripts. */
const worktrees = new Map<string, string>()
const worktreeOf = (id: string) => worktrees.get(id) ?? ""

/** The repository and git, once the scenario has made them, for the checks and workers. */
interface Reach {
  repository: Repository["Service"]
  git: Git["Service"]
}

/** The worker's first session: it finished its ticket, idle, then plays `then`. */
const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

/** The worker committing `files` in its worktree, those paths alone, its commit message `message`. */
const committing = (reach: Reach, id: string, message: string, files: Files) =>
  run(
    Effect.suspend(() => {
      const worktree = worktreeOf(id)
      const paths = Object.keys(files)
      return Effect.orDie(
        Effect.andThen(
          reach.repository.write(worktree, files),
          Effect.andThen(
            reach.git.addPaths(worktree, paths),
            reach.git.commitPaths(worktree, message, paths),
          ),
        ),
      )
    }),
  )

/** The worker writing `files` in its worktree and leaving them untracked. */
const leaving = (reach: Reach, id: string, files: Files) =>
  run(Effect.suspend(() => reach.repository.write(worktreeOf(id), files)))

/** A hand-back turn in which the worker commits a fix naming the ticket. */
const fixes = (reach: Reach, id: string, files: Files = { "fix.txt": "fixed\n" }) =>
  turn([committing(reach, id, `Fix the check (${id})`, files)])

/** A hand-back turn in which the worker resolves the rebase's conflict, writing `files`. */
const resolves = (reach: Reach, id: string, files: Files) =>
  turn([
    run(
      Effect.suspend(() => Effect.asVoid(reach.repository.continueRebase(worktreeOf(id), files))),
    ),
  ])

/** Another ticket's merge landing `files` on main, as a worker's turn plays. */
const landing = (reach: Reach, files: Files) =>
  run(
    Effect.suspend(() =>
      Effect.asVoid(reach.repository.commit(reach.repository.dir, "Land something else", files)),
    ),
  )

/**
 * A check that writes `files` into the worktree it runs in, as a check with a coverage report does,
 * then goes as `then` says: fails with it, or passes.
 */
const writing =
  (reach: Reach, files: Files, then: Effect.Effect<void, CheckFailed> = Effect.void): Scripted =>
  (run) =>
    Effect.gen(function* () {
      yield* reach.repository.write(run.cwd, files)
      yield* then
      return { ...passed("fast"), command: check }
    })

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads,
 * Working in the ledger, its session started and saved, and its worker idle.
 */
const finished = (id: TicketId, files: Files) =>
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

/** Waits until every ticket named is in its phase. */
const until = (phases: Readonly<Record<string, PhaseTag>>) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state: State) =>
        Object.entries(phases).every(
          ([id, phase]) => state.tickets.get(id as TicketId)?.phase._tag === phase,
        ),
      ),
      Stream.runHead,
    )
  })

interface Ended {
  readonly phases: Record<string, PhaseTag>
  /** main's files at the end. */
  readonly main: ReadonlyMap<string, string>
  /** The untracked files in each ticket's worktree at the end, as git has them; none once removed. */
  readonly untracked: Record<string, ReadonlyArray<string>>
}

/**
 * Runs `body` with a merge queue in a scope of its own, the checks and workers scripted, and hands
 * back each ticket's phase, main's files and what is untracked in each worktree.
 */
const merging = (
  plan: {
    readonly tickets: ReadonlyArray<string>
    readonly settings?: Partial<typeof defaults.merge>
    readonly checks: (reach: Reach) => ReadonlyArray<Scripted>
    readonly scripts: (reach: Reach) => Scripts
  },
  body: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger | Scope.Scope>,
) => {
  const reach = {} as Reach
  let seeds = backlog()
  for (const id of plan.tickets) seeds = seeds.ticket(id)
  return scenario(
    {
      config: { settings: settings(plan.settings) },
      backlog: seeds.seeds,
      checks: { fast: plan.checks(reach) },
      scripts: () => plan.scripts(reach),
    },
    Effect.gen(function* () {
      reach.repository = yield* Repository
      reach.git = yield* Git
      const queue = yield* makeQueue(options)
      yield* body(queue)
      const untracked: Record<string, ReadonlyArray<string>> = {}
      for (const id of plan.tickets) {
        const status = yield* reach.git
          .status(worktreeOf(id))
          .pipe(Effect.orElseSucceed((): ReadonlyArray<StatusEntry> => []))
        untracked[id] = status.filter((entry) => entry.code === "??").map((entry) => entry.path)
      }
      return {
        phases: tagsOf(yield* (yield* Ledger).current),
        main: yield* reach.repository.tree("main"),
        untracked,
      } satisfies Ended
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )
}

/** a finished, main moved on with `landed`, a offered; the queue settles. */
const aAlone = (
  plan: Omit<Parameters<typeof merging>[0], "tickets">,
  landed: Files = { "b.txt": "b\n" },
) =>
  merging({ ...plan, tickets: ["a"] }, (queue) =>
    Effect.gen(function* () {
      const repository = yield* Repository
      const a = yield* finished("a" as TicketId, { "a.txt": "a\n" })
      yield* repository.commit(repository.dir, "Land something else", landed)
      yield* queue.offer(a)
      yield* queue.settled
    }),
  )

const fixingLine = (attempt: number) =>
  `  FIXING: '${check}' fails on tutti/a rebased onto main; handed back to its worker to fix (${attempt} of 2, up to 20m)`

describe("a fix after a merge check that failed, having written an untracked file", () => {
  test("is accepted and merges, the file left to the worktree's removal", async () => {
    const ran = await aAlone({
      checks: (reach) => [writing(reach, coverage, Effect.fail(failing()))],
      scripts: (reach) => ({ a: [finishedSession(fixes(reach, "a"))] }),
    })
    const ended = resultOf(ran)
    expectLog(ran, [
      fixingLine(1),
      `  '${check}' passes on tutti/a as its worker fixed it`,
      /^ {2}a closed \([0-9a-f]{7} .*\); merged into main, worktree and branch removed$/,
    ])
    expect(ended.phases).toEqual({ a: "Done" })
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
    expect(ran.log.some((text) => text.includes("untracked files"))).toBe(false)
    expect(ran.checkRuns.map(whose)).toEqual(["a", "a"])
    expect(ended.main.get("fix.txt")).toBe("fixed\n")
    expect(ended.main.has("coverage/lcov.info")).toBe(false)
  })

  test("in the second round too, the check having written the file again on the first fix", async () => {
    const ran = await aAlone({
      checks: (reach) => [
        writing(reach, coverage, Effect.fail(failing())),
        writing(reach, coverage, Effect.fail(failing("error: a.test.ts: expected 2"))),
        writing(reach, coverage),
      ],
      scripts: (reach) => ({
        a: [
          finishedSession([
            ...fixes(reach, "a", { "fix.txt": "first\n" }),
            ...fixes(reach, "a", { "fix.txt": "second\n" }),
          ]),
        ],
      }),
    })
    const ended = resultOf(ran)
    expectLog(ran, [fixingLine(1), fixingLine(2), /^ {2}a closed .*; merged into main/])
    expect(ended.phases).toEqual({ a: "Done" })
    expect(ran.log.some((text) => text.includes("untracked files"))).toBe(false)
    expect(ran.checkRuns.map(whose)).toEqual(["a", "a", "a"])
    expect(ended.main.get("fix.txt")).toBe("second\n")
    expect(ended.main.has("coverage/lcov.info")).toBe(false)
  })

  test("is still rejected for a file its worker left beside it, naming the worker's alone", async () => {
    const ran = await aAlone({
      checks: (reach) => [writing(reach, coverage, Effect.fail(failing()))],
      scripts: (reach) => ({
        a: [
          finishedSession(
            turn([
              committing(reach, "a", "Fix the check (a)", { "fix.txt": "fixed\n" }),
              leaving(reach, "a", { "src/util.ts": "export const util = 1\n" }),
            ]),
          ),
        ],
      }),
    })
    const ended = resultOf(ran)
    expectLog(ran, [
      fixingLine(1),
      /^ {2}CHECKS_FAILED: a closed, but .* after it was handed back to its worker to fix once \(see its notes\)/,
    ])
    expect(ended.phases).toEqual({ a: "Review" })
    const notes = ran.issues.find((issue) => issue.id === "a")?.notes ?? ""
    expect(notes).toMatch(/its worker left untracked files in \S+: src\/util\.ts\b/)
    expect(notes).not.toContain("coverage/lcov.info")
    // The check ran once: the fix was not checked.
    expect(ran.checkRuns.map(whose)).toEqual(["a"])
    expect(ended.main.has("fix.txt")).toBe(false)
    expect(ended.untracked.a).toEqual(["coverage/lcov.info", "src/util.ts"])
  })
})

describe("a resolution after an earlier check of tutti's wrote an untracked file in the worktree", () => {
  test("after a check ahead of its turn: the conflict in its turn is resolved and merges", async () => {
    // b's check ahead of its turn, on top of tutti/a, writes its coverage report and passes. a's
    // check waits for it, then lands a change to b.txt on main and passes: a is rebased onto main
    // again and merges, and b, put back, conflicts with main in its turn and is handed back.
    const bPassed = Deferred.makeUnsafe<void>()
    const ran = await merging(
      {
        tickets: ["a", "b"],
        settings: { train: 1 },
        checks: (reach) => {
          const counts = new Map<string, number>()
          const one: Scripted = (run) => {
            const id = whose(run)
            const nth = (counts.get(id) ?? 0) + 1
            counts.set(id, nth)
            const play =
              id === "b" && nth === 1
                ? Effect.andThen(
                    reach.repository.write(run.cwd, coverage),
                    Deferred.succeed(bPassed, undefined),
                  )
                : id === "a" && nth === 1
                  ? Effect.andThen(
                      Deferred.await(bPassed),
                      reach.repository.commit(reach.repository.dir, "Land b's file", {
                        "b.txt": "main's b\n",
                      }),
                    )
                  : Effect.void
            return Effect.as(play, { ...passed("fast"), command: check })
          }
          return Array.from({ length: 8 }, () => one)
        },
        scripts: (reach) => ({
          a: [finishedSession()],
          b: [finishedSession(resolves(reach, "b", { "b.txt": "both\n" }))],
        }),
      },
      (queue) =>
        Effect.gen(function* () {
          const repository = yield* Repository
          const a = yield* finished("a" as TicketId, { "a.txt": "a\n" })
          const b = yield* finished("b" as TicketId, { "b.txt": "b\n" })
          yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
        }),
    )
    const ended = resultOf(ran)
    expectLog(ran, [
      "  checking tutti/b ahead of its turn to merge, rebased onto tutti/a as it is checked",
      /^ {2}RESOLVING: tutti\/b conflicts with main in b\.txt; handed back to its worker to resolve/,
      `  b's worker finished the rebase; checking it with '${check}'`,
      /^ {2}b closed .*; merged into main/,
    ])
    expect(ended.phases).toEqual({ a: "Done", b: "Done" })
    expect(ran.log.some((text) => text.includes("untracked files"))).toBe(false)
    expect(ended.main.get("a.txt")).toBe("a\n")
    expect(ended.main.get("b.txt")).toBe("both\n")
  })

  test("after an earlier turn's failed check: the fix is accepted and the conflict resolved", async () => {
    // a's check fails, writing its coverage report; its worker's fix turn lands a conflicting
    // change on main first, as another ticket's merge would, then commits the fix: the fix is
    // carried to a rebase, which conflicts, and the resolution is checked in the same worktree.
    const ran = await aAlone({
      checks: (reach) => [
        writing(reach, coverage, Effect.fail(failing())),
        writing(reach, coverage),
      ],
      scripts: (reach) => ({
        a: [
          finishedSession([
            ...turn([
              landing(reach, { "a.txt": "main's a\n" }),
              committing(reach, "a", "Fix the check (a)", { "fix.txt": "fixed\n" }),
            ]),
            ...resolves(reach, "a", { "a.txt": "both\n" }),
          ]),
        ],
      }),
    })
    const ended = resultOf(ran)
    expectLog(ran, [
      fixingLine(1),
      "  a's worker committed 1 commit, but main moved on meanwhile: rebasing tutti/a onto it before checking it",
      /^ {2}RESOLVING: tutti\/a conflicts with main in a\.txt/,
      `  a's worker finished the rebase; checking it with '${check}'`,
      /^ {2}a closed .*; merged into main/,
    ])
    expect(ended.phases).toEqual({ a: "Done" })
    expect(ran.log.some((text) => text.includes("untracked files"))).toBe(false)
    expect(ended.main.get("a.txt")).toBe("both\n")
    expect(ended.main.get("fix.txt")).toBe("fixed\n")
    expect(ended.main.has("coverage/lcov.info")).toBe(false)
  })
})

describe("a ticket set aside as its check failed, having written an untracked file", () => {
  test("is checked once more when main moves on, and merges", async () => {
    // a's check fails and, hand-backs off, a is set aside at once; b merges, moving main on, and
    // a is put back to be checked once more: its worktree has only the check's file.
    const ran = await merging(
      {
        tickets: ["a", "b"],
        settings: { check_hand_backs: 0 },
        checks: (reach) => [
          writing(reach, coverage, Effect.fail(failing("shared/b.go:12: expected 1"))),
        ],
        scripts: () => ({ a: [finishedSession()], b: [finishedSession()] }),
      },
      (queue) =>
        Effect.gen(function* () {
          const repository = yield* Repository
          const a = yield* finished("a" as TicketId, { "a/a.go": "a\n" })
          yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
          yield* queue.offer(a)
          yield* until({ a: "Review" })
          yield* queue.offer(yield* finished("b" as TicketId, { "b/b.go": "b\n" }))
          yield* until({ a: "Done", b: "Done" })
          yield* queue.settled
        }),
    )
    const ended = resultOf(ran)
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, but/,
      /^ {2}RECHECK: a's check failed on main at [0-9a-f]{7}/,
      /^ {2}a closed .*; merged into main/,
    ])
    expect(ended.phases).toEqual({ a: "Done", b: "Done" })
    expect(ran.log.some((text) => text.includes("is not checked again"))).toBe(false)
    // a's check, b's, then a's once more.
    expect(ran.checkRuns.map(whose)).toEqual(["a", "b", "a"])
    expect(ended.main.get("a/a.go")).toBe("a\n")
    expect(ended.main.has("coverage/lcov.info")).toBe(false)
  })
})
