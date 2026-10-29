// tutti init --no-checks (§ 8.3): the checks left for later, as for a project with no code yet. No
// scout runs and no check question is asked; a runner that is missing is written checking nothing,
// one there is kept byte for byte; no test work is filed; the summary says so and the Next lines say
// how to set the checks afterwards. With --check-fast or --check-full it is a setup problem, said
// with the rest. The form's fourth option, "Not yet: leave them empty", does the same. Each runs
// init in a temp repository with a scripted form, as test/init-checks.test.ts does.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Layer, Option, Result } from "effect"
import { type InitFlagTexts, readInitFlags } from "../src/cli/commands.ts"
import {
  type ChecksAnswers,
  type ChecksQuestions,
  checksOptions,
  choiceScripts,
  runnersDiffer,
  scoutSearch,
} from "../src/init/checks.ts"
import {
  type InitFlags,
  type InitForm,
  type InitSummary,
  init,
  setChecksLater,
} from "../src/init/init.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { fastScript, fullScript } from "../src/init/runners.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

/** A temp repository (its top and git folder) and a home folder. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-no-checks-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

const machineFor = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

/**
 * Runs init in `project`, its scout canned to find a suite, and gives its summary, the backlog
 * afterwards and the organ calls made.
 */
const runInit = async (project: Project, flags: InitFlags, form: InitForm | null = null) => {
  const calls: Array<OrganCallRecord> = []
  const organs = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer(
          {
            scout: {
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
              ],
              stack: [],
              note: "",
            },
          },
          calls,
        ),
        TestAppConfig.layer(TestAppConfig.appConfig({})),
      ).pipe(Layer.provideMerge(logLayer())),
    ),
  )
  const { exit, issues } = await Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        init({
          repo: project.repo,
          commonDir: project.commonDir,
          branch: "main",
          version: "0.1.0",
          flags,
          form,
          scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
          machine: machineFor(project),
          configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
          account: TestAccount.layer(),
          claudeConfig: join(project.home, ".claude.json"),
        }),
      )
      const issues = yield* (yield* TestBeads.Backlog).issues
      return { exit, issues }
    }).pipe(
      Effect.provide(RunLock.layer),
      Effect.provide(TestBeads.layer([])),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return { summary: exit.value, issues, calls }
}

