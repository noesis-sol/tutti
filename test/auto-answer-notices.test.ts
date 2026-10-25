// --auto-answer and the run's notifications (notices.ts, § 7.9): a question it answers at once, in
// the session or as a ticket, doesn't notify, as it is answered by the time you read the notice;
// one it answers after a time, or leaves to you, notifies as without the flag.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Attention, type AutoAnswerOptions } from "../src/agent/Attention.ts"
import { respondTries } from "../src/run/autoAnswer.ts"
import { notice, notifying } from "../src/run/notices.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { filesQuestion } from "../src/testing/AgentHost.ts"
import { appConfig, layer as appConfigLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Backlog } from "../src/testing/Beads.ts"
import { layer as eventsLayer, Captured as Records } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { Captured, layer as notifierLayer } from "../src/testing/Notifier.ts"
import { openFibers } from "./fibers.ts"
import {
  advance,
  backlog,
  type Env,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1" as TicketId

describe("notice", () => {
  test("says nothing of a question --auto-answer answers at once", () => {
    const asked = {
      kind: "asked",
      ticket: "t-1",
      title: "x",
      detail: "q-1: Which?",
      text: "",
    } as const
    expect(notice({ ...asked, auto_answering: true })).toBeNull()
    expect(notice(asked)).toBe("t-1 needs your answer · Which?")
    const question = {
      kind: "attention",
      ticket: "t-1",
      request: "r1",
      type: "question",
      questions: [{ question: "Which?", options: [{ label: "A" }] }],
      default_to_no: false,
    } as const
    expect(notice({ ...question, auto_answering: true })).toBeNull()
    expect(notice(question)).toBe("t-1 needs you · Which?")
  })
})

/** Runs `effect` with Attention answering by --auto-answer as `auto` says, its records notifying. */
const inSession = <A, E>(
  effect: Effect.Effect<A, E, Attention | Captured | Records>,
  auto: AutoAnswerOptions,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        attentionLayer(waitForTest, auto).pipe(
          Layer.provideMerge(logLayer()),
          Layer.provideMerge(notifying),
          Layer.provideMerge(Layer.mergeAll(eventsLayer(), notifierLayer)),
          Layer.provideMerge(Layer.mergeAll(appConfigLayer(), TestClock.layer())),
        ),
      ),
    ),
  )

const sdkOptions = (): Parameters<CanUseTool>[2] => ({
  signal: new AbortController().signal,
  toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
  requestId: "req",
})

/** Calls `ticket`'s canUseTool for `tool` with `input`: its result, as a promise. */
const call = (tool: string, input: Record<string, unknown>, ticket: TicketId = id) =>
  Effect.gen(function* () {
    const canUseTool = yield* (yield* Attention).request(ticket, openFibers())
    return canUseTool(tool, input, sdkOptions())
  })

/** Gives the fibers a moment, the clock still. */
const moment = Effect.promise(() => Bun.sleep(5))

const which = {
  questions: [
    {
      question: "Which store?",
      options: [{ label: "Postgres" }, { label: "SQLite (Recommended)" }],
    },
  ],
}

/** The notices so far, and the attention records. */
const seen = Effect.gen(function* () {
  const records = yield* (yield* Records).records
  return {
    notices: yield* (yield* Captured).notices,
    attention: records.filter((record) => record.kind === "attention"),
  }
})

describe("--auto-answer and the notice of a question in the session", () => {
  test("answered at once: no notice, its record saying so", async () => {
    const got = await inSession(
      Effect.gen(function* () {
        const pending = yield* call("AskUserQuestion", which)
        const result = yield* Effect.promise(() => pending)
        return { result, ...(yield* seen) }
      }),
      { after: Duration.zero },
    )
    expect(got.result).toMatchObject({ behavior: "allow" })
    expect(got.notices).toEqual([])
    expect(got.attention).toEqual([
      expect.objectContaining({ type: "question", auto_answering: true }),
    ])
  })

  test("answered at once, it leaves the next request its notice within 30 seconds", async () => {
    const got = await inSession(
      Effect.gen(function* () {
        const pending = yield* call("AskUserQuestion", which)
        yield* Effect.promise(() => pending)
        yield* call("Bash", { command: "ls" }, "t-2" as TicketId)
        yield* moment
        return yield* seen
      }),
      { after: Duration.zero },
    )
    expect(got.notices).toEqual(["t-2 needs you · Allow Bash(ls)?"])
  })

  test("after a time: notifies, so you can answer first", async () => {
    const got = await inSession(
      Effect.gen(function* () {
        yield* call("AskUserQuestion", which)
        yield* moment
        return yield* seen
      }),
      { after: Duration.minutes(10) },
    )
    expect(got.notices).toEqual(["t-1 needs you · Which store?"])
    expect(got.attention).toEqual([expect.not.objectContaining({ auto_answering: true })])
  })

  test("a ticket's whose questions it doesn't answer, the interview's: notifies", async () => {
    const got = await inSession(
      Effect.gen(function* () {
        yield* call("AskUserQuestion", which)
        yield* moment
        return yield* seen
      }),
      { after: Duration.zero, answers: (ticket) => ticket !== id },
    )
    expect(got.notices).toEqual(["t-1 needs you · Which store?"])
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-auto-answer-notices-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A question's metadata: two options, the second recommended. */
const withOptions = {
  options: [
    { label: "Postgres", description: "a server to run" },
    { label: "SQLite", description: "one file" },
  ],
  recommended: 1,
}

/** t-1's worker files a question `Which store?` with `metadata`, and puts t-1 back to open. */
const asks = (world: World, metadata: Readonly<Record<string, unknown>>) =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        world.beads.create({ title: "Which store?", labels: ["human"], blocks: [id], metadata }),
        world.beads.update(id, { status: "open" }),
      ),
    ),
  })

