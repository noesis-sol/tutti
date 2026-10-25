// What runs spend, in the event stream (§ 10): each worker turn's `turn` record with its share of
// the session's running totals (Spending), the `check` records of the checks a run runs, the
// `organ` record of each organ call (OrganCost), and what a ticket spent on the records that end
// its part in the run (`closed`, `ticket_end`) and the run's totals on its `end` record.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Transcripts } from "../src/agent/Transcripts.ts"
import { settled } from "../src/agent/WorkerState.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { makePrinter } from "../src/print/organLine.ts"
import { recorded } from "../src/run/check.ts"
import type { EventRecord } from "../src/run/events.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import { finish, run } from "../src/run/run.ts"
import { endRecord, nothingSpent, Spending, shareOf, type Totals } from "../src/run/spending.ts"
import type { TicketId } from "../src/services/Beads.ts"
import {
  type CheckError,
  CheckFailed,
  CheckNotRun,
  type CheckResult,
} from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, tool, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as spendingLayer } from "../src/testing/Spending.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { backlog, scenario, type World } from "./harness.ts"

const model = "claude-opus-5-5"

/** A model's usage as a result's modelUsage gives it. */
const usage = (input: number, output: number, cacheWrite = 0, cacheRead = 0) => ({
  [model]: {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
})

/** A result with the running totals `cost` and `modelUsage`. */
const resultMessage = (cost: number, modelUsage: object, fields: object = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "DONE",
    num_turns: 2,
    duration_ms: 4000,
    duration_api_ms: 3000,
    total_cost_usd: cost,
    modelUsage,
    ...fields,
  }) as unknown as SDKMessage

const turnsOf = (records: ReadonlyArray<EventRecord>) =>
  records.flatMap((r) => (r.kind === "turn" ? [r] : []))

/** Spending over captured records: `body`'s value and the records it wrote. */
const spending = <A>(body: Effect.Effect<A, never, Spending>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const value = yield* body
      return { value, records: yield* (yield* Captured).records }
    }).pipe(Effect.provide(spendingLayer().pipe(Layer.provideMerge(eventsLayer())))),
  )

describe("a turn's share of the session's running totals", () => {
  test("is the difference from the last result, model by model", () => {
    const before: Totals = {
      costUsd: 0.5,
      tokens: { [model]: { input: 10, output: 100, cache_write: 5, cache_read: 50 } },
    }
    const now: Totals = {
      costUsd: 0.75,
      tokens: { [model]: { input: 12, output: 160, cache_write: 5, cache_read: 90 } },
    }
    expect(shareOf(before, now)).toEqual({
      costUsd: 0.25,
      tokens: { [model]: { input: 2, output: 60, cache_write: 0, cache_read: 40 } },
    })
  })

  test("is the whole when there was no result before, or a total fell (it started again)", () => {
    const now: Totals = {
      costUsd: 0.1,
      tokens: { [model]: { input: 1, output: 2, cache_write: 0, cache_read: 0 } },
    }
    expect(shareOf(undefined, now)).toEqual(now)
    expect(shareOf({ costUsd: 0.5, tokens: {} }, now)).toEqual(now)
  })

  test("shares of a session's running totals add up to its last total", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 })), {
          minLength: 1,
          maxLength: 20,
        }),
        (steps) => {
          let cents = 0
          let output = 0
          let before: Totals | undefined
          let sumCents = 0
          let sumOutput = 0
          for (const [c, o] of steps) {
            cents += c
            output += o
            const now: Totals = {
              costUsd: cents / 100,
              tokens: { [model]: { input: 0, output, cache_write: 0, cache_read: 0 } },
            }
            const share = shareOf(before, now)
            sumCents += Math.round(share.costUsd * 100)
            sumOutput += share.tokens[model]?.output ?? 0
            before = now
          }
          expect(sumCents).toBe(cents)
          expect(sumOutput).toBe(output)
        },
      ),
    )
  })
})

