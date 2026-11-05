// --auto-answer without --overnight leaves a permission request to you (spec § 8.2; the maintainer's
// choice, tutti-ym0h): it holds the run with BLOCKED at 4 minutes, its ticket not set aside, nor the
// request denied after 30 s, as --overnight's would be.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Option, Result } from "effect"
import { Attention } from "../src/agent/Attention.ts"
import { defaultSettings, defaultUserConfig, resolve } from "../src/cli/AppConfig.ts"
import { noFlags } from "../src/cli/flags.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { canUseTool, result, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, scenario, whyFailed } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `auto-answer-hold-${name}-`)))

/** Lets the run go, in real time, until `done`. */
const until = <R>(done: Effect.Effect<boolean, never, R>, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if (yield* done) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`never: ${what}: ${(yield* texts).join("\n")}`)
  })

/** What a run of t-1, with the flag's time, logs of its worker's permission request 5 minutes on. */
const logs = (autoAnswer: Duration.Duration) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: { repo, settings: appConfig().settings, overnight: false, autoAnswer },
      backlog: backlog().ticket("t-1").seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      scripts: () => ({
        "t-1": [
          turn([canUseTool("Bash", { command: "rm -rf build" }), sleep("1 hour")], result("x")),
        ],
      }),
    },
    Effect.gen(function* () {
      yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
        branch: "tutti/t-1",
        base: "main",
      })
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      const attention = yield* Attention
      yield* until(
        Effect.map(attention.current, (open) => open.length > 0),
        "the worker's request",
      )
      yield* advance("5 minutes")
      yield* until(
        Effect.map(texts, (log) => log.some((text) => /BLOCKED|set aside|denied/.test(text))),
        "the request's outcome",
      )
      const log = yield* texts
      yield* Fiber.interrupt(fiber)
      return log
    }),
  )
}

describe("--auto-answer without --overnight, and a worker's permission request", () => {
  for (const [name, autoAnswer] of [
    ["bare", Duration.zero],
    ["after 10m", Duration.minutes(10)],
  ] as const) {
    test(`${name}: holds the run with BLOCKED, the ticket kept and the request open`, async () => {
      const ran = await logs(autoAnswer)
      if (ran.exit._tag === "Failure") throw new Error(whyFailed(ran.exit.cause))
      const log = ran.exit.value
      expect(log.some((text) => /BLOCKED >4min: t-1 needs you: Bash/.test(text))).toBe(true)
      expect(log.some((text) => /set aside|denied|deferred/.test(text))).toBe(false)
    })
  }
})

describe("the config --auto-answer resolves to", () => {
  for (const given of ["true", "10m"]) {
    test(`--auto-answer=${given} doesn't turn on what --overnight does for a permission request`, () => {
      const config = resolve({
        repo: "/work/project",
        flags: { ...noFlags, autoAnswer: Option.some(given) },
        env: () => undefined,
        user: defaultUserConfig,
        settings: defaultSettings,
      })
      if (Result.isFailure(config)) throw new Error(`expected a config, got ${config.failure}`)
      expect(config.success.autoAnswer).not.toBeNull()
      expect(config.success).toMatchObject({ overnight: false, denyPermissions: null })
    })
  }
})
