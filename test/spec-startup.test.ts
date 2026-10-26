// A spec run's startup checks (§ 4.14, § 5 item 1): the spec is read with the other checks, a
// problem with it listed beside theirs; the spec itself, which the run commits, and the files a
// spec run's setup wrote, are no uncommitted changes in the main checkout.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit } from "effect"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { check, type Started, type StartupFailed } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import { Repository } from "../src/testing/Git.ts"

/** A project `tutti init` has set up, with `files` in its folder, which git doesn't have yet. */
const project = (files: Readonly<Record<string, string>> = {}) => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-startup-"))), "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  mkdirSync(join(repo, ".beads"))
  writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  writeFileSync(join(repo, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  return repo
}

/** The startup checks in `repo` with `config`, the main checkout's working tree holding `files`. */
const run = (
  repo: string,
  config: Partial<AppConfigValue>,
  files: Readonly<Record<string, string>> = {},
  uncommitted: ReadonlyArray<string> = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Repository).write(repo, files)
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
      Effect.provide(TestGit.layer({ dir: repo })),
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

describe("a spec run's startup checks", () => {
  test("read the spec, which may be uncommitted, for the run", async () => {
    const spec = { "docs/shop.md": "# Shop\n" }
    const repo = project(spec)
    const started = passed(await run(repo, { spec: "docs/shop.md", specFrom: "--spec" }, spec))
    expect(started.spec).toMatchObject({ path: "docs/shop.md", copy: false, text: "# Shop\n" })
  })

  test("list a problem with the spec beside the others", async () => {
    const repo = project()
    expect(
      problems(
        await run(repo, { spec: "missing.md", specFrom: "TUTTI_SPEC" }, { "notes.txt": "mine\n" }),
      ),
    ).toEqual([
      "The main checkout has uncommitted changes (notes.txt). Commit or stash them first: finished tickets merge into it. Inspect with: git status",
      "Spec not found: missing.md (TUTTI_SPEC).",
    ])
  })

  test("take the files a spec run's setup wrote as no uncommitted changes", async () => {
    const spec = { "docs/shop.md": "# Shop\n" }
    const repo = project(spec)
    const setup = { "scripts/check-fast.sh": "exit 0\n", "scripts/check-full.sh": "exit 0\n" }
    passed(
      await run(repo, { spec: "docs/shop.md", specFrom: "--spec" }, { ...spec, ...setup }, [
        "scripts/check-fast.sh",
        "scripts/check-full.sh",
      ]),
    )
  })
})
