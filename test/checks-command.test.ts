// tutti checks (§ 8.1, § 8.3): init's Checks step on its own, in a project init set up with runners
// that check nothing yet. Its form's flow in lines, with the scout's canned answer; the flags,
// which answer without asking; its refusals (before init, during a run, without a terminal or a
// flag, in a linked worktree); its writes put in as one, which a cancel or a failed write leaves as
// they were; and init's Next lines, which point to it.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Duration, Effect, Exit, FileSystem, Layer, type Scope } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"
import {
  mapUntestedTitle,
  passRunnersTitle,
  scoutSearch,
  testsEpicTitle,
  testWorkLabel,
} from "../src/init/checks.ts"
import { type InitForm, InitRefused, type InitSummary, init } from "../src/init/init.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { runnerCommands, runsNothing } from "../src/init/runners.ts"
import { type ChecksOptions, checksUnasked, setChecks } from "../src/init/setChecks.ts"
import { InitFailed, type Machine, stepLine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import type { Scouting } from "../src/organs/scout.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { FormCancelled } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

/** A temp repository (its top and git folder) and a home folder. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-checks-command-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { root, repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** bd on the PATH, every command answered with nothing. */
const machine = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

const services = (project: Project) =>
  Layer.mergeAll(
    RunLock.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
  )

/**
 * Sets `project` up as init does for a project with no checks yet: runners that check nothing, and
 * a lockfile, for which the setup command is offered. init's summary.
 */
const setUp = async (project: Project): Promise<InitSummary> => {
  writeFileSync(join(project.repo, "package-lock.json"), "{}\n")
  const exit = await Effect.runPromiseExit(
    init({
      repo: project.repo,
      commonDir: project.commonDir,
      branch: "main",
      version: "0.1.0",
      flags: {
        force: false,
        checkFast: "",
        checkFull: "",
        verifier: false,
        changelogUnion: false,
        installBeads: false,
        mcp: [],
        setup: "",
      },
      form: null,
      scout: Effect.fail("there is no scout in init here"),
      machine: machine(project),
      configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
      account: TestAccount.layer(),
      claudeConfig: join(project.home, ".claude.json"),
    }).pipe(
      Effect.provide(services(project)),
      Effect.provide(TestBeads.layer([])),
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

/** The suites the canned scout finds. */
const twoSuites: Scouting = {
  suites: [
    {
      name: "unit tests",
      kind: "unit",
      command: "npm test",
      targeted: "",
      found_in: "package.json:7",
      tier: "fast",
      covers_fast: false,
      ci_build: false,
      cost: "",
      parallel_safe: true,
      needs: [],
    },
    {
      name: "e2e",
      kind: "e2e",
      command: "npx playwright test",
      targeted: "",
      found_in: "playwright.config.ts:1",
      tier: "full",
      covers_fast: false,
      ci_build: false,
      cost: "",
      parallel_safe: false,
      needs: ["a browser"],
    },
  ],
  stack: ["TypeScript 5.9"],
  note: "",
}

/**
 * Runs tutti checks in `project` with the form `makeForm` makes (none by default), the scout
 * answering `scout` (none: it fails), over `files` where given: its exit, the backlog afterwards
 * and the organ calls made.
 */
const runChecks = async (
  project: Project,
  over: Partial<Pick<ChecksOptions<never>, "flags" | "form">> & {
    readonly makeForm?: Effect.Effect<InitForm, never, Scope.Scope>
    readonly scout?: Scouting
    readonly files?: Layer.Layer<FileSystem.FileSystem>
  } = {},
) => {
  const calls: Array<OrganCallRecord> = []
  const organs = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer(over.scout === undefined ? {} : { scout: { ...over.scout } }, calls),
        TestAppConfig.layer(TestAppConfig.appConfig({})),
      ).pipe(Layer.provideMerge(logLayer())),
    ),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const form = over.makeForm === undefined ? (over.form ?? null) : yield* over.makeForm
      const exit = yield* Effect.exit(
        setChecks({
          repo: project.repo,
          commonDir: project.commonDir,
          branch: "main",
          version: "0.1.0",
          flags: over.flags ?? {},
          form,
          scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
          machine: machine(project),
        }),
      )
      const issues = yield* (yield* TestBeads.Backlog).issues
      return { exit, issues }
    }).pipe(
      Effect.scoped,
      Effect.provide(services(project)),
      Effect.provide(TestBeads.layer([])),
      Effect.provide(over.files ?? BunServices.layer),
      Effect.provide(BunServices.layer),
    ),
  )
  return { ...result, calls }
}

