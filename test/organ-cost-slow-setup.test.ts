// A call's time runs from before its setup (§ 6.1's Cost): the time a call of unknown cost ran
// counts its setup, and a time limit that ends the call during its setup still records it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Duration, Effect, type Exit, FileSystem, Layer } from "effect"
import { LanguageModel } from "effect/ai"
import { layer, OrganCall } from "../src/organs/AgentSdkLanguageModel.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import type { Log } from "../src/run/log.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as costLayer } from "../src/testing/OrganCost.ts"
import { testEnv } from "./env.ts"

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** The real file system, its session folders made `delay` late: a slow setup. */
const slowSetup = (delay: Duration.Input) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return {
        ...fs,
        makeTempDirectoryScoped: (options?: Parameters<typeof fs.makeTempDirectoryScoped>[0]) =>
          Effect.delay(fs.makeTempDirectoryScoped(options), delay),
      }
    }),
  ).pipe(Layer.provide(BunServices.layer))

/** Runs `effect` with the provider over the fake, its setup `delay` late, its session hanging. */
const run = <A, E>(
  delay: Duration.Input,
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel | OrganCost | Log>,
): Promise<Exit.Exit<A, E>> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-organ-cost-test-"))
  const scenario = { turns: [[{ hang: true }]], eofAfterTurn: true }
  return Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        layer({
          account: { subscription: true },
          env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) },
        }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              costLayer(),
              configLayer(appConfig({ claude: fake }, dir)),
              BunServices.layer,
              slowSetup(delay),
            ),
          ),
        ),
      ),
    ),
  )
}

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (exit._tag === "Failure") throw new Error(`failed: ${String(exit.cause)}`)
  return exit.value
}

const total = Effect.flatMap(OrganCost, (costs) => costs.total)

/** A triage call under a time limit: "answered" or "timed out". */
const triage = (limit: Duration.Input) =>
  LanguageModel.generateText({ prompt: "What became of tut-1?" }).pipe(
    Effect.provideService(OrganCall, { organ: "triage" }),
    Effect.as("answered"),
    Effect.timeoutOrElse({ duration: limit, orElse: () => Effect.succeed("timed out") }),
  )

describe("an organ call with a slow setup", () => {
  test("timed out after its setup, the time it ran counts the setup", async () => {
    const before = Date.now()
    const exit = await run("900 millis", Effect.all([triage("1500 millis"), texts, total]))
    const elapsed = Date.now() - before
    const [outcome, lines, sum] = value(exit)
    expect(outcome).toBe("timed out")
    expect(lines).toHaveLength(1)
    expect(sum).toMatchObject({ calls: 1, costUsd: 0, turns: 0, unknown: 1 })
    // At least the setup's delay, less a timer's early wakeup.
    expect(sum.durationMs).toBeGreaterThanOrEqual(890)
    expect(sum.durationMs).toBeLessThanOrEqual(elapsed)
  })

  test("timed out during its setup, it is still counted as a call of unknown cost", async () => {
    const before = Date.now()
    const exit = await run("10 seconds", Effect.all([triage("300 millis"), texts, total]))
    const elapsed = Date.now() - before
    const [outcome, lines, sum] = value(exit)
    expect(outcome).toBe("timed out")
    expect(lines).toHaveLength(1)
    expect(sum).toMatchObject({ calls: 1, costUsd: 0, turns: 0, unknown: 1 })
    expect(sum.durationMs).toBeGreaterThan(0)
    expect(sum.durationMs).toBeLessThanOrEqual(elapsed)
  })
})
