// The queue's shared files (queue.shared_files, § 5 item 5, § 8.4): files nearly every ticket
// edits in place, as the features map, whose overlap holds no two tickets apart, though they stay
// in their footprints and their worktrees both changing one still warns LIKELY_CONFLICT. tutti init
// lists the features map create-check-suite writes as it files the test work. The init runs are
// test/init-test-work-runners.test.ts's: a temp repository with a scripted form.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Deferred, Effect, Exit, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import {
  type ChecksAnswers,
  type ChecksChoice,
  scoutSearch,
  settleScout,
} from "../src/init/checks.ts"
import { type InitForm, init } from "../src/init/init.ts"
import type { Machine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import { planLinks } from "../src/plan/plan.ts"
import { readSettings } from "../src/project/settings.ts"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { type FootprintTicket, ticketFootprint } from "../src/run/footprint.ts"
import { settingsGlobMatch } from "../src/run/glob.ts"
import { overlapHold } from "../src/run/holds.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Footprints, make } from "../src/run/schedule.ts"
import type { Issue } from "../src/services/Beads.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"

const tracked = [
  "test/FEATURES.md",
  "test/loop.test.ts",
  "docs/guide.md",
  "docs/api/index.md",
  "src/a.ts",
  "src/b.ts",
]

/** A ticket with this description and nothing else. */
const ticket = (description: string): FootprintTicket => ({
  title: "",
  description,
  design: "",
  acceptance: "",
  labels: [],
  metadata: {},
  files: [],
  predictedFiles: [],
})

/** Whether a ticket described so is held back for one running described so, and why. */
const heldFor = (shared: ReadonlyArray<string>, mine: string, running: string) => {
  const repo = repoFiles(tracked, [], [], shared)
  return overlapHold(
    ticketFootprint(ticket(mine), repo),
    new Map([["t-1", ticketFootprint(ticket(running), repo)]]),
    undefined,
    (file) => !repo.shared(file),
  )?.text
}

describe("a shared file", () => {
  test("two tickets overlapping only in one aren't held apart", () => {
    const mine = "Map the export in test/FEATURES.md and change src/a.ts."
    const running = "Map the import in test/FEATURES.md and change src/b.ts."
    expect(heldFor(["test/FEATURES.md"], mine, running)).toBeUndefined()
  })

  test("by default none is shared: the same tickets are held apart", () => {
    const mine = "Map the export in test/FEATURES.md and change src/a.ts."
    const running = "Map the import in test/FEATURES.md and change src/b.ts."
    expect(heldFor([], mine, running)).toBe("touches test/FEATURES.md, like running t-1")
  })

  test("a ticket overlapping in a shared file and another file is held back over the other", () => {
    const mine = "Map the export in test/FEATURES.md and change src/a.ts."
    const running = "Map the import in test/FEATURES.md and change src/a.ts."
    expect(heldFor(["test/FEATURES.md"], mine, running)).toBe("touches src/a.ts, like running t-1")
  })

  test("stays in the footprint, for the log", () => {
    const repo = repoFiles(tracked, [], [], ["test/FEATURES.md"])
    expect(ticketFootprint(ticket("Update test/FEATURES.md."), repo).files).toEqual([
      "test/FEATURES.md",
    ])
  })

  test("is matched by a glob, by its path, or by its name in any folder", () => {
    const docs = "Update docs/guide.md and src/a.ts."
    const otherDocs = "Update docs/guide.md and src/b.ts."
    expect(heldFor(["docs/*.md"], docs, otherDocs)).toBeUndefined()
    expect(heldFor(["docs/**"], docs, otherDocs)).toBeUndefined()
    expect(heldFor(["guide.md"], docs, otherDocs)).toBeUndefined()
    expect(heldFor(["/guide.md"], docs, otherDocs)).toBe("touches docs/guide.md, like running t-1")
    expect(heldFor(["src/*.md"], docs, otherDocs)).toBe("touches docs/guide.md, like running t-1")

    const repo = repoFiles(tracked, [], [], ["docs/*.md", "FEATURES.md"])
    expect(repo.shared("docs/guide.md")).toBe(true)
    expect(repo.shared("docs/api/index.md")).toBe(false)
    expect(repo.shared("test/FEATURES.md")).toBe(true)
    expect(repo.shared("FEATURES.md")).toBe(true)
    expect(repo.shared("docs/")).toBe(false)
    expect(settingsGlobMatch("docs/**/*.md", "docs/api/index.md")).toBe(true)
  })

  test("a folder holding one still holds tickets apart over its other files", () => {
    const repo = repoFiles(tracked, [], [], ["test/FEATURES.md"])
    const folder = ticketFootprint({ ...ticket("Rework the tests."), files: ["test/"] }, repo)
    const map = ticketFootprint(ticket("Update test/FEATURES.md."), repo)
    const loop = ticketFootprint(ticket("Fix test/loop.test.ts."), repo)
    const apart = (file: string) => !repo.shared(file)
    expect(overlapHold(map, new Map([["t-1", folder]]), undefined, apart)).toBeUndefined()
    expect(overlapHold(loop, new Map([["t-1", folder]]), undefined, apart)?.text).toBe(
      "touches test/loop.test.ts, like running t-1",
    )
  })

  test("links nothing in tutti plan", () => {
    const open = ["a", "b"].map(
      (id, i): Issue => ({
        id,
        title: id,
        description: "Keep test/FEATURES.md current.",
        design: "",
        acceptance: "",
        notes: "",
        status: "open",
        priority: i + 1,
        type: "task",
        assignee: "",
        labels: [],
        dependencies: [],
        metadata: {},
        files: [],
        predictedFiles: [],
        createdAt: "2026-10-01T00:00:00Z",
        closeReason: "",
      }),
    )
    expect(
      planLinks(open, [], repoFiles(tracked, [], [], ["test/FEATURES.md"]), () => "\n"),
    ).toEqual([])
    expect(planLinks(open, [], repoFiles(tracked), () => "\n").length).toBe(1)
  })
})

describe("the scheduler", () => {
  /** Two fills of a 2-slot scheduler, `shared` the shared files: the tickets started, and the log. */
  const twoFills = (seeds: ReadonlyArray<Seed>, shared: ReadonlyArray<string>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const started = yield* Ref.make<ReadonlyArray<string>>([])
        const footprints: Footprints = {
          repo: Effect.succeed(repoFiles(tracked, [], [], shared)),
          changed: () => Effect.succeed(["test/FEATURES.md"]),
          mentions: () => Effect.succeed(() => false),
        }
        const schedule = yield* make({
          concurrent: 2,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          footprints,
          start: {
            start: (issue: Issue) =>
              Effect.andThen(
                Ref.update(started, (all) => [...all, issue.id]),
                Deferred.await(gate),
              ),
          },
        })
        yield* schedule.fill
        yield* schedule.fill
        yield* schedule.fill
        return [yield* Ref.get(started), yield* texts] as const
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )

  const seeds: ReadonlyArray<Seed> = [
    { id: "t-1", priority: 0, description: "Map src/a.ts in test/FEATURES.md." },
    { id: "t-2", priority: 1, description: "Map src/b.ts in test/FEATURES.md." },
  ]

  test("starts two tickets sharing only a shared file side by side, still warning", async () => {
    const [started, lines] = await twoFills(seeds, ["test/FEATURES.md"])
    expect(started).toEqual(["t-1", "t-2"])
    expect(lines.some((line) => line.includes("skipping t-2"))).toBe(false)
    expect(lines).toContain("  t-2 footprint: src/b.ts, test/FEATURES.md")
    expect(lines).toContain(
      "  LIKELY_CONFLICT: t-1 and t-2 both edit test/FEATURES.md; the second to merge may conflict",
    )
  })

  test("holds the second back when the file isn't shared", async () => {
    const [started, lines] = await twoFills(seeds, [])
    expect(started).toEqual(["t-1"])
    expect(lines).toContain("  skipping t-2: touches test/FEATURES.md, like running t-1")
  })
})

describe("the setting", () => {
  test("is empty by default", async () => {
    const settings = await Effect.runPromise(
      readSettings(newProject().repo).pipe(Effect.provide(BunServices.layer)),
    )
    expect(settings.queue.shared_files).toEqual([])
  })
})

// --- tutti init ---

const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-shared-files-")))
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

/** A Checks step choosing `choice`. */
const formFor = (choice: ChecksChoice): InitForm => ({
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
      const answers: ChecksAnswers = { checks: choice, stack: [], verifier: false }
      return answers
    }),
  trust: () => Effect.succeed(false),
  import: () => Effect.succeed(false),
})

