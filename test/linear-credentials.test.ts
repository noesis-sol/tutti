// Linear's credentials (LINEAR_API_KEY, and bd's OAuth pair) reach nothing tutti starts but its own
// bd linear calls (src/core/env.ts' linearVariable): not a worker, an organ or the login probe
// (workerEnv, through ClaudeCode's launchEnv), not a check or the setup (branchEnv), not git or bd
// (exec's own environment), whatever the billing; and a run started with them set writes them to
// neither its log nor its event stream.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { BilledAs, launchEnv } from "../src/agent/ClaudeCode.ts"
import {
  BranchEnv,
  branchEnv,
  linearCredentials,
  linearVariable,
  linearVariables,
  probeEnv,
  withoutLinear,
  workerEnv,
} from "../src/core/env.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { defaultSettings } from "../src/run/resolveConfig.ts"
import { Checks } from "../src/services/Checks.ts"
import { exec } from "../src/services/exec.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { testEnv, withVariable } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Real processes: a check's shell, and in the slow test tutti, its probe's Claude Code and its setup.
setDefaultTimeout(90_000)

/** The credentials as the maintainer's shell holds them for the sync. */
const credentials = {
  LINEAR_API_KEY: "lin_api_secretkey",
  LINEAR_OAUTH_CLIENT_ID: "lin-oauth-client-id",
  LINEAR_OAUTH_CLIENT_SECRET: "lin-oauth-client-secret",
}

const names = Object.keys(credentials)

/** tutti's environment with the credentials set. */
const tutti = { PATH: "/usr/bin:/bin", HOME: "/home/someone", ...credentials }

/** The credentials' names `env` holds. */
const held = (env: Readonly<Record<string, string | undefined>>): ReadonlyArray<string> =>
  names.filter((name) => name in env)

const accounts = [
  { subscription: true, billing: "subscription" },
  { subscription: true, billing: "api" },
  { subscription: false, billing: "subscription" },
  { subscription: false, billing: "api" },
] as const

describe("linearVariable", () => {
  test("names LINEAR_API_KEY and bd's OAuth pair, and nothing else of Linear's", () => {
    expect([...linearVariables].sort()).toEqual([...names].sort())
    expect(names.every(linearVariable)).toBe(true)
    expect(linearVariable("LINEAR_TEAM")).toBe(false)
    expect(linearVariable("ANTHROPIC_API_KEY")).toBe(false)
  })

  test("withoutLinear keeps the rest; linearCredentials keeps them alone, the set ones", () => {
    expect(withoutLinear(tutti)).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/someone" })
    expect(linearCredentials(tutti)).toEqual(credentials)
    expect(
      linearCredentials({ ...tutti, LINEAR_OAUTH_CLIENT_ID: "", LINEAR_API_KEY: undefined }),
    ).toEqual({
      LINEAR_OAUTH_CLIENT_SECRET: "lin-oauth-client-secret",
    })
  })
})

describe("a worker's, an organ's and the probe's environment", () => {
  test("hold none of them, whatever the account and the billing", () => {
    for (const account of accounts) {
      const workers = workerEnv({ ...account, env: tutti })
      const worker = launchEnv(
        { billedAs: BilledAs.Workers(), share: { checkTimeout: Duration.minutes(20), cores: 3 } },
        workers,
      )
      const organ = launchEnv({ billedAs: BilledAs.Workers() }, workers)
      expect(worker.TUTTI_CORES).toBe("3")
      expect(worker.PATH).toBe("/usr/bin:/bin")
      expect(held(worker)).toEqual([])
      expect(held(organ)).toEqual([])
    }
    expect(held(launchEnv({ billedAs: BilledAs.LoginProbe(), env: tutti }, {}))).toEqual([])
    expect(held(probeEnv({ env: tutti }))).toEqual([])
  })
})

