// A worker checks its own change (§ 4.11, orchestra 0.9.0): the worker prompt's check section has it
// run the suites on what its change touches and leave the whole suite to the merge check, which
// tutti runs on every ticket. tutti init lists each suite there with the scout's command for part of
// the project (§ 6.3); checks.own (§ 8.4) names a worker's own check, which the check note gives in
// place of the merge check, and which footprints leave out as the other checks.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import fc from "fast-check"
import { workerOptions } from "../src/agent/options.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { type ChecksAnswers, suiteLines, suitesIntro, verifierSection } from "../src/init/checks.ts"
import { importSettings } from "../src/init/import.ts"
import { type InitForm, init } from "../src/init/init.ts"
import type { Suite } from "../src/init/runners.ts"
import { stepLine } from "../src/init/steps.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import {
  builtInWorkerPrompt,
  checkNote,
  unknownSuitesLines,
  withSuites,
} from "../src/project/prompt.ts"
import { checkCommands, Settings } from "../src/project/settings.ts"
import { repoFiles } from "../src/run/footprint.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"

const unit: Suite = {
  name: "unit tests",
  command: "bun test",
  targeted: "bun test <files>",
  foundIn: "package.json:7",
  serial: false,
}
const build: Suite = { name: "build", command: "bun run build", foundIn: "x:1", serial: false }
const lint: Suite = {
  name: "lint",
  command: "biome check .",
  targeted: "biome check <files>",
  foundIn: "x:2",
  serial: false,
}
const e2e: Suite = { name: "e2e", command: "playwright test", foundIn: "x:3", serial: true }
const typecheck: Suite = { name: "tsc", command: "tsc --noEmit", foundIn: "x:4", serial: false }

describe("the worker prompt's check section", () => {
  test("has a worker check its own change, and leaves the whole suite to tutti", () => {
    const prompt = builtInWorkerPrompt
    expect(prompt).toContain(
      "- Check your own change before you close the ticket: run the project's suites on what it touches\n" +
        "  (the modules or packages it changes and their tests, existing ones included), the slower suites\n" +
        "  too where they cover it, and lint and type checks on the files you changed. While iterating, run\n" +
        "  only the checks you need.\n" +
        unknownSuitesLines +
        "- Leave the whole suite to tutti: its merge check, `scripts/check-fast.sh`, runs on every ticket\n" +
        "  before it merges it, and hands the ticket back to you when your change breaks something you\n" +
        "  didn't consider; the full check, `scripts/check-full.sh`, runs every suite once at the end of a run.\n" +
        "- Run the checks in the foreground",
    )
    // No longer the whole merge check before closing.
    expect(prompt).not.toContain("Check your work with")
    expect(prompt).not.toContain("also run `scripts/check-full.sh`")
    expect(prompt).not.toContain("`scripts/check-fast.sh` passes")
    expect(prompt).toContain(
      "- Close the ticket only when your checks pass after your last change.",
    )
    expect(prompt).toContain("close the ticket once your checks pass, with a note naming the CI")
  })

  test("the verifier's section asks for it once the worker's own checks pass", () => {
    expect(verifierSection).toContain(
      "- Before you close the ticket, once your checks pass after your last commit, have the verifier\n",
    )
    expect(verifierSection).toContain("commit, run your\n  checks again, and ask it again")
    expect(verifierSection).not.toContain("scripts/check-fast.sh")
  })
})

