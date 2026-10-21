// An organ call refused for the account's usage limit puts the run's usage-limit hold on (§ 4.12),
// as a worker's turn ending on it does: AgentSdkLanguageModel fails the call with
// QuotaExhaustedError, carrying the limit's reset, and Organs reports it through OrganHold.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { DateTime, type Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { AiError, LanguageModel, type Prompt } from "effect/ai"
import { layer, limitOf, metadataKey, OrganCall } from "../src/organs/AgentSdkLanguageModel.ts"
import { make, OrganFailed, Organs, refusalOf } from "../src/organs/Organs.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { clock } from "../src/run/runView.ts"
import { organHold } from "../src/run/usageLimit.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses, type SessionScript, sleep } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as costLayer } from "../src/testing/OrganCost.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"
import { Reported, layer as usageLayer } from "../src/testing/UsageLimits.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  scenario,
  type World,
} from "./harness.ts"

// The model's tests start the fake as a Claude Code process, and whole runs wait out a hold: bun's
// 5 s default fails them when other checks run beside this one.
setDefaultTimeout(60_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

// TestClock starts at the epoch: a limit resetting at 3600 seconds resets an hour into the run.
const hour = 3600

const Verdict = Schema.Struct({ cause: Schema.String })

const triage = make("triage", { prompt: "You are the triage organ.\n", answer: Verdict })

/** Triage's answer, asked through Organs. */
const asksTriage = Effect.gen(function* () {
  return yield* (yield* Organs).ask(triage, [])
})

/** The QuotaExhaustedError a call refused for the five-hour limit, resetting at `at` (s), is. */
const refused = (at: number) =>
  AiError.make({
    module: "test",
    method: "generateText",
    reason: new AiError.QuotaExhaustedError({
      resetAt: DateTime.makeUnsafe(at * 1000),
      metadata: { [metadataKey]: { rate_limit_type: "five_hour" } },
    }),
  })

describe("AgentSdkLanguageModel on the usage limit", () => {
  const prompt: Prompt.RawInput = [
    { role: "system", content: "You are the triage organ." },
    { role: "user", content: "What became of tut-1?" },
  ]

  /** The AiError a call fails with whose session plays `steps` on the fake Claude Code. */
  const errorOf = async (steps: ReadonlyArray<object>): Promise<AiError.AiError> => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-organ-limit-"))
    const fakeScenario = { turns: [steps], eofAfterTurn: true }
    const exit = await Effect.runPromiseExit(
      LanguageModel.generateObject({ prompt, schema: Verdict }).pipe(
        Effect.provideService(OrganCall, { organ: "triage" }),
        Effect.provide(
          layer({
            account: { subscription: true },
            env: { ...process.env, FAKE_CLAUDE_SCENARIO: JSON.stringify(fakeScenario) },
          }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                costLayer(),
                configLayer(appConfig({ claude: fake }, dir)),
                BunServices.layer,
              ),
            ),
          ),
        ),
      ),
    )
    if (Exit.isSuccess(exit)) throw new Error("the call succeeded")
    const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
    if (reason === undefined || reason._tag !== "Fail") throw new Error(String(exit.cause))
    return reason.error as AiError.AiError
  }

  const limited = { is_error: true, api_error_status: 429, result: "API Error: 429" }

  test("a turn refused with a rejection is a QuotaExhaustedError with its reset and limit", async () => {
    const error = await errorOf([
      {
        message: {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", resetsAt: hour, rateLimitType: "five_hour" },
          uuid: crypto.randomUUID(),
        },
      },
      { result: limited },
    ])
    expect(error.reason._tag).toBe("QuotaExhaustedError")
    expect(refusalOf(error)).toEqual({ limit: "five_hour", resetsAt: hour * 1000 })
  })

  test("a 429 alone is a QuotaExhaustedError whose reset is unknown", async () => {
    const error = await errorOf([{ result: limited }])
    expect(error.reason._tag).toBe("QuotaExhaustedError")
    expect(refusalOf(error)).toEqual({ limit: null, resetsAt: null })
  })

  test("another API error is not the usage limit", async () => {
    const error = await errorOf([{ result: { ...limited, api_error_status: 500 } }])
    expect(error.reason._tag).not.toBe("QuotaExhaustedError")
    expect(refusalOf(error)).toBeUndefined()
    expect(limitOf(error)).toBeUndefined()
  })
})

