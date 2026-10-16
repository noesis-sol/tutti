import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Duration, Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import {
  Account,
  type AccountError,
  NotLoggedIn,
  SettingsUnreadable,
} from "../src/agent/Account.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { type AppConfigValue, SetupProblem } from "../src/cli/AppConfig.ts"
import {
  check,
  exitSetup,
  notSetUpMessage,
  orchestraWarning,
  orchestraWorkers,
  report,
  type Started,
  StartupFailed,
  startBlock,
} from "../src/run/startup.ts"
import { Beads, BeadsFailed } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import { Repository } from "../src/testing/Git.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"

/** A folder for a project, `tutti init` already run in it unless `setUp` is false. */
const project = (options: { readonly setUp?: boolean; readonly beads?: boolean } = {}) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-startup-")))
  const repo = join(dir, "repo")
  mkdirSync(repo)
  if (options.setUp ?? true) {
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  }
  if (options.beads ?? true) mkdirSync(join(repo, ".beads"))
  return { dir, repo }
}

const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** bd that isn't installed: every call fails as exec reports a command it couldn't start. */
const noBd = Layer.succeed(
  Beads,
  Beads.of(
    new Proxy({} as Beads["Service"], {
      get: () => () =>
        Effect.fail(
          new BeadsFailed({
            command: "bd ready --json",
            exitCode: 127,
            stderr: "bd: command not found",
            noSuchIssue: false,
          }),
        ),
    }),
  ),
)

/** bd that is installed but finds no database. */
const noDatabase = Layer.succeed(
  Beads,
  Beads.of(
    new Proxy({} as Beads["Service"], {
      get: () => () =>
        Effect.fail(
          new BeadsFailed({
            command: "bd ready --json",
            exitCode: 1,
            stderr: "Error: no beads database found\n",
            noSuchIssue: false,
          }),
        ),
    }),
  ),
)

/** A probe that fails with every one of `errors`, as the live probe can. */
const probeFailing = (...errors: ReadonlyArray<AccountError>) =>
  Layer.succeed(
    Account,
    Account.of({ probe: Effect.failCause(Cause.fromReasons(errors.map(Cause.makeFailReason))) }),
  )

interface Scenario {
  readonly cwd?: string
  /** The configuration, or the problems loading it finds. */
  readonly config?: Partial<AppConfigValue> | ReadonlyArray<string>
  readonly beads?: Layer.Layer<Beads>
  readonly account?: Layer.Layer<Account>
  /** What to do to the repository before the checks. */
  readonly before?: Effect.Effect<void, unknown, Git | Repository>
  readonly env?: Record<string, string>
}

/** The startup checks in `repo`, over an in-memory git whose main checkout is there. */
const run = (repo: string, scenario: Scenario = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (scenario.before !== undefined) yield* scenario.before
      return yield* Effect.exit(
        check({
          cwd: scenario.cwd ?? repo,
          config: (top) =>
            Array.isArray(scenario.config)
              ? Effect.fail(new SetupProblem({ problems: scenario.config }))
              : Effect.succeed(
                  TestAppConfig.appConfig((scenario.config ?? {}) as Partial<AppConfigValue>, top),
                ),
          beads: () => scenario.beads ?? TestBeads.layer(),
          account: scenario.account ?? TestAccount.layer(),
        }),
      )
    }).pipe(
      Effect.provide(TestGit.layer({ dir: repo })),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: scenario.env ?? { HOME: join(repo, "..", "home") } }),
        ),
      ),
      Effect.provide(BunServices.layer),
    ),
  )

