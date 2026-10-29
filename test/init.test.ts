// tutti init's Workers step and the files it writes (§ 8.3, § 9.1), in a temp repository with a
// scripted form, a scripted machine (git, bd, the Beads install) and the Account test layer; the
// run lock is the live one, on the temp repository's git folder.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Duration, Effect, Exit, Layer, Option, Result } from "effect"
import {
  Account,
  type AccountError,
  type AccountProbe,
  UntrustedCheckout,
} from "../src/agent/Account.ts"
import type { AppConfig } from "../src/cli/AppConfig.ts"
import { readInitFlags } from "../src/cli/commands.ts"
import { readConcurrency } from "../src/init/form.ts"
import {
  type InitFlags,
  type InitForm,
  type InitSummary,
  init,
  summaryLines,
  type TrustOffer,
} from "../src/init/init.ts"
import { readServers } from "../src/init/lineForm.ts"
import { fastScript, fullScript, isRunner, runsRunner, suiteMarker } from "../src/init/runners.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import {
  concurrencyNote,
  normalPrefix,
  prefixProblem,
  renamedId,
  trustKey,
  type WorkersAnswers,
  type WorkersQuestions,
} from "../src/init/workers.ts"
import { readConfigFile } from "../src/project/configFile.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { Settings } from "../src/project/settings.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { FormCancelled } from "../src/ui/questions.ts"

/** A temp repository (its top and git folder) and a home folder for Claude Code's user config. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** A command's answer: its stdout, or why it failed. */
type Answer = string | { readonly fail: string }

/**
 * A scripted machine: bd on the PATH (or not), brew (or not), each command answered by `answer`
 * ("" by default); the commands it ran, as typed.
 */
const scriptedMachine = (
  project: Project,
  options: {
    readonly bd?: boolean
    readonly brew?: boolean
    readonly answer?: (command: string, args: ReadonlyArray<string>) => Answer | undefined
  } = {},
) => {
  const ran: Array<string> = []
  const state = { bd: options.bd ?? true }
  const machine: Machine = {
    run: (command, args) =>
      Effect.suspend(() => {
        ran.push([command, ...args].join(" "))
        if (command === "brew" && args[0] === "install") state.bd = true
        const answer = options.answer?.(command, args) ?? ""
        return typeof answer === "string" ? Effect.succeed(answer) : Effect.fail(answer.fail)
      }),
    which: (command) =>
      command === "bd"
        ? state.bd
          ? "/opt/bin/bd"
          : null
        : command === "brew" && options.brew
          ? "/opt/bin/brew"
          : null,
    env: (name) => (name === "HOME" ? project.home : undefined),
    platform: "darwin",
    executable: () => false,
  }
  return { machine, ran }
}

/** A scripted form: its Workers answers and its answer to the trust offer; what it was asked. */
const scriptedForm = (answers: WorkersAnswers = {}, trust = false) => {
  const asked: Array<WorkersQuestions> = []
  const offers: Array<TrustOffer> = []
  const form: InitForm = {
    workers: (questions) =>
      Effect.sync(() => {
        asked.push(questions)
        return answers
      }),
    checks: () => Effect.succeed({ verifier: false }),
    trust: (offer) =>
      Effect.sync(() => {
        offers.push(offer)
        return trust
      }),
    import: () => Effect.succeed(false),
  }
  return { form, asked, offers }
}

const noFlags: InitFlags = { force: false }

/** Runs init in `project`, with what `over` gives instead of the defaults. */
const runInit = (
  project: Project,
  over: {
    readonly flags?: InitFlags
    readonly form?: InitForm | null
    readonly machine?: Machine
    readonly account?: Layer.Layer<Account, never, AppConfig>
    readonly beads?: ReadonlyArray<TestBeads.Seed>
  } = {},
) =>
  Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags: over.flags ?? noFlags,
        form: over.form ?? null,
        scout: Effect.fail("there is no scout in these tests"),
        machine: over.machine ?? scriptedMachine(project).machine,
        configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
        account: over.account ?? TestAccount.layer(),
        claudeConfig: join(project.home, ".claude.json"),
      }).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer(over.beads ?? [])),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
        ),
        Effect.provide(BunServices.layer),
      ),
    ),
  )

