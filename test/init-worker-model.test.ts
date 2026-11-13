// tutti init's question of the workers' model and effort (§ 8.3): Opus and high offered, written to
// .tutti/settings.json as workers.model and workers.effort, which the next run's workers take;
// Claude Code's default leaving the model null; --worker-model and --worker-effort answering
// without asking; the defaults written without a terminal, and said; a model or an effort the
// settings, or an import from orchestra, already name kept and not asked.
import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Option, Result } from "effect"
import { readInitFlags } from "../src/cli/commands.ts"
import { type InitFlags, type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import { type WorkersAnswers, type WorkersQuestions, workerModels } from "../src/init/workers.ts"
import { noFlags } from "../src/project/flags.ts"
import { orchestra } from "../src/project/scheme.ts"
import { loadLenient } from "../src/run/resolveConfig.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme } from "../src/ui/theme.ts"

const plain = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const fixture = resolve(import.meta.dir, "fixtures/orchestra-project")

/** A temp repository, with a copy of the orchestra fixture's .orchestra/ where `orchestra` says. */
const newProject = (orchestra = false) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-worker-model-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  if (orchestra) cpSync(join(fixture, ".orchestra"), join(repo, ".orchestra"), { recursive: true })
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** A form answering the Workers step with `answers` and the import offer with yes; what it was asked. */
const scriptedForm = (answers: WorkersAnswers = {}) => {
  const asked: Array<WorkersQuestions> = []
  const form: InitForm = {
    workers: (questions) =>
      Effect.sync(() => {
        asked.push(questions)
        return answers
      }),
    checks: () => Effect.succeed({ verifier: false }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(true),
  }
  return { form, asked }
}

const machine = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

const runInit = async (
  project: Project,
  form: InitForm | null,
  flags: InitFlags = { force: false },
): Promise<InitSummary> => {
  const exit = await Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags,
        form,
        scout: Effect.fail("there is no scout in these tests"),
        machine: machine(project),
        configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
        account: TestAccount.layer(),
        claudeConfig: join(project.home, ".claude.json"),
      }).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer([])),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
        ),
        Effect.provide(BunServices.layer),
      ),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

/** The workers section of the settings file init wrote, as it is in the file. */
const writtenWorkers = (project: Project): Record<string, unknown> =>
  JSON.parse(readFileSync(join(project.repo, ".tutti/settings.json"), "utf8")).workers

/** The model and effort the next run's workers take, as a run reads the project's settings. */
const nextRun = async (project: Project) => {
  const read = await Effect.runPromise(
    loadLenient(noFlags, project.repo).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
  const { model, effort } = read.value.settings.workers
  return { model, effort }
}

const modelLine = (summary: InitSummary) =>
  summary.steps.map(stepLine).find((line) => line.includes(" model  "))

const writeSettings = (project: Project, settings: unknown) => {
  mkdirSync(join(project.repo, ".tutti"))
  writeFileSync(join(project.repo, ".tutti/settings.json"), JSON.stringify(settings))
}

describe("the workers' model and effort in init's form", () => {
  /** The Workers step in lines over `input`, which then ends: its answers, and what it wrote. */
  const asked = async (input: string) => {
    const stream = new PassThrough()
    stream.write(input)
    stream.end()
    let output = ""
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const form = lineForm({
            input: yield* streamInput(stream),
            write: (text) => {
              output += text
            },
            theme: plain,
          })
          return yield* form.workers({
            installBeads: null,
            concurrent: null,
            model: true,
            effort: true,
            mcp: null,
            changelogUnion: false,
          })
        }),
      ),
    )
    return {
      answers: Exit.isSuccess(exit) ? exit.value : String(exit),
      output: Bun.stripANSI(output),
    }
  }

  test("offers Opus first, the other families, then Claude Code's default", () => {
    expect(workerModels.map((each) => each.model)).toEqual([
      "opus",
      "fable",
      "sonnet",
      "haiku",
      null,
    ])
  })

  test("Enter takes Opus at high", async () => {
    const { answers, output } = await asked("\n\n")
    expect(answers).toEqual({ model: "opus", effort: "high" })
    expect(output).toContain("Workers' model")
    expect(output).toContain("Workers' effort")
    expect(output).toContain("--worker-model")
  })

  test("Claude Code's default is null, and another level is taken", async () => {
    const { answers } = await asked(`${workerModels.length}\n5\n`)
    expect(answers).toEqual({ model: null, effort: "max" })
  })
})