describe("Spending", () => {
  test("writes a turn record per result with its share, across a resume, and sums each ticket", async () => {
    const { value, records } = await spending(
      Effect.gen(function* () {
        const s = yield* Spending
        yield* s.message("t-1" as TicketId, {
          session: "s-1",
          message: resultMessage(0.5, usage(10, 100)),
        })
        yield* s.message("t-1" as TicketId, {
          session: "s-1",
          message: resultMessage(0.75, usage(12, 160)),
        })
        // The session resumed: its totals go on from its transcript's.
        yield* s.message("t-1" as TicketId, {
          session: "s-1",
          message: resultMessage(1, usage(13, 200)),
        })
        // A crash's zeroed result spends nothing and leaves the totals as they were.
        yield* s.message("t-1" as TicketId, {
          session: "s-1",
          message: resultMessage(0, {}, { subtype: "error_during_execution" }),
        })
        yield* s.message("t-1" as TicketId, {
          session: "s-1",
          message: resultMessage(1.25, usage(14, 250)),
        })
        yield* s.message("t-2" as TicketId, {
          session: "s-2",
          message: resultMessage(0.25, usage(1, 10), { is_error: true }),
        })
        return {
          t1: yield* s.ofTicket("t-1" as TicketId),
          total: yield* s.total,
          t3: yield* s.ofTicket("t-3" as TicketId),
        }
      }),
    )
    const turns = turnsOf(records)
    expect(turns.map((t) => [t.ticket, t.cost_usd, t.tokens?.[model]?.output ?? 0])).toEqual([
      ["t-1", 0.5, 100],
      ["t-1", 0.25, 60],
      ["t-1", 0.25, 40],
      ["t-1", 0, 0],
      ["t-1", 0.25, 50],
      ["t-2", 0.25, 10],
    ])
    expect(turns[0]).toMatchObject({
      session: "s-1",
      subtype: "success",
      turns: 2,
      duration_ms: 4000,
      api_ms: 3000,
    })
    expect(turns[3]?.subtype).toBe("error_during_execution")
    expect(turns[5]?.is_error).toBe(true)
    expect(value.t1.costUsd).toBe(1.25)
    expect(value.t1.tokens[model]?.output).toBe(250)
    expect(value.t1.turns).toBe(10)
    expect(value.total.costUsd).toBe(1.5)
    expect(value.t3).toEqual(nothingSpent)
  })

  test("a message that isn't a result is nothing to it", async () => {
    const { records } = await spending(
      Effect.flatMap(Spending, (s) =>
        s.message("t-1" as TicketId, {
          session: "s-1",
          message: { type: "system", subtype: "init" } as unknown as SDKMessage,
        }),
      ),
    )
    expect(records).toEqual([])
  })
})

describe("OrganCost's organ records", () => {
  test("a priced call, one with no price and one with no result, each with its ticket", async () => {
    const records = await Effect.runPromise(
      Effect.gen(function* () {
        const costs = yield* OrganCost
        yield* costs.record({
          organ: "triage",
          ticket: "t-1" as TicketId,
          costUsd: 0.0123,
          turns: 1,
          durationMs: 4200,
          sessionId: "s-9",
        })
        yield* costs.recordUnknown({ organ: "screen", durationMs: 1500, unpriced: true })
        yield* costs.recordUnknown({
          organ: "predictor",
          ticket: "t-2" as TicketId,
          durationMs: 180_000,
        })
        const end = yield* endRecord(0)
        return { records: yield* (yield* Captured).records, end }
      }).pipe(
        Effect.provide(
          OrganCost.layer.pipe(Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer()))),
        ),
      ),
    )
    expect(records.records.map(({ v, time, run, ...rest }) => rest)).toEqual([
      {
        kind: "organ",
        organ: "triage",
        ticket: "t-1",
        outcome: "answered",
        cost_usd: 0.0123,
        turns: 1,
        session: "s-9",
        duration_ms: 4200,
      },
      { kind: "organ", organ: "screen", outcome: "unpriced", duration_ms: 1500 },
      {
        kind: "organ",
        organ: "predictor",
        ticket: "t-2",
        outcome: "no_result",
        duration_ms: 180_000,
      },
    ])
    expect(records.end).toEqual({
      kind: "end",
      code: 0,
      organs: { calls: 3, turns: 1, cost_usd: 0.0123 },
    })
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-spending-${name}-`)))

/** Claims, commits and closes its ticket in one turn, its result costing $0.40 so far. */
const closesAt = (world: World, root: string, id: TicketId) =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...tool("Edit", { file_path: "src/main.ts", old_string: "a", new_string: "b" }),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`, {
      total_cost_usd: 0.4,
      modelUsage: usage(20, 300, 1000, 5000),
      duration_ms: 9000,
      duration_api_ms: 7000,
      num_turns: 6,
    }),
  )

