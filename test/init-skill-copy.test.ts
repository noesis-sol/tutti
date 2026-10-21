// tutti init with a copy of the create-check-suite skill already in the project (§ 8.3, § 6.3): the
// same copy is kept as it is; one that differs is kept unless replacing it is chosen, which the
// Checks step asks only then. Init runs in a temp repository with a scripted form and machine, as
// test/init-checks.test.ts has them.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import { type ChecksQuestions, type SkillState, skillPath, skillText } from "../src/init/checks.ts"
import { type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import type { Scouting } from "../src/organs/scout.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

/** What the scout found: no suites, unless given. */
const scouting = (over: Partial<Scouting> = {}): Scouting => ({
  suites: [],
  stack: [],
  note: "",
  ...over,
})

const ours = "---\nname: create-check-suite\n---\nOur own way of setting up the tests.\n"

/** A temp repository with `copy` as its skill's copy, if given, and a home folder. */
const newProject = (copy?: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-skill-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  if (copy !== undefined) {
    mkdirSync(dirname(join(repo, skillPath)), { recursive: true })
    writeFileSync(join(repo, skillPath), copy)
  }
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** bd on the PATH, every command answered with "". */
const machineOf = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

/** Checks created from scratch, which files test work, the skill's copy replaced if `replace`. */
const scratchForm = (replace?: boolean) => {
  const asked: Array<SkillState | undefined> = []
  const form: InitForm = {
    workers: () => Effect.succeed({}),
    checks: (questions) =>
      Effect.sync(() => {
        asked.push(questions.checks?.skill)
        return {
          checks: { kind: "scratch" },
          verifier: false,
          ...(replace === undefined ? {} : { replaceSkill: replace }),
        }
      }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  }
  return { form, asked }
}

const runInit = async (project: Project, form: InitForm) => {
  const exit = await Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags: { force: false },
        form,
        scout: Effect.succeed(scouting({})),
        machine: machineOf(project),
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
  return summaryOf(exit)
}

const summaryOf = (exit: Exit.Exit<InitSummary, unknown>): InitSummary => {
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

/** The summary's skill line. */
const skillLine = (summary: InitSummary) =>
  summary.steps.map(stepLine).find((line) => line.slice(2).startsWith("skill  "))

const copyOf = (project: Project) => readFileSync(join(project.repo, skillPath), "utf8")

describe("a copy of the create-check-suite skill already there", () => {
  test("the same as tutti's: kept as it is", async () => {
    const project = newProject(skillText)
    const { form, asked } = scratchForm()
    const summary = await runInit(project, form)
    expect(asked).toEqual(["same"])
    expect(copyOf(project)).toBe(skillText)
    expect(skillLine(summary)).toBe(
      "• skill  .claude/skills/create-check-suite/ is there; left as it is",
    )
  })

  test("a different one: kept, unless replacing it is chosen", async () => {
    const kept = newProject(ours)
    const declined = scratchForm(false)
    const keptSummary = await runInit(kept, declined.form)
    expect(declined.asked).toEqual(["differs"])
    expect(copyOf(kept)).toBe(ours)
    expect(skillLine(keptSummary)).toBe(
      "! skill  .claude/skills/create-check-suite/ differs from tutti's; kept (remove it and run tutti init again for tutti's)",
    )

    const replaced = newProject(ours)
    const chosen = scratchForm(true)
    const replacedSummary = await runInit(replaced, chosen.form)
    expect(copyOf(replaced)).toBe(skillText)
    expect(skillLine(replacedSummary)).toBe(
      "✓ skill  replaced .claude/skills/create-check-suite/, for the tickets that set up the project's tests",
    )
  })

  test("not answered: a different one is kept", async () => {
    const project = newProject(ours)
    const { form } = scratchForm()
    const summary = await runInit(project, form)
    expect(copyOf(project)).toBe(ours)
    expect(skillLine(summary)).toStartWith("! skill  ")
  })
})

describe("the Checks step in lines", () => {
  /** The line form's Checks step, creating from scratch, over the copy in `skill` and `typed`. */
  const answer = async (skill: SkillState, typed: string) => {
    const questions: ChecksQuestions = {
      checks: {
        scout: Effect.succeed(scouting({ note: "No tests here." })),
        checkScript: false,
        command: "",
        keepsRunner: false,
        runners: { fast: null, full: null },
        skill,
      },
      setup: null,
      prefix: null,
      verifier: false,
    }
    const stream = new PassThrough()
    stream.end(typed)
    let output = ""
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const form = lineForm({
            input: yield* streamInput(stream),
            write: (text) => {
              output += text
            },
            theme: makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true }),
          })
          return yield* form.checks(questions)
        }),
      ),
    )
    return { exit, output }
  }

  test("asks whether to replace a copy that differs, and only that one", async () => {
    const question = "Replace .claude/skills/create-check-suite/?"
    for (const replace of [true, false]) {
      const differs = await answer("differs", `\n${replace ? "y" : "n"}\n`)
      expect(differs.output).toContain(question)
      expect(Exit.isSuccess(differs.exit) && differs.exit.value).toMatchObject({
        checks: { kind: "scratch" },
        replaceSkill: replace,
      })
    }
    const same = await answer("same", "\n")
    expect(same.output).not.toContain(question)
    expect(Exit.isSuccess(same.exit) && same.exit.value).not.toHaveProperty("replaceSkill")
  })
})