const summaryOf = (exit: Exit.Exit<InitSummary, unknown>): InitSummary => {
  if (Exit.isFailure(exit)) throw new Error(`tutti checks failed: ${String(exit.cause)}`)
  return exit.value
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected tutti checks to fail")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason?._tag !== "Fail") throw new Error(`no failure in ${String(exit.cause)}`)
  return reason.error
}

const read = (project: Project, path: string) => readFileSync(join(project.repo, path), "utf8")

const settings = (project: Project) => JSON.parse(read(project, ".tutti/settings.json"))

/** Every file under `repo` but the git folder: its path, mode and text. */
const tree = (repo: string): Record<string, string> => {
  const files: Record<string, string> = {}
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      const at = relative(repo, path)
      if (at === ".git") continue
      const info = statSync(path)
      if (info.isDirectory()) {
        files[`${at}/`] = ""
        walk(path)
      } else {
        files[at] = `${(info.mode & 0o777).toString(8)} ${readFileSync(path, "utf8")}`
      }
    }
  }
  walk(repo)
  return files
}

/** tutti checks in `project` with init's line form over `input`: as runChecks, and what it wrote. */
const runInLines = async (project: Project, input: string, scout: Scouting) => {
  const stream = new PassThrough()
  stream.write(input)
  stream.end()
  let output = ""
  const makeForm = Effect.map(streamInput(stream), (lines) =>
    lineForm({
      input: lines,
      write: (text) => {
        output += text
      },
      theme: makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true }),
    }),
  )
  const ran = await runChecks(project, { makeForm, scout })
  return { ...ran, output }
}

describe("tutti checks' form", () => {
  test("asks init's Checks step: the scout, the choice, the checklists, the untested areas, the replace questions, the setup", async () => {
    const project = newProject()
    await setUp(project)
    // Enter for the choice the scout selects and both checklists' defaults; yes to the untested
    // areas and to replacing each runner, which checks nothing; Enter for npm ci.
    const { exit, issues, calls, output } = await runInLines(
      project,
      "\n\n\ny\ny\ny\n\n",
      twoSuites,
    )
    const summary = summaryOf(exit)
    expect(calls.map((each) => each.call.organ)).toEqual(["scout"])
    // In order, under the Checks step alone; nothing of init's other questions.
    const asked = [
      "Checks",
      "The project's checks",
      "On every merge (check-fast)",
      "At the end of a run (check-full)",
      "Also file tickets for untested areas?",
      "Replace scripts/check-fast.sh?",
      "Replace scripts/check-full.sh?",
      "Setup command",
    ]
    const at = asked.map((title) => output.indexOf(title))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const other of ["Workers", "Ticket prefix", "verification step", "Tickets to run"]) {
      expect(output).not.toContain(other)
    }

    expect(read(project, "scripts/check-fast.sh")).toContain("\nnpm test\n")
    expect(read(project, "scripts/check-full.sh")).toContain("\nnpx playwright test\n")
    expect(settings(project).checks.setup.command).toBe("npm ci")
    expect(settings(project).queue.shared_files).toContain("FEATURES.md")
    expect(existsSync(join(project.repo, ".claude/skills/create-check-suite/SKILL.md"))).toBe(true)
    // init's files outside the checks are left as they were.
    expect(existsSync(join(project.repo, ".claude/agents/verifier.md"))).toBe(false)

    const titles = issues.map((issue) => issue.title)
    expect(titles).toEqual([testsEpicTitle, passRunnersTitle("main"), mapUntestedTitle])
    for (const issue of issues) expect(issue.labels).toContain(testWorkLabel)

    const lines = summary.steps.map(stepLine)
    expect(lines).toContain("✓ check-fast  replaced scripts/check-fast.sh")
    expect(lines).toContain("✓ check-full  replaced scripts/check-full.sh")
    expect(
      lines.some((line) => line.startsWith("✓ settings  updated .tutti/settings.json: ")),
    ).toBe(true)
    expect(lines.some((line) => line.startsWith("✓ ticket  filed "))).toBe(true)
    // Not the lines of init's other steps.
    for (const label of ["worker prompt", "Beads", "bd", ".gitignore", "login"]) {
      expect(summary.steps.map((each) => each.label)).not.toContain(label)
    }
    expect(summary.next.some((line) => line.includes("tutti checks"))).toBe(false)
  })

  test("Manual's command writes check-fast.sh from it, and check-full.sh, which checked nothing, runs it", async () => {
    const project = newProject()
    await setUp(project)
    // The scout found nothing: Manual, typed; Enter for npm ci.
    const scout: Scouting = { suites: [], stack: [], note: "" }
    const { exit, issues } = await runInLines(project, "3\nmake check\n\n", scout)
    summaryOf(exit)
    expect(read(project, "scripts/check-fast.sh")).toContain("\nmake check\n")
    const full = read(project, "scripts/check-full.sh")
    expect(runnerCommands(full)).toEqual(["scripts/check-fast.sh"])
    expect(issues).toEqual([])
  })

  test("a cancel changes nothing", async () => {
    const project = newProject()
    await setUp(project)
    const before = tree(project.repo)
    // The input ends at the choice of checks: the line form's cancel.
    const { exit } = await runInLines(project, "", twoSuites)
    expect(failureOf(exit)).toBeInstanceOf(FormCancelled)
    expect(tree(project.repo)).toEqual(before)
  })
})