describe("a check's environment", () => {
  test("branchEnv holds none of them, whatever the account and the billing", () => {
    for (const account of accounts) expect(held(branchEnv({ ...account, env: tutti }))).toEqual([])
  })

  test("the setup and the merge check run without them", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tutti-linear-credentials-")))
    const printed = names.map((name) => `\${${name}-unset}`).join(" ")
    const { checks } = defaultSettings
    const settings = {
      ...defaultSettings,
      checks: {
        ...checks,
        setup: { ...checks.setup, command: `echo "${printed}"` },
        fast: { command: `echo "${printed}"`, timeout: Duration.seconds(10) },
      },
    }
    const layer = Checks.layer.pipe(
      Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
    )
    const env = branchEnv({
      subscription: false,
      billing: "subscription",
      env: { ...credentials, PATH: testEnv.PATH ?? "/usr/bin:/bin" },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* Checks
        yield* run.setup({ cwd, outputFile: join(cwd, "setup.log"), before: "fast" })
        yield* run.fast({ cwd, outputFile: join(cwd, "check.log") })
      }).pipe(
        Effect.provide(layer),
        Effect.provide(Layer.succeed(BranchEnv, env)),
        Effect.provide(BunServices.layer),
      ),
    )
    expect(readFileSync(join(cwd, "setup.log"), "utf8")).toBe("unset unset unset\n")
    expect(readFileSync(join(cwd, "check.log"), "utf8")).toBe("unset unset unset\n")
  })
})

describe("git's, bd's and tutti's own commands", () => {
  /** What `sh` prints of the credentials, run by exec from tutti's environment with `env` over it. */
  const run = (env?: Readonly<Record<string, string>>) =>
    withVariable("LINEAR_API_KEY", credentials.LINEAR_API_KEY, () =>
      Effect.runPromise(
        exec({
          command: "sh",
          args: ["-c", `echo "\${LINEAR_API_KEY-unset}"`],
          timeLimit: "10 seconds",
          ...(env === undefined ? {} : { env }),
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
      ),
    )

  test("start without them, from tutti's own environment", async () => {
    expect((await run()).stdout).toBe("unset\n")
  })

  test("a bd linear call gets them back by laying linearCredentials over it", async () => {
    const env = withVariable("LINEAR_API_KEY", credentials.LINEAR_API_KEY, () =>
      linearCredentials(),
    )
    expect((await run(env)).stdout).toBe(`${credentials.LINEAR_API_KEY}\n`)
  })
})

describe("a run started with them set", () => {
  slow.test(
    "writes them to neither its log nor its event stream, nor gives them to its login probe",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-linear-run-")))
      const home = join(root, "home")
      const bin = join(root, "bin")
      const claudeLog = join(root, "claude.log")
      mkdirSync(home)
      mkdirSync(bin)
      writeFileSync(join(bin, "bd"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 })
      const fake = join(import.meta.dir, "fixtures", "fake-claude", "claude.ts")
      writeFileSync(
        join(bin, "claude"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.301 (Claude Code)"; exit 0; fi
exec bun '${fake}' "$@"
`,
        { mode: 0o755 },
      )
      const settings = { checks: { fast: { command: "true" } } }
      const repo = makeRepo()
      repo.commit("Set up tutti", {
        ".tutti/settings.json": `${JSON.stringify(settings, null, 2)}\n`,
        ".tutti/worker-prompt.md": builtInWorkerPrompt,
        ".gitignore": ".tutti/run/\n.tutti/tutti.log\n",
      })
      mkdirSync(join(repo.dir, ".beads"))
      const env: Record<string, string | undefined> = {
        ...testEnv,
        ...credentials,
        PATH: `${bin}:${testEnv.PATH ?? ""}`,
        HOME: home,
        FAKE_CLAUDE_SCENARIO: JSON.stringify({ log: claudeLog, env: names }),
      }
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      const main = join(import.meta.dir, "..", "src", "main.ts")
      const proc = Bun.spawn(
        ["bun", main, "--claude", join(bin, "claude"), "--plain", "--limit", "1"],
        { cwd: repo.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env },
      )
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      const log = readFileSync(join(repo.dir, ".tutti", "tutti.log"), "utf8")
      const events = readFileSync(join(repo.dir, ".tutti", "run", "events.jsonl"), "utf8")
      expect(events).toContain('"kind":"start"')
      for (const value of Object.values(credentials)) {
        expect(log).not.toContain(value)
        expect(events).not.toContain(value)
        expect(stdout).not.toContain(value)
      }
      const started = readFileSync(claudeLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { env?: Record<string, string | null> })
        .filter((entry) => entry.env !== undefined)
      expect(started.length).toBeGreaterThan(0)
      for (const entry of started)
        expect(entry.env).toEqual(Object.fromEntries(names.map((name) => [name, null])))
    },
  )
})
