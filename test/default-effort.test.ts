import { describe, expect, test } from "bun:test"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { Exit, Option, Result } from "effect"
import fc from "fast-check"
import {
  interviewOptions,
  probeOptions,
  type WorkerCallbacks,
  workerOptions,
} from "../src/agent/options.ts"
import {
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  resolve,
} from "../src/cli/AppConfig.ts"
import { noFlags } from "../src/cli/flags.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import { efforts, Settings } from "../src/project/settings.ts"
import { appConfig } from "../src/testing/AppConfig.ts"

const file = ".tutti/settings.json"

const callbacks: WorkerCallbacks = {
  canUseTool: async () => ({ behavior: "allow" }),
  onElicitation: async () => ({ action: "decline" }),
  hooks: {},
  stderr: () => {},
}

const server = { type: "sdk", name: "tutti", instance: {} } as McpSdkServerConfigWithInstance

/** The effort of a worker's, the probe's and the interview's options under `config`. */
const effortsOf = (config: AppConfigValue) => {
  const shared = {
    config,
    env: { PATH: "/usr/bin" },
    abortController: new AbortController(),
  }
  const session = { _tag: "New", sessionId: "s" } as const
  return {
    worker: workerOptions({
      ...shared,
      ticket: "tutti-abc.1",
      worktree: "/work/project-tutti/tutti-abc.1",
      prompt: null,
      servers: { servers: [], note: null },
      skills: false,
      callbacks,
      session,
    }).effort,
    probe: probeOptions({ ...shared, stderr: () => {} }).effort,
    interview: interviewOptions({
      ...shared,
      setup: { prompt: "Talk it through.", server },
      chrome: false,
      callbacks,
      session,
    }).effort,
  }
}

const withEffort = (effort: Settings["workers"]["effort"]): AppConfigValue => {
  const base = appConfig()
  return {
    ...base,
    settings: { ...base.settings, workers: { ...base.settings.workers, effort } },
  }
}

describe("workers.effort's default", () => {
  test("is high when the settings don't say, and null when they say null", () => {
    const missing = decodeConfig(Settings, file, {})
    const unset = decodeConfig(Settings, file, { workers: { mcp_servers: [] } })
    const none = decodeConfig(Settings, file, { workers: { effort: null } })
    expect(Exit.isSuccess(missing) && missing.value.workers.effort).toBe("high")
    expect(Exit.isSuccess(unset) && unset.value.workers.effort).toBe("high")
    expect(Exit.isSuccess(none) && none.value.workers.effort).toBeNull()
    expect(defaultSettings.workers.effort).toBe("high")
  })

  test("workers, the login probe and the feature interview start at high by default", () => {
    expect(effortsOf(appConfig())).toEqual({ worker: "high", probe: "high", interview: "high" })
  })

  test("null leaves the effort to Claude Code, for all three", () => {
    const options = effortsOf(withEffort(null))
    expect(options).toEqual({ worker: undefined, probe: undefined, interview: undefined })
  })

  test("the settings' level, or --worker-effort's over it, is the one all three start at", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...efforts),
        fc.option(fc.constantFrom(...efforts), { nil: undefined }),
        (setting, flag) => {
          const resolved = resolve({
            repo: "/work/project",
            flags: flag === undefined ? noFlags : { ...noFlags, workerEffort: Option.some(flag) },
            env: () => undefined,
            user: defaultUserConfig,
            settings: {
              ...defaultSettings,
              workers: { ...defaultSettings.workers, effort: setting },
            },
          })
          if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
          const level = flag ?? setting
          expect(effortsOf(resolved.success)).toEqual({
            worker: level,
            probe: level,
            interview: level,
          })
        },
      ),
    )
  })
})
