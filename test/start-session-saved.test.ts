// A start saves its session once Claude Code has made it, as the session's first system/init says
// (§ 4.8): one interrupted or failed before then ends the session and leaves none to resume.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import { type Start, type StartTicket, start } from "../src/run/start.ts"
import { Store, type TicketRecord } from "../src/services/Store.ts"
import { init, type SessionScript, run as step, wait } from "../src/testing/AgentHost.ts"
import { advance, backlog, expectLog, type Ran, scenario } from "./harness.ts"

const t1: StartTicket = { id: "t-1", title: "One ticket", metadata: {} }

/** What became of the start, and what state.json had on the ticket after it. */
interface Begun {
  readonly start: Exit.Exit<Start, unknown>
  readonly record: TicketRecord | undefined
}

/**
 * Starts t-1, whose session takes its first message and sends nothing more, its system/init never
 * coming unless `begins`; `then` does what happens next to the start's fiber. An earlier attempt's
 * session is in state.json first.
 */
const starting = (
  then: (started: Fiber.Fiber<Start, unknown>) => Effect.Effect<void>,
  begins = false,
): Promise<Ran<Begun>> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-start-saved-")))
  return Effect.runPromise(Deferred.make<void>()).then((taken) =>
    scenario(
      {
        backlog: backlog().ticket("t-1").seeds,
        scripts: {
          "t-1": [
            [
              wait,
              ...(begins ? [init()] : []),
              step(Deferred.succeed(taken, undefined)),
            ] satisfies SessionScript,
          ],
        },
        worktrees: { root },
      },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const store = yield* Store
        yield* store.saveSession("t-1", {
          session: "earlier",
          worktree: join(root, "t-1"),
          branch: "tutti/t-1",
        })
        // Suspended by a run whose carry-over this one kept, as when bd couldn't show it.
        yield* store.suspend("t-1", "quit", "Stopped")
        yield* ledger.transition("t-1", Move.Ready(), { title: t1.title })
        yield* ledger.transition("t-1", Move.Dispatched())
        const started = yield* Effect.forkChild(start(t1, "main"))
        yield* Deferred.await(taken)
        yield* then(started)
        return {
          start: yield* Fiber.await(started),
          record: yield* store.ticket("t-1"),
        } satisfies Begun
      }).pipe(Effect.provide(Ledger.layer)),
    ),
  )
}

const begun = (ran: Ran<Begun>): Begun => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("a start before its session begins", () => {
  test("interrupted, as a quit does: the session ended, and none saved to resume", async () => {
    const ran = await starting(Fiber.interrupt)
    const { start, record } = begun(ran)
    expect(Exit.hasInterrupts(start)).toBe(true)
    expect(ran.sent.map((sent) => sent._tag)).toEqual(["Started", "Message", "Closed", "Ended"])
    // Neither this start's session nor the earlier attempt's, nor the earlier suspension.
    expect(record?.session).toBeUndefined()
    expect(record?.suspended).toBeUndefined()
    expect(record?.phase).toBeUndefined()
  })

  test("its system/init not come within a minute: the start failed, the ticket set aside", async () => {
    const ran = await starting(() => advance("1 minute"))
    const { start, record } = begun(ran)
    expect(Exit.isSuccess(start) ? start.value : undefined).toMatchObject({
      _tag: "SetAside",
      why: "its worker didn't start",
    })
    expect(ran.sent.map((sent) => sent._tag)).toEqual(["Started", "Message", "Closed", "Ended"])
    expect(record?.session).toBeUndefined()
    expectLog(ran, [
      /START_FAILED: t-1's worker didn't start: its session didn't begin its first turn within 1m -> deferred/,
    ])
  })

  test("interrupted once its session has begun: the session saved for the run's end to suspend", async () => {
    const ran = await starting(Fiber.interrupt, true)
    const { record } = begun(ran)
    // Not ended: the quit interrupts and closes it, and saves it as suspended.
    expect(ran.sent.map((sent) => sent._tag)).toEqual(["Started", "Message"])
    const started = ran.sent[0]
    expect(record?.session).toBe(started?._tag === "Started" ? started.session.sessionId : "")
  })
})