describe("each suite on part of the project", () => {
  test("a bullet a suite: its command for part of the project, or whole, the serial ones left out", () => {
    expect(suiteLines([unit, build, e2e], [lint, typecheck])).toBe(
      suitesIntro +
        "  - unit tests: `bun test <files>`\n" +
        "  - build: `bun run build`, whole, as it doesn't run on part of the project\n" +
        "  - e2e: leave it to the merge check; two copies at once, in two worktrees, collide\n" +
        "  - lint (slower): `biome check <files>`\n" +
        "  - tsc (slower): `tsc --noEmit`, whole, where the change touches what it covers\n",
    )
  })

  test("a suite with no name is named by its command; one running a runner is left out", () => {
    const unnamed: Suite = {
      name: " ",
      command: "make test",
      foundIn: "--check-fast",
      serial: false,
    }
    const runner: Suite = { ...unit, command: "scripts/check-fast.sh" }
    expect(suiteLines([unnamed, runner], [])).toBe(
      `${suitesIntro}  - \`make test\`: whole, as it doesn't run on part of the project\n`,
    )
  })

  test("with no suites there are no lines, and the template's stay", () => {
    expect(suiteLines([], [])).toBe("")
    expect(withSuites(builtInWorkerPrompt, "")).toBe(builtInWorkerPrompt)
    const filled = withSuites(builtInWorkerPrompt, suiteLines([unit], []))
    expect(filled).not.toContain(unknownSuitesLines)
    expect(filled).toContain(
      "  only the checks you need.\n" +
        `${suitesIntro}  - unit tests: \`bun test <files>\`\n` +
        "- Leave the whole suite to tutti",
    )
  })

  test("the scout's words make one bullet a suite, on one line, whatever they hold", () => {
    const text = fc.string({ maxLength: 12 })
    const suite = fc.record({
      name: text,
      command: text.filter((s) => s.trim() !== "" && !s.includes("check-f")),
      targeted: fc.option(text, { nil: undefined }),
      foundIn: text,
      serial: fc.boolean(),
    })
    fc.assert(
      fc.property(fc.array(suite, { maxLength: 4 }), fc.array(suite, { maxLength: 4 }), (f, l) => {
        const kept = [...f, ...l].filter((each) => !/check-f(ast|ull)\.sh/.test(each.command))
        const lines = suiteLines(
          f.map(({ targeted, ...rest }) => (targeted === undefined ? rest : { ...rest, targeted })),
          l.map(({ targeted, ...rest }) => (targeted === undefined ? rest : { ...rest, targeted })),
        )
        if (kept.length === 0) return expect(lines).toBe("")
        const rows = lines.split("\n")
        expect(rows.at(-1)).toBe("")
        expect(rows.slice(1, -1)).toHaveLength(kept.length)
        for (const row of rows.slice(1, -1)) expect(row).toStartWith("  - ")
      }),
    )
  })
})

/** A temp repository (its top and git folder) and a home folder. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-own-check-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { repo, commonDir, home }
}

/** Runs init in a new project whose Checks step gives `answers`; gives the worker prompt and steps. */
const initWith = async (answers: ChecksAnswers, before: (repo: string) => void = () => {}) => {
  const project = newProject()
  before(project.repo)
  const form: InitForm = {
    workers: () => Effect.succeed({}),
    checks: () => Effect.succeed(answers),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  }
  const exit = await Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags: { force: false },
        form,
        scout: Effect.fail("not run: the form answers"),
        machine: {
          run: () => Effect.succeed(""),
          which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
          env: (name) => (name === "HOME" ? project.home : undefined),
          platform: "darwin",
          executable: () => false,
        },
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
  return {
    prompt: readFileSync(join(project.repo, ".tutti", "worker-prompt.md"), "utf8"),
    steps: exit.value.steps.map(stepLine),
  }
}

describe("tutti init's worker prompt", () => {
  const found: ChecksAnswers = {
    checks: { kind: "found", fast: [unit], full: [typecheck], fileUntested: false },
    verifier: false,
  }

  test("lists each suite the scout found with its command for part of the project", async () => {
    const { prompt, steps } = await initWith(found)
    expect(prompt).toBe(withSuites(builtInWorkerPrompt, suiteLines([unit], [typecheck])))
    expect(prompt).toContain("  - unit tests: `bun test <files>`\n")
    expect(steps).toContain(
      "✓ worker prompt  wrote .tutti/worker-prompt.md from the built-in template, with how to run each suite on part of the project",
    )
  })

  test("from scratch or manual, it says where the suites are", async () => {
    for (const checks of [
      { kind: "scratch" } as const,
      { kind: "manual", command: "make check" } as const,
    ]) {
      const { prompt } = await initWith({ checks, verifier: false })
      expect(prompt).toBe(builtInWorkerPrompt)
    }
  })

  test("a runner there that differs, and is kept, leaves the template's lines", async () => {
    const ours = (repo: string) => {
      mkdirSync(join(repo, "scripts"))
      writeFileSync(join(repo, "scripts", "check-fast.sh"), "#!/bin/sh\nmake ours\n")
    }
    expect((await initWith(found, ours)).prompt).toBe(builtInWorkerPrompt)
    expect((await initWith({ ...found, replaceFast: true }, ours)).prompt).toContain(
      "  - unit tests: `bun test <files>`\n",
    )
  })
})

