// tutti init's test-work tickets say what the runners on disk do once init has written them
// (§ 8.3): 'create from scratch' with a check-fast.sh kept doesn't say the runners check nothing,
// and the suites found with a runner kept don't say init wrote it from them. The runners are read
// with readRunners; init runs in a temp repository with a scripted form, as
// test/init-kept-fast-check.test.ts does.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import {
  type ChecksAnswers,
  type ChecksChoice,
  passRunnersTitle,
  readRunners,
  scoutSearch,
  settleScout,
  setUpTestsTitle,
  testWork,
} from "../src/init/checks.ts"
import { type InitForm, init } from "../src/init/init.ts"
import { fastScript, fullScript, type Suite } from "../src/init/runners.ts"
import type { Machine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"

const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-test-work-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

const writeRunner = (project: Project, path: string, text: string) => {
  mkdirSync(join(project.repo, "scripts"), { recursive: true })
  writeFileSync(join(project.repo, path), text)
  chmodSync(join(project.repo, path), 0o755)
}

/** A check-fast.sh the project wrote, with a suite. */
const ours = "#!/bin/sh\nset -e\necho ours checked\n"

const unit: Suite = {
  name: "unit tests",
  command: "npm test",
  foundIn: "package.json:7",
  serial: false,
}
const e2e: Suite = { name: "e2e", command: "npx playwright test", foundIn: "e2e/", serial: false }
const found: ChecksChoice = { kind: "found", fast: [unit], full: [e2e], fileUntested: false }
const scratch: ChecksChoice = { kind: "scratch" }

const read = (project: Project, choice: ChecksChoice) =>
  Effect.runPromise(readRunners(project.repo, choice).pipe(Effect.provide(BunServices.layer)))

/** The description of the ticket `choice` files that the runners concern, the runners as `onDisk`. */
const described = (choice: ChecksChoice, onDisk: Parameters<typeof testWork>[2]) =>
  testWork(choice, "main", onDisk).find(
    (ticket) => ticket.title === setUpTestsTitle || ticket.title === passRunnersTitle("main"),
  )?.description ?? ""

describe("what the test-work tickets say of the runners", () => {
  test("from scratch, both checking nothing: nothing merged is checked until the ticket is done", () => {
    expect(described(scratch, { fast: "nothing", full: "nothing" })).toStartWith(
      "tutti init wrote scripts/check-fast.sh and scripts/check-full.sh checking nothing (exit 0): until this ticket is done, nothing merged is checked. It runs first and alone",
    )
    // As init writes them where none were there, by default.
    expect(described(scratch, undefined)).toBe(
      described(scratch, { fast: "nothing", full: "nothing" }),
    )
  })

  test("from scratch, check-fast.sh kept: both run the project's checks, and merges are checked", () => {
    const text = described(scratch, { fast: "own", full: "own" })
    expect(text).toStartWith(
      "scripts/check-fast.sh and scripts/check-full.sh run the checks the project had. It runs first and alone",
    )
    expect(text).not.toContain("checking nothing")
    expect(text).not.toContain("nothing merged is checked")
  })

  test("from scratch, only check-full.sh checks: nothing merged is checked", () => {
    expect(described(scratch, { fast: "nothing", full: "own" })).toStartWith(
      "tutti init wrote scripts/check-fast.sh checking nothing (exit 0); scripts/check-full.sh runs the checks the project had: until this ticket is done, nothing merged is checked.",
    )
  })

  test("suites found, both written from them: init wrote them from the suites", () => {
    expect(described(found, { fast: "suites", full: "suites" })).toStartWith(
      "tutti init wrote scripts/check-fast.sh and scripts/check-full.sh from the suites the project has. Every merge runs scripts/check-fast.sh",
    )
    expect(described(found, undefined)).toBe(described(found, { fast: "suites", full: "suites" }))
  })

  test("suites found, both kept: init doesn't say it wrote them", () => {
    const text = described(found, { fast: "own", full: "own" })
    expect(text).toStartWith(
      "scripts/check-fast.sh and scripts/check-full.sh run the checks the project had. Every merge runs scripts/check-fast.sh",
    )
    expect(text).not.toContain("tutti init wrote")
  })

  test("suites found, check-fast.sh kept: init wrote only check-full.sh", () => {
    expect(described(found, { fast: "own", full: "suites" })).toStartWith(
      "tutti init wrote scripts/check-full.sh from the suites the project has; scripts/check-fast.sh runs the checks the project had. Every merge",
    )
  })
})

describe("readRunners", () => {
  test("no runners, or runners running nothing but exit 0, check nothing", async () => {
    const project = newProject()
    expect(await read(project, scratch)).toEqual({ fast: "nothing", full: "nothing" })
    writeRunner(project, "scripts/check-fast.sh", fastScript([]))
    writeRunner(project, "scripts/check-full.sh", fullScript([], true))
    expect(await read(project, scratch)).toEqual({ fast: "nothing", full: "nothing" })
  })

  test("a kept check-fast.sh and a check-full.sh running it are the project's own", async () => {
    const project = newProject()
    writeRunner(project, "scripts/check-fast.sh", ours)
    writeRunner(project, "scripts/check-full.sh", fullScript([], false))
    expect(await read(project, scratch)).toEqual({ fast: "own", full: "own" })
  })

  test("runners as init writes them from the suites found are the suites'", async () => {
    const project = newProject()
    writeRunner(project, "scripts/check-fast.sh", fastScript([unit]))
    writeRunner(project, "scripts/check-full.sh", fullScript([e2e], false))
    expect(await read(project, found)).toEqual({ fast: "suites", full: "suites" })
    writeRunner(project, "scripts/check-fast.sh", ours)
    expect(await read(project, found)).toEqual({ fast: "own", full: "suites" })
  })
})

const machineFor = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

/** A Checks step choosing 'create from scratch', keeping the runners there. */
const scratchForm: InitForm = {
  workers: () => Effect.succeed({}),
  checks: (questions) =>
    Effect.gen(function* () {
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
        replaceFast: false,
      }
      return answers
    }),
  trust: () => Effect.succeed(false),
  import: () => Effect.succeed(false),
}

