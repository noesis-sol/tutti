// The startup checks of a run scoped to one ticket (--ticket), and of a --feature run whose limit
// would start none of its plan: setup problems, listed with the others, as orchestra's scopeProblem
// and checkFlagCombos make them.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Result } from "effect"
import fc from "fast-check"
import { defaultSettings, defaultUserConfig, resolve } from "../src/cli/AppConfig.ts"
import { noFlags } from "../src/cli/flags.ts"
import { check, exitSetup, type Started, type StartupFailed } from "../src/run/startup.ts"
import { Beads, BeadsFailed } from "../src/services/Beads.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"

/** A folder for a project `tutti init` has set up, with a Beads database. */
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-startup-scope-")))
  const repo = join(dir, "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  mkdirSync(join(repo, ".beads"))
  return repo
}

/** The startup checks of a run scoped to `ticket`, over `beads`, after `before`. */
const run = (
  ticket: string | null,
  beads: Layer.Layer<Beads>,
  before: (repo: string) => Effect.Effect<void, unknown, TestGit.Repository> = () => Effect.void,
) => {
  const repo = project()
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* before(repo)
      return yield* Effect.exit(
        check({
          cwd: repo,
          env: {},
          config: (top) => Effect.succeed(TestAppConfig.appConfig({ ticket }, top)),
          beads: () => beads,
          claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
          account: TestAccount.layer(),
        }),
      )
    }).pipe(
      Effect.provide(TestGit.layer({ dir: repo })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..", "home") } })),
      ),
      Effect.provide(BunServices.layer),
    ),
  )
}

/** The problems of checks that must have failed. */
const problemsOf = (exit: Exit.Exit<Started, StartupFailed>): ReadonlyArray<string> => {
  if (Exit.isSuccess(exit)) throw new Error("the checks passed")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
  return reason.error.problems
}

/** bd whose ready works, but whose show of any ticket fails as `failure` says. */
const showFailing = (failure: BeadsFailed) =>
  Layer.succeed(
    Beads,
    Beads.of(
      new Proxy({} as Beads["Service"], {
        get: (_, key) => () => (key === "ready" ? Effect.succeed([]) : Effect.fail(failure)),
      }),
    ),
  )

describe("--ticket at startup", () => {
  test("an open ticket that is work passes", async () => {
    const exit = await run("tut-1", TestBeads.layer([{ id: "tut-1" }]))
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(exit.value.config.ticket).toBe("tut-1")
  })

  test("in progress, blocked or deferred, it is still work", async () => {
    for (const status of ["in_progress", "blocked", "deferred"] as const) {
      const exit = await run("tut-1", TestBeads.layer([{ id: "tut-1", status }]))
      expect(Exit.isSuccess(exit)).toBe(true)
    }
  })

  test("a ticket bd has no issue for is a setup problem", async () => {
    expect(problemsOf(await run("tut-9", TestBeads.layer([{ id: "tut-1" }])))).toEqual([
      "Cannot read ticket tut-9 (--ticket): bd has no ticket by that ID",
    ])
  })

  test("a ticket bd can't show says bd's error", async () => {
    const beads = showFailing(
      new BeadsFailed({
        command: "bd show tut-1 --json",
        exitCode: 1,
        stderr: "Error: database is locked\nmore detail\n",
        noSuchIssue: false,
      }),
    )
    expect(problemsOf(await run("tut-1", beads))).toEqual([
      "Cannot read ticket tut-1 (--ticket): Error: database is locked",
    ])
    const silent = showFailing(
      new BeadsFailed({ command: "bd show", exitCode: 3, stderr: "", noSuchIssue: false }),
    )
    expect(problemsOf(await run("tut-1", silent))).toEqual([
      "Cannot read ticket tut-1 (--ticket): exit code 3",
    ])
  })

  test("a closed ticket is a setup problem, with the command that reopens it", async () => {
    const beads = TestBeads.layer([{ id: "tut-1", status: "closed" }])
    expect(problemsOf(await run("tut-1", beads))).toEqual([
      "Ticket tut-1 (--ticket) is closed: nothing to run. Reopen it with: bd update tut-1 --status open",
    ])
  })

  test("a question is a setup problem, with the command that answers it", async () => {
    const beads = TestBeads.layer([{ id: "tut-1", labels: ["human"] }])
    expect(problemsOf(await run("tut-1", beads))).toEqual([
      "Ticket tut-1 (--ticket) is a question for you (label human), not work. Answer it with: bd human respond tut-1",
    ])
  })

  test("is listed with the other problems, after bd's", async () => {
    const beads = TestBeads.layer([{ id: "tut-1", status: "closed" }])
    const exit = await run("tut-1", beads, (repo) =>
      Effect.flatMap(TestGit.Repository, (repository) =>
        repository.write(repo, { "notes.txt": "new\n" }),
      ),
    )
    expect(problemsOf(exit)).toEqual([
      "The main checkout has uncommitted changes (notes.txt). Commit or stash them first: finished tickets merge into it. Inspect with: git status",
      "Ticket tut-1 (--ticket) is closed: nothing to run. Reopen it with: bd update tut-1 --status open",
    ])
    expect(exitSetup).toBe(2)
  })

  test("no --ticket shows no ticket", async () => {
    const beads = showFailing(
      new BeadsFailed({ command: "bd show", exitCode: 1, stderr: "no", noSuchIssue: false }),
    )
    expect(Exit.isSuccess(await run(null, beads))).toBe(true)
  })

  test("bd's error, whatever it says, makes a one-line problem", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (id, stderr) => {
        const beads = showFailing(
          new BeadsFailed({ command: "bd show", exitCode: 1, stderr, noSuchIssue: false }),
        )
        const [problem] = problemsOf(await run(id === "" ? "x" : id, beads))
        expect(problem).toBeDefined()
        expect(problem).toBe(sanitizeLine(problem ?? ""))
      }),
      { numRuns: 25 },
    )
  })
})

describe("--feature with a limit that starts nothing", () => {
  const problemsOfFlags = (flags: Partial<Record<keyof typeof noFlags, string>>) => {
    const resolved = resolve({
      repo: "/work/project",
      flags: {
        ...noFlags,
        ...Object.fromEntries(Object.entries(flags).map(([key, text]) => [key, Option.some(text)])),
      },
      env: () => undefined,
      user: defaultUserConfig,
      settings: defaultSettings,
    })
    return Result.isFailure(resolved) ? resolved.failure : []
  }

  test("--limit 0 is a setup problem: the plan would be filed and none of it started", () => {
    expect(problemsOfFlags({ feature: "dark mode", limit: "0" })).toEqual([
      "--feature would file a plan and run none of it: --limit (or TUTTI_LIMIT) is 0. Raise --limit.",
    ])
  })

  test("a limit above 0, or --limit 0 without --feature, is no problem", () => {
    expect(problemsOfFlags({ feature: "dark mode", limit: "1" })).toEqual([])
    expect(problemsOfFlags({ feature: "dark mode" })).toEqual([])
    expect(problemsOfFlags({ limit: "0" })).toEqual([])
  })
})