const summaryOf = (exit: Exit.Exit<InitSummary, unknown>): InitSummary => {
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected init to fail")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason?._tag !== "Fail") throw new Error(`no failure in ${String(exit.cause)}`)
  return reason.error
}

const lines = (summary: InitSummary) => summary.steps.map(stepLine)

const read = (project: Project, path: string) => readFileSync(join(project.repo, path), "utf8")

const readSettings = (project: Project) =>
  Effect.runPromise(
    readConfigFile(Settings, join(project.repo, ".tutti", "settings.json")).pipe(
      Effect.provide(BunServices.layer),
    ),
  )

/** Runs a runner with sh in the repository: its exit code and output. */
const runRunner = (project: Project, path: string) => {
  const ran = Bun.spawnSync(["sh", join(project.repo, path)], { cwd: project.repo })
  return { code: ran.exitCode, out: `${ran.stdout.toString()}${ran.stderr.toString()}` }
}

describe("the files init writes", () => {
  test("writes .tutti/ and the runners where they are missing", async () => {
    const project = newProject()
    const summary = summaryOf(await runInit(project))

    const settings = await readSettings(project)
    expect(settings.concurrent).toBe(1)
    expect(settings.checks.fast.command).toBe("scripts/check-fast.sh")
    expect(settings.checks.full.command).toBe("scripts/check-full.sh")
    expect(Duration.toMinutes(settings.checks.fast.timeout)).toBe(30)
    expect(Duration.toMinutes(settings.checks.full.timeout)).toBe(60)
    expect(settings.workers.mcp_servers).toEqual([])
    expect(JSON.parse(read(project, ".tutti/settings.json")).$schema).toBe(
      "https://raw.githubusercontent.com/noesis-sol/tutti/main/schema/settings.json",
    )

    expect(read(project, ".tutti/worker-prompt.md")).toBe(builtInWorkerPrompt)
    const ignored = read(project, ".tutti/.gitignore").split("\n")
    expect(ignored).toContain("tutti.log")
    expect(ignored).toContain("reports/")
    expect(ignored).toContain("run/")

    for (const runner of ["scripts/check-fast.sh", "scripts/check-full.sh"]) {
      expect(statSync(join(project.repo, runner)).mode & 0o777).toBe(0o755)
      expect(read(project, runner)).toEndWith("\nexit 0\n")
      expect(runRunner(project, runner).code).toBe(0)
    }

    expect(lines(summary)).toContain("✓ settings  wrote .tutti/settings.json")
    expect(lines(summary)).toContain(
      "✓ worker prompt  wrote .tutti/worker-prompt.md from the built-in template",
    )
    expect(lines(summary)).toContain(
      `✓ check-fast  wrote scripts/check-fast.sh: it checks nothing yet (tutti checks gives it one)`,
    )
    expect(summary.next).toContain("Read .tutti/worker-prompt.md and adjust it to the project.")
  })

  test("keeps a runner that is there, and the full runner it writes runs it first", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, "scripts"))
    const own = "#!/bin/sh\necho our own check\n"
    writeFileSync(join(project.repo, "scripts/check-fast.sh"), own, { mode: 0o755 })

    const summary = summaryOf(await runInit(project))
    expect(read(project, "scripts/check-fast.sh")).toBe(own)
    expect(lines(summary)).toContain("• check-fast  scripts/check-fast.sh is there; left as it is")
    const full = runRunner(project, "scripts/check-full.sh")
    expect(full.code).toBe(0)
    expect(full.out).toContain(`${suiteMarker} scripts/check-fast.sh`)
    expect(full.out).toContain("our own check")
  })

  test("a missing check-fast.sh calls the project's own scripts/check.sh", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, "scripts"))
    writeFileSync(join(project.repo, "scripts/check.sh"), "#!/bin/sh\necho checked\n", {
      mode: 0o755,
    })
    summaryOf(await runInit(project))
    const fast = runRunner(project, "scripts/check-fast.sh")
    expect(fast.code).toBe(0)
    expect(fast.out).toContain(`${suiteMarker} the project's own check`)
    expect(fast.out).toContain("checked")
  })

  test("--check-fast replaces a runner, and the runner stops at a failing suite", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, "scripts"))
    writeFileSync(join(project.repo, "scripts/check-fast.sh"), "#!/bin/sh\nexit 0\n")
    const summary = summaryOf(
      await runInit(project, {
        flags: {
          ...noFlags,
          checkFast: "echo linted && false",
          checkFastTimeout: Duration.minutes(5),
        },
      }),
    )
    expect(lines(summary)).toContain("✓ check-fast  replaced scripts/check-fast.sh")
    const fast = runRunner(project, "scripts/check-fast.sh")
    expect(fast.code).not.toBe(0)
    expect(fast.out).toContain(`${suiteMarker} echo linted && false`)
    expect(fast.out).toContain("linted")
    expect(Duration.toMinutes((await readSettings(project)).checks.fast.timeout)).toBe(5)
  })

  test("keeps an existing prompt unless --force, and settings it doesn't change", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, ".tutti"))
    writeFileSync(join(project.repo, ".tutti/worker-prompt.md"), "Ours: TICKET_ID\n")
    const settings = {
      concurrent: 3,
      workers: { mcp_servers: [], effort: "high" },
      ui: { colour_scheme: "dusk" },
    }
    writeFileSync(join(project.repo, ".tutti/settings.json"), JSON.stringify(settings))

    const { form } = scriptedForm({ concurrent: 4 })
    const summary = summaryOf(await runInit(project, { form }))
    expect(read(project, ".tutti/worker-prompt.md")).toBe("Ours: TICKET_ID\n")
    const written = JSON.parse(read(project, ".tutti/settings.json"))
    expect(written.concurrent).toBe(4)
    expect(written.workers.effort).toBe("high")
    expect(written.ui).toEqual({ colour_scheme: "dusk" })
    expect(lines(summary).find((line) => line.startsWith("✓ settings"))).toContain(
      "updated .tutti/settings.json: concurrent",
    )

    summaryOf(await runInit(project, { flags: { ...noFlags, force: true } }))
    expect(read(project, ".tutti/worker-prompt.md")).toBe(builtInWorkerPrompt)
  })

  test("refuses settings with problems, and changes nothing", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, ".tutti"))
    writeFileSync(join(project.repo, ".tutti/settings.json"), `{"concurrent": 0, "colour": 1}`)
    const error = failureOf(await runInit(project))
    expect(error._tag).toBe("InitRefused")
    expect(String((error as { message: string }).message)).toContain('unknown key "colour"')
    expect(existsSync(join(project.repo, "scripts"))).toBe(false)
  })

  test("a cancelled form changes nothing", async () => {
    const project = newProject()
    const form: InitForm = {
      workers: () => Effect.fail(new FormCancelled()),
      checks: () => Effect.succeed({}),
      trust: () => Effect.succeed(false),
      import: () => Effect.succeed(false),
    }
    const error = failureOf(await runInit(project, { form }))
    expect(error).toBeInstanceOf(FormCancelled)
    expect(existsSync(join(project.repo, ".tutti"))).toBe(false)
    expect(existsSync(join(project.repo, "scripts"))).toBe(false)
  })
})