describe("a whole run", () => {
  test("records the turn, the merge check, what the ticket spent as it merged, and the run's totals", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
    const { settings } = appConfig()
    const fast = { ...settings.checks.fast, command: "scripts/check-fast.sh" }
    const ran = await scenario(
      {
        config: { repo, settings: { ...settings, checks: { ...settings.checks, fast } } },
        git: { dir: repo },
        worktrees: { root },
        backlog: backlog().ticket("t-1").seeds,
        scripts: (world) => ({ "t-1": [closesAt(world, root, "t-1" as TicketId)] }),
      },
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
          branch: "tutti/t-1",
          base: "main",
        })
        const outcome = yield* Fiber.join(
          yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main", endLater: true })),
        )
        const out = { write: () => {}, columns: () => 100, tty: false }
        yield* finish(
          outcome,
          Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }),
          false,
        )
      }),
    )
    if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
    const tokens = { [model]: { input: 20, output: 300, cache_write: 1000, cache_read: 5000 } }
    const [turnRecord] = turnsOf(ran.events)
    expect(turnRecord).toMatchObject({
      ticket: "t-1",
      subtype: "success",
      cost_usd: 0.4,
      turns: 6,
      duration_ms: 9000,
      api_ms: 7000,
      tokens,
    })
    const checks = ran.events.flatMap((r) => (r.kind === "check" ? [r] : []))
    expect(checks).toEqual([
      expect.objectContaining({ suite: "merge", ticket: "t-1", result: "passed" }),
    ])
    const closed = ran.events.find((r) => r.kind === "closed")
    expect(closed).toMatchObject({
      ticket: "t-1",
      cost_usd: 0.4,
      tokens,
      hand_backs: { resolve: 0, fix: 0 },
    })
    expect(closed && "phases" in closed ? Object.keys(closed.phases ?? {}) : []).toEqual(
      expect.arrayContaining(["working", "waiting", "merging"]),
    )
    const ends = ran.events.filter((r) => r.kind === "ticket_end")
    expect(ends).toEqual([
      expect.objectContaining({
        ticket: "t-1",
        outcome: "merged",
        phase: "Done",
        turns: 6,
        cost_usd: 0.4,
        tokens,
      }),
    ])
    // The ticket_end follows the closed record, the phase record before both.
    const kinds = ran.events.map((r) => r.kind)
    expect(kinds.indexOf("ticket_end")).toBe(kinds.indexOf("closed") + 1)
    expect(ran.events.at(-1)).toMatchObject({ kind: "end", cost_usd: 0.4, tokens })
  })
})

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

const endsOf = (records: ReadonlyArray<EventRecord>) =>
  records.flatMap((r) => (r.kind === "ticket_end" ? [r] : []))

describe("what a ticket spent, on the records that end its part in the run", () => {
  test("its phases, both kinds of hand-back and its cost, as it merges after each", async () => {
    const records = await inLedger(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const move = (cause: Move, wait = 0) =>
          Effect.andThen(
            TestClock.adjust(wait),
            ledger.transition("t-1" as TicketId, cause, { title: "T" }),
          )
        yield* move(Move.Ready())
        yield* move(Move.Dispatched(), 1000)
        yield* (yield* Spending).message("t-1" as TicketId, {
          session: "s-1",
          message: resultMessage(0.5, usage(1, 10)),
        })
        yield* move(Move.Verified({ place: 1 }), 60_000)
        yield* move(Move.ItsTurn(), 5000)
        yield* move(Move.ConflictsHandedBack({ attempt: 1 }), 2000)
        yield* move(Move.Verified({ place: 1 }), 3000)
        yield* move(Move.ItsTurn())
        yield* move(Move.CheckHandedBack({ attempt: 1 }), 2000)
        yield* move(Move.Verified({ place: 1 }), 4000)
        yield* move(Move.ItsTurn())
        yield* ledger.transition("t-1" as TicketId, Move.FastForwarded({ commit: "abc1234" }), {
          beside: [{ kind: "closed", ticket: "t-1", title: "T", text: "  t-1 closed" }],
        })
      }),
    )
    const spent = {
      phases: { working: 60, waiting: 5, merging: 4, resolving: 3, fixing: 4 },
      hand_backs: { resolve: 1, fix: 1 },
      tokens: { [model]: { input: 1, output: 10, cache_write: 0, cache_read: 0 } },
      cost_usd: 0.5,
    }
    expect(records.find((r) => r.kind === "closed")).toMatchObject(spent)
    expect(endsOf(records)).toEqual([
      expect.objectContaining({
        ticket: "t-1",
        outcome: "merged",
        phase: "Done",
        seconds: 76,
        turns: 2,
        ...spent,
      }),
    ])
  })

  test("each way its part ends: set aside, needs you, stopped, no change; carried over", async () => {
    const records = await inLedger(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        for (const id of ["a" as TicketId, "b" as TicketId, "c" as TicketId, "d" as TicketId]) {
          yield* ledger.transition(id, Move.Ready(), { title: id })
          yield* ledger.transition(id, Move.Dispatched())
        }
        yield* ledger.transition("a" as TicketId, Move.Aside({ why: "CHECKS_FAILED" }), {
          beside: [{ kind: "warn", ticket: "a", aside: true, detail: "checks failed", text: "x" }],
        })
        yield* ledger.transition("b" as TicketId, Move.FiledQuestion({ question: "q-1" }))
        yield* ledger.transition("c" as TicketId, Move.RunEnded({ why: "run ended" }))
        yield* ledger.transition("d" as TicketId, Move.NoChange())
        // Carried over from an earlier run: its worker resumed, then deferred.
        yield* ledger.transition("e" as TicketId, Move.Resumed(), { title: "e" })
        yield* ledger.transition("e" as TicketId, Move.Defer({ why: "by the worker" }), {
          beside: [{ kind: "deferred", ticket: "e", title: "e", text: "x" }],
        })
      }),
    )
    expect(endsOf(records).map((r) => [r.ticket, r.outcome, r.phase, r.why, r.carried])).toEqual([
      ["a", "set_aside", "Review", "CHECKS_FAILED", undefined],
      ["b", "needs_you", "Asked", "q-1", undefined],
      ["c", "stopped", "Stopped", "run ended", undefined],
      ["d", "no_change", "Done", undefined, undefined],
      ["e", "set_aside", "Deferred", "by the worker", true],
    ])
    expect(records.find((r) => r.kind === "warn")).toMatchObject({
      phases: { working: 0 },
      hand_backs: { resolve: 0, fix: 0 },
    })
    expect(records.find((r) => r.kind === "deferred")).toMatchObject({ carried: true })
  })
})

