// The requests neither --auto-answer's answers nor --overnight's denials took (tutti-epza.22): under
// either, an MCP server's form elicitation is declined, and an AskUserQuestion call whose input
// didn't decode is denied with what to ask again with, each once it has waited as long as a
// question does, in nobody's name, and said in the log. Without either, both wait for a person.
import { describe, expect, test } from "bun:test"
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
  Attention,
  type AttentionRequest,
  type AutoAnswerOptions,
  blockedAfter,
  type DenyOptions,
  formDecline,
  reshapeDenial,
  tuttiDenialMessage,
} from "../src/agent/Attention.ts"
import { overnightDenyAfter } from "../src/core/AppConfig.ts"
import type { Log } from "../src/core/log.ts"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { openFibers } from "./fibers.ts"

type Env = Attention | Log | EventStream | Captured

const ticket = "t-1" as TicketId

const atOnce: AutoAnswerOptions = { after: Duration.zero }
const tenMinutes: AutoAnswerOptions = { after: Duration.minutes(10) }
const overnightDeny: DenyOptions = { after: overnightDenyAfter }

/** Runs `effect` with Attention answering as `auto` and `deny` say, under TestClock. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Env>,
  auto?: AutoAnswerOptions,
  deny?: DenyOptions,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        attentionLayer(waitForTest, auto, deny).pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** Gives the fibers a moment, the clock still. */
const moment = Effect.promise(() => Bun.sleep(5))

/** Moves TestClock on by `n` seconds, a second at a time, the fibers given a moment after each. */
const seconds = (n: number) =>
  Effect.forEach(
    Array.from({ length: n }),
    () => Effect.andThen(TestClock.adjust(Duration.seconds(1)), moment),
    { discard: true },
  )

/** Moves TestClock on by `n` minutes, a minute at a time, the fibers given a moment after each. */
const minutes = (n: number) =>
  Effect.forEach(
    Array.from({ length: n }),
    () => Effect.andThen(TestClock.adjust(Duration.minutes(1)), moment),
    { discard: true },
  )

const form: ElicitationRequest = {
  serverName: "forms",
  message: "Your API token?",
  mode: "form",
  requestedSchema: { type: "object", properties: { token: { type: "string" } } },
}

const urlLogin: ElicitationRequest = {
  serverName: "linear",
  message: "Log in to Linear",
  mode: "url",
  url: "https://linear.app/login",
  elicitationId: "e1",
}

/** AskUserQuestion's input with its options as plain strings, which doesn't decode. */
const misshapen = {
  questions: [{ question: "Which store?", options: ["Postgres", "SQLite"] }],
}

/** The ticket's MCP server asks `request`: its result, as a promise. */
const elicits = (request: ElicitationRequest, id: TicketId = ticket) =>
  Effect.gen(function* () {
    const onElicitation = yield* (yield* Attention).elicitation(id, openFibers())
    const result = onElicitation(request, { signal: new AbortController().signal, requestId: "x" })
    yield* moment
    return result
  })

/** The ticket's worker calls `tool` with `input`: its result, as a promise. */
const calls = (tool: string, input: Record<string, unknown>, id: TicketId = ticket) =>
  Effect.gen(function* () {
    const canUseTool = yield* (yield* Attention).request(id, openFibers())
    const options: Parameters<CanUseTool>[2] = {
      signal: new AbortController().signal,
      toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
      requestId: "req",
    }
    const result = canUseTool(tool, input, options)
    yield* moment
    return result
  })

const settled = <A>(result: Promise<A>) => Effect.promise(() => result)

const records = Effect.flatMap(Captured, (captured) => captured.records)

const answeredRecords = (all: ReadonlyArray<EventRecord>) =>
  all.filter((record) => record.kind === "attention_answered")

const attentionRecords = (all: ReadonlyArray<EventRecord>) =>
  all.filter((record) => record.kind === "attention")

/** What became of the one request asked, once `wait` has passed. */
const outcome = <A>(asked: Effect.Effect<Promise<A>, never, Env>, wait: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const result = yield* asked
    const attention = yield* Attention
    const [request] = yield* attention.current
    yield* wait
    return {
      blocks:
        request === undefined
          ? undefined
          : Duration.toMillis(attention.blocksAfter(request as AttentionRequest)),
      open: (yield* attention.current).length,
      result: (yield* attention.current).length === 0 ? yield* settled(result) : undefined,
      tally: yield* attention.tally(ticket),
      records: yield* records,
      log: yield* texts,
    }
  })