describe("the run lock", () => {
  test("is held, naming init, while init changes the project", async () => {
    const project = newProject()
    let seen: unknown
    // The probe runs after the files are written, with the lock still held.
    const account = Layer.succeed(
      Account,
      Account.of({
        probe: Effect.gen(function* () {
          const lock = yield* RunLock
          const taken = yield* Effect.result(
            Effect.scoped(
              lock.acquire({
                repo: project.repo,
                commonDir: project.commonDir,
                holder: { pid: 1, started: "", version: "0", branch: "main" },
              }),
            ),
          )
          seen = Result.isFailure(taken) ? taken.failure : "taken"
          return TestAccount.accountProbe()
        }).pipe(Effect.provide(RunLock.layer)),
      }),
    )
    summaryOf(await runInit(project, { account }))
    expect(seen).toMatchObject({ _tag: "AlreadyRunning", program: "tutti" })
    expect((seen as { holder: { init?: boolean; pid?: number } }).holder).toMatchObject({
      init: true,
      pid: process.pid,
    })
    expect(readFileSync(join(project.commonDir, "tutti.lock"), "utf8")).toBe("")
  })

  test("refuses while a run holds it, before asking, and changes nothing", async () => {
    const project = newProject()
    const { form, asked } = scriptedForm()
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RunLock
          yield* lock.acquire({
            repo: project.repo,
            commonDir: project.commonDir,
            holder: { pid: 4242, started: new Date().toISOString(), version: "0", branch: "main" },
          })
          return yield* Effect.promise(() => runInit(project, { form }))
        }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    const error = failureOf(exit)
    expect((error as { message: string }).message).toContain("tutti is already running in")
    expect((error as { message: string }).message).toContain("set up between runs")
    expect(asked).toEqual([])
    expect(existsSync(join(project.repo, ".tutti"))).toBe(false)
  })
})

