import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { startProbe } from "../src/agent/Account.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { probeOptions, type WorkerCallbacks, workerOptions } from "../src/agent/options.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"

// The login probe runs none of the hooks of the settings files and plugins (§ 4.13): a project's
// SessionStart hook would hold up its initialization, and every start with it. Workers keep theirs.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

const callbacks: WorkerCallbacks = {
  canUseTool: async () => ({ behavior: "allow" }),
  onElicitation: async () => ({ action: "decline" }),
  hooks: {},
  stderr: () => {},
}

describe("the login probe's hooks", () => {
  test("the probe's options disable every hook of the settings files and plugins", () => {
    const options = probeOptions({ config: appConfig({}, "/work/project") })
    expect(options.settings).toEqual({ disableAllHooks: true })
  })

  test("a worker's options leave the project's hooks on", () => {
    const options = workerOptions({
      config: appConfig({}, "/work/project"),
      ticket: "tutti-abc.1" as TicketId,
      worktree: "/work/project-tutti/tutti-abc.1",
      prompt: { text: "You work on TICKET_ID.", file: null },
      servers: { servers: [], note: null },
      skills: false,
      callbacks,
      session: { _tag: "New", sessionId: "s" },
    })
    expect("settings" in options).toBe(false)
  })

  test("Claude Code is started with the flag settings, and the probe reads what it says", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-probe-hooks-"))
    const log = join(dir, "fake.jsonl")
    const scenario = {
      initialize: {
        account: { email: "ada@example.com", subscriptionType: "Claude Max" },
        current_permission_mode: "auto",
      },
      log,
    }
    const env = { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) }
    const config = appConfig({ claude: fake }, dir)
    const found = await Effect.runPromise(
      startProbe({ config, env }).pipe(
        Effect.scoped,
        Effect.provide(ClaudeCode.layer.pipe(Layer.provide(configLayer(config)))),
      ),
    )
    expect(found.account.email).toBe("ada@example.com")
    expect(found.permissionMode).toBe("auto")
    const started = JSON.parse(readFileSync(log, "utf8").split("\n")[0] ?? "{}") as {
      args?: Array<string>
    }
    const args = started.args ?? []
    const at = args.indexOf("--settings")
    expect(at).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(args[at + 1] ?? "{}")).toEqual({ disableAllHooks: true })
  })
})
