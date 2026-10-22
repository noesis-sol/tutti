// The usage probe (§ 4.12): before the usage-limit hold lifts on the clock, it asks the account
// with one tiny model turn. Refused, the hold holds on to the reset the probe gave, or tries again
// retryEvery later, and no worker is told to carry on; unanswered, it lifts on the clock; a
// session's word that the account is under the limit lifts it with no probe. The probe's answer is
// read from its turn's messages, and its live layer runs one isolated haiku turn, its cost an
// organ call's.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Options, query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import fc from "fast-check"
import { UsageLimits } from "../src/agent/UsageLimits.ts"
import {
  answerOf,
  ProbeAnswer,
  probeModel,
  probeOrgan,
  UsageProbe,
} from "../src/agent/UsageProbe.ts"
import { Ledger } from "../src/run/ledger.ts"
import { resetLabel } from "../src/run/localTime.ts"
import { run } from "../src/run/run.ts"
import type { Dashboard } from "../src/run/screen.ts"
import { carryOnText, make as makeUsageHold } from "../src/run/usageLimit.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses, hitsUsageLimit, type Sent } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as organCostLayer } from "../src/testing/OrganCost.ts"
import { Probed } from "../src/testing/UsageProbe.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

setDefaultTimeout(30_000)

const hour = 3600
const hourMs = hour * 1000

const fixture = (name: string): ReadonlyArray<SDKMessage> =>
  readFileSync(resolve(import.meta.dir, "fixtures/usage-limit", name), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SDKMessage)

const result = (fields: object): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    num_turns: 1,
    total_cost_usd: 0.0004,
    duration_ms: 1800,
    session_id: "probe",
    ...fields,
  }) as unknown as SDKMessage

const rateLimitEvent = (status: string, resetsAt?: number): SDKMessage =>
  ({
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      rateLimitType: "five_hour",
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
  }) as unknown as SDKMessage

describe("the probe's answer", () => {
  test("a rejected event, a rate_limit error or a 429 result is Refused, with the event's reset", () => {
    expect(answerOf(fixture("rejected.jsonl"))).toEqual(
      ProbeAnswer.Refused({ limit: "five_hour", resetsAt: 1_792_222_200_000 }),
    )
    expect(answerOf(fixture("result-429.jsonl"))).toEqual(
      ProbeAnswer.Refused({ limit: null, resetsAt: null }),
    )
  })

  test("a clean result or an allowed event is Allowed; anything else Unanswered", () => {
    expect(answerOf([result({})])).toEqual(ProbeAnswer.Allowed())
    expect(answerOf([rateLimitEvent("allowed_warning"), result({})])).toEqual(ProbeAnswer.Allowed())
    expect(
      answerOf([rateLimitEvent("allowed"), result({ is_error: true, api_error_status: 500 })]),
    ).toEqual(ProbeAnswer.Allowed())
    expect(
      answerOf([result({ is_error: true, api_error_status: 500, result: "API Error: 500" })]),
    ).toEqual(ProbeAnswer.Unanswered({ reason: "API Error: 500" }))
    expect(answerOf([])).toEqual(
      ProbeAnswer.Unanswered({ reason: "the session ended with no result" }),
    )
  })

  test("the last rate_limit_event's status decides, whatever came before", () => {
    const status = fc.constantFrom("allowed", "allowed_warning", "rejected")
    fc.assert(
      fc.property(fc.array(status, { minLength: 1 }), (statuses) => {
        const events = statuses.map((each) => rateLimitEvent(each, hour))
        const answer = answerOf([...events, result({})])
        expect(answer._tag).toBe(statuses.at(-1) === "rejected" ? "Refused" : "Allowed")
      }),
    )
  })

  test("asks haiku, or the model a seven-day limit of its own counts", () => {
    expect(probeModel(null)).toBe("haiku")
    expect(probeModel("five_hour")).toBe("haiku")
    expect(probeModel("seven_day")).toBe("haiku")
    expect(probeModel("seven_day_opus")).toBe("opus")
    expect(probeModel("seven_day_sonnet")).toBe("sonnet")
  })
})