describe("the Workers step", () => {
  test("asks the concurrency, the MCP servers defined here and the changelog's union", async () => {
    const project = newProject()
    writeFileSync(join(project.repo, "CHANGELOG.md"), "# Changelog\n")
    writeFileSync(
      join(project.repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { postgres: { command: "pg-mcp" } } }),
    )
    writeFileSync(
      join(project.home, ".claude.json"),
      JSON.stringify({
        mcpServers: { firecrawl: { type: "http", url: "https://x" }, "claude.ai Gmail": {} },
      }),
    )
    const { machine } = scriptedMachine(project, {
      answer: (command, args) =>
        command === "git" && args[0] === "check-attr"
          ? "CHANGELOG.md: merge: unspecified\n"
          : undefined,
    })
    const { form, asked } = scriptedForm({
      concurrent: 3,
      mcp: ["postgres"],
      changelogUnion: true,
    })
    const summary = summaryOf(await runInit(project, { form, machine }))
    expect(asked).toEqual([
      {
        installBeads: null,
        concurrent: { initial: 1, max: 16 },
        mcp: { available: ["postgres", "firecrawl"], chosen: [], notes: {} },
        changelogUnion: true,
      },
    ])
    const settings = await readSettings(project)
    expect(settings.concurrent).toBe(3)
    expect(settings.workers.mcp_servers).toEqual(["postgres"])
    expect(read(project, ".gitattributes")).toBe("CHANGELOG.md merge=union\n")
    expect(lines(summary)).toContain(
      "✓ concurrent  3 tickets at the same time, about 3 GiB of memory, about 1 GiB per worker",
    )
    expect(lines(summary)).toContain("✓ MCP servers  workers get postgres")
    expect(summary.next.find((line) => line.startsWith("Commit"))).toContain(".gitattributes")
  })

  test("flags answer the questions, and the form isn't shown", async () => {
    const project = newProject()
    writeFileSync(join(project.repo, "CHANGELOG.md"), "# Changelog\n")
    writeFileSync(
      join(project.repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { postgres: { command: "pg-mcp" } } }),
    )
    const { form, asked } = scriptedForm()
    summaryOf(
      await runInit(project, {
        form,
        flags: { ...noFlags, concurrent: 2, mcp: [], changelogUnion: false },
      }),
    )
    expect(asked).toEqual([])
    expect((await readSettings(project)).concurrent).toBe(2)
    expect(existsSync(join(project.repo, ".gitattributes"))).toBe(false)
  })

  test("without a terminal it asks nothing and says what --changelog-union would do", async () => {
    const project = newProject()
    writeFileSync(join(project.repo, "CHANGELOG.md"), "# Changelog\n")
    const summary = summaryOf(await runInit(project))
    expect(
      lines(summary).some((line) =>
        line.startsWith("! changelog  not asked (no terminal): with two tickets"),
      ),
    ).toBe(true)
    expect(existsSync(join(project.repo, ".gitattributes"))).toBe(false)
  })

  test("a worker's memory is stated above one ticket at a time", () => {
    expect(concurrencyNote(1)).toBeNull()
    expect(concurrencyNote(4)).toBe("about 4 GiB of memory, about 1 GiB per worker")
  })
})