describe("init writes the workers' model and effort", () => {
  test("in a new project it asks both, and accepting writes opus at high for the next run", async () => {
    const project = newProject()
    const { form, asked } = scriptedForm({ model: "opus", effort: "high" })
    const summary = await runInit(project, form)
    expect(asked[0]).toMatchObject({ model: true, effort: true })
    expect(writtenWorkers(project)).toMatchObject({ model: "opus", effort: "high" })
    expect(await nextRun(project)).toEqual({ model: "opus", effort: "high" })
    expect(modelLine(summary)).toBe("✓ model  workers run opus at high effort")
  })

  test("Claude Code's default leaves the model null", async () => {
    const project = newProject()
    const { form } = scriptedForm({ model: null, effort: "medium" })
    const summary = await runInit(project, form)
    expect(writtenWorkers(project)).toMatchObject({ model: null, effort: "medium" })
    expect(await nextRun(project)).toEqual({ model: null, effort: "medium" })
    expect(modelLine(summary)).toBe(
      "✓ model  workers run Claude Code's default model at medium effort",
    )
  })

  test("the flags answer without asking", async () => {
    const project = newProject()
    const { form, asked } = scriptedForm({ model: "opus", effort: "high" })
    await runInit(project, form, { force: false, workerModel: "sonnet", workerEffort: "low" })
    expect(asked[0]).toMatchObject({ model: false, effort: false })
    expect(await nextRun(project)).toEqual({ model: "sonnet", effort: "low" })
  })

  test("--worker-model and --worker-effort win over a settings file's own", async () => {
    const project = newProject()
    writeSettings(project, { workers: { model: "haiku", effort: "low" } })
    await runInit(project, null, { force: false, workerModel: null, workerEffort: "xhigh" })
    expect(writtenWorkers(project)).toMatchObject({ model: null, effort: "xhigh" })
  })

  test("without a terminal the defaults are written, and the summary says so", async () => {
    const project = newProject()
    const summary = await runInit(project, null)
    expect(writtenWorkers(project)).toMatchObject({ model: "opus", effort: "high" })
    expect(modelLine(summary)).toBe(
      "✓ model  workers run opus at high effort; not asked (no terminal): --worker-model and --worker-effort choose others",
    )
  })

  test("a settings file's model and effort are kept, and not asked", async () => {
    const project = newProject()
    writeSettings(project, { workers: { model: "sonnet", effort: "medium" } })
    const { form, asked } = scriptedForm({ model: "opus", effort: "high" })
    const summary = await runInit(project, form)
    expect(asked[0]).toMatchObject({ model: false, effort: false })
    expect(await nextRun(project)).toEqual({ model: "sonnet", effort: "medium" })
    expect(modelLine(summary)).toBe("• model  workers run sonnet at medium effort")

    // Nor are they changed without a terminal; a model set to null is the project's too.
    const quiet = newProject()
    writeSettings(quiet, { workers: { model: null } })
    const unasked = await runInit(quiet, null)
    expect(writtenWorkers(quiet)).toMatchObject({ model: null, effort: "high" })
    expect(modelLine(unasked)).toBe(
      "✓ model  workers run Claude Code's default model at high effort; not asked (no terminal): --worker-effort chooses another",
    )
  })

  test("an import from orchestra keeps the effort it brings, and asks the model", async () => {
    const project = newProject(true)
    const { form, asked } = scriptedForm({ model: "fable", effort: "low" })
    await runInit(project, form)
    expect(asked[0]).toMatchObject({ model: true, effort: false })
    expect(await nextRun(project)).toEqual({ model: "fable", effort: "high" })
  })
})

describe("--worker-model and --worker-effort", () => {
  const none = Option.none<string>()
  const texts = {
    checkFast: none,
    checkFull: none,
    checkFastTimeout: none,
    checkFullTimeout: none,
    setup: none,
    concurrent: none,
    workerModel: none,
    workerEffort: none,
    mcp: none,
    changelogUnion: none,
    installBeads: none,
    prefix: none,
    verifier: none,
    noMouse: none,
    noChecks: none,
    force: false,
  }

  test('read a model, "" as Claude Code\'s default, and a level', () => {
    const read = (model: string, effort: string) =>
      readInitFlags({
        ...texts,
        workerModel: Option.some(model),
        workerEffort: Option.some(effort),
      })
    expect(read(" opus ", "max")).toEqual(
      Result.succeed({ workerModel: "opus", workerEffort: "max", force: false }),
    )
    expect(read("", "low")).toEqual(
      Result.succeed({ workerModel: null, workerEffort: "low", force: false }),
    )
    expect(Result.isFailure(read("opus", "huge") as Result.Result<unknown, unknown>)).toBe(true)
  })
})