describe("tutti checks' flags", () => {
  test("answer without asking: no scout, the runners and their settings as given", async () => {
    const project = newProject()
    await setUp(project)
    let asked = false
    const form: InitForm = {
      workers: () => Effect.die("not asked"),
      checks: () =>
        Effect.sync(() => {
          asked = true
          return {}
        }),
      trust: () => Effect.die("not asked"),
      import: () => Effect.die("not asked"),
    }
    const { exit, calls, issues } = await runChecks(project, {
      form,
      flags: {
        checkFast: "npm test",
        checkFull: "npx playwright test",
        checkFastTimeout: Duration.minutes(5),
        setup: "npm ci",
      },
    })
    summaryOf(exit)
    expect(asked).toBe(false)
    expect(settings(project).checks.fast.timeout).toBe("5m")
    expect(calls).toEqual([])
    expect(issues).toEqual([])
  })

  test("without a terminal: what the flags give, a line each for what changed", async () => {
    const project = newProject()
    await setUp(project)
    const { exit, calls } = await runChecks(project, {
      flags: {
        checkFast: "npm test",
        checkFullTimeout: Duration.minutes(90),
        setup: "npm ci",
      },
    })
    const summary = summaryOf(exit)
    expect(calls).toEqual([])
    expect(read(project, "scripts/check-fast.sh")).toContain("\nnpm test\n")
    expect(runsNothing(read(project, "scripts/check-full.sh"))).toBe(false)
    const checks = settings(project).checks
    expect(checks.full.timeout).toBe("1h30m")
    expect(checks.setup.command).toBe("npm ci")
    expect(summary.steps.map(stepLine)).toContain(
      "✓ settings  updated .tutti/settings.json: checks.full.timeout and checks.setup.command",
    )
    expect(summary.next).toContain(
      "Commit scripts/check-fast.sh, scripts/check-full.sh and .tutti/.",
    )
  })

  test("without a terminal or a flag: says what it needs, and changes nothing", async () => {
    const project = newProject()
    await setUp(project)
    const before = tree(project.repo)
    const { exit, calls } = await runChecks(project)
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(InitRefused)
    expect((error as InitRefused).message).toBe(checksUnasked)
    expect(calls).toEqual([])
    expect(tree(project.repo)).toEqual(before)
  })
})

describe("where tutti checks refuses", () => {
  test("before tutti init: it says to run tutti init first", async () => {
    const project = newProject()
    const { exit } = await runChecks(project, { flags: { checkFast: "npm test" } })
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(InitRefused)
    expect((error as InitRefused).message).toContain("run tutti init first")
    expect(tree(project.repo)).toEqual({})
  })

  test("while a run holds the lock", async () => {
    const project = newProject()
    await setUp(project)
    const before = tree(project.repo)
    const holder = {
      pid: process.pid,
      started: new Date().toISOString(),
      version: "0.1.0",
      branch: "main",
    }
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RunLock
          yield* lock.acquire({ repo: project.repo, commonDir: project.commonDir, holder })
          return (yield* Effect.promise(() =>
            runChecks(project, { flags: { checkFast: "npm test" } }),
          )).exit
        }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(InitRefused)
    expect((error as InitRefused).message).toContain("already running")
    expect((error as InitRefused).message).toContain("set the checks between runs")
    expect(tree(project.repo)).toEqual(before)
  })
})

