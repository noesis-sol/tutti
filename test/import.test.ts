// tutti init's import from orchestra (§ 8.3): orchestra 0.7.7's settings mapped to tutti's, the keys
// it can't import named, the changes § 4.11 needs in an imported worker prompt listed, and
// .orchestra/ left as it is. The fixture, test/fixtures/orchestra-project/, is an orchestra project's
// .orchestra/ with every key tutti understands, two it doesn't, and a prompt with the project's
// changes; init runs on a copy of it in a temp repository, as test/init.test.ts runs it.
import { describe, expect, test } from "bun:test"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Duration, Effect, Exit } from "effect"
import fc from "fast-check"
import {
  type ImportOffer,
  importSettings,
  offerDescription,
  promptChanges,
} from "../src/init/import.ts"
import { type InitFlags, type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import type { WorkersQuestions } from "../src/init/workers.ts"
import { decodeConfig, readConfigFile } from "../src/project/configFile.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { Settings } from "../src/project/settings.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"

const fixture = resolve(import.meta.dir, "fixtures/orchestra-project")
const fixtureSettings = JSON.parse(
  readFileSync(join(fixture, ".orchestra/settings.json"), "utf8"),
) as Record<string, unknown>
const fixturePrompt = readFileSync(join(fixture, ".orchestra/worker-prompt.md"), "utf8")

describe("orchestra's settings, imported", () => {
  test("each understood key goes to tutti's, and the rest are named", () => {
    const imported = importSettings(fixtureSettings)
    expect(imported.json).toEqual({
      checks: {
        fast: { command: "scripts/check.sh", timeout: "15m" },
        full: { command: "scripts/check-all.sh", timeout: "1h30m" },
        setup: { command: "npm ci", files: ["package-lock.json"] },
      },
      concurrent: 3,
      workers: { ticket_limit: "2h", mcp_servers: ["postgres"], effort: "high" },
      organs: { effort: "low" },
      queue: { exclude_types: ["epic", "chore"], footprint: false },
      merge: { resolve_conflicts: false, resolve_timeout: "10m", check_hand_backs: 1 },
      environment_hold: { count: 3, window: "5m", probe: "0" },
    })
    expect(Object.fromEntries(imported.imported.map((each) => [each.key, each.to]))).toEqual({
      check_fast: "checks.fast.command",
      check_full: "checks.full.command",
      check_fast_timeout: "checks.fast.timeout",
      check_full_timeout: "checks.full.timeout",
      concurrent: "concurrent",
      ticket_limit: "workers.ticket_limit",
      setup: "checks.setup.command",
      setup_files: "checks.setup.files",
      exclude_types: "queue.exclude_types",
      footprint: "queue.footprint",
      resolve_conflicts: "merge.resolve_conflicts",
      resolve_timeout: "merge.resolve_timeout",
      check_hand_backs: "merge.check_hand_backs",
      "environment_hold.count": "environment_hold.count",
      "environment_hold.window": "environment_hold.window",
      "environment_hold.probe": "environment_hold.probe",
      mcp_servers: "workers.mcp_servers",
      worker_effort: "workers.effort",
      organ_effort: "organs.effort",
    })
    expect(imported.leftOut).toEqual([
      {
        key: "environment_hold.notify (true)",
        why: "not an orchestra setting tutti knows",
      },
      { key: 'terminal ("tmux")', why: "tutti has no terminals; its workers run inside it" },
      { key: 'agent_kind ("codex")', why: "not an orchestra setting tutti knows" },
    ])
    expect(imported.mcpUnset).toBe(false)
    expect(Exit.isSuccess(decodeConfig(Settings, "settings.json", imported.json))).toBe(true)
  })

  test("orchestra's old names are read as the new ones, unless those are set", () => {
    expect(importSettings({ check: "make check", check_timeout: "5m" }).json).toEqual({
      checks: { fast: { command: "make check", timeout: "5m" } },
    })
    const both = importSettings({ check: "make check", check_fast: "scripts/check-fast.sh" })
    expect(both.json).toEqual({ checks: { fast: { command: "scripts/check-fast.sh" } } })
    expect(both.leftOut).toEqual([
      { key: 'check ("make check")', why: "orchestra's old name for check_fast, set too" },
    ])
  })

  test("orchestra's unset values are skipped, and its ticket limit 0 is none", () => {
    const imported = importSettings({
      concurrent: 0,
      check_fast: "",
      setup: "",
      ticket_limit: "0",
      environment_hold: { window: "" },
      mcp_servers: [],
    })
    expect(imported.json).toEqual({ workers: { ticket_limit: null, mcp_servers: [] } })
    expect(imported.leftOut).toEqual([])
  })

  test("a value tutti's settings can't take is named with why", () => {
    const imported = importSettings({
      concurrent: 20,
      check_fast_timeout: "soon",
      worker_effort: "huge",
      exclude_types: ["epic,chore"],
      environment_hold: "off",
      footprint: true,
    })
    expect(imported.json).toEqual({ queue: { footprint: true } })
    expect(imported.leftOut.map((each) => each.key)).toEqual([
      "concurrent (20)",
      'check_fast_timeout ("soon")',
      'worker_effort ("huge")',
      'exclude_types (["epic,chore"])',
      'environment_hold ("off")',
    ])
    for (const each of imported.leftOut.slice(0, 4)) {
      expect(each.why).toStartWith("tutti can't take it: ")
    }
    expect(imported.leftOut[0]?.why).toContain("concurrent")
  })

  test("settings without mcp_servers say so, since orchestra then gives every server", () => {
    expect(importSettings({ concurrent: 2 }).mcpUnset).toBe(true)
  })

  test("settings that aren't an object import nothing, and say so", () => {
    expect(importSettings([1, 2]).leftOut).toEqual([
      { key: ".orchestra/settings.json", why: "isn't a JSON object" },
    ])
  })

  test("any JSON object: each key imported, named or unset, and the import decodes", () => {
    const keys = [
      ...Object.keys(fixtureSettings),
      "check",
      "check_timeout",
      "environment_hold",
      "unknown",
      "constructor",
      "__proto__",
    ]
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...keys), fc.jsonValue(), { maxKeys: 8 }),
        (orchestra) => {
          const imported = importSettings(orchestra)
          expect(Exit.isSuccess(decodeConfig(Settings, "settings.json", imported.json))).toBe(true)
          const named = imported.leftOut.map((each) => each.key.split(/[ .]/)[0] ?? "")
          const taken = imported.imported.map((each) => each.key.split(".")[0] ?? "")
          for (const key of [...named, ...taken]) expect(Object.keys(orchestra)).toContain(key)
        },
      ),
    )
  })
})