describe("Organs on the usage limit", () => {
  /** Asks triage, its answer `canned`, with OrganHold over UsageLimits; what UsageLimits heard. */
  const asks = (canned: Effect.Effect<Record<string, unknown>, AiError.AiError>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(asksTriage)
        return { exit, events: yield* (yield* Reported).events }
      }).pipe(
        Effect.provide(
          Organs.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(cannedLayer({ triage: canned }), configLayer(appConfig()), logLayer()),
            ),
            Layer.provideMerge(organHold),
            Layer.provideMerge(usageLayer),
          ),
        ),
      ),
    )

  test("a call refused for the limit fails, reported as a rejection with its reset", async () => {
    const { exit, events } = await asks(Effect.fail(refused(hour)))
    expect(Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail").toBe(true)
    if (Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail") {
      expect(exit.cause.reasons[0].error).toBeInstanceOf(OrganFailed)
    }
    expect(events).toEqual([
      {
        status: "rejected",
        limit: "five_hour",
        resetsAt: hour * 1000,
        utilization: null,
        overage: false,
      },
    ])
  })

  test("a call failing otherwise reports nothing", async () => {
    const failed = AiError.make({
      module: "test",
      method: "generateText",
      reason: new AiError.RateLimitError({}),
    })
    const { events } = await asks(Effect.fail(failed))
    expect(events).toEqual([])
  })
})

describe("the usage-limit hold from an organ", () => {
  test("an organ refused for the limit holds dispatch, lifting at the reset with workers running", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-organ-limit-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-organ-limit-worktrees-")))
    const tickets = ["t-1", "t-2", "t-3"]
    /** Claims, commits and closes its ticket, working `long` before it starts. */
    const finishes = (world: World, id: string, long?: Duration.Input): SessionScript => {
      const steps = claimsAndCloses(id, {
        claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
        commit: Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
        close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
      })
      return long === undefined ? steps : [...steps.slice(0, 4), sleep(long), ...steps.slice(4)]
    }
    const organ = asksTriage.pipe(
      Effect.provide(
        Organs.layer.pipe(
          Layer.provideMerge(cannedLayer({ triage: Effect.fail(refused(2 * hour)) })),
          Layer.provideMerge(organHold),
        ),
      ),
    )
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 2 } },
        backlog: tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          "t-1": [finishes(world, "t-1", "3 hours")],
          "t-2": [finishes(world, "t-2", "10 minutes")],
          "t-3": [finishes(world, "t-3")],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard: () => Effect.void,
          }),
        )
        yield* untilLogged(/t-2 dispatching/)
        // The organ is refused while both workers run: the hold is on until 2h, and t-3 waits.
        expect(yield* Effect.flip(organ)).toBeInstanceOf(OrganFailed)
        yield* untilLogged(/^USAGE_LIMIT: the five-hour limit is reached/)
        // t-2 finishes in 10 minutes; its slot is free, but the hold keeps t-3 back.
        yield* advanceUntil(closed("t-2"), "1 minute")
        // At the reset, t-1 still at work until 3h, the hold lifts and t-3 starts.
        yield* advanceUntil(/t-3 dispatching/, "5 minutes")
        yield* advanceUntil(closed("t-1"), "5 minutes")
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      "[2] t-2 dispatching: t-2",
      `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at ${clock(2 * hour * 1000)}`,
      closed("t-2"),
      "USAGE_LIMIT lifted",
      "[3] t-3 dispatching: t-3",
      closed("t-1"),
    ])
    expect(ran.log.some((text) => text.includes("nothing else runs"))).toBe(false)
    const records = ran.events.filter((r) => r.kind === "usage_limit")
    expect(records.map((r) => (r.kind === "usage_limit" ? r.status : ""))).toEqual([
      "rejected",
      "lifted",
    ])
  })
})

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** Moves TestClock on by `step` at a time, until a log line matches `pattern`. */
const advanceUntil = (pattern: RegExp, step: Duration.Input) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* advance(step)
      yield* Effect.promise(() => Bun.sleep(5))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** The line of a ticket closed and merged. */
const closed = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )
