// --auto-answer for the questions asked in a worker's session (src/agent/Attention.ts, § 4.5): an
// AskUserQuestion call answered with each question's recommended option, at once or once it has
// waited the flag's time, a person's answer first winning; a permission request never answered.
import { describe, expect, test } from "bun:test"
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  Attention,
  type AttentionRequest,
  type AutoAnswerOptions,
  blockedAfter,
  overdue,
  type Question,
  recommendedChoices,
} from "../src/agent/Attention.ts"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { openFibers } from "./fibers.ts"

type Env = Attention | Log | EventStream | Captured

const ticket = "t-1" as TicketId

/** Runs `effect` with Attention answering by --auto-answer as `auto` says, under TestClock. */
const run = <A, E>(effect: Effect.Effect<A, E, Env>, auto: AutoAnswerOptions): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        attentionLayer(waitForTest, auto).pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

const atOnce: AutoAnswerOptions = { after: Duration.zero }
const tenMinutes: AutoAnswerOptions = { after: Duration.minutes(10) }

const sdkOptions = (over: Partial<Parameters<CanUseTool>[2]> = {}): Parameters<CanUseTool>[2] => ({
  signal: new AbortController().signal,
  toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
  requestId: "req",
  ...over,
})

/** Calls the ticket's canUseTool for `tool` with `input`: its result, as a promise. */
const call = (
  tool: string,
  input: Record<string, unknown>,
  options = sdkOptions(),
  id: TicketId = ticket,
) =>
  Effect.gen(function* () {
    const canUseTool = yield* (yield* Attention).request(id, openFibers())
    return canUseTool(tool, input, options)
  })

/** Waits until `n` requests are open, and gives them, oldest first. */
const openRequests = (n: number) =>
  Effect.gen(function* () {
    const seen = yield* (yield* Attention).open.pipe(
      Stream.filter((all) => all.length >= n),
      Stream.runHead,
    )
    return seen._tag === "Some" ? seen.value : []
  })

const settled = (result: Promise<PermissionResult | null>) => Effect.promise(() => result)

/** Gives the fibers a moment, the clock still. */
const moment = Effect.promise(() => Bun.sleep(5))

/** Advances the clock by `minutes`, a minute at a time, each given the fibers a moment. */
const minutes = (n: number) =>
  Effect.forEach(
    Array.from({ length: n }),
    () => Effect.andThen(TestClock.adjust(Duration.minutes(1)), moment),
    { discard: true },
  )

const records = Effect.flatMap(Captured, (captured) => captured.records)

const answeredRecords = (all: ReadonlyArray<EventRecord>) =>
  all.filter((record) => record.kind === "attention_answered")

const which = {
  questions: [
    {
      question: "Which store?",
      options: [{ label: "Postgres" }, { label: "SQLite (Recommended)" }, { label: "Files" }],
    },
  ],
}