describe("an imported worker prompt's changes", () => {
  test("lists the tabs, .orchestra paths, wt/ branches, the time and --ticket lines", () => {
    const changes = promptChanges(fixturePrompt)
    const on = (line: number) =>
      changes.filter((each) => each.line === line).map((each) => each.change)
    expect(on(3)).toEqual(["wt/<id> is tutti/<id>: tutti's branches"])
    expect(on(4)).toEqual(["the orchestrator is tutti"])
    expect(on(9)).toEqual(["tutti has no tabs or terminals: its workers run inside it"])
    expect(on(10)).toEqual([".orchestra/ is .tutti/ for tutti"])
    expect(on(14)).toEqual([
      "the orchestrator is tutti",
      expect.stringMatching(/^checks in the foreground have tutti's reason/),
    ])
    expect(on(22)).toEqual([
      expect.stringMatching(/^a removal the safety check holds has tutti's reason/),
    ])
    expect(on(79)).toEqual(["the time a worker has goes in its first message, so remove it"])
    expect(on(81)).toEqual([
      "the orchestrator is tutti",
      "the --ticket line goes in the first message, so remove it",
    ])
    expect(changes.filter((each) => each.line === null).map((each) => each.change)).toEqual([
      expect.stringMatching(/^questions: /),
      expect.stringMatching(/^working unattended: /),
    ])
  })

  test("tutti's own prompt needs none, and a prompt without TICKET_ID needs it", () => {
    expect(promptChanges(builtInWorkerPrompt)).toEqual([])
    expect(promptChanges("Work on the ticket.\n").map((each) => each.change)).toContain(
      "add TICKET_ID, which tutti replaces with the ticket's ID",
    )
  })

  test("any text: each change is on one of its lines", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const count = text.split("\n").length
        for (const each of promptChanges(text)) {
          if (each.line !== null) {
            expect(each.line).toBeGreaterThanOrEqual(1)
            expect(each.line).toBeLessThanOrEqual(count)
          }
        }
      }),
    )
  })
})

/** A temp repository with a copy of the fixture's .orchestra/, and a home for Claude Code's config. */
const newProject = (orchestra = true) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-import-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  if (orchestra) cpSync(join(fixture, ".orchestra"), join(repo, ".orchestra"), { recursive: true })
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** Every file under `dir` with its text, by path. */
const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name)
        return [path, readFileSync(path, "utf8")]
      }),
  )

/** A form answering the import offer with `yes`; the offers and Workers questions it got. */
const scriptedForm = (yes: boolean) => {
  const offers: Array<ImportOffer> = []
  const asked: Array<WorkersQuestions> = []
  const form: InitForm = {
    workers: (questions) =>
      Effect.sync(() => {
        asked.push(questions)
        return {}
      }),
    trust: () => Effect.succeed(false),
    import: (offer) =>
      Effect.sync(() => {
        offers.push(offer)
        return yes
      }),
  }
  return { form, offers, asked }
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

const read = (project: Project, path: string) => readFileSync(join(project.repo, path), "utf8")

const readSettings = (project: Project) =>
  Effect.runPromise(
    readConfigFile(Settings, join(project.repo, ".tutti", "settings.json")).pipe(
      Effect.provide(BunServices.layer),
    ),
  )

describe("init's import", () => {
  test("imports the settings and the prompt, lists its changes, and leaves .orchestra/", async () => {
    const project = newProject()
    const before = snapshot(join(project.repo, ".orchestra"))
    const { form, offers, asked } = scriptedForm(true)
    const summary = await runInit(project, form)

    expect(offers).toHaveLength(1)
    expect(offers[0]?.imports).toContain("concurrent")
    expect(offers[0]?.imports).toContain("the worker prompt")
    expect(offers[0]?.leftOut).toContain(
      'terminal ("tmux"): tutti has no terminals; its workers run inside it',
    )
    expect(offerDescription(offers[0] as ImportOffer)).toContain(".orchestra/ is left as it is.")
    // The Workers step starts from the imported settings.
    expect(asked[0]?.concurrent?.initial).toBe(3)

    const settings = await readSettings(project)
    expect(settings.concurrent).toBe(3)
    expect(settings.checks.fast.command).toBe("scripts/check.sh")
    expect(Duration.toMinutes(settings.checks.full.timeout)).toBe(90)
    expect(settings.checks.setup).toEqual({ command: "npm ci", files: ["package-lock.json"] })
    expect(settings.workers.mcp_servers).toEqual(["postgres"])
    expect(settings.queue).toEqual({ exclude_types: ["epic", "chore"], footprint: false })
    expect(settings.merge.check_hand_backs).toBe(1)
    expect(settings.environment_hold.count).toBe(3)
    expect(read(project, ".tutti/worker-prompt.md")).toBe(fixturePrompt)

    const lines = summary.steps.map(stepLine)
    expect(lines.find((line) => line.startsWith("✓ import"))).toContain(
      "from .orchestra/settings.json; .orchestra/ is left as it is",
    )
    expect(lines).toContain(
      '! import  not imported: terminal ("tmux"): tutti has no terminals; its workers run inside it',
    )
    expect(lines).toContain(
      '! import  not imported: agent_kind ("codex"): not an orchestra setting tutti knows',
    )
    expect(lines).toContain(
      "✓ worker prompt  imported .orchestra/worker-prompt.md to .tutti/worker-prompt.md, with your changes",
    )
    expect(lines).toContain(
      "! worker prompt  .tutti/worker-prompt.md:3: wt/<id> is tutti/<id>: tutti's branches",
    )
    expect(lines).toContain(
      "! worker prompt  .tutti/worker-prompt.md:79: the time a worker has goes in its first message, so remove it",
    )
    expect(summary.next).toContain("Make the changes to .tutti/worker-prompt.md listed above.")

    expect(snapshot(join(project.repo, ".orchestra"))).toEqual(before)
  })

  test("the flags win over what it imports", async () => {
    const project = newProject()
    await runInit(project, scriptedForm(true).form, {
      force: false,
      concurrent: 5,
      checkFastTimeout: Duration.minutes(7),
    })
    const settings = await readSettings(project)
    expect(settings.concurrent).toBe(5)
    expect(Duration.toMinutes(settings.checks.fast.timeout)).toBe(7)
    expect(settings.checks.fast.command).toBe("scripts/check.sh")
  })

  test("declined, it writes tutti's own and leaves .orchestra/", async () => {
    const project = newProject()
    const before = snapshot(join(project.repo, ".orchestra"))
    const summary = await runInit(project, scriptedForm(false).form)
    expect((await readSettings(project)).concurrent).toBe(1)
    expect(read(project, ".tutti/worker-prompt.md")).toBe(builtInWorkerPrompt)
    expect(summary.steps.map(stepLine)).toContain(
      "• import  not imported (declined); .orchestra/ is left as it is",
    )
    expect(snapshot(join(project.repo, ".orchestra"))).toEqual(before)
  })

  test("without a terminal it isn't asked, and imports nothing", async () => {
    const project = newProject()
    const summary = await runInit(project, null)
    expect(read(project, ".tutti/worker-prompt.md")).toBe(builtInWorkerPrompt)
    expect(summary.steps.map(stepLine).find((line) => line.startsWith("! import"))).toContain(
      "not asked (no terminal)",
    )
  })

  test("isn't offered where .tutti/ is there, or there's no .orchestra/", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, ".tutti"))
    writeFileSync(join(project.repo, ".tutti/settings.json"), "{}")
    const { form, offers } = scriptedForm(true)
    const summary = await runInit(project, form)
    expect(offers).toEqual([])
    expect(summary.steps.some((each) => each.label === "import")).toBe(false)

    const bare = newProject(false)
    const offered = scriptedForm(true)
    await runInit(bare, offered.form)
    expect(offered.offers).toEqual([])
    expect(existsSync(join(bare.repo, ".orchestra"))).toBe(false)
  })
})
