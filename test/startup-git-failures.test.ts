// The startup checks when git itself fails (src/run/startup.ts): git not found, its worktrees, the
// main checkout's branch or its changes unreadable, or git taking too long, each a problem line the
// run exits 2 with, over the test Git layer's fail(op).
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit } from "effect"
import { formatDuration } from "../src/project/configFile.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { check, report, type Started, type StartupFailed } from "../src/run/startup.ts"
import { TimeLimit } from "../src/services/exec.ts"
import type { GitOp } from "../src/services/Git.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import { type Fault, Repository } from "../src/testing/Git.ts"

/** A repository `tutti init` has set up, with a Beads database. */
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-startup-git-")))
  const repo = join(dir, "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  writeFileSync(join(repo, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
  mkdirSync(join(repo, ".beads"))
  return repo
}

/**
 * The startup checks in a fresh repository, the next call of git's `op` failing with `fault` (none without one); the
 * repository's main checkout, and how they ended.
 */
const runIn = (op: GitOp | undefined, fault: Fault = {}) => {
  const repo = project()
  const exit = Effect.runPromise(
    Effect.gen(function* () {
      if (op !== undefined) {
        yield* Effect.flatMap(Repository, (repository) => repository.fail(op, fault))
      }
      return yield* Effect.exit(
        check({
          cwd: repo,
          env: {},
          config: (top) => Effect.succeed(TestAppConfig.appConfig({}, top)),
          beads: () => TestBeads.layer(),
          claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
          account: TestAccount.layer(),
        }),
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(TestGit.layer({ dir: repo })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..", "home") } })),
      ),
      Effect.provide(BunServices.layer),
    ),
  )
  return { repo, exit }
}

/** How the startup checks ended, the next call of git's `op` failing with `fault`. */
const run = (op: GitOp | undefined, fault: Fault = {}) => runIn(op, fault).exit

/** The checks' StartupFailed, which they must have failed with. */
const failed = (exit: Exit.Exit<Started, StartupFailed>): StartupFailed => {
  if (Exit.isSuccess(exit)) throw new Error("the checks passed")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
  return reason.error
}

const readLimit = formatDuration(TimeLimit.read)

describe("the startup checks when git fails", () => {
  test("the checks pass with no fault", async () => {
    const exit = await run(undefined)
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("git not found (exit 127) is a required command not found", async () => {
    const failure = failed(
      await run("--version", { exitCode: 127, stderr: "git: command not found" }),
    )
    expect(failure.problems).toEqual(["Required command not found: git"])
    expect(failure.notSetUp).toBe(false)
    expect(report(failure)).toBe("tutti cannot start:\n  - Required command not found: git")
  })

  test("git not found as it lists the worktrees is a required command not found", async () => {
    const failure = failed(await run("worktree list", { exitCode: 127 }))
    expect(failure.problems).toEqual(["Required command not found: git"])
  })

  test("another failure of git --version is left to the commands after it", async () => {
    const exit = await run("--version", { exitCode: 1, stderr: "error: something odd" })
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("git taking too long to list the worktrees says so", async () => {
    const { repo, exit } = runIn("worktree list", { timedOut: true })
    expect(failed(await exit).problems).toEqual([
      `git took too long to list the worktrees of ${repo}.`,
    ])
  })

  test("the branch can't be read: git's stderr", async () => {
    const failure = failed(
      await run("symbolic-ref", { exitCode: 128, stderr: "fatal: bad HEAD\n" }),
    )
    expect(failure.problems).toEqual([
      "Could not read the main checkout's branch: fatal: bad HEAD.",
    ])
  })

  test("the branch can't be read in time: git's time limit", async () => {
    const failure = failed(await run("symbolic-ref", { timedOut: true }))
    expect(failure.problems).toEqual([
      `Could not read the main checkout's branch: git took longer than ${readLimit}.`,
    ])
  })

  test("the status can't be read: git's stderr", async () => {
    const failure = failed(
      await run("status", { exitCode: 128, stderr: "fatal: index file corrupt\n" }),
    )
    expect(failure.problems).toEqual([
      "Could not read the main checkout's changes: fatal: index file corrupt.",
    ])
  })

  test("the status can't be read in time: git's time limit", async () => {
    const failure = failed(await run("status", { timedOut: true }))
    expect(failure.problems).toEqual([
      `Could not read the main checkout's changes: git took longer than ${readLimit}.`,
    ])
  })
})
