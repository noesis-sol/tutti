// A nudge cancelled by an interrupt is no longer outstanding (§ 4.2, § 4.8): its command_lifecycle
// `cancelled` answers it, and so does the interrupt's receipt or `cancel_async_message`, for a send
// no message of the session says was cancelled. The per-ticket fiber then goes on to its next nudge
// and PAUSED, rather than waiting on the nudge until the session ends.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Exit, Fiber, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { read } from "../src/agent/reading.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import { idleGrace, nudgeText } from "../src/run/settle.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Git } from "../src/services/Git.ts"
import { run, turn } from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, type Env, scenario, type World } from "./harness.ts"

const id = "t-1"
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished, cause = (place) => Move.Verified({ place })) =>
      ledger.transition(finished.id, cause(1)),
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

/** Waits, yielding, until the log has a line matching `pattern`, then a little more. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 20_000; i++) {
      if ((yield* texts).some((each) => pattern.test(each))) break
      yield* Effect.yieldNow
    }
    for (let i = 0; i < 200; i++) yield* Effect.yieldNow
  })

/** Lets every fiber run as far as it can without the clock moving. */
const quiet = Effect.gen(function* () {
  for (let i = 0; i < 2_000; i++) yield* Effect.yieldNow
})

const claim = (world: World) => Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true })))

describe("a nudge an interrupt cancels", () => {
  test("its command_lifecycle cancelled answers it; another send's doesn't", () => {
    const uuid = "00000000-0000-4000-8000-000000000002"
    const lifecycle = (state: string, command = uuid) =>
      read({ type: "command_lifecycle", command_uuid: command, state } as unknown as SDKMessage)
    expect(lifecycle("cancelled")).toEqual(expect.objectContaining({ ended: uuid }))
    expect(lifecycle("cancelled", "other")).toEqual(expect.objectContaining({ ended: "other" }))
  })

  test("a send only the receipt cancels is waited for until the receipt", async () => {
    const ran = await scenario(
      { scripts: () => ({ [id]: [turn([])] }) },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start(id, { sessionId: "s-1", cwd: "/work/t-1" })
        yield* host.send(id, "Go.", "clientComposed")
        yield* host.state(id).pipe(
          Stream.filter((state) => state._tag === "Idle"),
          Stream.runHead,
        )
        // The worker's steps have run out: the nudge stays queued until the interrupt cancels it.
        const uuid = yield* host.send(id, nudgeText(id), "clientComposed")
        const waiting = yield* Effect.forkChild(host.answered(id, uuid))
        yield* quiet
        expect(waiting.pollUnsafe()).toBeUndefined()
        const receipt = yield* host.interrupt(id)
        expect(receipt.cancelled).toEqual([uuid])
        yield* Fiber.join(waiting)
        return (yield* host.current(id))._tag
      }),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    expect(ran.exit.value).toBe("Idle")
  })

  test("the fiber goes on to its next nudge, then PAUSED after the grace", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-nudge-cancelled-")))
    const ran = await scenario(
      {
        backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
        worktrees: { root },
        // One turn, then nothing: each nudge stays queued until an interrupt cancels it.
        scripts: (world) => ({ [id]: [turn([run(claim(world))])] }),
      },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const git = yield* Git
        const host = yield* AgentHost
        const repository = yield* Repository
        yield* git.addWorktree(repository.dir, join(root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
        yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
        yield* ledger.transition(id, Move.Dispatched())
        const fiber = yield* Effect.forkChild(
          work(ticket, { base: "main", queue: yield* lineOnly }),
        )
        yield* untilLogged(/told it to continue \(1 of 2\)/)
        yield* Effect.orDie(host.interrupt(id))
        yield* untilLogged(/told it to continue \(2 of 2\)/)
        yield* Effect.orDie(host.interrupt(id))
        yield* quiet
        yield* advance(idleGrace)
        yield* advance(Duration.seconds(1))
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    expect(ran.exit.value.phase).toEqual(
      expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }),
    )
    const sent = ran.sent.flatMap((each) =>
      each._tag === "Message" && each.ticket === id ? [String(each.message.message.content)] : [],
    )
    expect(sent.slice(1)).toEqual([nudgeText(id), nudgeText(id)])
  })
})