describe("a check's record", () => {
  const ran = (check: Effect.Effect<CheckResult, CheckError>, train = false) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* recorded("fix", "t-1", Effect.andThen(TestClock.adjust(2550), check), { train })
        return (yield* (yield* Captured).records).map(({ v, time, run, ...rest }) => rest)
      }).pipe(Effect.provide(Layer.mergeAll(eventsLayer(), TestClock.layer()))),
    )
  const said = {
    failingLines: [],
    lastLines: [],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  }

  test("says how it went, for how long, and where its output is when it didn't pass", async () => {
    expect(
      await ran(
        Effect.succeed({ _tag: "CheckPassed", check: "fast", command: "c", ...said }),
        true,
      ),
    ).toEqual([
      {
        kind: "check",
        suite: "fix",
        ticket: "t-1",
        seconds: 2.6,
        train: true,
        command: "c",
        result: "passed",
      },
    ])
    expect(
      await ran(
        Effect.fail(
          new CheckFailed({ check: "fast", command: "c", exitCode: 1, outputFile: "/o", ...said }),
        ),
      ),
    ).toEqual([
      {
        kind: "check",
        suite: "fix",
        ticket: "t-1",
        seconds: 2.6,
        command: "c",
        result: "failed",
        output: "/o",
      },
    ])
    expect(
      await ran(Effect.fail(new CheckNotRun({ check: "fast", command: "c", reason: "no sh" }))),
    ).toEqual([
      { kind: "check", suite: "fix", ticket: "t-1", seconds: 2.6, command: "c", result: "not_run" },
    ])
  })

  test("a check with no command ran nothing and has none", async () => {
    expect(await ran(Effect.succeed({ _tag: "NoCheckCommand", check: "fast" }))).toEqual([])
  })
})

describe("a session resumed from an earlier run", () => {
  test("its first turn counts only what it spent over its last result in its transcript", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("t-1").seeds,
        scripts: {
          "t-1": [turn([], result("DONE", { total_cost_usd: 1.25, modelUsage: usage(14, 250) }))],
        },
      },
      Effect.gen(function* () {
        // What the earlier run's transcript holds of the session: two results, the last at $1.
        const transcripts = yield* Transcripts
        yield* transcripts.record("t-1", {
          session: "s-1",
          message: resultMessage(0.5, usage(10, 100)),
        })
        yield* transcripts.record("t-1", {
          session: "s-1",
          message: resultMessage(1, usage(13, 200)),
        })
        yield* transcripts.record("t-1", {
          session: "s-0",
          message: resultMessage(9, usage(90, 900)),
        })
        const host = yield* AgentHost
        yield* host.resume(
          "t-1" as TicketId,
          { sessionId: "s-1", cwd: "/w/t-1" },
          { text: "Carry on.", from: "clientComposed" },
        )
        yield* host
          .state("t-1" as TicketId)
          .pipe(Stream.filter(settled), Stream.take(1), Stream.runDrain)
        yield* host.end("t-1" as TicketId)
        return yield* (yield* Spending).ofTicket("t-1" as TicketId)
      }),
    )
    if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
    expect(turnsOf(ran.events).map((t) => [t.session, t.cost_usd, t.tokens?.[model]])).toEqual([
      ["s-1", 0.25, { input: 1, output: 50, cache_write: 0, cache_read: 0 }],
    ])
    expect(ran.exit.value.costUsd).toBe(0.25)
  })
})