describe("Beads", () => {
  test("bd missing without a terminal: not installed, and the flag that installs it named", async () => {
    const project = newProject()
    const { machine, ran } = scriptedMachine(project, { bd: false, brew: true })
    const summary = summaryOf(await runInit(project, { machine }))
    expect(lines(summary)).toContain(
      "✗ bd  not installed; not asked (no terminal): --install-beads installs it with Homebrew (brew install beads)",
    )
    expect(ran.some((command) => command.startsWith("brew"))).toBe(false)
    expect(summary.ready).toBe(false)
  })

  test("offered in the form, installed with Homebrew, then bd init sets Beads up", async () => {
    const project = newProject()
    const { machine, ran } = scriptedMachine(project, { bd: false, brew: true })
    const { form, asked } = scriptedForm({ installBeads: true })
    const summary = summaryOf(
      await runInit(project, { form, machine, flags: { ...noFlags, prefix: "orc-" } }),
    )
    expect(asked[0]?.installBeads).toEqual({ method: "Homebrew", command: "brew install beads" })
    expect(ran).toContain("brew install beads")
    expect(ran).toContain(
      "bd init --non-interactive --role maintainer --init-if-missing --prefix orc",
    )
    expect(lines(summary)).toContain("✓ bd  installed with Homebrew (brew install beads)")
    expect(lines(summary)).toContain("✓ ticket prefix  orc, for the new Beads")
  })

  test("bd init doesn't run while something is staged", async () => {
    const project = newProject()
    const { machine, ran } = scriptedMachine(project, {
      answer: (command, args) =>
        command === "git" && args[0] === "diff" && args[1] === "--cached"
          ? "src/a.ts\nsrc/b.ts\n"
          : undefined,
    })
    const summary = summaryOf(await runInit(project, { machine }))
    expect(ran.some((command) => command.startsWith("bd init"))).toBe(false)
    expect(lines(summary).find((line) => line.startsWith("✗ Beads"))).toContain(
      "it would commit what you have staged (src/)",
    )
  })

  test("--prefix renames an existing Beads' tickets", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, ".beads"))
    const { machine, ran } = scriptedMachine(project, {
      answer: (command, args) =>
        command === "bd" && args[0] === "config"
          ? JSON.stringify({ schema_version: 1, data: { key: "issue_prefix", value: "tutti" } })
          : undefined,
    })
    const summary = summaryOf(
      await runInit(project, {
        machine,
        flags: { ...noFlags, prefix: "tt" },
        beads: [{ id: "tutti-1" }, { id: "tutti-2", status: "closed" }],
      }),
    )
    expect(ran).toContain("bd rename-prefix tt-")
    expect(lines(summary)).toContain("✓ ticket prefix  tt (was tutti), 2 tickets renamed")
  })

  test("--prefix is refused while a ticket is left unmerged, and nothing changes", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, ".beads"))
    const { machine, ran } = scriptedMachine(project, {
      answer: (command, args) =>
        command === "bd" && args[0] === "config"
          ? JSON.stringify({ data: { value: "tutti" }, schema_version: 1 })
          : undefined,
    })
    const error = failureOf(
      await runInit(project, {
        machine,
        flags: { ...noFlags, prefix: "tt" },
        beads: [{ id: "tutti-1", status: "closed", labels: ["unmerged"] }],
      }),
    )
    expect((error as { message: string }).message).toBe(
      "--prefix: the tickets can't be renamed from tutti to tt while tutti-1 is labelled unmerged. Nothing was changed.",
    )
    expect(ran.some((command) => command.startsWith("bd rename-prefix"))).toBe(false)
    expect(existsSync(join(project.repo, ".tutti"))).toBe(false)
  })

  test("prefixes are checked as bd checks them", () => {
    expect(normalPrefix(" orc- ")).toBe("orc")
    expect(prefixProblem("orc")).toBeNull()
    expect(prefixProblem("Orc")).toContain("must start with a lowercase letter")
    expect(prefixProblem("orc_x")).toContain("lowercase letters, digits and hyphens")
    expect(prefixProblem("")).toBe("is empty")
    expect(renamedId("orchestra-74b2.31", "orchestra", "orc")).toBe("orc-74b2.31")
  })
})

