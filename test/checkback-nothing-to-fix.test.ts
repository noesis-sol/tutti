// A check hand-back whose worker finds nothing to fix and commits nothing (tutti-kkb.7), as
// orchestra's checkRebased has it (orchestra-2jwy): the check runs a second time, and a pass merges
// the ticket, while a second failure sets it aside with no further hand-back.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { init, result, type SessionScript, sessionState, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, type Setup, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const check = "scripts/check-fast.sh"

/** The default settings with a check command. */
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    },
  },
} satisfies Setup

/** A failing check, its lines saying what failed: a test timing out on a loaded machine. */
const failing = () =>
  new CheckFailed({
    check: "fast",
    command: check,
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: ["error: a.test.ts: timed out after 5000ms"],
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

/** The worker's first session: it finished its ticket, idle, then plays `then`. */
const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

/** A hand-back turn in which the worker reruns what failed, sees it pass, and commits nothing. */
const commitsNothing = turn([])

/**
 * Ticket a its worker finished: its worktree on tutti/a with a commit naming it, closed in Beads,
 * Working in the ledger, its session started and saved, and its worker idle.
 */
const finished = Effect.gen(function* () {
  const git = yield* Git
  const repository = yield* Repository
  const worktree = yield* (yield* Worktrees).prepare("a" as TicketId)
  yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
  yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
  yield* (yield* Beads).close("a" as TicketId, "done")
  const ledger = yield* Ledger
  yield* ledger.transition("a" as TicketId, Move.Ready(), { title: "Ticket a" })
  yield* ledger.transition("a" as TicketId, Move.Dispatched())
  yield* (yield* Store).saveSession("a" as TicketId, {
    session: "session-a",
    worktree: worktree.path,
    branch: worktree.branch,
  })
  yield* (yield* AgentHost).start("a" as TicketId, { sessionId: "session-a", cwd: worktree.path })
  yield* untilSettled("a" as TicketId)
  return {
    id: "a" as TicketId,
    title: "Ticket a",
    branch: worktree.branch,
    worktree: worktree.path,
  } satisfies FinishedTicket
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
 * Finishes ticket a, moves main on, offers a to the queue and waits until the queue settles, its
 * check failing as `checks` say and its worker committing nothing on each hand-back; then the
 * files on main and a's branch's tip.
 */
const merged = (checks: ReadonlyArray<CheckFailed>) => {
  const after = { files: new Map<string, string>() as ReadonlyMap<string, string>, tip: "" }
  const ran = scenario(
    {
      backlog: backlog().ticket("a").seeds,
      ...withCheck,
      checks: { fast: checks },
      scripts: () => ({ a: [finishedSession([...commitsNothing, ...commitsNothing])] }),
    },
    withQueue((queue) =>
      Effect.gen(function* () {
        const ticket = yield* finished
        const repository = yield* Repository
        yield* repository.commit(repository.dir, "Land something else", { "b.txt": "b\n" })
        yield* queue.offer(ticket)
        yield* queue.settled
        after.files = yield* repository.tree("main")
        after.tip = yield* repository.head(ticket.branch)
      }),
    ),
  )
  return ran.then((done) => ({ ran: done, ...after }))
}

/** The client_composed messages ticket a's worker was sent. */
const composed = (ran: Ran<unknown>) =>
  ran.sent.flatMap((item) =>
    item._tag === "Message" && item.ticket === "a" && item.message.client_composed === true
      ? [item.message.message.content as string]
      : [],
  )

describe("a check hand-back whose worker commits nothing", () => {
  test("is checked again, and merges when the second check passes", async () => {
    const { ran, files } = await merged([failing()])
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
    expectLog(ran, [
      `  FIXING: '${check}' fails on tutti/a rebased onto main; handed back to its worker to fix (1 of 2, up to 20m)`,
      `  '${check}' passes on tutti/a on a second run; its worker committed nothing`,
      /^ {2}a closed \([0-9a-f]{7} .*\); merged into main, worktree and branch removed$/,
    ])
    expect(ran.log.some((each) => each.includes("CHECKS_FAILED"))).toBe(false)
    // Handed back once, and checked twice: as it failed, and again on the branch as it was.
    expect(composed(ran)).toHaveLength(1)
    expect(ran.checkRuns).toHaveLength(2)
    expect(files.get("a.txt")).toBe("a\n")
  })

  test("is set aside when the second check fails too, with no further hand-back", async () => {
    const { ran, files, tip } = await merged([failing(), failing()])
    expect(resultOf(ran).a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expect(pathOf(ran, "a").slice(-3)).toEqual(["Merging", "Fixing", "Review"])
    expectLog(ran, [
      `  FIXING: '${check}' fails on tutti/a rebased onto main; handed back to its worker to fix (1 of 2, up to 20m)`,
      new RegExp(
        `^ {2}CHECKS_FAILED: a closed, but '${check}' fails on tutti/a rebased onto main, after it was handed back to its worker to fix once \\(see its notes\\)`,
      ),
    ])
    const notes = ran.issues.find((issue) => issue.id === "a")?.notes ?? ""
    expect(notes).toContain(
      `; it was handed back to its worker to fix once: (1) its worker committed nothing, and '${check}' fails again (output is in `,
    )
    expect(notes).toContain(
      "; not handed back again: its worker found nothing to fix; so a was set aside for review.",
    )
    // One hand-back, though an attempt is left, and two checks; main has nothing of a.
    expect(composed(ran)).toHaveLength(1)
    expect(ran.checkRuns).toHaveLength(2)
    expect(files.has("a.txt")).toBe(false)
    expect(tip).not.toBe("")
  })
})
