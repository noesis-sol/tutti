import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Layer } from "effect"
import { Account, startProbe } from "../src/agent/Account.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { check } from "../src/run/startup.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import { testEnv } from "./env.ts"

// The login probe answers once its session has answered, without waiting out Claude Code's exit
// (about 0.75 s on 2.1.301, flushing its telemetry): the exit is awaited in the background, in
// the probe's Scope, whose close waits for it (§ 4.13). Over the fake Claude Code
// (test/fixtures/fake-claude/claude.ts), which lingers once closed as the real one does.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** How long the fake lingers once its session is closed, before it exits. */
const linger = 1500

const untrusted =
  "Ignoring 1 permissions.allow entry from /work/.claude/settings.json: this workspace has not been trusted.\n"

/** The fake, lingering once closed, in a fresh checkout; with its log. */
const lingering = (stderrAtStart = untrusted) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-probe-exit-")))
  const log = join(dir, "fake.jsonl")
  const scenario = {
    initialize: { account: { email: "ada@example.com", subscriptionType: "Claude Max" } },
    stderrAtStart,
    lingerOnClose: linger,
    log,
  }
  const env = { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) }
  return { dir, config: appConfig({ claude: fake }, dir), env, log }
}

/** The fake's log: one entry a line. */
const entries = (file: string): Array<Record<string, unknown>> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : []

const exited = (log: string) => entries(log).some((e) => e.exited !== undefined)

describe("the login probe's Claude Code exits in the background", () => {
  test("the probe answers before Claude Code has exited, and its Scope's close waits for it", async () => {
    const { config, env, log } = lingering()
    let exitedAtAnswer = true
    const started = Date.now()
    let answered = 0
    const found = await Effect.runPromise(
      startProbe({ config, env }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            answered = Date.now()
            exitedAtAnswer = exited(log)
          }),
        ),
        Effect.scoped,
        Effect.provide(ClaudeCode.layer.pipe(Layer.provide(configLayer(config)))),
      ),
    )
    const closed = Date.now()
    // The stderr written before initialize's answer was read.
    expect(found.untrustedFiles).toEqual(["/work/.claude/settings.json"])
    expect(found.account.email).toBe("ada@example.com")
    expect(exitedAtAnswer).toBe(false)
    expect(entries(log).some((e) => e.closed === true)).toBe(true)
    expect(exited(log)).toBe(true)
    // The Scope's close waited out the fake's linger, which the answer didn't.
    expect(closed - answered).toBeGreaterThanOrEqual(linger - 500)
    expect(closed - started).toBeLessThan(15_000)
  })

  test("the Account layer's close waits for the probe's Claude Code to exit", async () => {
    const { config, env, log } = lingering()
    let exitedAtAnswer = true
    const account = Account.layerWith(startProbe, env).pipe(
      Layer.provide(ClaudeCode.layer),
      Layer.provide(configLayer(config)),
    )
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Effect.service(Account), (a) => a.probe).pipe(
        Effect.ensuring(Effect.sync(() => (exitedAtAnswer = exited(log)))),
        Effect.provide(account),
      ),
    )
    // The checkout isn't trusted, which the probe fails with; its Claude Code exited all the same.
    expect(exit._tag).toBe("Failure")
    expect(exitedAtAnswer).toBe(false)
    expect(exited(log)).toBe(true)
  })

  test("the startup checks answer before the probe's Claude Code has exited, and the caller's Scope waits for it", async () => {
    const { dir, env, log } = lingering("")
    mkdirSync(join(dir, ".tutti"))
    mkdirSync(join(dir, ".beads"))
    writeFileSync(join(dir, ".tutti", "settings.json"), "{}\n")
    writeFileSync(join(dir, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
    let exitedAtCheck = true
    const checked = await Effect.runPromise(
      check({
        cwd: dir,
        env: {},
        config: (top) => Effect.succeed(appConfig({ claude: fake }, top)),
        beads: () => TestBeads.layer(),
        claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
        account: Account.layerWith(startProbe, env).pipe(Layer.provide(ClaudeCode.layer)),
      }).pipe(
        Effect.tap(() => Effect.sync(() => (exitedAtCheck = exited(log)))),
        Effect.scoped,
        Effect.provide(TestGit.layer({ dir })),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(dir, "home") } })),
        ),
        Effect.provide(BunServices.layer),
      ),
    )
    expect(checked.account.billing._tag).toBe("Subscription")
    // The checks didn't close the probe's layer, which would have waited for the exit.
    expect(exitedAtCheck).toBe(false)
    expect(exited(log)).toBe(true)
  })
})