describe("the login probe", () => {
  test("its account, billing and permission mode are in the summary", async () => {
    const project = newProject()
    const summary = summaryOf(await runInit(project))
    expect(lines(summary)).toContain("✓ account  maintainer@example.com, Example, Claude Max")
    expect(lines(summary)).toContain("✓ billing  subscription")
    expect(lines(summary)).toContain("✓ permission mode  auto")
  })

  test("no login is something missing", async () => {
    const project = newProject()
    const summary = summaryOf(
      await runInit(project, { account: TestAccount.layer(TestAccount.loggedOut) }),
    )
    expect(lines(summary)).toContain(
      "✗ login  Not logged in to Claude: run claude /login, or tutti login",
    )
    expect(summary.ready).toBe(false)
  })

  /** A probe that finds the checkout untrusted until .claude.json trusts it. */
  const trustingProbe = (project: Project) =>
    Layer.succeed(
      Account,
      Account.of({
        probe: Effect.suspend((): Effect.Effect<AccountProbe, AccountError> => {
          const file = join(project.home, ".claude.json")
          const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
          return config.projects?.[project.repo]?.hasTrustDialogAccepted === true
            ? Effect.succeed(TestAccount.accountProbe())
            : Effect.fail(
                new UntrustedCheckout({
                  checkout: project.repo,
                  files: [".claude/settings.json"],
                }),
              )
        }),
      }),
    )

  test("an untrusted main checkout is marked trusted once you say yes, and probed again", async () => {
    const project = newProject()
    const file = join(project.home, ".claude.json")
    writeFileSync(file, JSON.stringify({ theme: "dark", projects: { "/else": { x: 1 } } }), {
      mode: 0o640,
    })
    const { form, offers } = scriptedForm({}, true)
    const summary = summaryOf(await runInit(project, { form, account: trustingProbe(project) }))
    expect(offers).toEqual([
      {
        checkout: project.repo,
        explanation: expect.stringContaining("hasn't been trusted"),
        file,
        key: trustKey(project.repo),
      },
    ])
    const written = JSON.parse(readFileSync(file, "utf8"))
    expect(written.theme).toBe("dark")
    expect(written.projects["/else"]).toEqual({ x: 1 })
    expect(written.projects[project.repo]).toEqual({ hasTrustDialogAccepted: true })
    expect(statSync(file).mode & 0o777).toBe(0o640)
    expect(lines(summary)).toContain(`✓ trust  set ${trustKey(project.repo)} in ${file}`)
    expect(lines(summary)).toContain("✓ billing  subscription")
  })

  test("declined, .claude.json is left alone and the other fix is named", async () => {
    const project = newProject()
    const file = join(project.home, ".claude.json")
    writeFileSync(file, "{}")
    const { form } = scriptedForm({}, false)
    const summary = summaryOf(await runInit(project, { form, account: trustingProbe(project) }))
    expect(readFileSync(file, "utf8")).toBe("{}")
    expect(lines(summary)).toContain(
      `✗ trust  not trusted: run claude once in ${project.repo} and accept the trust dialog`,
    )
  })
})

describe("the runners' format", () => {
  test("is orchestra's: SUITE: lines, subshells, the lock for a serial suite", () => {
    const script = fastScript([
      { name: "unit tests", command: "bun test", foundIn: "package.json:7", serial: false },
      { name: "e2e", command: "npm run e2e", foundIn: "package.json:9", serial: true },
    ])
    expect(script).toStartWith("#!/bin/sh\n# scripts/check-fast.sh: tutti's merge check")
    expect(script).toContain('set -e\ncd "$(dirname "$0")/.."\n')
    expect(script).toContain("\nlock() {")
    expect(script).toContain("\ntrap unlock EXIT\n")
    expect(script).toContain(
      "# unit tests, from package.json:7\nprintf '%s\\n' 'SUITE: unit tests'\n(\nbun test\n)\n",
    )
    expect(script).toContain(
      "# e2e, from package.json:9, one worktree at a time\nprintf '%s\\n' 'SUITE: e2e'\nlock e2e\n(\nnpm run e2e\n)\nunlock\n",
    )
  })

  test("a suite that runs a runner is left out", () => {
    expect(runsRunner("bash scripts/check-fast.sh")).toBe(true)
    expect(runsRunner("make lint && ./scripts/check-full.sh")).toBe(true)
    expect(runsRunner("npm test")).toBe(false)
    expect(isRunner("sh scripts/check-fast.sh", "scripts/check-fast.sh")).toBe(true)
    expect(
      fastScript([{ name: "", command: "scripts/check-full.sh", foundIn: "", serial: false }]),
    ).toEndWith("\nexit 0\n")
    expect(fullScript([], true)).toEndWith("\nexit 0\n")
    expect(fullScript([], false)).toContain("SUITE: scripts/check-fast.sh")
  })
})