describe("a form elicitation, nobody being there to fill it in", () => {
  test("is declined at once under bare --auto-answer, by tutti, without notifying", async () => {
    const seen = await run(outcome(elicits(form), moment), atOnce)
    expect(seen.result).toEqual({ action: "decline" } satisfies ElicitationResult)
    expect(seen.tally).toMatchObject({ elicitations: 1, declined: 1 })
    expect(attentionRecords(seen.records)).toEqual([
      expect.objectContaining({ type: "elicitation", auto_answering: true }),
    ])
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({ ticket, answer: "deny", via: "auto_answer", after_ms: 0 }),
    ])
    expect(seen.log).toContain(
      `  QUESTION: t-1's worker: MCP server forms: Your API token? declined (${formDecline}), by tutti, under --auto-answer`,
    )
  })

  test("waits --auto-answer's time first, holding the run only past it", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const result = yield* elicits(form)
        const attention = yield* Attention
        yield* minutes(9)
        const before = (yield* attention.current).length
        const after = yield* outcome(Effect.succeed(result), minutes(1))
        return { before, ...after }
      }),
      tenMinutes,
    )
    expect(seen.before).toBe(1)
    expect(seen.blocks).toBe(
      Duration.toMillis(blockedAfter) + Duration.toMillis(Duration.minutes(10)),
    )
    expect(seen.result).toEqual({ action: "decline" })
    expect(attentionRecords(seen.records)).toEqual([
      expect.not.objectContaining({ auto_answering: true }),
    ])
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({ via: "auto_answer", after_ms: 600_000 }),
    ])
  })

  test("is declined after 30s in an overnight run without --auto-answer", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const result = yield* elicits(form)
        yield* seconds(29)
        const before = (yield* (yield* Attention).current).length
        const after = yield* outcome(Effect.succeed(result), seconds(1))
        return { before, ...after }
      }),
      undefined,
      overnightDeny,
    )
    expect(seen.before).toBe(1)
    expect(seen.result).toEqual({ action: "decline" })
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({ answer: "deny", via: "overnight", after_ms: 30_000 }),
    ])
    expect(seen.log).toContain(
      `  QUESTION: t-1's worker: MCP server forms: Your API token? declined (${formDecline}), by tutti, the run being an overnight one`,
    )
  })

  test("waits for a person in a run with neither, as a URL login does with both", async () => {
    const plain = await run(outcome(elicits(form), minutes(60)))
    expect(plain.open).toBe(1)
    expect(plain.blocks).toBe(Duration.toMillis(blockedAfter))
    const url = await run(outcome(elicits(urlLogin), minutes(60)), atOnce, overnightDeny)
    expect(url.open).toBe(1)
    expect(answeredRecords(url.records)).toEqual([])
  })

  test("of a session tutti doesn't answer for, as the --feature interview's, waits", async () => {
    const seen = await run(
      Effect.gen(function* () {
        yield* elicits(form, "tutti-interview" as TicketId)
        yield* minutes(5)
        return (yield* (yield* Attention).current).length
      }),
      { after: Duration.zero, answers: (id) => id !== "tutti-interview" },
      { after: overnightDenyAfter, denies: (id) => id !== "tutti-interview" },
    )
    expect(seen).toBe(1)
  })
})

describe("an AskUserQuestion call whose input didn't decode", () => {
  const denied: PermissionResult = {
    behavior: "deny",
    message: `${tuttiDenialMessage}: ${reshapeDenial}`,
    decisionClassification: "user_reject",
  }

  test("is denied at once under bare --auto-answer, told to ask again in its shape", async () => {
    const seen = await run(outcome(calls("AskUserQuestion", misshapen), moment), atOnce)
    expect(seen.result).toEqual(denied)
    expect(seen.tally).toMatchObject({ permissions: 1, denied: 1, autoAnswered: 0 })
    expect(attentionRecords(seen.records)).toEqual([
      expect.objectContaining({
        type: "permission",
        tool: "AskUserQuestion",
        auto_answering: true,
      }),
    ])
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({ ticket, answer: "deny", via: "auto_answer" }),
    ])
    expect(
      seen.log.some(
        (line) =>
          line.startsWith("  PERMISSION: t-1's worker: AskUserQuestion(") &&
          line.endsWith(`denied (${reshapeDenial}), by tutti, under --auto-answer`),
      ),
    ).toBe(true)
  })

  test("is denied so after 30s in an overnight run, not with the overnight denial", async () => {
    const seen = await run(
      outcome(calls("AskUserQuestion", misshapen), seconds(30)),
      undefined,
      overnightDeny,
    )
    expect(seen.result).toEqual(denied)
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({ via: "overnight", after_ms: 30_000 }),
    ])
  })

  test("waits --auto-answer's time where it has one, overnight too", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const result = yield* calls("AskUserQuestion", misshapen)
        yield* minutes(9)
        const before = (yield* (yield* Attention).current).length
        const after = yield* outcome(Effect.succeed(result), minutes(1))
        return { before, ...after }
      }),
      tenMinutes,
      overnightDeny,
    )
    expect(seen.before).toBe(1)
    expect(seen.blocks).toBe(
      Duration.toMillis(blockedAfter) + Duration.toMillis(Duration.minutes(10)),
    )
    expect(seen.result).toEqual(denied)
  })

  test("waits for a person in a run with neither", async () => {
    const seen = await run(outcome(calls("AskUserQuestion", misshapen), minutes(60)))
    expect(seen.open).toBe(1)
    expect(answeredRecords(seen.records)).toEqual([])
  })

  test("leaves another tool's permission request to --overnight alone", async () => {
    const seen = await run(outcome(calls("Bash", { command: "git push" }), minutes(60)), atOnce)
    expect(seen.open).toBe(1)
  })
})