/** Runs init in `project` choosing `choice`: the settings file it leaves, as JSON. */
const runInit = async (project: Project, choice: ChecksChoice) => {
  const organs = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer({ scout: { suites: [], stack: [], note: "" } }, []),
        TestAppConfig.layer(TestAppConfig.appConfig({})),
      ).pipe(Layer.provideMerge(logLayer())),
    ),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        init({
          repo: project.repo,
          commonDir: project.commonDir,
          branch: "main",
          version: "0.1.0",
          flags: { force: false },
          form: formFor(choice),
          scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
          machine: machineFor(project),
          configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
          account: TestAccount.layer(),
          claudeConfig: join(project.home, ".claude.json"),
        }),
      )
      if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
    }).pipe(
      Effect.provide(RunLock.layer),
      Effect.provide(TestBeads.layer([])),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
  return JSON.parse(readFileSync(join(project.repo, ".tutti", "settings.json"), "utf8"))
}

const sharedFilesOf = (settings: { queue?: { shared_files?: unknown } }) =>
  settings.queue?.shared_files

const scratch: ChecksChoice = { kind: "scratch" }
const manual: ChecksChoice = { kind: "manual", command: "make check" }

describe("tutti init", () => {
  test("lists the features map in the test folder as it files the test work", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, "test"))
    expect(sharedFilesOf(await runInit(project, scratch))).toEqual(["test/FEATURES.md"])
  })

  test("lists the map where the project has it, else its name, matching it in any folder", async () => {
    const there = newProject()
    mkdirSync(join(there.repo, "test"))
    mkdirSync(join(there.repo, "e2e"))
    writeFileSync(join(there.repo, "e2e", "FEATURES.md"), "# Features\n")
    expect(sharedFilesOf(await runInit(there, scratch))).toEqual(["e2e/FEATURES.md"])

    const bare = newProject()
    expect(sharedFilesOf(await runInit(bare, scratch))).toEqual(["FEATURES.md"])
  })

  test("keeps the shared files there, adding the map only where none matches it", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, "test"))
    mkdirSync(join(project.repo, ".tutti"))
    const write = (shared: ReadonlyArray<string>) =>
      writeFileSync(
        join(project.repo, ".tutti", "settings.json"),
        `${JSON.stringify({ version: 1, queue: { shared_files: shared } }, null, 2)}\n`,
      )
    write(["docs/*.md"])
    expect(sharedFilesOf(await runInit(project, scratch))).toEqual([
      "docs/*.md",
      "test/FEATURES.md",
    ])
    write(["FEATURES.md"])
    expect(sharedFilesOf(await runInit(project, scratch))).toEqual(["FEATURES.md"])
  })

  test("without test work, lists a map the project has only where it names no shared files", async () => {
    const project = newProject()
    expect(sharedFilesOf(await runInit(project, manual))).toBeUndefined()

    mkdirSync(join(project.repo, "test"))
    writeFileSync(join(project.repo, "test", "FEATURES.md"), "# Features\n")
    expect(sharedFilesOf(await runInit(project, manual))).toEqual(["test/FEATURES.md"])

    writeFileSync(
      join(project.repo, ".tutti", "settings.json"),
      `${JSON.stringify({ version: 1, queue: { shared_files: [] } }, null, 2)}\n`,
    )
    expect(sharedFilesOf(await runInit(project, manual))).toEqual([])
  })
})
