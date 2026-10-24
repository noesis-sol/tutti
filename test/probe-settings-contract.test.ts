// Contract test (§ 13, TUTTI_LIVE=1): what the account probe reads that the SDK's types leave out.
// getSettings() is a control request Claude Code answers at runtime, and current_permission_mode a
// field of the initialization result, and neither is in sdk.d.ts (§ 4.13). This pins both, as
// Claude Code sends them, for the embedded Claude Code, so an SDK bump that moves or drops one fails
// here rather than letting the probe miss skipped settings files.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Layer } from "effect"
import { BilledAs, ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { probeOptions } from "../src/agent/options.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"
import { live } from "./gates.ts"

/** A prompt that sends nothing until `signal` aborts. */
async function* nothing(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
}

/**
 * Starts a probe session in `repo`, as the probe does, through ClaudeCode, and returns what it
 * answers, untyped: its initialization result and its settings (getSettings()).
 */
const answers = (repo: string): Promise<{ init: unknown; settings: unknown }> => {
  const config = TestAppConfig.appConfig({}, repo)
  return Effect.gen(function* () {
    const ended = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => ended.abort()))
    const session = yield* (yield* ClaudeCode).open({
      options: probeOptions({ config }),
      prompt: nothing(ended.signal),
      billedAs: BilledAs.LoginProbe(),
      env: testEnv,
      closeLimit: Duration.seconds(10),
    })
    const init: unknown = yield* session.initialization
    const settings = yield* session.settings
    return { init, settings }
  }).pipe(
    Effect.scoped,
    Effect.provide(ClaudeCode.layer.pipe(Layer.provide(TestAppConfig.layer(config)))),
    Effect.runPromise,
  )
}

live.describe("the probe's untyped answers", () => {
  test(
    "getSettings() lists skipped settings files, and the init carries the permission mode",
    async () => {
      // A temp repository whose settings.json doesn't parse and whose settings.local.json is
      // valid JSON that settings' schema rejects.
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-settings-errors-")))
      Bun.spawnSync(["git", "init", "-q", repo])
      mkdirSync(join(repo, ".claude"))
      writeFileSync(join(repo, ".claude", "settings.json"), "{ not json")
      writeFileSync(
        join(repo, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { allow: "Bash(echo hi)" } }),
      )

      const { init, settings } = await answers(repo)

      // A Query without getSettings() answers undefined.
      expect(settings).toBeDefined()
      const errors = (settings as { errors?: unknown }).errors
      expect(Array.isArray(errors)).toBe(true)
      const entries = errors as Array<Record<string, unknown>>
      for (const entry of entries) {
        expect(typeof entry.file).toBe("string")
        expect(typeof entry.path).toBe("string")
        expect(typeof entry.message).toBe("string")
        expect(entry.message).not.toBe("")
      }
      const files = new Set(entries.map((entry) => entry.file))
      expect(files).toContain(join(repo, ".claude", "settings.json"))
      expect(files).toContain(join(repo, ".claude", "settings.local.json"))

      const mode = (init as { current_permission_mode?: unknown }).current_permission_mode
      expect(typeof mode).toBe("string")
      expect(mode).not.toBe("")
    },
    { timeout: 90_000 },
  )
})