/** A form that records the Checks step's questions and answers them with `answers`. */
const recordingForm = (answers: ChecksAnswers = {}) => {
  const asked: Array<ChecksQuestions> = []
  const form: InitForm = {
    workers: () => Effect.succeed({}),
    checks: (questions) =>
      Effect.sync(() => {
        asked.push(questions)
        return answers
      }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  }
  return { form, asked }
}

const lines = (summary: InitSummary) => summary.steps.map(stepLine)

const read = (project: Project, path: string) => readFileSync(join(project.repo, path), "utf8")

const write = (project: Project, path: string, text: string) => {
  mkdirSync(join(project.repo, path, ".."), { recursive: true })
  writeFileSync(join(project.repo, path), text)
}

const quiet: InitFlags = { force: false, mcp: [], changelogUnion: false, verifier: false }
const noChecks: InitFlags = { ...quiet, noChecks: true }

const ownFast = "#!/bin/sh\nset -eu\nnpm test\n"
const ownFull = "#!/bin/sh\nset -eu\nscripts/check-fast.sh\nnpm run e2e\n"

/** Checks init left for later in a repository with no runners: what it wrote and said. */
const expectWrittenEmpty = (project: Project, summary: InitSummary) => {
  expect(read(project, "scripts/check-fast.sh")).toBe(fastScript([]))
  expect(read(project, "scripts/check-full.sh")).toBe(fullScript([], true))
  expect(lines(summary)).toContain(
    "✓ check-fast  wrote scripts/check-fast.sh: it checks nothing yet, the checks left for later",
  )
  expect(lines(summary)).toContain(
    "✓ check-full  wrote scripts/check-full.sh: it checks nothing yet, the checks left for later",
  )
  expect(summary.next).toContain(setChecksLater)
  const settings = JSON.parse(read(project, ".tutti/settings.json"))
  expect(settings.checks.fast.command).toBe("scripts/check-fast.sh")
  expect(settings.checks.full.command).toBe("scripts/check-full.sh")
}

/** Checks init left for later in a repository with runners of its own: kept, and said so. */
const expectKept = (project: Project, summary: InitSummary) => {
  expect(read(project, "scripts/check-fast.sh")).toBe(ownFast)
  expect(read(project, "scripts/check-full.sh")).toBe(ownFull)
  expect(lines(summary)).toContain(
    "• check-fast  scripts/check-fast.sh is there; left as it is, the checks left for later",
  )
  expect(lines(summary)).toContain(
    "• check-full  scripts/check-full.sh is there; left as it is, the checks left for later",
  )
  expect(summary.next).toContain(setChecksLater)
}

describe("tutti init --no-checks", () => {
  test("in a repository with no runners, writes both checking nothing, with no scout", async () => {
    const project = newProject()
    const { summary, issues, calls } = await runInit(project, noChecks)

    expectWrittenEmpty(project, summary)
    expect(calls).toEqual([])
    expect(issues).toEqual([])
  })

  test("a scripts/check.sh there doesn't become check-fast's suite", async () => {
    const project = newProject()
    write(project, "scripts/check.sh", "#!/bin/sh\nnpm test\n")
    const { summary } = await runInit(project, noChecks)

    expectWrittenEmpty(project, summary)
  })

  test("keeps runners there byte for byte, and the settings' commands", async () => {
    const project = newProject()
    write(project, "scripts/check-fast.sh", ownFast)
    write(project, "scripts/check-full.sh", ownFull)
    write(
      project,
      ".tutti/settings.json",
      JSON.stringify({ checks: { fast: { command: "make check" }, full: { command: null } } }),
    )
    const { summary, issues } = await runInit(project, noChecks)

    expectKept(project, summary)
    const settings = JSON.parse(read(project, ".tutti/settings.json"))
    expect(settings.checks.fast.command).toBe("make check")
    expect(settings.checks.full.command).toBeNull()
    expect(issues).toEqual([])
  })

  test("keeps one runner there and writes the one missing", async () => {
    const project = newProject()
    write(project, "scripts/check-fast.sh", ownFast)
    const { summary } = await runInit(project, noChecks)

    expect(read(project, "scripts/check-fast.sh")).toBe(ownFast)
    // check-full.sh runs the check-fast.sh kept, as it checks something.
    expect(read(project, "scripts/check-full.sh")).toBe(fullScript([], false))
    expect(lines(summary)).toContain(
      "• check-fast  scripts/check-fast.sh is there; left as it is, the checks left for later",
    )
    expect(lines(summary)).toContain(
      "✓ check-full  wrote scripts/check-full.sh: it runs scripts/check-fast.sh, the checks left for later",
    )
  })

  test("in a terminal, asks the rest of the Checks step but no check question", async () => {
    const project = newProject()
    const { form, asked } = recordingForm()
    const { summary, calls } = await runInit(
      project,
      { force: false, mcp: [], changelogUnion: false, noChecks: true },
      form,
    )

    expect(asked).toHaveLength(1)
    expect(asked[0]?.checks).toBeNull()
    expect(asked[0]?.verifier).toBe(true)
    expect(calls).toEqual([])
    expectWrittenEmpty(project, summary)
  })

  test("=off asks the checks as before", async () => {
    const project = newProject()
    const { form, asked } = recordingForm()
    await runInit(project, { ...quiet, noChecks: false }, form)

    expect(asked[0]?.checks).not.toBeNull()
  })

  test("without it, the Next lines don't say how to set the checks", async () => {
    const project = newProject()
    const { summary } = await runInit(project, { ...quiet, checkFast: "", checkFull: "" })

    expect(summary.next).not.toContain(setChecksLater)
  })
})

describe("the form's fourth option", () => {
  test("is Not yet: leave them empty", () => {
    expect(checksOptions.map((option) => option.label)).toEqual([
      "Use them as they are",
      "Create from scratch with the create-check-suite skill",
      "Manual",
      "Not yet: leave them empty",
    ])
  })

  test("writes no runner over one there, so asks no replace question", () => {
    expect(choiceScripts({ kind: "later" })).toBeNull()
    expect(runnersDiffer({ fast: ownFast, full: ownFull }, { kind: "later" })).toEqual({
      fast: false,
      full: false,
    })
  })

  test("picked in the line form, it answers the checks with later, asking nothing more", async () => {
    const plainTheme = makeTheme(orchestra, {
      appearance: "dark",
      depth: "truecolor",
      noColor: true,
    })
    const stream = new PassThrough()
    stream.write("4\n")
    stream.end()
    let output = ""
    const questions: ChecksQuestions = {
      checks: {
        scout: Effect.fail("there is no scout in this test"),
        checkScript: false,
        command: "",
        keepsRunner: true,
        runners: { fast: ownFast, full: ownFull },
        skill: "differs",
      },
      setup: null,
      prefix: null,
      verifier: false,
    }
    const answers = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const form = lineForm({
            input: yield* streamInput(stream),
            write: (text) => {
              output += text
            },
            theme: plainTheme,
          })
          return yield* form.checks(questions)
        }),
      ),
    )
    expect(answers).toEqual({ checks: { kind: "later" }, stack: [] })
    expect(output).toContain("4. Not yet: leave them empty")
    expect(output).not.toContain("Replace ")
  })

  test("in a repository with no runners, writes both checking nothing and files no ticket", async () => {
    const project = newProject()
    const { form } = recordingForm({ checks: { kind: "later" }, verifier: false })
    const { summary, issues } = await runInit(project, quiet, form)

    expectWrittenEmpty(project, summary)
    expect(issues).toEqual([])
  })

  test("in a repository with runners, keeps them byte for byte", async () => {
    const project = newProject()
    write(project, "scripts/check-fast.sh", ownFast)
    write(project, "scripts/check-full.sh", ownFull)
    const { form } = recordingForm({ checks: { kind: "later" }, verifier: false })
    const { summary, issues } = await runInit(project, quiet, form)

    expectKept(project, summary)
    expect(issues).toEqual([])
  })
})

