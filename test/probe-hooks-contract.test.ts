// Contract test (§ 13, TUTTI_LIVE=1): the login probe's flag settings (`disableAllHooks`) keep the
// embedded Claude Code from running a project's SessionStart hook, which would hold up the probe's
// initialization and every start with it (§ 4.13). The same session without them runs the hook, so
// the test can tell a skipped hook from one Claude Code never ran for a session sent no prompt.
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Layer } from "effect"
import { BilledAs, ClaudeCode, type SessionSpec } from "../src/agent/ClaudeCode.ts"
import { probeOptions } from "../src/agent/options.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"
import { live } from "./gates.ts"

/** A prompt that sends nothing until `signal` aborts. */
async function* nothing(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
}

/** A temp repository whose project settings have a SessionStart hook that writes `hook-ran`. */
const repositoryWithHook = (): { repo: string; marker: string } => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-probe-hooks-")))
  Bun.spawnSync(["git", "init", "-q", repo])
  mkdirSync(join(repo, ".claude"))
  const marker = join(repo, "hook-ran")
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: `touch '${marker}'` }] }],
      },
    }),
  )
  return { repo, marker }
}

/** Starts a session in `repo` with `options`, as the probe does, until it has answered. */
const start = (repo: string, options: (spec: SessionSpec) => SessionSpec): Promise<void> => {
  const config = TestAppConfig.appConfig({}, repo)
  return Effect.gen(function* () {
    const ended = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => ended.abort()))
    const session = yield* (yield* ClaudeCode).open({
      options: options(probeOptions({ config })),
      prompt: nothing(ended.signal),
      billedAs: BilledAs.LoginProbe(),
      env: testEnv,
      closeLimit: Duration.seconds(10),
    })
    yield* session.initialization
    yield* session.settings
  }).pipe(
    Effect.scoped,
    Effect.provide(ClaudeCode.layer.pipe(Layer.provide(TestAppConfig.layer(config)))),
    Effect.runPromise,
  )
}

live.describe("the probe's hooks", () => {
  test(
    "the probe runs no project SessionStart hook; the same session without its settings does",
    async () => {
      const probed = repositoryWithHook()
      await start(probed.repo, (spec) => spec)
      expect(existsSync(probed.marker)).toBe(false)

      const hooked = repositoryWithHook()
      await start(hooked.repo, ({ settings: _, ...spec }) => spec)
      expect(existsSync(hooked.marker)).toBe(true)
    },
    { timeout: 90_000 },
  )
})
