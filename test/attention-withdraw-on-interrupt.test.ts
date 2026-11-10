// A request whose session closes as it opens is withdrawn (tutti-34k9.8): the interrupt of wait
// covers the request from the moment it is among the open ones, including its announcement, which
// waits for the log's permit. And an answer under way, interrupted the same, is whole.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { BunFileSystem } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Attention } from "../src/agent/Attention.ts"
import { requestFile, serve } from "../src/agent/attentionFiles.ts"
import { sessionFibers } from "../src/agent/callbacks.ts"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { Log } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { openFibers } from "./fibers.ts"

type Env = Attention | Log | EventStream | Captured | TestClock.TestClock | Scope.Scope

const tempRepo = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-attention-interrupt-")))

/**
 * Runs `effect` with the Attention test layer (every request waits for an answer) over captured
 * logs and events, and the run's side of the attention files in `repo` serving it.
 */
const run = <A, E>(repo: string, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.andThen(serve({ repo, poll: "1 hour" }), effect)).pipe(
      Effect.provide(
        attentionLayer().pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer(), BunFileSystem.layer)),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

const sdkOptions = (): Parameters<CanUseTool>[2] => ({
  signal: new AbortController().signal,
  toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
  requestId: "req",
})

const ticket = "tut-1" as TicketId
const bash = { command: "touch made-by-bash.txt" }
const withdrawnLine = "  PERMISSION: tut-1's worker: Bash(touch made-by-bash.txt) withdrawn"

/** Looks for `check` to hold up to 500 times, 10 ms of real time apart. */
const until = <R>(what: string, check: Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      if (yield* check) return
      yield* Effect.promise(() => Bun.sleep(10))
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`))
  })

/** Whether the promise has settled, either way, by the time it is asked. */
const settling = (promise: Promise<unknown>) => {
  let settled = false
  const mark = () => {
    settled = true
  }
  promise.then(mark, mark)
  return () => settled
}

/**
 * Holds the log's permit until the Deferred it gives is opened, from a fiber of its own: writeWith
 * holds the permit for its record, so an announcement or an answer's line waits for it.
 */
const holdLog = Effect.gen(function* () {
  const logs = yield* Log
  const held = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  yield* Effect.forkScoped(
    logs.writeWith([], Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))),
  )
  yield* Deferred.await(held)
  return release
})

const records = Effect.flatMap(Captured, (captured) => captured.records)

const answeredRecords = (all: ReadonlyArray<EventRecord>) =>
  all.filter(
    (r): r is Extract<EventRecord, { kind: "attention_answered" }> =>
      r.kind === "attention_answered",
  )

const openIds = Effect.map(
  Effect.flatMap(Attention, (a) => a.current),
  (all) => all.map((r) => r.id),
)

describe("Attention: a request whose session closes as it opens", () => {
  test("is withdrawn from the open ones and the attention folder", async () => {
    const repo = tempRepo()
    const seen = await run(
      repo,
      Effect.gen(function* () {
        const attention = yield* Attention
        const release = yield* holdLog
        // The session's FiberSet, in a scope the test closes as the session's would.
        const session = yield* Scope.make()
        const fibers = yield* Scope.provide(sessionFibers, session)
        const canUseTool = yield* attention.request(ticket, fibers)
        const settled = settling(canUseTool("Bash", bash, sdkOptions()))
        // The request is open and its file written while its announcement waits for the log.
        yield* until(
          "the request file",
          Effect.sync(() => existsSync(join(repo, requestFile("r1")))),
        )
        expect(yield* openIds).toEqual(["r1"])
        expect(yield* texts).toEqual([])

        // The session closes: its fibers are interrupted where they wait. The withdrawal takes the
        // request out of the open ones at once, and waits for the log's permit to record it, so the
        // close is left to finish on its own, and the call doesn't settle before.
        const closing = yield* Effect.forkScoped(Scope.close(session, Exit.void))
        yield* until(
          "the request to be taken",
          Effect.map(openIds, (ids) => ids.length === 0),
        )
        yield* Effect.promise(() => Bun.sleep(30))
        const settledBefore = settled()

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(closing)
        yield* until(
          "the request to be withdrawn",
          Effect.map(openIds, (ids) => ids.length === 0),
        )
        yield* until(
          "the request file to go",
          Effect.sync(() => !existsSync(join(repo, requestFile("r1")))),
        )
        yield* until("the call to settle", Effect.sync(settled))
        return {
          settledBefore,
          log: yield* texts,
          events: answeredRecords(yield* records),
          tally: yield* attention.tally(ticket),
        }
      }),
    )
    expect(seen.settledBefore).toBe(false)
    expect(seen.log).toEqual([withdrawnLine])
    expect(seen.events).toHaveLength(1)
    expect(seen.events[0]).toMatchObject({ ticket, request: "r1", cancelled: true })
    expect(seen.events[0]?.answer).toBeUndefined()
    expect(seen.tally.cancelled).toBe(1)
  })

  test("an answer interrupted as it waits for the log is still whole", async () => {
    const repo = tempRepo()
    const seen = await run(
      repo,
      Effect.gen(function* () {
        const attention = yield* Attention
        const canUseTool = yield* attention.request(ticket, openFibers())
        let outcome: PermissionResult | null | undefined
        canUseTool("Bash", bash, sdkOptions()).then((value) => {
          outcome = value
        })
        yield* until(
          "the request to open",
          Effect.map(openIds, (ids) => ids.length === 1),
        )
        const release = yield* holdLog
        const answering = yield* Effect.forkScoped(
          attention.answer("r1", { _tag: "Allow" }, "answer_command"),
        )
        // Taken out of the open ones, its line waiting for the log: the interrupt doesn't lose it.
        yield* until(
          "the request to be taken",
          Effect.map(openIds, (ids) => ids.length === 0),
        )
        const interrupting = yield* Effect.forkScoped(Fiber.interrupt(answering))
        yield* Effect.promise(() => Bun.sleep(30))
        const settledBefore = outcome !== undefined
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)
        yield* until(
          "the call to settle",
          Effect.sync(() => outcome !== undefined),
        )
        return { settledBefore, outcome, log: yield* texts, open: yield* openIds }
      }),
    )
    expect(seen.settledBefore).toBe(false)
    expect(seen.outcome?.behavior).toBe("allow")
    expect(seen.open).toEqual([])
    expect(seen.log.at(-1)).toStartWith(
      "  PERMISSION: tut-1's worker: Bash(touch made-by-bash.txt) allowed",
    )
  })
})
