// Contract test for the usage-limit hold's probe (§ 4.12) against the real Agent SDK (§ 13), run
// only with TUTTI_LIVE=1: one haiku turn of a few tokens, a fraction of a cent, on this machine's
// Claude login. The account answers it, under the limit or refused for it, never unanswered, and
// its cost is logged as an organ call's.
import { expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ClaudeCode } from "../../src/agent/ClaudeCode.ts"
import { paneVariable } from "../../src/agent/env.ts"
import { probeOrgan, UsageProbe } from "../../src/agent/UsageProbe.ts"
import { layer as configLayer } from "../../src/testing/AppConfig.ts"
import { texts } from "../../src/testing/Log.ts"
import { layer as organCostLayer } from "../../src/testing/OrganCost.ts"
import { live } from "../gates.ts"

const testLimit = 120_000

/** tutti's environment without the variables of a Claude Code session or terminal pane. */
const hostEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name) && !paneVariable(name),
    ),
  )

live.describe("the usage probe", () => {
  live.test(
    "the account answers it, and its cost is an organ call's",
    async () => {
      const { answer, log } = await Effect.gen(function* () {
        const probe = yield* UsageProbe
        const answer = yield* probe.probe("five_hour")
        return { answer, log: yield* texts }
      }).pipe(
        Effect.provide(
          UsageProbe.layer({ account: { subscription: true }, env: hostEnv() }).pipe(
            Layer.provideMerge(ClaudeCode.layer),
            Layer.provideMerge(Layer.mergeAll(configLayer(), organCostLayer(), BunServices.layer)),
          ),
        ),
        Effect.runPromise,
      )
      expect(answer._tag === "Unanswered" ? answer : answer._tag).not.toHaveProperty("reason")
      expect(["Allowed", "Refused"]).toContain(answer._tag)
      expect(log.some((text) => new RegExp(`^ORGAN ${probeOrgan}: \\$\\d`).test(text))).toBe(true)
    },
    testLimit,
  )
})
