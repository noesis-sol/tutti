// The startup checks' committed check scripts (§ 5 item 1; tutti-m9cm): a ticket's worktree has only
// what the base's head commit holds, so a merge check, full check or setup command whose script
// isn't committed there refuses the run, rather than fail every ticket's check with `No such file
// or directory`. The project's settings and worker prompt untracked are a warning.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit } from "effect"
import fc from "fast-check"
import type { AppConfigValue } from "../src/core/AppConfig.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import type { Settings } from "../src/project/settings.ts"
import { commandPath } from "../src/run/committedChecks.ts"
import { defaultSettings } from "../src/run/resolveConfig.ts"
import { check, type Started, type StartupFailed } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import { Repository } from "../src/testing/Git.ts"

/** What the main checkout's one commit holds: no check script. */
const committed = { "README.md": "# Shop\n", ".gitignore": "node_modules/\n" }

/** A project `tutti init` has set up, its files on disk. */
const project = () => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-committed-checks-"))), "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  mkdirSync(join(repo, ".beads"))
  writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  writeFileSync(join(repo, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
  return repo
}

/** Settings whose checks' commands are `commands`'. */
const checks = (commands: {
  readonly fast?: string
  readonly full?: string
  readonly setup?: string
}): Settings => ({
  ...defaultSettings,
  checks: {
    ...defaultSettings.checks,
    fast: { ...defaultSettings.checks.fast, command: commands.fast ?? null },
    full: { ...defaultSettings.checks.full, command: commands.full ?? null },
    setup: { ...defaultSettings.checks.setup, command: commands.setup ?? null },
  },
})

/** The startup checks in `repo` under `settings`, after `before` has changed the main checkout. */
const run = (
  repo: string,
  settings: Settings,
  before: (repository: Repository["Service"]) => Effect.Effect<unknown> = () => Effect.void,
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
          config: (top) => Effect.succeed(TestAppConfig.appConfig({ settings, ...config }, top)),
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

const failed = (exit: Exit.Exit<Started, StartupFailed>): StartupFailed => {
  if (Exit.isSuccess(exit)) throw new Error("the checks passed")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
  return reason.error
}

const notCommitted = (path: string, names: string) =>
  `${path}, ${names}, is not committed on main: a ticket's worktree would not have it. Commit it (git add ${path} .tutti && git commit), then start again.`

const script = "#!/bin/sh\nexit 0\n"

describe("the startup checks' committed check scripts", () => {
  test("an untracked merge check script stops the run, saying to commit it", async () => {
    const repo = project()
    const exit = await run(repo, checks({ fast: "scripts/check-fast.sh" }), (repository) =>
      repository.write(repo, { "scripts/check-fast.sh": script }),
    )
    expect(failed(exit).problems).toEqual([
      notCommitted("scripts/check-fast.sh", "the merge check"),
    ])
  })

  test("a script on no disk nor commit stops it too: a ticket's worktree wouldn't have it", async () => {
    const repo = project()
    expect(failed(await run(repo, checks({ full: "./scripts/check-full.sh" }))).problems).toEqual([
      notCommitted("scripts/check-full.sh", "the full check"),
    ])
  })

  test("each check's script is named once, with every check that runs it", async () => {
    const repo = project()
    const exit = await run(
      repo,
      checks({
        fast: "scripts/check.sh",
        full: "TUTTI_SLOW=1 scripts/check.sh --all",
        setup: "scripts/setup.sh",
      }),
    )
    expect(failed(exit).problems).toEqual([
      notCommitted("scripts/check.sh", "the merge check and the full check"),
      notCommitted("scripts/setup.sh", "the setup command"),
    ])
  })

  test("committed scripts pass", async () => {
    const repo = project()
    passed(
      await run(
        repo,
        checks({
          fast: "scripts/check-fast.sh",
          full: "scripts/check-full.sh",
          setup: "bin/setup",
        }),
        (repository) =>
          repository.commit(repo, "the checks", {
            "scripts/check-fast.sh": script,
            "scripts/check-full.sh": script,
            "bin/setup": script,
          }),
      ),
    )
  })

  test("a committed script changed in the main checkout is the clean tree's problem alone", async () => {
    const repo = project()
    const exit = await run(repo, checks({ fast: "scripts/check-fast.sh" }), (repository) =>
      Effect.andThen(
        repository.commit(repo, "the check", { "scripts/check-fast.sh": script }),
        repository.write(repo, { "scripts/check-fast.sh": "#!/bin/sh\nexit 1\n" }),
      ),
    )
    expect(failed(exit).problems).toEqual([
      "The main checkout has uncommitted changes (scripts/check-fast.sh). Commit or stash them first: finished tickets merge into it. Inspect with: git status",
    ])
  })

  test("a command that isn't a path in the repository isn't looked at", async () => {
    const repo = project()
    passed(
      await run(
        repo,
        checks({
          fast: "npm run check",
          full: "make check",
          setup: "bun install --frozen-lockfile",
        }),
      ),
    )
    passed(await run(repo, checks({ fast: "/usr/bin/true", full: "../other/check.sh" })))
  })

  test("a script git ignores, a tool's under node_modules/, isn't looked at", async () => {
    const repo = project()
    passed(await run(repo, checks({ fast: "node_modules/.bin/vitest run" })))
  })

  test("a spec run's setup files, which it commits with the spec, aren't a problem", async () => {
    const repo = project()
    passed(
      await run(
        repo,
        checks({ fast: "scripts/check-fast.sh" }),
        (repository) => repository.write(repo, { "scripts/check-fast.sh": script }),
        {},
        ["scripts/check-fast.sh"],
      ),
    )
  })
})

describe("the project's files untracked", () => {
  const warning =
    ".tutti/settings.json and .tutti/worker-prompt.md are not committed: a ticket's worktree would not have them, and its worker reads the project's files from its own tree. Commit them (git add .tutti && git commit)."

  test("the settings and the worker prompt untracked are a warning", async () => {
    const repo = project()
    const started = passed(
      await run(repo, checks({}), (repository) =>
        repository.write(repo, {
          ".tutti/settings.json": "{}\n",
          ".tutti/worker-prompt.md": builtInWorkerPrompt,
        }),
      ),
    )
    expect(started.warnings).toEqual([warning])
  })

  test("alongside the problem of a check script untracked", async () => {
    const repo = project()
    const exit = await run(repo, checks({ fast: "scripts/check-fast.sh" }), (repository) =>
      repository.write(repo, {
        ".tutti/settings.json": "{}\n",
        ".tutti/worker-prompt.md": builtInWorkerPrompt,
        "scripts/check-fast.sh": script,
      }),
    )
    expect(failed(exit).warnings).toEqual([warning])
  })

  test("one untracked is named alone; a worker prompt of the run's own isn't the project's", async () => {
    const repo = project()
    writeFileSync(join(repo, "mine.md"), builtInWorkerPrompt)
    const started = passed(
      await run(
        repo,
        checks({}),
        (repository) =>
          repository.write(repo, {
            ".tutti/settings.json": "{}\n",
            ".tutti/worker-prompt.md": builtInWorkerPrompt,
          }),
        { prompt: join(repo, "mine.md") },
      ),
    )
    expect(started.warnings).toEqual([
      ".tutti/settings.json is not committed: a ticket's worktree would not have it, and its worker reads the project's files from its own tree. Commit it (git add .tutti && git commit).",
    ])
  })

  test("committed, they are no warning", async () => {
    const repo = project()
    const started = passed(
      await run(repo, checks({}), (repository) =>
        repository.commit(repo, "tutti init", {
          ".tutti/settings.json": "{}\n",
          ".tutti/worker-prompt.md": builtInWorkerPrompt,
        }),
      ),
    )
    expect(started.warnings).toEqual([])
  })
})

describe("commandPath", () => {
  const repo = "/work/shop"

  test("the path a command's first word names in the repository, from its top", () => {
    expect(commandPath("scripts/check-fast.sh", repo)).toBe("scripts/check-fast.sh")
    expect(commandPath("  ./scripts/check.sh --all", repo)).toBe("scripts/check.sh")
    expect(commandPath("TUTTI_SLOW=1 A=b scripts/check.sh", repo)).toBe("scripts/check.sh")
    expect(commandPath("'scripts/check.sh'", repo)).toBe("scripts/check.sh")
    expect(commandPath("/work/shop/bin/check", repo)).toBe("bin/check")
  })

  test("none for a command found on PATH, expanded by the shell, or outside the repository", () => {
    for (const command of [
      "npm run check",
      "make check",
      "sh scripts/check.sh",
      "TUTTI_SLOW=1",
      "$HOME/bin/check",
      "~/bin/check",
      "scripts/*.sh",
      "../other/check.sh",
      "/usr/bin/true",
      "./",
      "",
    ]) {
      expect(commandPath(command, repo)).toBeNull()
    }
  })

  test("never throws, and names a path inside the repository or none", () => {
    fc.assert(
      fc.property(fc.string(), (command) => {
        const path = commandPath(command, repo)
        if (path === null) return
        expect(path).not.toBe("")
        expect(path.startsWith("/")).toBe(false)
        expect(path === ".." || path.startsWith("../")).toBe(false)
      }),
    )
  })
})
