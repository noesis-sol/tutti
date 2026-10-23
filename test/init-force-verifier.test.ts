// tutti init --force keeps a verifier in use (§ 8.3): --force replaces the worker prompt with the
// template, which has no Verify section, so init appends it again where the prompt on disk ran the
// verifier, with a form or without one, and asks nothing about it. --no-verifier still drops it.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import {
  type ChecksAnswers,
  type ChecksQuestions,
  scoutSearch,
  verifierPath,
  verifierSection,
} from "../src/init/checks.ts"
import { type InitFlags, type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"

const promptPath = ".tutti/worker-prompt.md"

/** A temp repository (its top and git folder) and a home folder. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-force-verifier-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** A machine with bd on the PATH, each command answered with "". */
const machine = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

/** A scripted form answering the Checks step with `answers`, keeping the questions it was asked. */
const checksForm = (answers: ChecksAnswers) => {
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

/** Runs init in `project` with `flags` and `form` (none: no terminal), and gives its summary. */
const runInit = async (
  project: Project,
  flags: InitFlags,
  form: InitForm | null = null,
): Promise<InitSummary> => {
  const organs = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer({}, []),
        TestAppConfig.layer(TestAppConfig.appConfig({})),
        logLayer(),
      ),
    ),
  )
  const exit = await Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags,
        form,
        scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
        machine: machine(project),
        configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
        account: TestAccount.layer(),
        claudeConfig: join(project.home, ".claude.json"),
      }),
    ).pipe(
      Effect.provide(RunLock.layer),
      Effect.provide(TestBeads.layer([])),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

const lines = (summary: InitSummary) => summary.steps.map(stepLine)

const read = (project: Project, path: string) => readFileSync(join(project.repo, path), "utf8")

const keptLine =
  "✓ verifier  .claude/agents/verifier.md is there; left as it is; the worker prompt has workers run it before they close a ticket"

/** A project init has set up with the verifier. */
const withVerifier = async () => {
  const project = newProject()
  await runInit(project, { force: false, verifier: true })
  expect(read(project, promptPath)).toEndWith(verifierSection)
  return project
}

describe("tutti init --force with the verifier in use", () => {
  test("without a terminal, the template's prompt runs the verifier again", async () => {
    const project = await withVerifier()
    const verifier = read(project, verifierPath)
    const summary = await runInit(project, { force: true })

    const prompt = read(project, promptPath)
    expect(prompt).toEndWith(verifierSection)
    expect(prompt.indexOf("## Verify")).toBe(prompt.lastIndexOf("## Verify"))
    expect(read(project, verifierPath)).toBe(verifier)
    expect(lines(summary)).toContain(keptLine)
    expect(lines(summary).join("\n")).not.toContain("not asked")
  })

  test("with a form, it isn't asked about, and is kept", async () => {
    const project = await withVerifier()
    const { form, asked } = checksForm({ verifier: false })
    const summary = await runInit(project, { force: true }, form)

    expect(asked[0]?.verifier).toBe(false)
    expect(read(project, promptPath)).toEndWith(verifierSection)
    expect(lines(summary)).toContain(keptLine)
  })

  test("--no-verifier drops the section, leaving the verifier's file", async () => {
    const project = await withVerifier()
    await runInit(project, { force: true, verifier: false })
    expect(read(project, promptPath)).not.toContain("## Verify")
    expect(existsSync(join(project.repo, verifierPath))).toBe(true)
  })

  test("a prompt that didn't run it is asked about under --force, as before", async () => {
    const project = newProject()
    await runInit(project, { force: false })
    const { form, asked } = checksForm({ verifier: false })
    await runInit(project, { force: true }, form)
    expect(asked[0]?.verifier).toBe(true)
    expect(read(project, promptPath)).not.toContain("## Verify")
  })
})