describe("the live probe", () => {
  /** A query() that answers `messages`, keeping the options it was given and whether it closed. */
  const fake = (messages: ReadonlyArray<SDKMessage> | Error) => {
    const seen: { options?: Options; closed: boolean } = { closed: false }
    const open = ((args: { readonly options?: Options }) => {
      if (messages instanceof Error) throw messages
      if (args.options !== undefined) seen.options = args.options
      const session = (async function* () {
        for (const m of messages) yield m
      })()
      return Object.assign(session, {
        close: () => {
          seen.closed = true
        },
      })
    }) as unknown as typeof query
    return { open, seen }
  }

  const probing = (open: typeof query, limit: string | null) =>
    Effect.gen(function* () {
      const probe = yield* UsageProbe
      const answer = yield* probe.probe(limit)
      return { answer, log: yield* texts }
    }).pipe(
      Effect.provide(
        UsageProbe.layerWith(open, { account: { subscription: true }, env: {} }).pipe(
          Layer.provideMerge(Layer.mergeAll(configLayer(), organCostLayer(), BunServices.layer)),
        ),
      ),
      Effect.runPromise,
    )

  test("runs one isolated turn of the probe's model, its cost an organ call's", async () => {
    const { open, seen } = fake([rateLimitEvent("allowed", hour), result({})])
    const { answer, log } = await probing(open, "five_hour")
    expect(answer).toEqual(ProbeAnswer.Allowed())
    expect(seen.options).toMatchObject({
      model: "haiku",
      maxTurns: 1,
      tools: [],
      settingSources: [],
      persistSession: false,
    })
    expect(seen.closed).toBe(true)
    expect(log).toContain(`ORGAN ${probeOrgan}: $0.0004 in 1 turn, 1.8s`)
  })

  test("refused, it gives the limit and its reset", async () => {
    const { open } = fake(fixture("rejected.jsonl"))
    const { answer } = await probing(open, null)
    expect(answer).toEqual(ProbeAnswer.Refused({ limit: "five_hour", resetsAt: 1_792_222_200_000 }))
  })

  test("a session that can't start is Unanswered, its cost unknown", async () => {
    const { open } = fake(new Error("no Claude Code"))
    const { answer, log } = await probing(open, null)
    expect(answer).toEqual(ProbeAnswer.Unanswered({ reason: "no Claude Code" }))
    expect(log.some((text) => text.startsWith(`ORGAN ${probeOrgan}:`))).toBe(true)
  })
})

