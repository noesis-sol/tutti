// What tutti runs on a branch's behalf, the setup, the checks and the requires list's commands, runs
// in the workers' reduced environment, less tutti's own variables (branchEnv, BranchEnv): without
// the terminal pane's, a parent Claude Code session's and git's local variables, and without the
// API key where workers go without it. A check run by tutti then sees what it saw run by the worker.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import {
  apiKeyVariable,
  BranchEnv,
  branchEnv,
  workerEnv,
  workerVariables,
} from "../src/agent/env.ts"
import { makeRequiresTools } from "../src/agent/requiresTools.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { checkRequires } from "../src/run/requires.ts"
import { Checks } from "../src/services/Checks.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { testEnv, withVariable } from "./env.ts"

// Real processes.
setDefaultTimeout(30_000)

/** tutti's environment as a run started from a Claude Code session in a Herdr pane may have it. */
const started = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/someone",
  CLAUDE_CONFIG_DIR: "/home/someone/.claude-work",
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "parent",
  HERDR_PANE: "3",
  TMUX: "/tmp/tmux-1/default",
  GIT_DIR: "/elsewhere/.git",
  GIT_AUTHOR_NAME: "Someone",
  [apiKeyVariable]: "sk-ant-key",
  UNSET: undefined,
}

describe("branchEnv", () => {
  test("leaves out the pane's, the parent session's and git's local variables", () => {
    expect(branchEnv({ subscription: false, billing: "subscription", env: started })).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      CLAUDE_CONFIG_DIR: "/home/someone/.claude-work",
      GIT_AUTHOR_NAME: "Someone",
      [apiKeyVariable]: "sk-ant-key",
    })
  })

  test("goes without the API key where workers do", () => {
    const key = (subscription: boolean, billing: "subscription" | "api") =>
      branchEnv({ subscription, billing, env: started })[apiKeyVariable]
    expect(key(true, "subscription")).toBeUndefined()
    expect(key(true, "api")).toBe("sk-ant-key")
    expect(key(false, "subscription")).toBe("sk-ant-key")
  })

  test("is a worker's environment but tutti's variables", () => {
    for (const subscription of [true, false]) {
      const options = { subscription, billing: "subscription" as const, env: started }
      expect(workerEnv(options)).toEqual({ ...branchEnv(options), ...workerVariables() })
    }
  })
})

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-branch-env-")))

/** What the commands print of the variables a branch's commands should and shouldn't see. */
const printed = 'echo "${TUTTI_GIVEN-unset} ${TUTTI_PROCESS_ONLY-unset} ${GIT_DIR-unset}"'

/** The environment a run gives: its PATH, a variable of its own, and GIT_DIR, which exec drops. */
const given = { PATH: testEnv.PATH ?? "/usr/bin:/bin", TUTTI_GIVEN: "given", GIT_DIR: "/x/.git" }

/** Runs `effect` with BranchEnv as `given`, TUTTI_PROCESS_ONLY set in tutti's own environment. */
const inBranchEnv = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  withVariable("TUTTI_PROCESS_ONLY", "leaked", () =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(Layer.succeed(BranchEnv, given)),
        Effect.provide(BunServices.layer),
      ),
    ),
  )

describe("what tutti runs on a branch's behalf", () => {
  test("the setup and the merge check run in BranchEnv's environment", async () => {
    const cwd = folder()
    const { checks } = defaultSettings
    const settings = {
      ...defaultSettings,
      checks: {
        ...checks,
        setup: { ...checks.setup, command: printed },
        fast: { command: printed, timeout: Duration.seconds(10) },
      },
    }
    const layer = Checks.layer.pipe(
      Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
    )
    const outputFile = join(cwd, "check.log")
    const setupFile = join(cwd, "setup.log")
    await inBranchEnv(
      Effect.gen(function* () {
        const run = yield* Checks
        yield* run.setup({ cwd, outputFile: setupFile, before: "fast" })
        yield* run.fast({ cwd, outputFile })
      }).pipe(Effect.provide(layer)),
    )
    expect(readFileSync(setupFile, "utf8")).toBe("given unset unset\n")
    expect(readFileSync(outputFile, "utf8")).toBe("given unset unset\n")
  })

  test("the requires list's checks and installs run in BranchEnv's environment", async () => {
    const repo = folder()
    const report = await inBranchEnv(
      checkRequires(
        [
          { name: "given", check: 'test "$TUTTI_GIVEN" = given', install: "false" },
          {
            name: "installed",
            check: "test -f printed",
            install: `${printed} > printed.txt; touch printed`,
          },
        ],
        { repo, installLimit: "10 seconds" },
      ),
    )
    expect(report.map((res) => [res.requirement.name, res.state])).toEqual([
      ["given", "met"],
      ["installed", "installed"],
    ])
    expect(readFileSync(join(repo, "printed.txt"), "utf8")).toBe("given unset unset\n")
  })

  test("requires_check runs them in the environment of the services it was made with", async () => {
    const repo = folder()
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(
      join(repo, ".tutti", "settings.json"),
      JSON.stringify({
        requires: [{ name: "given", check: 'test "$TUTTI_GIVEN" = given', install: "false" }],
      }),
    )
    const tools = await inBranchEnv(makeRequiresTools(repo, repo))
    const check = tools.tools[0]
    if (check === undefined) throw new Error("no requires_check")
    const answer = await check.handler({}, {})
    expect(answer.content.map((c) => (c as { text: string }).text).join("\n")).toBe("given: met")
  })
})
