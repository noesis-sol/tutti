// Contract test (§ 13, TUTTI_LIVE=1): what the account probe reads that the SDK's types leave out.
// getSettings() is a control request Claude Code answers at runtime, and current_permission_mode a
// field of the initialization result, and neither is in sdk.d.ts (§ 4.13). This pins both, as
// Claude Code sends them, for the embedded Claude Code, so an SDK bump that moves or drops one fails
// here rather than letting the probe miss skipped settings files.
import { expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { probeEnv } from "../src/agent/env.ts"
import { probeOptions } from "../src/agent/options.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"
import { live } from "./gates.ts"

/** A prompt that sends nothing until `signal` aborts. */
async function* nothing(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
}

/**
 * Starts a probe session in `repo`, as the probe does, and returns what it answers, untyped: its
 * initialization result and its settings.
 */
const answers = async (repo: string): Promise<{ init: unknown; settings: unknown }> => {
  const abortController = new AbortController()
  let closed: Promise<void> | undefined
  const session = query({
    prompt: nothing(abortController.signal),
    options: probeOptions({
      config: TestAppConfig.appConfig({}, repo),
      env: probeEnv({ env: testEnv }),
      stderr: () => {},
      spawned: (child: ChildProcess) => {
        closed = new Promise((resolve) => child.once("close", () => resolve()))
      },
      abortController,
    }),
  })
  try {
    const init: unknown = await session.initializationResult()
    const getSettings = (session as { getSettings?: () => Promise<unknown> }).getSettings
    expect(typeof getSettings).toBe("function")
    const settings = await getSettings?.call(session)
    return { init, settings }
  } finally {
    session.close()
    if (closed !== undefined) {
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 10_000))])
    }
    abortController.abort()
  }
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
