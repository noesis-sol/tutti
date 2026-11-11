// The startup checks' clean tree (§ 5 item 1; tutti-6svh): uncommitted changes to tracked files in
// the main checkout refuse the run, but an untracked file there, a .DS_Store or a tool's stray
// file, is left to git, as the merge's pre-check leaves it (tutti-epza.5).
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit } from "effect"
import type { AppConfigValue } from "../src/core/AppConfig.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { check, type Started, type StartupFailed } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import { Repository } from "../src/testing/Git.ts"

/** What the main checkout's one commit holds. */
const committed = { "README.md": "# Shop\n", "docs/shop.md": "# Shop\n", ".gitattributes": "" }

/** A project `tutti init` has set up, its spec on disk as `docs/shop.md`. */
const project = (spec = "# Shop\n") => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-startup-untracked-"))), "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  mkdirSync(join(repo, ".beads"))
  mkdirSync(join(repo, "docs"))
  writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  writeFileSync(join(repo, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
  writeFileSync(join(repo, "docs", "shop.md"), spec)
  return repo
}

/** The startup checks in `repo`, after `before` has changed the main checkout. */
const run = (
  repo: string,
  before: (repository: Repository["Service"]) => Effect.Effect<unknown>,
  config: Partial<AppConfigValue> = {},
  uncommitted: ReadonlyArray<string> = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* before(yield* Repository)
      return yield* Effect.exit(
        check({
          cwd: repo,
          env: {},
          config: (top) => Effect.succeed(TestAppConfig.appConfig(config, top)),
          beads: () => TestBeads.layer(),
          claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
          account: TestAccount.layer(),
          uncommitted,
        }),
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(TestGit.layer({ dir: repo, files: committed })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..") } })),
      ),
      Effect.provide(BunServices.layer),
    ),
  )

const passed = (exit: Exit.Exit<Started, StartupFailed>): Started => {
  if (Exit.isFailure(exit)) throw new Error(`the checks failed: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const problems = (exit: Exit.Exit<Started, StartupFailed>): ReadonlyArray<string> => {
  if (Exit.isSuccess(exit)) throw new Error("the checks passed")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
  return reason.error.problems
}

const dirty = (files: string) =>
  `The main checkout has uncommitted changes (${files}). Commit or stash them first: finished tickets merge into it. Inspect with: git status`

describe("the startup checks' clean tree", () => {
  test("an untracked .DS_Store or a tool's stray file doesn't refuse the run", async () => {
    const repo = project()
    passed(
      await run(repo, (repository) =>
        repository.write(repo, {
          ".DS_Store": "\u0000\u0000\u0000\u0001Bud1",
          "docs/.DS_Store": "\u0000\u0000\u0000\u0001Bud1",
          "coverage/lcov.info": "TN:\n",
          "notes.txt": "mine\n",
        }),
      ),
    )
  })

  test("a changed tracked file refuses it, the untracked ones beside it not named", async () => {
    const repo = project()
    expect(
      problems(
        await run(repo, (repository) =>
          repository.write(repo, { "README.md": "# Shop, changed\n", ".DS_Store": "Bud1" }),
        ),
      ),
    ).toEqual([dirty("README.md")])
  })

  test("a new file staged with git add is an uncommitted change", async () => {
    const repo = project()
    expect(
      problems(
        await run(repo, (repository) =>
          Effect.andThen(
            repository.write(repo, { "src/new.ts": "export {}\n", ".DS_Store": "Bud1" }),
            repository.stage(repo, ["src/new.ts"]),
          ),
        ),
      ),
    ).toEqual([dirty("src/new.ts")])
  })

  test("a spec run's tracked spec and setup files, changed, are no clean-tree problem", async () => {
    const repo = project("# Shop, refined\n")
    passed(
      await run(
        repo,
        (repository) =>
          repository.write(repo, {
            "docs/shop.md": "# Shop, refined\n",
            ".gitattributes": "CHANGELOG.md merge=union\n",
          }),
        { spec: "docs/shop.md", specFrom: "--spec" },
        [".gitattributes"],
      ),
    )
  })
})