/** The checks' result, which must be a pass. */
const passed = (exit: Exit.Exit<Started, StartupFailed>): Started => {
  if (Exit.isFailure(exit)) throw new Error(`the checks failed: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

/** The checks' failure, which must be StartupFailed. */
const failed = (exit: Exit.Exit<Started, StartupFailed>): StartupFailed => {
  if (Exit.isSuccess(exit)) throw new Error("the checks passed")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
  return reason.error
}

describe("the startup checks", () => {
  test("pass in a repository set up, clean, on a branch, logged in", async () => {
    const { repo } = project()
    const started = passed(await run(repo))
    expect(started.base).toBe("main")
    expect(started.config.repo).toBe(repo)
    expect(started.prompt.file).toBeNull()
    expect(started.mcp.servers).toEqual([])
    expect(started.account.billing).toEqual({ _tag: "Subscription", keyUnused: false })
    expect(started.warnings).toEqual([])
  })

  test("the exit code of a run that can't start is 2", () => {
    expect(exitSetup).toBe(2)
  })

  describe("each problem alone", () => {
    test("not inside a git repository", async () => {
      const { dir, repo } = project()
      const failure = failed(await run(repo, { cwd: join(dir, "elsewhere") }))
      expect(failure.problems).toEqual(["Not inside a git repository: cd into the project first."])
      expect(failure.notSetUp).toBe(false)
    })

    test("started in a linked worktree, not the main checkout", async () => {
      const { dir, repo } = project()
      const linked = join(dir, "repo-tutti", "tut-1")
      const failure = failed(
        await run(repo, {
          cwd: join(linked, "src"),
          before: Effect.flatMap(Git, (git) =>
            git.addWorktree(repo, linked, { branch: "tutti/tut-1", base: "main" }),
          ),
        }),
      )
      expect(failure.problems).toEqual([
        `${linked} is a linked worktree. Run this from the main checkout.`,
      ])
    })

    test("a subfolder of the main checkout is the main checkout", async () => {
      const { repo } = project()
      const started = passed(await run(repo, { cwd: join(repo, "src", "deep") }))
      expect(started.config.repo).toBe(repo)
    })

    test("the main checkout on a detached HEAD", async () => {
      const { repo } = project()
      const failure = failed(
        await run(repo, {
          before: Effect.gen(function* () {
            const repository = yield* Repository
            yield* repository.checkout(repo, yield* repository.head("main"))
          }),
        }),
      )
      expect(failure.problems).toEqual([
        "The main checkout is on a detached HEAD. Check out the branch finished tickets should land on.",
      ])
    })

    test("uncommitted changes in the main checkout", async () => {
      const { repo } = project()
      const failure = failed(
        await run(repo, {
          before: Effect.flatMap(Repository, (repository) =>
            repository.write(repo, { "README.md": "changed\n", "notes.txt": "new\n" }),
          ),
        }),
      )
      expect(failure.problems).toEqual([
        "The main checkout has uncommitted changes (README.md, notes.txt). Commit or stash them first: finished tickets merge into it. Inspect with: git status",
      ])
    })

    test("names five changed files and counts the rest", async () => {
      const { repo } = project()
      const files = Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`file-${i}.txt`, "new\n"]),
      )
      const failure = failed(
        await run(repo, {
          before: Effect.flatMap(Repository, (repository) => repository.write(repo, files)),
        }),
      )
      expect(failure.problems[0]).toContain(
        "(file-0.txt, file-1.txt, file-2.txt, file-3.txt, file-4.txt and 3 more)",
      )
    })

    test("changes in the run state and bd's folder leave the tree clean", async () => {
      const { repo } = project()
      passed(
        await run(repo, {
          before: Effect.flatMap(Repository, (repository) =>
            repository.write(repo, {
              ".tutti/run/events.jsonl": "{}\n",
              ".orchestra/run/state.json": "{}\n",
              ".beads/issues.jsonl": "{}\n",
            }),
          ),
        }),
      )
    })

    test("changes to the project's committed tool files are uncommitted changes", async () => {
      const { repo } = project()
      const failure = failed(
        await run(repo, {
          before: Effect.flatMap(Repository, (repository) =>
            repository.write(repo, {
              ".tutti/worker-prompt.md": "Work on TICKET_ID.\n",
              ".orchestra/specs/spec.md": "# spec\n",
              ".claude/agents/verifier.md": "verify\n",
            }),
          ),
        }),
      )
      expect(failure.problems).toEqual([
        "The main checkout has uncommitted changes (.claude/agents/verifier.md, .orchestra/specs/spec.md, .tutti/worker-prompt.md). Commit or stash them first: finished tickets merge into it. Inspect with: git status",
      ])
    })

    test("bd isn't installed", async () => {
      const { repo } = project()
      const failure = failed(await run(repo, { beads: noBd }))
      expect(failure.problems).toEqual([
        "Required command not found: bd (Beads). Install it, or let tutti init offer to.",
      ])
    })

    test("no Beads database", async () => {
      const { repo } = project({ beads: false })
      const failure = failed(await run(repo, { beads: noDatabase }))
      expect(failure.problems).toEqual([`No Beads database in ${repo}. Run: bd init`])
    })

    test("a Beads database bd can't read", async () => {
      const { repo } = project()
      const failure = failed(await run(repo, { beads: noDatabase }))
      expect(failure.problems).toEqual([
        `Cannot read the Beads database in ${repo}: Error: no beads database found`,
      ])
    })

    test("not logged in to Claude", async () => {
      const { repo } = project()
      const failure = failed(await run(repo, { account: TestAccount.layer(new NotLoggedIn()) }))
      expect(failure.problems).toEqual([
        "Not logged in to Claude: run claude /login, or tutti login",
      ])
    })

    test("a Claude Code settings file that doesn't parse", async () => {
      const { repo } = project()
      const unreadable = new SettingsUnreadable({
        errors: [{ file: "/home/me/.claude/settings.json", path: "", message: "Invalid JSON" }],
      })
      const failure = failed(await run(repo, { account: TestAccount.layer(unreadable) }))
      expect(failure.problems).toEqual([unreadable.message])
    })

    test("the settings, flags, variables or user config", async () => {
      const { repo } = project()
      const problems = [
        ".tutti/settings.json: concurrent: Expected a value between 1 and 16, got 40",
        "--limit expects a whole number, got 'many'.",
      ]
      const failure = failed(await run(repo, { config: problems }))
      expect(failure.problems).toEqual(problems)
    })

    test("an MCP name not defined on this machine", async () => {
      const { repo } = project()
      const config = TestAppConfig.appConfig({}, repo)
      const failure = failed(
        await run(repo, {
          config: {
            settings: {
              ...config.settings,
              workers: { ...config.settings.workers, mcp_servers: ["postgres"] },
            },
          },
        }),
      )
      expect(failure.problems).toHaveLength(1)
      expect(failure.problems[0]).toStartWith(
        'MCP server "postgres" in workers.mcp_servers isn\'t defined here',
      )
    })

    test("a worker prompt without TICKET_ID", async () => {
      const { repo } = project()
      write(join(repo, ".tutti", "worker-prompt.md"), "Work on the ticket.\n")
      const failure = failed(await run(repo))
      expect(failure.problems).toEqual([
        "Worker prompt has no TICKET_ID placeholder: .tutti/worker-prompt.md.",
      ])
    })

    test("a --prompt file that isn't there", async () => {
      const { dir, repo } = project()
      const prompt = join(dir, "missing.md")
      const failure = failed(await run(repo, { config: { prompt } }))
      expect(failure.problems).toEqual([
        `Worker prompt not found: ${prompt} (from --prompt or TUTTI_PROMPT).`,
      ])
    })
  })

  test("several problems together, in one report, in § 5's order", async () => {
    const { repo } = project()
    write(join(repo, ".tutti", "worker-prompt.md"), "Work on the ticket.\n")
    const failure = failed(
      await run(repo, {
        config: [".tutti/settings.json: workers.permission_mode: Expected auto, got plan"],
        beads: noBd,
        account: probeFailing(
          new NotLoggedIn(),
          new SettingsUnreadable({
            errors: [{ file: "/home/me/.claude/settings.json", path: "", message: "Invalid JSON" }],
          }),
        ),
        before: Effect.flatMap(Repository, (repository) =>
          repository.write(repo, { "notes.txt": "new\n" }),
        ),
      }),
    )
    expect(failure.notSetUp).toBe(false)
    expect(failure.problems).toEqual([
      "The main checkout has uncommitted changes (notes.txt). Commit or stash them first: finished tickets merge into it. Inspect with: git status",
      "Required command not found: bd (Beads). Install it, or let tutti init offer to.",
      "Not logged in to Claude: run claude /login, or tutti login",
      "Claude Code skips a settings file it can't read, and the permission rules in it: /home/me/.claude/settings.json: Invalid JSON",
      ".tutti/settings.json: workers.permission_mode: Expected auto, got plan",
      "Worker prompt has no TICKET_ID placeholder: .tutti/worker-prompt.md.",
    ])
    expect(report(failure)).toBe(
      ["tutti cannot start:", ...failure.problems.map((problem) => `  - ${problem}`)].join("\n"),
    )
  })

  describe("a repository tutti init hasn't set up", () => {
    test("says so first, then the other problems", async () => {
      const { repo } = project({ setUp: false, beads: false })
      const failure = failed(
        await run(repo, {
          beads: noDatabase,
          account: TestAccount.layer(new NotLoggedIn()),
        }),
      )
      expect(failure.notSetUp).toBe(true)
      // init writes the worker prompt and sets up Beads: neither is a problem of its own.
      expect(failure.problems).toEqual([
        "Not logged in to Claude: run claude /login, or tutti login",
      ])
      expect(report(failure)).toBe(
        `${notSetUpMessage}\n\nAlso fix before a run:\n  - Not logged in to Claude: run claude /login, or tutti login`,
      )
      expect(report(failure).startsWith("tutti isn't set up in this repository yet.")).toBe(true)
    })

    test("alone, it is the whole report", async () => {
      const { repo } = project({ setUp: false })
      const failure = failed(await run(repo))
      expect(failure.notSetUp).toBe(true)
      expect(failure.problems).toEqual([])
      expect(failure.message).toBe(notSetUpMessage)
    })

    test("a worker prompt of its own sets it up enough", async () => {
      const { repo } = project({ setUp: false })
      write(join(repo, ".tutti", "worker-prompt.md"), "Work on TICKET_ID.\n")
      passed(await run(repo))
    })
  })

  describe("workers orchestra left behind", () => {
    const state = (repo: string, text: string) =>
      write(join(repo, ".orchestra", "run", "state.json"), text)

    test("are a warning, not a problem", async () => {
      const { repo } = project()
      state(
        repo,
        JSON.stringify({
          saved: "2026-10-16T08:31:00Z",
          workers: [
            { ticket: "tut-1", agent: "w1", tab: "tut-1", worktree: "/w/tut-1" },
            { ticket: "tut-2", agent: "w2", tab: "tut-2", worktree: "/w/tut-2", left: "PAUSED" },
          ],
        }),
      )
      const started = passed(await run(repo))
      expect(started.warnings).toEqual([
        "orchestra left workers on tut-1, tut-2; finish them with orchestra first",
      ])
    })

    test("are warned about beside the problems", async () => {
      const { repo } = project()
      state(repo, JSON.stringify({ workers: [{ ticket: "tut-3" }] }))
      const failure = failed(await run(repo, { account: TestAccount.layer(new NotLoggedIn()) }))
      expect(failure.warnings).toEqual([orchestraWarning(["tut-3"])])
      expect(report(failure)).toEndWith(
        "\n\nWarning: orchestra left workers on tut-3; finish them with orchestra first",
      )
    })

    test("none named, or a state tutti can't read, is no warning", async () => {
      for (const text of ['{"workers":[]}', "not json", '{"workers":"tut-1"}', "[]", "null"]) {
        const { repo } = project()
        state(repo, text)
        expect(passed(await run(repo)).warnings).toEqual([])
      }
    })

    test("any state file gives one-line ticket IDs, each once", async () => {
      const { repo } = project()
      const read = (text: string) =>
        Effect.runPromise(orchestraWorkers(repo).pipe(Effect.provide(BunServices.layer))).then(
          (tickets) => ({ text, tickets }),
        )
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.string(),
            fc.json(),
            fc
              .array(fc.record({ ticket: fc.oneof(fc.string(), fc.integer()) }))
              .map((workers) => JSON.stringify({ workers })),
          ),
          async (text) => {
            state(repo, text)
            const { tickets } = await read(text)
            expect(new Set(tickets).size).toBe(tickets.length)
            for (const ticket of tickets) {
              expect(ticket).not.toBe("")
              expect(ticket).toBe(sanitizeLine(ticket))
              expect([..."\n\r\t\u001b"].some((c) => ticket.includes(c))).toBe(false)
            }
          },
        ),
        { numRuns: 50 },
      )
    })
  })
})

describe("the START block", () => {
  /** The block's lines as text. */
  const block = (s: Started, version: string): ReadonlyArray<string> => startBlock(s, version)

  const started = (overrides: Partial<Started> = {}): Started => ({
    config: TestAppConfig.appConfig({}, "/work/project"),
    base: "main",
    prompt: { text: "Work on TICKET_ID.", file: null },
    mcp: { servers: [], note: noServersNote },
    account: TestAccount.accountProbe(),
    warnings: [],
    ...overrides,
  })

  test("names the version, repository, branch and settings, then billing and permission mode", () => {
    expect(block(started(), "0.1.0")).toEqual([
      "START tutti 0.1.0 in /work/project on main (limit: 40, concurrent: 1, ticket limit: none, check timeout: 30m, worktrees: /work/project-tutti)",
      "  billing: subscription",
      "  permission mode: auto",
      `  ${noServersNote}`,
      "  memory: about 1 GiB of memory, about 1 GiB per worker",
    ])
  })

  test("carries the scope, the MCP servers, the billing and mode in effect, memory and warnings", () => {
    const config = TestAppConfig.appConfig({ ticket: "tut-7" }, "/work/project")
    const lines = block(
      started({
        config: {
          ...config,
          settings: {
            ...config.settings,
            concurrent: 4,
            workers: { ...config.settings.workers, ticket_limit: Duration.hours(2) },
          },
        },
        mcp: {
          servers: [
            { name: "postgres", scope: "project", definition: { command: "pg-mcp" } },
            { name: "github", scope: "user", definition: { type: "http", url: "https://x" } },
          ],
          note: null,
        },
        account: TestAccount.accountProbe({
          billing: { _tag: "Subscription", keyUnused: true },
          permissionMode: { requested: "auto", inEffect: "default" },
        }),
        warnings: [orchestraWarning(["tut-1"])],
      }),
      "0.1.0",
    )
    expect(lines).toEqual([
      "START tutti 0.1.0 in /work/project on main · ticket tut-7 (limit: 40, concurrent: 4, ticket limit: 2h, check timeout: 30m, worktrees: /work/project-tutti, MCP servers: postgres, github)",
      "  billing: subscription (ANTHROPIC_API_KEY is set but not used; --billing api uses it)",
      "  permission mode: default (auto mode isn't available here)",
      "  memory: about 4 GiB of memory, about 1 GiB per worker",
      "  orchestra left workers on tut-1; finish them with orchestra first",
    ])
  })

  test("says when workers are billed to the API key", () => {
    const lines = block(
      started({ account: TestAccount.accountProbe({ billing: { _tag: "ApiKey" } }) }),
      "0.1.0",
    )
    expect(lines).toContain("  billing: API key")
  })
})

test("StartupFailed's message is its report", () => {
  const failure = new StartupFailed({ notSetUp: false, problems: ["One.", "Two."], warnings: [] })
  expect(failure.message).toBe("tutti cannot start:\n  - One.\n  - Two.")
})