/** Runs init in `project` with the form `scratchForm`: the backlog afterwards. */
const runInit = async (project: Project) => {
  const organs = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer({ scout: { suites: [], stack: [], note: "" } }, []),
        TestAppConfig.layer(TestAppConfig.appConfig({})),
        logLayer(),
      ),
    ),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        init({
          repo: project.repo,
          commonDir: project.commonDir,
          branch: "main",
          version: "0.1.0",
          flags: { force: false },
          form: scratchForm,
          scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
          machine: machineFor(project),
          configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
          account: TestAccount.layer(),
          claudeConfig: join(project.home, ".claude.json"),
        }),
      )
      if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
      return yield* (yield* TestBeads.Backlog).issues
    }).pipe(
      Effect.provide(RunLock.layer),
      Effect.provide(TestBeads.layer([])),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
}

describe("init's set-up ticket", () => {
  test("create from scratch with check-fast.sh kept: the ticket says the runners check", async () => {
    const project = newProject()
    writeRunner(project, "scripts/check-fast.sh", ours)
    const issues = await runInit(project)

    const setUp = issues.find((issue) => issue.title === setUpTestsTitle)
    expect(setUp?.description).toStartWith(
      "scripts/check-fast.sh and scripts/check-full.sh run the checks the project had.",
    )
    expect(setUp?.description).not.toContain("nothing merged is checked")
  })

  test("create from scratch with no runners: the ticket says nothing merged is checked", async () => {
    const project = newProject()
    const issues = await runInit(project)

    const setUp = issues.find((issue) => issue.title === setUpTestsTitle)
    expect(setUp?.description).toStartWith(
      "tutti init wrote scripts/check-fast.sh and scripts/check-full.sh checking nothing (exit 0): until this ticket is done, nothing merged is checked.",
    )
  })
})
