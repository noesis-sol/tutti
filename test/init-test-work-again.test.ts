// tutti init run again files a test-work ticket whose earlier one is closed only where it wrote or
// replaced a runner (§ 8.3, on purpose unlike orchestra): runners it left as they were are those
// the closed ticket saw to. init runs in a temp repository with a scripted form, as
// test/init-test-work-runners.test.ts does.
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
  scoutSearch,
  settleScout,
  setUpTestsTitle,
  testsEpicTitle,
  testWorkLabel,
} from "../src/init/checks.ts"
import { type InitForm, init } from "../src/init/init.ts"
import type { Suite } from "../src/init/runners.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"

const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-test-work-again-")))
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

const unit: Suite = {
  name: "unit tests",
  command: "npm test",
  foundIn: "package.json:7",
  serial: false,
}
const e2e: Suite = { name: "e2e", command: "npx playwright test", foundIn: "e2e/", serial: false }
const found: ChecksChoice = { kind: "found", fast: [unit], full: [e2e], fileUntested: false }
const scratch: ChecksChoice = { kind: "scratch" }

const machineFor = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

/** A Checks step choosing `choice`, keeping the runners there that differ from it unless `replace`. */
const formFor = (choice: ChecksChoice, replace: boolean): InitForm => ({
  workers: () => Effect.succeed({}),
  checks: (questions) =>
    Effect.gen(function* () {
      if (questions.checks !== null) {
        const result = yield* questions.checks.scout.pipe(
          Effect.match({
            onSuccess: (scouted) => ({ found: scouted }),
            onFailure: (failed) => ({ failed }),
          }),
        )
        settleScout(result, questions.checks.checkScript)
      }
      const answers: ChecksAnswers = {
        checks: choice,
        stack: [],
        verifier: false,
        replaceFast: replace,
        replaceFull: replace,
      }
      return answers
    }),
  trust: () => Effect.succeed(false),
  import: () => Effect.succeed(false),
})

/** Runs init in `project` choosing `choice`, on a backlog of `seeds`: its lines and the backlog. */
const runInit = async (
  project: Project,
  choice: ChecksChoice,
  seeds: ReadonlyArray<TestBeads.Seed>,
  replace = false,
) => {
  const organs = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer({ scout: { suites: [], stack: [], note: "" } }, []),
        TestAppConfig.layer(TestAppConfig.appConfig({})),
      ).pipe(Layer.provideMerge(logLayer())),
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
          form: formFor(choice, replace),
          scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
          machine: machineFor(project),
          configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
          account: TestAccount.layer(),
          claudeConfig: join(project.home, ".claude.json"),
        }),
      )
      if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
      const issues = yield* (yield* TestBeads.Backlog).issues
      return { lines: exit.value.steps.map(stepLine), issues }
    }).pipe(
      Effect.provide(RunLock.layer),
      Effect.provide(TestBeads.layer(seeds)),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
}

/** The backlog `issues` as seeds, each closed. */
const closedSeeds = (issues: ReadonlyArray<Issue>): ReadonlyArray<TestBeads.Seed> =>
  issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    type: issue.type,
    labels: issue.labels,
    status: "closed",
  }))

const titled = (issues: ReadonlyArray<Issue>, title: string) =>
  issues.filter((issue) => issue.title === title)

describe("init run again, after the test work is closed", () => {
  test("the suites found, runners unchanged: the closed pass ticket isn't filed again", async () => {
    const project = newProject()
    const first = await runInit(project, found, [])
    const pass = titled(first.issues, passRunnersTitle("main"))
    expect(pass).toHaveLength(1)

    const again = await runInit(project, found, closedSeeds(first.issues))
    expect(titled(again.issues, passRunnersTitle("main"))).toHaveLength(1)
    expect(again.issues.filter((issue) => issue.status !== "closed")).toEqual([])
    expect(again.lines).toContain(
      `• ticket  ${pass[0]?.id} is closed: ${passRunnersTitle("main")}; init changed no runner, so not filed again`,
    )
  })

  test("the suites found, a runner replaced: the pass ticket is filed again", async () => {
    const project = newProject()
    const first = await runInit(project, found, [])
    // The suites found differ now, and replacing the runner is chosen.
    const changed: ChecksChoice = { ...found, fast: [{ ...unit, command: "npm run test:unit" }] }

    const again = await runInit(project, changed, closedSeeds(first.issues), true)
    expect(again.lines).toContain("✓ check-fast  replaced scripts/check-fast.sh")
    const pass = titled(again.issues, passRunnersTitle("main"))
    expect(pass.map((issue) => issue.status)).toEqual(["closed", "open"])
  })

  test("from scratch, runners kept: neither the epic nor the set-up ticket is filed again", async () => {
    const project = newProject()
    writeRunner(project, "scripts/check-fast.sh", "#!/bin/sh\nset -e\nmake check\n")
    writeRunner(project, "scripts/check-full.sh", "#!/bin/sh\nset -e\nmake slow\n")
    const seeds: ReadonlyArray<TestBeads.Seed> = [
      {
        id: "app-1",
        title: testsEpicTitle,
        type: "epic",
        labels: [testWorkLabel],
        status: "closed",
      },
      {
        id: "app-2",
        title: setUpTestsTitle,
        labels: [testWorkLabel, "solo"],
        parent: "app-1",
        status: "closed",
      },
    ]

    const again = await runInit(project, scratch, seeds)
    expect(again.issues.map((issue) => issue.id)).toEqual([
      "app-1" as TicketId,
      "app-2" as TicketId,
    ])
    expect(again.lines).toContain(
      `• ticket  app-2 is closed: ${setUpTestsTitle}; init changed no runner, so not filed again`,
    )
  })

  test("from scratch, runners written: the closed set-up ticket is filed again", async () => {
    const project = newProject()
    const seeds: ReadonlyArray<TestBeads.Seed> = [
      { id: "app-2", title: setUpTestsTitle, labels: [testWorkLabel, "solo"], status: "closed" },
    ]

    const again = await runInit(project, scratch, seeds)
    const setUp = titled(again.issues, setUpTestsTitle)
    expect(setUp.map((issue) => issue.status)).toEqual(["closed", "open"])
  })
})