/** A config whose checks have `own` and `fast` as their commands. */
const configWith = (own: string | null, fast: string | null): AppConfigValue => {
  const base = TestAppConfig.appConfig({}, "/work/project")
  const checks = base.settings.checks
  return {
    ...base,
    settings: {
      ...base.settings,
      checks: { ...checks, own: { command: own }, fast: { ...checks.fast, command: fast } },
    },
  }
}

/** The standing rules a worker on `bd-7` is given under `config`. */
const rules = (config: AppConfigValue): string => {
  const options = workerOptions({
    config,
    ticket: "bd-7",
    worktree: "/w",
    prompt: { text: "You work on TICKET_ID.", file: null },
    servers: { servers: [], note: null },
    skills: false,
    callbacks: {
      canUseTool: async () => ({ behavior: "allow" }),
      onElicitation: async () => ({ action: "decline" }),
      hooks: {},
      stderr: () => {},
    },
    session: { _tag: "New", sessionId: "s" },
    env: {},
    abortController: new AbortController(),
  })
  const system = options.systemPrompt
  if (typeof system !== "object" || Array.isArray(system) || system.type !== "preset") {
    throw new Error("not a preset system prompt")
  }
  return system.append ?? ""
}

describe("checks.own", () => {
  test("is none by default, and names a worker's own check", () => {
    const decode = (json: unknown) => {
      const exit = decodeConfig(Settings, "settings.json", json)
      if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
      return exit.value
    }
    expect(decode({}).checks.own).toEqual({ command: null })
    expect(decode({ checks: { own: { command: "scripts/check-own.sh" } } }).checks.own).toEqual({
      command: "scripts/check-own.sh",
    })
    expect(Exit.isFailure(decodeConfig(Settings, "s", { checks: { own: { command: "" } } }))).toBe(
      true,
    )
  })

  test("the check note gives it in place of the merge check", () => {
    expect(rules(configWith("scripts/check-own.sh", "scripts/check-fast.sh"))).toEndWith(
      checkNote("scripts/check-own.sh"),
    )
    expect(rules(configWith(null, "scripts/check-fast.sh"))).toEndWith(
      checkNote("scripts/check-fast.sh"),
    )
  })

  test("is a check command: its files are no ticket's in footprints", () => {
    const { settings } = configWith("scripts/check-own.sh", "scripts/check-fast.sh")
    const full = { ...settings.checks.full, command: "scripts/check-full.sh" }
    expect(checkCommands({ ...settings, checks: { ...settings.checks, full } })).toEqual([
      "scripts/check-fast.sh",
      "scripts/check-full.sh",
      "scripts/check-own.sh",
    ])
    const files = repoFiles(
      ["scripts/check-own.sh", "scripts/check-fast.sh", "src/a.ts"],
      checkCommands(settings),
    )
    expect(files.checks("scripts/check-own.sh")).toBe(true)
    expect(files.checks("src/a.ts")).toBe(false)
  })

  test("orchestra's check_own is imported to it", () => {
    const imported = importSettings({ check_own: "scripts/check-own.sh" })
    expect(imported.json).toEqual({ checks: { own: { command: "scripts/check-own.sh" } } })
    expect(imported.imported).toEqual([{ key: "check_own", to: "checks.own.command" }])
  })
})