describe("--no-checks beside --check-fast or --check-full", () => {
  const none = Option.none<string>()
  const texts: InitFlagTexts = {
    checkFast: none,
    checkFull: none,
    noChecks: none,
    checkFastTimeout: none,
    checkFullTimeout: none,
    setup: none,
    concurrent: none,
    mcp: none,
    changelogUnion: none,
    installBeads: none,
    verifier: none,
    prefix: none,
    noMouse: none,
    force: false,
  }
  const problems = (over: Partial<InitFlagTexts>) => {
    const read = readInitFlags({ ...texts, ...over })
    return Result.isFailure(read) ? read.failure : []
  }

  test("reads as --no-mouse does: bare is on, =off is off", () => {
    const on = readInitFlags({ ...texts, noChecks: Option.some("true") })
    expect(Result.isSuccess(on) && on.success.noChecks).toBe(true)
    const off = readInitFlags({
      ...texts,
      noChecks: Option.some("off"),
      checkFast: Option.some(""),
    })
    expect(Result.isSuccess(off) && off.success.noChecks).toBe(false)
  })

  test("is a setup problem, naming the flags it conflicts with", () => {
    expect(problems({ noChecks: Option.some("true"), checkFast: Option.some("") })).toEqual([
      "--no-checks leaves the checks for later, which --check-fast sets: give one or the other",
    ])
    expect(
      problems({
        noChecks: Option.some("true"),
        checkFast: Option.some("make"),
        checkFull: Option.some(""),
      }),
    ).toEqual([
      "--no-checks leaves the checks for later, which --check-fast and --check-full set: give one or the other",
    ])
  })

  test("is said with every other problem at once", () => {
    expect(
      problems({
        noChecks: Option.some("true"),
        checkFull: Option.some("make e2e"),
        concurrent: Option.some("0"),
      }),
    ).toEqual([
      "--concurrent must be a whole number from 1 to 16 (got '0')",
      "--no-checks leaves the checks for later, which --check-full sets: give one or the other",
    ])
  })
})