describe("tutti checks' writes, as one", () => {
  test("each write failed in turn leaves the runners and the settings as they were", async () => {
    // The writes it makes: its temporary files, their modes and renames, the old files' copies.
    const temporary = (path: string) => /\.tutti-\d+-[0-9a-f-]+\.(new|old)$/.test(path)
    const faulty = (
      project: Project,
      seen: Array<string>,
      fails: (op: string, at: number) => boolean,
    ) =>
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) => {
          const check = <A, R>(
            op: string,
            path: string,
            effect: Effect.Effect<A, PlatformError, R>,
          ): Effect.Effect<A, PlatformError, R> =>
            Effect.suspend(() => {
              if (!path.startsWith(`${project.repo}/`) || !temporary(path)) return effect
              seen.push(`${op} ${relative(project.repo, path)}`)
              return fails(op, seen.length - 1)
                ? Effect.fail(
                    systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: op,
                      description: "failed on purpose",
                      pathOrDescriptor: path,
                    }),
                  )
                : effect
            })
          return FileSystem.FileSystem.of({
            ...real,
            open: (path, options) => check("open", path, real.open(path, options)),
            chmod: (path, mode) => check("chmod", path, real.chmod(path, mode)),
            rename: (from, to) => check("rename", from, real.rename(from, to)),
            link: (from, to) => check("link", to, real.link(from, to)),
            copyFile: (from, to) => check("copyFile", to, real.copyFile(from, to)),
          })
        }),
      ).pipe(Layer.provide(BunServices.layer))
    const flags = { checkFast: "npm test", checkFull: "npx playwright test", setup: "npm ci" }

    const counted: Array<string> = []
    const once = newProject()
    await setUp(once)
    summaryOf((await runChecks(once, { flags, files: faulty(once, counted, () => false) })).exit)
    expect(counted.at(-1)).toMatch(/^rename \.tutti\/\.settings\.json\.tutti-/)

    for (const [index, write] of counted.entries()) {
      const project = newProject()
      await setUp(project)
      const before = tree(project.repo)
      const { exit } = await runChecks(project, {
        flags,
        // An old file's copy falls back from a link to a copy: both fail.
        files: faulty(
          project,
          [],
          (op, at) => at === index || (op === "copyFile" && at === index + 1),
        ),
      })
      const error = failureOf(exit)
      expect(error).toBeInstanceOf(InitFailed)
      expect((error as InitFailed).step).toBe("the checks")
      expect([index, write, tree(project.repo)]).toEqual([index, write, before])
    }
  })
})

describe("init's Next lines", () => {
  test("a check-fast.sh that checks nothing points to tutti checks; one that checks something doesn't", async () => {
    const project = newProject()
    const summary = await setUp(project)
    expect(summary.steps.map(stepLine)).toContain(
      "✓ check-fast  wrote scripts/check-fast.sh: it checks nothing yet (tutti checks gives it one)",
    )
    expect(summary.next).toContain(
      "scripts/check-fast.sh checks nothing yet, so nothing merged is checked: set the project's checks with\ntutti checks",
    )
    const set = summaryOf((await runChecks(project, { flags: { checkFast: "npm test" } })).exit)
    expect(set.next.some((line) => line.includes("tutti checks"))).toBe(false)
  })
})

// Each test starts tutti as a bun process, which bun's 5 s default fails beside other checks.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")

/** `tutti checks` with `args` in `cwd`, stdin and stdout no terminal: its exit code and output. */
const tuttiChecks = async (cwd: string, args: ReadonlyArray<string> = []) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "tutti-checks-home-")))
  const proc = Bun.spawn(["bun", main, "checks", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...testEnv, HOME: home },
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("tutti checks' command", () => {
  slow.test("in a linked worktree: exit 2, and to run it from the main checkout", async () => {
    const repo = makeRepo()
    const worktree = repo.worktree("feature")
    const { code, stdout, stderr } = await tuttiChecks(worktree, ["--check-fast", "npm test"])
    expect([code, stdout]).toEqual([2, ""])
    expect(stderr).toBe(
      `tutti checks: ${worktree} is a linked worktree. Run this from the main checkout.\n`,
    )
    expect(existsSync(join(worktree, "scripts"))).toBe(false)
  })

  slow.test("before tutti init, and without a flag: exit 2, saying why", async () => {
    const repo = makeRepo()
    const before = await tuttiChecks(repo.dir, ["--check-fast", "npm test"])
    expect(before.code).toBe(2)
    expect(before.stderr).toContain("tutti checks: tutti init hasn't set this project up")
    expect(existsSync(join(repo.dir, "scripts"))).toBe(false)

    mkdirSync(join(repo.dir, ".tutti"))
    writeFileSync(join(repo.dir, ".tutti", "settings.json"), "{}\n")
    const unasked = await tuttiChecks(repo.dir)
    expect(unasked.code).toBe(2)
    expect(unasked.stderr).toBe(`tutti checks: ${checksUnasked}\n`)
  })
})