/** What a run does beside the worker's question. */
interface More {
  /** How many ready polls the clock is moved on by. */
  readonly polls?: number
  /** Before the run starts. */
  readonly before?: Effect.Effect<void, never, Env>
}

/** A whole run of t-1, whose worker asks, with --auto-answer `after`. */
const runs = (
  after: Duration.Duration,
  metadata: Readonly<Record<string, unknown>>,
  more: More = {},
): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: { repo, autoAnswer: after, settings: { ...appConfig().settings } },
      backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => ({ [id]: [asks(world, metadata)] }),
    },
    Effect.gen(function* () {
      mkdirSync(join(root, id), { recursive: true })
      yield* (yield* Git).addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      if (more.before !== undefined) yield* more.before
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main" }))
      for (let n = 0; n < (more.polls ?? 0); n++) {
        yield* Effect.promise(() => Bun.sleep(3))
        yield* advance(readyPoll)
      }
      return yield* Fiber.join(fiber)
    }),
  )
}

/** bd refuses every answer. */
const refusesRespond = Effect.flatMap(Backlog, (backlog) =>
  backlog.fail("human respond", { stderr: "Error: no", times: Infinity }),
)

const needsYourAnswer = (ran: Ran<unknown>) =>
  ran.notices.filter((text) => text.includes("needs your answer"))

describe("--auto-answer and the notice of a question ticket", () => {
  test("answered at once: no notice, its asked record saying so", async () => {
    const ran = await runs(Duration.zero, withOptions)
    expect(needsYourAnswer(ran)).toEqual([])
    expect(ran.events.filter((record) => record.kind === "asked")).toEqual([
      expect.objectContaining({ ticket: id, auto_answering: true }),
    ])
    expect(ran.events.some((record) => record.kind === "auto_answered")).toBe(true)
  })

  test("after a time: notifies, so you can answer first", async () => {
    const ran = await runs(Duration.minutes(10), withOptions, { polls: 24 })
    expect(needsYourAnswer(ran)).toEqual(["t-1 needs your answer · Which store?"])
    expect(ran.events.some((record) => record.kind === "auto_answered")).toBe(true)
  })

  test("answered at once but bd refusing it every time: notifies as it is left to you", async () => {
    const ran = await runs(Duration.zero, withOptions, { polls: 6, before: refusesRespond })
    expectPhases(ran, { [id]: "Asked" })
    expect(needsYourAnswer(ran)).toEqual(["t-1 needs your answer · Which store?"])
  })

  test("after a time, bd refusing it every time: notified once, as it asked", async () => {
    const ran = await runs(Duration.minutes(10), withOptions, {
      polls: 30,
      before: refusesRespond,
    })
    expectPhases(ran, { [id]: "Asked" })
    expect(ran.log.some((text) => text.includes(`${respondTries} times`))).toBe(true)
    expect(needsYourAnswer(ran)).toEqual(["t-1 needs your answer · Which store?"])
  })

  test("left to you, maintainer_only: notifies", async () => {
    const ran = await runs(Duration.zero, { ...withOptions, maintainer_only: true })
    expectPhases(ran, { [id]: "Asked" })
    expect(needsYourAnswer(ran)).toEqual(["t-1 needs your answer · Which store?"])
    expect(ran.events.filter((record) => record.kind === "asked")).toEqual([
      expect.not.objectContaining({ auto_answering: true }),
    ])
  })
})
