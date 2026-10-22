// tutti init's check-full.sh beside a check-fast.sh it keeps (§ 8.3): written from the check-fast.sh
// that ends up on disk, not the one the checks chosen would write. 'Create from scratch' with a
// check-fast.sh there that runs suites, kept (the default), writes a check-full.sh that runs it,
// never `exit 0`. Each runs init in a temp repository with a scripted form, as
// test/init-checks.test.ts does.
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import {
  type ChecksAnswers,
  type ChecksQuestions,
  runnersDiffer,
  scoutSearch,
  settleScout,
} from "../src/init/checks.ts"
import { type InitForm, type InitSummary, init } from "../src/init/init.ts"
import {
  checksNothing,
  fastScript,
  fullScript,
  runnerCommands,
  runsNothing,
} from "../src/init/runners.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"

const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-kept-fast-")))
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

/** A Checks step choosing 'create from scratch', answering `replaceFast` where it is asked. */
const scratchForm = (replaceFast?: boolean) => {
  const asked: Array<ChecksQuestions> = []
  const form: InitForm = {
    workers: () => Effect.succeed({}),
    checks: (questions) =>
      Effect.gen(function* () {
        asked.push(questions)
        if (questions.checks !== null) {
          const result = yield* questions.checks.scout.pipe(
            Effect.match({
              onSuccess: (found) => ({ found }),
              onFailure: (failed) => ({ failed }),
            }),
          )
          settleScout(result, questions.checks.checkScript)
        }
        const answers: ChecksAnswers = {
          checks: { kind: "scratch" },
          stack: [],
          verifier: false,
          ...(replaceFast === undefined ? {} : { replaceFast }),
        }
        return answers
      }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  }
  return { form, asked }
}

const runInit = async (project: Project, form: InitForm) => {
  const organs = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer({ scout: { suites: [], stack: [], note: "" } }, []),
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
        flags: { force: false },
        form,
        scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
        machine: machineFor(project),
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

const writeRunner = (project: Project, path: string, text: string) => {
  mkdirSync(join(project.repo, "scripts"), { recursive: true })
  writeFileSync(join(project.repo, path), text)
  chmodSync(join(project.repo, path), 0o755)
}

/** Runs a runner with sh in the repository: its exit code and output. */
const runRunner = (project: Project, path: string) => {
  const ran = Bun.spawnSync(["sh", join(project.repo, path)], { cwd: project.repo })
  return { code: ran.exitCode, out: `${ran.stdout.toString()}${ran.stderr.toString()}` }
}

/** A check-fast.sh the project wrote, with a suite. */
const ours = "#!/bin/sh\nset -e\necho ours checked\n"

describe("check-full.sh beside a kept check-fast.sh", () => {
  test("create from scratch, check-fast.sh kept, no check-full.sh: check-full.sh runs it, and the checks pass", async () => {
    const project = newProject()
    writeRunner(project, "scripts/check-fast.sh", ours)
    const { form, asked } = scratchForm(false)
    const summary = await runInit(project, form)

    expect(asked[0]?.checks?.runners).toEqual({ fast: ours, full: null })
    expect(read(project, "scripts/check-fast.sh")).toBe(ours)
    const full = read(project, "scripts/check-full.sh")
    expect(checksNothing(full)).toBe(false)
    expect(runnerCommands(full)).toEqual(["scripts/check-fast.sh"])
    expect(lines(summary)).toContain("✓ check-full  wrote scripts/check-full.sh")
    for (const path of ["scripts/check-fast.sh", "scripts/check-full.sh"]) {
      const ran = runRunner(project, path)
      expect(ran.code).toBe(0)
      expect(ran.out).toContain("ours checked")
    }
  })

  test("the default answer, not asked, keeps check-fast.sh and check-full.sh runs it", async () => {
    const project = newProject()
    writeRunner(project, "scripts/check-fast.sh", ours)
    await runInit(project, scratchForm().form)

    expect(read(project, "scripts/check-fast.sh")).toBe(ours)
    expect(runnerCommands(read(project, "scripts/check-full.sh"))).toEqual([
      "scripts/check-fast.sh",
    ])
  })

  test("check-fast.sh replaced with one that checks nothing: check-full.sh checks nothing either", async () => {
    const project = newProject()
    writeRunner(project, "scripts/check-fast.sh", ours)
    await runInit(project, scratchForm(true).form)

    expect(checksNothing(read(project, "scripts/check-fast.sh"))).toBe(true)
    expect(checksNothing(read(project, "scripts/check-full.sh"))).toBe(true)
  })

  test("a kept check-fast.sh that runs nothing but exit 0: check-full.sh is exit 0", async () => {
    const project = newProject()
    writeRunner(project, "scripts/check-fast.sh", "#!/bin/sh\n# nothing yet\nexit 0\n")
    await runInit(project, scratchForm(false).form)

    expect(checksNothing(read(project, "scripts/check-full.sh"))).toBe(true)
  })
})

describe("whether check-full.sh differs beside a kept check-fast.sh", () => {
  test("init's exit 0 check-full.sh differs from what init writes beside a kept check-fast.sh", () => {
    const runners = { fast: ours, full: fullScript([], true) }
    expect(runnersDiffer(runners, { kind: "scratch" })).toEqual({ fast: true, full: true })
    expect(runnersDiffer(runners, { kind: "scratch" }, true)).toEqual({ fast: true, full: false })
  })

  test("a check-fast.sh runs nothing only where its commands are none but exit 0", () => {
    expect(runsNothing(fastScript([]))).toBe(true)
    expect(runsNothing("#!/bin/sh\n")).toBe(true)
    expect(runsNothing(ours)).toBe(false)
    expect(
      runsNothing(fastScript([{ name: "", command: "make", foundIn: "", serial: false }])),
    ).toBe(false)
  })
})