describe("--auto-answer and a question asked in the session", () => {
  test("is answered at once with the option marked (Recommended), by --auto-answer", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const result = yield* settled(yield* call("AskUserQuestion", which))
        const attention = yield* Attention
        return {
          result,
          open: yield* attention.current,
          tally: yield* attention.tally(ticket),
          auto: yield* attention.autoAnswered,
          records: yield* records,
          log: yield* texts,
        }
      }),
      atOnce,
    )
    expect(seen.result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: which.questions,
        answers: { "Which store?": "SQLite (Recommended)" },
      },
    })
    expect(seen.open).toEqual([])
    // Tallied apart from the maintainer's answers, for triage and the reviewer.
    expect(seen.tally).toMatchObject({ questions: 1, answered: 0, autoAnswered: 1 })
    expect(seen.auto).toEqual([
      { ticket, question: "Which store?", answers: ["SQLite (Recommended)"] },
    ])
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({ ticket, answer: ["SQLite (Recommended)"], via: "auto_answer" }),
    ])
    expect(seen.log).toContain(
      "  QUESTION: t-1's worker: Which store? answered (SQLite (Recommended)), the recommended option, by --auto-answer",
    )
  })

  test("without one marked (Recommended), or with two, takes each question's first option", () => {
    const question = (labels: ReadonlyArray<string>): Question => ({
      question: "Q?",
      options: labels.map((label) => ({ label })),
      multiSelect: false,
    })
    expect(
      recommendedChoices([
        question(["A", "B"]),
        question(["C (Recommended)", "D (recommended)"]),
        question(["E", "F (recommended)"]),
        question([]),
      ]),
    ).toEqual(["A", "C (Recommended)", "F (recommended)", ""])
  })

  test("with a time, waits that long, holding with BLOCKED past blockedAfter, then answers", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const result = yield* call("AskUserQuestion", which)
        const attention = yield* Attention
        const [request] = yield* openRequests(1)
        yield* minutes(5)
        const now = Number(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
        // Open past blockedAfter (4 minutes): the run holds with BLOCKED as it does today.
        const blocked = overdue(yield* attention.current, now).map((r) => r.id)
        yield* minutes(4)
        const before = (yield* attention.current).length
        yield* minutes(1)
        return {
          request,
          blocked,
          before,
          after: (yield* attention.current).length,
          result: yield* settled(result),
          records: yield* records,
        }
      }),
      tenMinutes,
    )
    expect(Duration.toMinutes(blockedAfter)).toBeLessThan(5)
    expect(seen.blocked).toEqual([(seen.request as AttentionRequest).id])
    expect(seen.before).toBe(1)
    expect(seen.after).toBe(0)
    expect(seen.result).toMatchObject({ behavior: "allow" })
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({ via: "auto_answer", after_ms: 600_000 }),
    ])
  })

  test("with a time, the maintainer's answer before it wins, and tutti doesn't answer again", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const result = yield* call("AskUserQuestion", which)
        const attention = yield* Attention
        const [request] = yield* openRequests(1)
        yield* minutes(3)
        yield* attention.answer(
          (request as AttentionRequest).id,
          {
            _tag: "Choose",
            answers: ["Files"],
          },
          "screen",
        )
        const answered = yield* settled(result)
        yield* minutes(15)
        return {
          answered,
          tally: yield* attention.tally(ticket),
          auto: yield* attention.autoAnswered,
          records: yield* records,
        }
      }),
      tenMinutes,
    )
    expect(seen.answered).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which store?": "Files" } },
    })
    expect(seen.tally).toMatchObject({ answered: 1, autoAnswered: 0 })
    expect(seen.auto).toEqual([])
    expect(answeredRecords(seen.records)).toEqual([expect.objectContaining({ via: "screen" })])
  })

  test("never answers a permission request, the safety check's holds included", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* call("Bash", { command: "rm -rf build" })
            yield* call(
              "Bash",
              { command: "rm -rf $DIR/*" },
              sdkOptions({ decisionReasonType: "safetyCheck" } as Partial<
                Parameters<CanUseTool>[2]
              >),
            )
          }),
        )
        yield* Fiber.join(fiber)
        yield* openRequests(2)
        yield* minutes(60)
        const attention = yield* Attention
        return {
          open: (yield* attention.current).map((request) => request.kind._tag),
          records: yield* records,
        }
      }),
      atOnce,
    )
    expect(seen.open).toEqual(["Permission", "Permission"])
    expect(answeredRecords(seen.records)).toEqual([])
  })

  test("leaves the questions of a session it doesn't answer for, as the --feature interview's", async () => {
    const seen = await run(
      Effect.gen(function* () {
        yield* call("AskUserQuestion", which, sdkOptions(), "tutti-interview" as TicketId)
        yield* openRequests(1)
        yield* minutes(1)
        return (yield* (yield* Attention).current).map((request) => request.ticket)
      }),
      { after: Duration.zero, answers: (id) => id !== "tutti-interview" },
    )
    expect(seen).toEqual(["tutti-interview" as TicketId])
  })
})
