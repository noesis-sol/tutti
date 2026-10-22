// A ticket the run took up and left back in the queue as it ends (Waiting for a merge, a probe or
// a setup, Queued or HeldBack after it was requeued) gets its `ticket_end` at the run's end, with
// outcome `queued` (§ 10): no RunEnded moves it, but its workers' cost and time are its own.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { EventRecord } from "../src/run/events.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { Cause } from "../src/run/phase.ts"
import { run } from "../src/run/run.ts"
import { Spending } from "../src/run/spending.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as spendingLayer } from "../src/testing/Spending.ts"
import { backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const model = "claude-opus-5-5"

/** A result with the session's running totals: `cost` and `output` tokens. */
const resultMessage = (cost: number, output: number): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "DONE",
    num_turns: 3,
    duration_ms: 4000,
    duration_api_ms: 3000,
    total_cost_usd: cost,
    modelUsage: {
      [model]: {
        inputTokens: 1,
        outputTokens: output,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
  }) as unknown as SDKMessage

const endsOf = (records: ReadonlyArray<EventRecord>) =>
  records.flatMap((r) => (r.kind === "ticket_end" ? [r] : []))

/** The ledger over Spending and captured records, under TestClock: `body`'s records. */
const inLedger = (body: Effect.Effect<void, never, Ledger | Spending>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* body
      return (yield* (yield* Captured).records).filter((r) => r.kind !== "phase")
    }).pipe(
      Effect.provide(
        Ledger.layer.pipe(
          Layer.provideMerge(spendingLayer()),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer(), TestClock.layer())),
        ),
      ),
    ),
  )

describe("the ledger's ticket_end for the tickets left in the queue", () => {
  test("each one the run took up, with what it spent and what it waits for", async () => {
    const records = await inLedger(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const move = (ticket: string, cause: Cause) =>
          ledger.transition(ticket, cause, { title: ticket })
        for (const id of ["w", "s", "q", "h", "d"]) {
          yield* move(id, Cause.Ready())
          yield* move(id, Cause.Dispatched())
        }
        yield* move("n", Cause.Ready())
        yield* (yield* Spending).message("w", "s-w", resultMessage(0.25, 40))
        yield* TestClock.adjust(30_000)
        yield* move("w", Cause.WaitsForMerge({ for: "t-9" }))
        yield* move("s", Cause.SetupFailed())
        yield* move("q", Cause.WaitsForMerge({ for: "t-9" }))
        yield* move("q", Cause.Requeued())
        yield* move("h", Cause.WaitsForMerge({ for: "t-9" }))
        yield* move("h", Cause.Requeued())
        yield* move("h", Cause.Held({ why: "overlap" }))
        yield* move("d", Cause.NoChange())
        yield* TestClock.adjust(10_000)
        yield* ledger.endQueued
      }),
    )
    // n never left the queue, and d's part ended as it closed: neither gets one at the end.
    expect(endsOf(records).map((r) => [r.ticket, r.outcome, r.phase, r.why])).toEqual([
      ["d", "no_change", "Done", undefined],
      ["w", "queued", "Waiting", "t-9"],
      ["s", "queued", "Waiting", "setup"],
      ["q", "queued", "Queued", undefined],
      ["h", "queued", "HeldBack", "overlap"],
    ])
    expect(endsOf(records).find((r) => r.ticket === "w")).toEqual(
      expect.objectContaining({
        seconds: 40,
        turns: 3,
        phases: { working: 30 },
        hand_backs: { resolve: 0, fix: 0 },
        cost_usd: 0.25,
        tokens: { [model]: { input: 1, output: 40, cache_write: 0, cache_read: 0 } },
      }),
    )
  })

  test("writes nothing when no ticket is left in the queue", async () => {
    const records = await inLedger(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition("a", Cause.Ready(), { title: "a" })
        yield* ledger.endQueued
      }),
    )
    expect(endsOf(records)).toEqual([])
  })
})

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-teq-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A worker its environment fails: it ends its turn at once, without claiming or changing anything. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** Claims its ticket, links `blocker` as blocking it and stops with it open and nothing done. */
const needs = (world: World, id: string, blocker: string): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      ...bash(`bd dep add ${id} ${blocker}`, orDie(world.beads.addDependency(id, blocker))),
      ...bash(`bd update ${id} --status open`, orDie(world.beads.update(id, { status: "open" }))),
    ],
    result(`${id} needs ${blocker}'s work first.`),
  )

describe("a run that ends with tickets waiting", () => {
  test("ends each one's part with a queued ticket_end, its last", async () => {
    // t-2 waits for t-1 to merge; t-1 and t-3 fail at once, and the environment hold reopens them
    // to wait for the probe, which ends the run.
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = appConfig().settings
    const settings = {
      ...defaults,
      concurrent: 1,
      environment_hold: { ...defaults.environment_hold, probe: Duration.zero },
    }
    const tickets = ["t-1", "t-2", "t-3"]
    const ran = await scenario(
      {
        config: { repo, settings },
        backlog: tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => ({
          "t-1": [givesUp],
          "t-2": [needs(world, "t-2", "t-1")],
          "t-3": [givesUp],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 7)
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Waiting", "t-3": "Waiting" })
    const ends = endsOf(ran.events)
    expect(ends.filter((r) => r.outcome === "queued").map((r) => [r.ticket, r.why])).toEqual([
      ["t-1", "probe"],
      ["t-2", "t-1"],
      ["t-3", "probe"],
    ])
    // Each queued ticket_end is its ticket's last, and comes before the run's end record.
    for (const id of tickets) expect(ends.findLast((r) => r.ticket === id)?.outcome).toBe("queued")
    const kinds = ran.events.map((r) => r.kind)
    expect(kinds.lastIndexOf("ticket_end")).toBeLessThan(kinds.indexOf("end"))
  })
})
