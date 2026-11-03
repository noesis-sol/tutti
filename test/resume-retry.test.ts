// A resume that fails in a way that may pass (sessions.ts' resume, resumeRetry): Claude Code not
// spawned for want of memory or processes, or no initialize answer within its limit, as on a
// machine short of memory. It is tried once more resumeRetry later; failing again, its ticket is
// left for review, WORKER_GONE, but its record is kept in state.json, suspended, for a later run
// to resume, rather than forgotten with its session's ID.
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber } from "effect"
import { AgentStartFailed } from "../src/agent/AgentHost.ts"
import { launchFailed, transientStart } from "../src/agent/sessionChecks.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import { resumeFailedWhy, resumeGone, resumeRetry, workerGone } from "../src/run/sessions.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Store } from "../src/services/Store.ts"
import { failStart } from "../src/testing/AgentHost.ts"
import { advance, backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const id = "t-1" as TicketId
const tiny = backlog().ticket(id, { title: "One ticket" })
const short = "Claude Code couldn't be spawned: spawn claude EAGAIN"

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Lets every fiber that can go on run, in real time: TestClock holds only sleeps. */
const settle = Effect.promise(() => Bun.sleep(20))

/** Runs `effect` in a fiber, moving the clock on by `step` until it is done. */
const advancing = <A, E, R>(effect: Effect.Effect<A, E, R>, step = Duration.seconds(10)) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    for (let i = 0; i < 60 && fiber.pollUnsafe() === undefined; i++) {
      yield* settle
      yield* advance(step)
    }
    return yield* Fiber.join(fiber)
  })

/** The ticket's session saved, then `body`, in the ticket's scripted sessions `scripts`. */
const resuming = <A, E>(
  scripts: ReadonlyArray<ReadonlyArray<ReturnType<typeof failStart>>>,
  body: Effect.Effect<A, E, Ledger | Env>,
) =>
  scenario(
    { backlog: tiny.seeds, scripts: { [id]: scripts.map((steps) => [...steps]) } },
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.saveSession(id, { session: "s-1", worktree: "/w/t-1", branch: "tutti/t-1" })
      return yield* body
    }).pipe(Effect.provide(Ledger.layer)),
  )

const resumes = (ran: Ran<unknown>) => ran.sent.filter((sent) => sent._tag === "Resumed").length

describe("transientStart", () => {
  test("takes a spawn that failed, or one short of the machine's resources, for one that may pass", () => {
    expect(transientStart("Claude Code failed to launch: libc")).toBe(true)
    expect(transientStart("spawn claude EAGAIN")).toBe(true)
    expect(transientStart("Cannot allocate memory (ENOMEM)")).toBe(true)
    expect(transientStart("No conversation found with session ID s-1")).toBe(false)
    expect(transientStart(launchFailed)).toBe(false)
  })

  test("is said by AgentStartFailed only when given", () => {
    expect(new AgentStartFailed({ ticket: id, reason: "x" }).transient).toBeUndefined()
  })
})

describe("a resume that fails in a way that may pass", () => {
  test("is tried once more resumeRetry later, and goes on once it resumes", async () => {
    const ran = await resuming([[failStart(short)], []], advancing(resumeGone(id, "exit 1")))
    expect(resultOf(ran)._tag).toBe("Resumed")
    expectLog(ran, [
      `  ${id}'s session s-1 could not be resumed (${short}); trying again in ${Duration.format(resumeRetry)}`,
      /^ {2}RESUMED: t-1's worker is gone/,
    ])
  })

  test("failing again, leaves its ticket for review with its record kept, suspended", async () => {
    const ran = await resuming(
      [[failStart(short)], [failStart(short)]],
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition(id, Move.Ready(), { title: "One ticket" })
        yield* ledger.transition(id, Move.Dispatched())
        const back = yield* advancing(resumeGone(id, "exit 1"))
        if (back._tag !== "Failed") return { back, record: undefined }
        yield* workerGone({
          ticket: id,
          worktree: "/w/t-1",
          why: back.reason,
          transient: back.transient,
        })
        return { back, record: yield* (yield* Store).ticket(id) }
      }),
    )
    const { back, record } = resultOf(ran)
    expect(back).toEqual(expect.objectContaining({ _tag: "Failed", transient: true }))
    expect(resumes(ran)).toBe(2)
    expect(record).toEqual(
      expect.objectContaining({ session: "s-1", suspended: resumeFailedWhy, phase: "Review" }),
    )
    expectLog(ran, [
      /^ {2}WORKER_GONE: t-1 is in progress, but its worker is gone and its session could not be resumed \(.*EAGAIN.*\); worktree \/w\/t-1 left for review, no longer followed; its session is kept, and the next run resumes it; or finish it by hand$/,
    ])
  })

  test("of another kind is not tried again, and its record is forgotten", async () => {
    const ran = await resuming(
      [[failStart("No conversation found with session ID")], []],
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition(id, Move.Ready(), { title: "One ticket" })
        yield* ledger.transition(id, Move.Dispatched())
        const back = yield* resumeGone(id, "exit 1")
        if (back._tag !== "Failed") return { back, record: undefined }
        yield* workerGone({
          ticket: id,
          worktree: "/w/t-1",
          why: back.reason,
          transient: back.transient,
        })
        return { back, record: yield* (yield* Store).ticket(id) }
      }),
    )
    const { back, record } = resultOf(ran)
    expect(back).toEqual(expect.objectContaining({ _tag: "Failed", transient: false }))
    expect(resumes(ran)).toBe(1)
    expect(record).toBeUndefined()
  })
})