// The pinned shellcheck (scripts/fetch-shellcheck.sh), or null where it can't be had (offline).
const shellcheck = (() => {
  const fetched = Bun.spawnSync(["scripts/fetch-shellcheck.sh"], { stderr: "ignore" })
  return fetched.exitCode === 0 ? fetched.stdout.toString().trim() : null
})()

describe("the runners init writes", () => {
  // SC2251 is left out, as orchestra leaves it out: the `! kill -0` that ends the lock's `stale` is
  // its status, which its callers test in an if; rewording it would make every runner with a lock
  // that orchestra wrote differ from what init writes now.
  test.skipIf(shellcheck === null)("pass the pinned shellcheck", () => {
    const suites = [
      { name: "unit tests", command: "bun test", foundIn: "package.json:7", serial: false },
      {
        name: "it's lint",
        command: "cd web && npm run lint",
        foundIn: "web/package.json",
        serial: false,
      },
    ]
    const serial = [
      { name: "e2e on port 3000", command: "npm run e2e", foundIn: "", serial: true },
      ...suites,
    ]
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-runners-")))
    const scripts = {
      "empty.sh": fastScript([]),
      "fast.sh": fastScript(suites),
      "serial.sh": fastScript(serial),
      "full.sh": fullScript(serial, false),
      "full-only.sh": fullScript(suites, true),
    }
    const paths = Object.entries(scripts).map(([name, script]) => {
      writeFileSync(join(dir, name), script)
      return join(dir, name)
    })
    const checked = Bun.spawnSync([
      shellcheck ?? "shellcheck",
      "-s",
      "sh",
      "-e",
      "SC2251",
      "--",
      ...paths,
    ])
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  })
})

describe("init's flags and the line form's answers", () => {
  const texts = {
    checkFast: Option.none<string>(),
    checkFull: Option.none<string>(),
    checkFastTimeout: Option.none<string>(),
    checkFullTimeout: Option.none<string>(),
    setup: Option.none<string>(),
    concurrent: Option.none<string>(),
    mcp: Option.none<string>(),
    changelogUnion: Option.none<string>(),
    installBeads: Option.none<string>(),
    prefix: Option.none<string>(),
    verifier: Option.none<string>(),
    noMouse: Option.none<string>(),
    noChecks: Option.none<string>(),
    force: false,
  }

  test("are read, each absent unless given", () => {
    const read = readInitFlags({
      ...texts,
      concurrent: Option.some("4"),
      mcp: Option.some("postgres, firecrawl,"),
      changelogUnion: Option.some("false"),
      checkFast: Option.some(""),
    })
    expect(Result.isSuccess(read) ? read.success : read.failure).toEqual({
      concurrent: 4,
      mcp: ["postgres", "firecrawl"],
      changelogUnion: false,
      checkFast: "",
      force: false,
    })
  })

  test("every problem is reported at once", () => {
    const read = readInitFlags({
      ...texts,
      concurrent: Option.some("17"),
      installBeads: Option.some("maybe"),
      checkFullTimeout: Option.some("0"),
    })
    expect(Result.isFailure(read) ? read.failure : []).toEqual([
      "--concurrent must be a whole number from 1 to 16 (got '17')",
      "--install-beads must be 1 or 0, true or false, yes or no, or on or off (got 'maybe')",
      "--check-full-timeout must be a time longer than 0, such as 30m (got '0')",
    ])
  })

  test("the line form keeps the answer on Enter, and refuses names not defined here", () => {
    expect(readConcurrency("", 2, 16)).toEqual({ ok: 2 })
    expect(readConcurrency("17", 2, 16)).toEqual({ error: "Enter a whole number from 1 to 16." })
    expect(readServers("", ["a"], ["a", "b"])).toEqual({ ok: ["a"] })
    expect(readServers("-", ["a"], ["a", "b"])).toEqual({ ok: [] })
    expect(readServers("b, c", [], ["a", "b"])).toEqual({
      error: "Not defined here: c. Choose from a, b.",
    })
  })

  test("the summary ends with the next steps and the sign-off", async () => {
    const project = newProject()
    const summary = summaryOf(await runInit(project))
    const printed = summaryLines(summary)
    expect(printed).toContain("Next:")
    expect(printed.at(-1)).toBe(
      summary.ready ? "♪ tutti is ready." : "♪ Almost ready: fix what's missing above.",
    )
  })
})
