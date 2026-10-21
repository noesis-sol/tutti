// A project tutti init set up whose worker prompt is gone (§ 5 item 1, § 9.1): .tutti/settings.json
// is there and .tutti/worker-prompt.md isn't. As in orchestra, that is a setup problem naming the
// file and `tutti init`, where tutti ran on the built-in template.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit } from "effect"
import { NotLoggedIn } from "../src/agent/Account.ts"
import type { AppConfigValue, SetupProblem } from "../src/cli/AppConfig.ts"
import { builtInWorkerPrompt, loadWorkerPrompt, type WorkerPrompt } from "../src/project/prompt.ts"
import { check, report, type Started, type StartupFailed } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"

const missing = "Worker prompt not found: .tutti/worker-prompt.md. Recreate it with: tutti init"

/** A project with .tutti/settings.json and no worker prompt, unless `settings` is false. */
const project = (settings = true) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-prompt-missing-")))
  const repo = join(dir, "repo")
  mkdirSync(repo)
  mkdirSync(join(repo, ".beads"))
  if (settings) {
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  }
  return { dir, repo }
}

const load = (config: AppConfigValue) =>
  Effect.runPromise(
    Effect.exit(Effect.provide(loadWorkerPrompt(config), BunServices.layer)),
  ) as Promise<Exit.Exit<WorkerPrompt, SetupProblem>>

/** The startup checks in `repo`, over an in-memory git whose main checkout is there. */
const run = (
  repo: string,
  config: Partial<AppConfigValue> = {},
  account = TestAccount.layer(),
): Promise<Exit.Exit<Started, StartupFailed>> =>
  Effect.runPromise(
    Effect.exit(
      check({
        cwd: repo,
        env: {},
        config: (top) => Effect.succeed(TestAppConfig.appConfig(config, top)),
        beads: () => TestBeads.layer(),
        claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
        account,
      }),
    ).pipe(
      Effect.provide(TestGit.layer({ dir: repo })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..", "home") } })),
      ),
      Effect.provide(BunServices.layer),
    ),
  )

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("it succeeded")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
  return reason.error
}

describe("loadWorkerPrompt", () => {
  test("a missing project prompt beside the settings is a setup problem", async () => {
    const { repo } = project()
    expect(failure(await load(TestAppConfig.appConfig({}, repo))).problems).toEqual([missing])
  })

  test("a project without the settings still gets the built-in template", async () => {
    const { repo } = project(false)
    const exit = await load(TestAppConfig.appConfig({}, repo))
    expect(exit).toEqual(Exit.succeed({ text: builtInWorkerPrompt, file: null }))
  })

  test("a --prompt file of its own needs no project prompt", async () => {
    const { dir, repo } = project()
    const prompt = join(dir, "mine.md")
    writeFileSync(prompt, "Mine: TICKET_ID.\n")
    const exit = await load(TestAppConfig.appConfig({ prompt }, repo))
    expect(exit).toEqual(Exit.succeed({ text: "Mine: TICKET_ID.\n", file: prompt }))
  })
})

describe("the startup checks", () => {
  test("list the missing worker prompt with the other problems", async () => {
    const { repo } = project()
    const failed = failure(await run(repo, {}, TestAccount.layer(new NotLoggedIn())))
    expect(failed.notSetUp).toBe(false)
    expect(failed.problems).toEqual([
      "Not logged in to Claude: run claude /login, or tutti login",
      missing,
    ])
    expect(report(failed)).toBe(
      ["tutti cannot start:", ...failed.problems.map((problem) => `  - ${problem}`)].join("\n"),
    )
  })

  test("pass with a --prompt file though the project prompt is gone", async () => {
    const { dir, repo } = project()
    const prompt = join(dir, "mine.md")
    writeFileSync(prompt, "Work on TICKET_ID.\n")
    const exit = await run(repo, { prompt })
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(exit.value.prompt.file).toBe(prompt)
  })
})