/** Waits, in real time, until `count` log lines match `pattern`. */
const untilLogged = (pattern: RegExp, count = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).filter((text) => pattern.test(text)).length >= count) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no ${count} log lines matched ${pattern}`)
  })

/** Lets the hold go as far as it can, in real time, without the clock moving. */
const settle = Effect.promise(() => Bun.sleep(50))

const lifted = /^USAGE_LIMIT lifted$/
const refusedProbe = /^USAGE_LIMIT: a probe is refused for the five-hour limit still; /

/** The usage-limit hold alone, under `setup`'s probe answers, held by a rejection resetting at 1h. */
const heldHold = <A>(
  setup: Setup,
  during: Effect.Effect<A, unknown, Env | UsageLimits>,
  rejection: { readonly resetsAt?: number } = { resetsAt: hour },
) =>
  scenario(
    setup,
    Effect.gen(function* () {
      const hold = yield* makeUsageHold({
        base: "main",
        wakeUp: Effect.void,
        show: () => Effect.void,
      })
      const usage = yield* UsageLimits
      yield* usage.report({ status: "rejected", rateLimitType: "five_hour", ...rejection })
      for (let i = 0; i < 2000 && !(yield* hold.held); i++) {
        yield* Effect.promise(() => Bun.sleep(2))
      }
      expect(yield* hold.held).toBe(true)
      yield* during
      return yield* hold.held
    }).pipe(Effect.provide(Ledger.layer)),
  )

describe("the hold's probe", () => {
  test("refused with no reset, the hold tries again retryEvery later", async () => {
    const ran = await heldHold(
      { usageProbe: [ProbeAnswer.Refused({ limit: null, resetsAt: null })] },
      Effect.gen(function* () {
        yield* advance("61 minutes")
        yield* untilLogged(refusedProbe)
        yield* advance("14 minutes")
        yield* settle
        expect((yield* texts).filter((text) => lifted.test(text))).toHaveLength(0)
        yield* advance("1 minute")
        yield* untilLogged(lifted)
        expect(yield* (yield* Probed).limits).toEqual(["five_hour", "five_hour"])
      }),
    )
    expect(ran.exit).toEqual(Exit.succeed(false))
    expect(ran.log).toContain(
      `USAGE_LIMIT: a probe is refused for the five-hour limit still; tutti tries again at ${resetLabel(hourMs + 16 * 60_000, hourMs + 60_000)}, in 15m`,
    )
  })

  test("unanswered, the hold lifts on the clock", async () => {
    const ran = await heldHold(
      { usageProbe: [ProbeAnswer.Unanswered({ reason: "no answer within 1m" })] },
      Effect.gen(function* () {
        yield* advance("61 minutes")
        yield* untilLogged(lifted)
      }),
    )
    expect(ran.exit).toEqual(Exit.succeed(false))
    expectLog(ran, [
      "  the usage probe got no answer (no answer within 1m); the hold lifts on the clock",
      "USAGE_LIMIT lifted",
    ])
  })

  test("a session's word that the account is allowed lifts it with no probe", async () => {
    const ran = await heldHold(
      {},
      Effect.gen(function* () {
        yield* advance("2 minutes")
        const usage = yield* UsageLimits
        yield* usage.report({ status: "allowed", rateLimitType: "five_hour" })
        yield* untilLogged(lifted)
        expect(yield* (yield* Probed).limits).toEqual([])
      }),
    )
    expect(ran.exit).toEqual(Exit.succeed(false))
  })

  test("a session's word during a probe lifts it, the probe given up", async () => {
    const answered = Deferred.makeUnsafe<ProbeAnswer>()
    const ran = await heldHold(
      { usageProbe: [Deferred.await(answered)] },
      Effect.gen(function* () {
        yield* advance("61 minutes")
        for (let i = 0; i < 2000 && (yield* (yield* Probed).limits).length === 0; i++) {
          yield* Effect.promise(() => Bun.sleep(2))
        }
        const usage = yield* UsageLimits
        yield* usage.report({ status: "allowed", rateLimitType: "five_hour" })
        yield* untilLogged(lifted)
        // Its refusal, had it come, is never read.
        yield* Deferred.succeed(answered, ProbeAnswer.Refused({ limit: null, resetsAt: null }))
        yield* settle
      }),
    )
    expect(ran.exit).toEqual(Exit.succeed(false))
    expect(ran.log.filter((text) => refusedProbe.test(text))).toEqual([])
  })
})

describe("a run whose probe is refused", () => {
  const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-probe-${name}-`)))

  /** The messages tutti sent `ticket`'s worker, by their text. */
  const messagesTo = (sent: ReadonlyArray<Sent>, ticket: string): ReadonlyArray<string> =>
    sent.flatMap((each) =>
      each._tag === "Message" && each.ticket === ticket
        ? [String(each.message.message.content)]
        : [],
    )

  test("tells its worker nothing until a probe at the new reset is allowed", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const finishes = (world: World) =>
      claimsAndCloses("t-1", {
        claim: Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
        commit: Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
          ),
        ),
        close: Effect.asVoid(Effect.orDie(world.beads.close("t-1", "done"))),
      })
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({ "t-1": [[...hitsUsageLimit(hour), ...finishes(world)]] }),
        usageProbe: [ProbeAnswer.Refused({ limit: "five_hour", resetsAt: 2 * hourMs })],
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        const dashboard: Dashboard = () => Effect.void
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [], dashboard }),
        )
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        yield* advance("61 minutes")
        yield* untilLogged(refusedProbe)
        yield* advance("59 minutes")
        yield* settle
        expect((yield* texts).filter((text) => lifted.test(text))).toHaveLength(0)
        yield* advance("1 minute")
        yield* untilLogged(lifted)
        expect(yield* (yield* Probed).limits).toEqual(["five_hour", "five_hour"])
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at ${resetLabel(hourMs, 0)}`,
      `USAGE_LIMIT: a probe is refused for the five-hour limit still; it resets at ${resetLabel(2 * hourMs, hourMs + 60_000)}, in 59m`,
      "USAGE_LIMIT lifted",
      "  t-1: the usage limit has reset; its worker carries on",
    ])
    expect(messagesTo(ran.sent, "t-1").filter((text) => text === carryOnText("t-1"))).toHaveLength(
      1,
    )
  })
})
