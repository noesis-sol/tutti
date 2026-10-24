// The SDK's query() throwing as it is called (no Claude Code for the platform) fails an organ
// call as an AiError saying what to do, rather than as a defect, and counts a call of unknown cost.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { query } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { queryThrew } from "../src/agent/claudeBinary.ts"
import { layer, OrganCall } from "../src/organs/AgentSdkLanguageModel.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as costLayer } from "../src/testing/OrganCost.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

/** What the SDK's query() throws when it finds no platform package. */
const noBinary = new Error(
  "Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without " +
    "--omit=optional, or set options.pathToClaudeCodeExecutable.",
)

/** A query() that throws `error` as it is called, as the SDK's does. */
const throwing =
  (error: unknown): typeof query =>
  () => {
    throw error
  }

/** A triage call over the provider whose query() throws `error`, and the costs after it. */
const run = (error: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-organ-query-test-"))
  const call = LanguageModel.generateText({ prompt: "What became of tut-1?" }).pipe(
    Effect.provideService(OrganCall, { organ: "triage" }),
    Effect.exit,
  )
  return Effect.runPromise(
    Effect.all([call, Effect.flatMap(OrganCost, (costs) => costs.total)]).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(
            ClaudeCode.layerWith(throwing(error)).pipe(Layer.provide(workersIn(testEnv))),
          ),
          Layer.provideMerge(
            Layer.mergeAll(costLayer(), configLayer(appConfig({}, dir)), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

/** The AiError a failed call failed with. */
const aiErrorOf = <A>(exit: Exit.Exit<A, AiError.AiError>): AiError.AiError => {
  if (Exit.isSuccess(exit)) throw new Error("the call succeeded")
  const error = Cause.findErrorOption(exit.cause)
  if (error._tag === "None") throw new Error(`no failure: ${String(exit.cause)}`)
  return error.value
}

describe("an organ call whose query() throws", () => {
  test("a missing platform package fails as an AiError with what to do", async () => {
    const [exit, total] = await run(noBinary)
    const error = aiErrorOf(exit)
    expect(error).toBeInstanceOf(AiError.AiError)
    expect(error.method).toBe("generateText")
    expect(error.reason._tag).toBe("UnknownError")
    expect(error.reason.message).toContain(queryThrew(noBinary))
    expect(total).toMatchObject({ calls: 1, costUsd: 0, unknown: 1 })
  })

  test("any other throw fails as an AiError with its message", async () => {
    const [exit] = await run("Invalid pluginDelivery.")
    const error = aiErrorOf(exit)
    expect(error.reason._tag).toBe("UnknownError")
    expect(error.reason.message).toContain("Invalid pluginDelivery.")
  })
})
