// The create-check-suite skill as a versioned template (§ 8.3): its section on getting the runners
// passing, and init's ticket that gets them passing, run check-fast three times in all and
// check-full once; a project's older copy of the skill is noticed, `tutti init --update` rewrites
// that section alone, and init records the version of the skill it writes.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import { skillPath, skillText, testWork } from "../src/init/checks.ts"
import { type InitForm, init } from "../src/init/init.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import {
  currentTemplates,
  latestVersion,
  passingHeading,
  promptChanges,
  sections,
  skillChanges,
  templateNotes,
} from "../src/init/templates.ts"
import { updateLines, updateNext, updateTemplates } from "../src/init/update.ts"
import { readConfigFile } from "../src/project/configFile.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { Settings } from "../src/project/settings.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"

// The skill as its last recorded version has it. A change to it is a new version of it: this test
// fails until src/init/templates.ts records it.
const skillTemplateSum = "a5bd6d3e4514d77fc4818930bf70ff2517bde7c51dab096826647f32316c0a50"

const sum = (text: string): string => createHash("sha256").update(text).digest("hex")

/** The skill as init wrote it before its versions were recorded, on 2026-10-22. */
const oldSkill = readFileSync(
  join(import.meta.dir, "fixtures", "templates", "create-check-suite-2026-10-22.md"),
  "utf8",
)

/** A line of section 5 the project changed in its copy, which --update keeps. */
const ownLine = "Keep it to facts you checked, and our area names."

/** The text of `text`'s section titled `title`. */
const sectionOf = (text: string, title: string): string =>
  sections(text).find((each) => each.title === title)?.text ?? ""

/**
 * A project set up with an up-to-date worker prompt, no verifier, and the skill's copy `skill`; the
 * settings record the worker prompt's version and none for the skill.
 */
const project = (skill: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-skill-version-")))
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(home)
  write(repo, ".tutti/worker-prompt.md", builtInWorkerPrompt)
  const templates = { worker_prompt: latestVersion(promptChanges) }
  write(repo, ".tutti/settings.json", `${JSON.stringify({ concurrent: 2, templates }, null, 2)}\n`)
  write(repo, skillPath, skill)
  return { repo, home, commonDir: join(repo, ".git") }
}

const write = (repo: string, path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

const read = (repo: string, path: string) => readFileSync(join(repo, path), "utf8")

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const settingsOf = (repo: string) =>
  run(readConfigFile(Settings, join(repo, ".tutti", "settings.json")))

const notesOf = async (repo: string) =>
  run(templateNotes(repo, (await settingsOf(repo)).templates, true))

describe("the create-check-suite skill's version", () => {
  test("each change to the skill is recorded as a version of it", () => {
    const now = sum(skillText)
    expect(
      now,
      `create-check-suite.md changed. Record the change in src/init/templates.ts: a change in skillChanges with the next version (${latestVersion(skillChanges) + 1}), the section it changed, what changed and a marker only the new text has; then set skillTemplateSum to ${now}`,
    ).toBe(skillTemplateSum)
    for (const change of skillChanges) {
      expect(sectionOf(skillText, change.section)).toContain(change.marker)
    }
    expect(currentTemplates.check_suite_skill).toBe(latestVersion(skillChanges))
  })

  test("the skill runs check-fast three times in all, and check-full once", () => {
    const passing = sectionOf(skillText, passingHeading)
    for (const want of [
      "Run `scripts/check-fast.sh` on your branch from the main branch, read what fails, fix it and run it\nagain until it exits 0;",
      "Once check-fast passes, run it twice more, to catch a test that passes only sometimes",
      "check-full runs once at the end of\na run: run it once, after those, and again only where a fix since touched what it runs.",
      "record how long each runner took",
    ]) {
      expect(passing).toContain(want)
    }
    expect(skillText).not.toContain("Run each runner twice more")
  })

  test("tutti's own copy is the template's", () => {
    const top = join(import.meta.dir, "..")
    expect(read(top, skillPath)).toBe(skillText)
    const own = JSON.parse(read(top, ".tutti/settings.json")) as {
      templates: { check_suite_skill: number }
    }
    expect(own.templates.check_suite_skill).toBe(currentTemplates.check_suite_skill)
  })
})

describe("init's ticket to get the runners passing", () => {
  test("asks for check-fast three times in all, and check-full once", () => {
    const found = { kind: "found", fast: [], full: [], fileUntested: false } as const
    const [pass] = testWork(found, "main")
    expect(pass?.description).toContain(
      "Run scripts/check-fast.sh and fix what fails; once it passes, run it twice more, to catch a test that passes only sometimes. Then run scripts/check-full.sh once, as a run does at its end, fixing what fails, and again only where a fix since touched what it runs.",
    )
    expect(pass?.description).toContain("Record how long each runner takes in this ticket's notes.")
    expect(pass?.description).not.toContain("Run each runner twice more")
    expect(pass?.acceptance).toBe(
      "scripts/check-fast.sh exits 0 on main three times running, and scripts/check-full.sh once; how long each takes is in the notes.",
    )
  })
})

describe("an older copy of the skill", () => {
  const older = () => project(oldSkill.replace("Keep it to facts you checked.", ownLine))

  test("a run notices it, naming the section and what changed", async () => {
    const { repo } = older()
    expect(await notesOf(repo)).toEqual([
      `templates: ${skillPath} is older than tutti's create-check-suite skill template, which has since changed ${passingHeading} (check-fast is run three times in all to catch a flaky test, and check-full once, at the end): tutti init --update rewrites those sections from the template, keeping the rest of the file, and shows the diff to commit`,
    ])
  })

  test("tutti init --update rewrites that section alone, and records the skill's version", async () => {
    const { repo } = older()
    const before = read(repo, skillPath)
    expect(before).toContain(ownLine)
    const result = await run(updateTemplates(repo))
    expect(result.updates.map((each) => each.path)).toEqual([skillPath])
    const after = read(repo, skillPath)
    expect(sectionOf(after, passingHeading)).toBe(sectionOf(skillText, passingHeading))
    expect(after).toContain(ownLine)
    // Every other section is the copy's, as it was.
    const others = (text: string) => sections(text).filter((each) => each.title !== passingHeading)
    expect(others(after)).toEqual(others(before))

    const lines = updateLines(result)
    expect(lines).toContain(
      `✓ skill  rewrote ${passingHeading} in ${skillPath} from the template; the rest is as it was`,
    )
    expect(lines).toContain(
      `✓ settings  recorded the versions of the templates the files now have (worker prompt ${currentTemplates.worker_prompt}, create-check-suite skill ${currentTemplates.check_suite_skill})`,
    )
    expect(lines.join("\n")).toContain("\n-Run each runner twice more")
    expect(updateNext(result).at(-1)).toBe(`Commit ${skillPath} and .tutti/settings.json.`)
    expect(JSON.parse(read(repo, ".tutti/settings.json")).templates).toEqual({
      worker_prompt: currentTemplates.worker_prompt,
      check_suite_skill: currentTemplates.check_suite_skill,
    })
    expect(await notesOf(repo)).toEqual([])

    // Again, there is nothing to do.
    const again = await run(updateTemplates(repo))
    expect(again.updates).toEqual([])
    expect(again.steps.map(stepLine)).toEqual([
      "• worker prompt  .tutti/worker-prompt.md has every change to its template",
      `• skill  ${skillPath} has every change to its template`,
    ])
    expect(updateNext(again)).toEqual([
      "Nothing to commit: the worker prompt, the verifier and the create-check-suite skill have every change to their templates.",
    ])
  })

  test("a skill of the project's own, without the section, is left alone", async () => {
    const { repo } = project(
      "---\nname: create-check-suite\n---\nOur own way of setting up tests.\n",
    )
    expect(await notesOf(repo)).toEqual([])
    const result = await run(updateTemplates(repo))
    expect(result.updates).toEqual([])
  })
})

/** A machine on which every command succeeds, bd on the PATH. */
const machineOf = (home: string): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? home : undefined),
  platform: "darwin",
  executable: () => false,
})

/** Checks created from scratch, which writes the skill; a copy that differs replaced if `replace`. */
const scratchForm = (replace: boolean): InitForm => ({
  workers: () => Effect.succeed({}),
  checks: () =>
    Effect.succeed({ checks: { kind: "scratch" }, verifier: false, replaceSkill: replace }),
  trust: () => Effect.succeed(false),
  import: () => Effect.succeed(false),
})

const runInit = async (at: ReturnType<typeof project>, form: InitForm) => {
  const exit = await Effect.runPromise(
    Effect.exit(
      init({
        repo: at.repo,
        commonDir: at.commonDir,
        branch: "main",
        version: "0.1.0",
        flags: { force: false },
        form,
        scout: Effect.succeed({ suites: [], stack: [], note: "" }),
        machine: machineOf(at.home),
        configure: Effect.succeed(TestAppConfig.appConfig({}, at.repo)),
        account: TestAccount.layer(),
        claudeConfig: join(at.home, ".claude.json"),
      }).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer([])),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: at.home } }))),
        Effect.provide(BunServices.layer),
      ),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

describe("tutti init and the skill's version", () => {
  test("records the version of the skill it writes", async () => {
    const at = project(oldSkill)
    const summary = await runInit(at, scratchForm(true))
    expect(read(at.repo, skillPath)).toBe(skillText)
    expect((await settingsOf(at.repo)).templates.check_suite_skill).toBe(
      currentTemplates.check_suite_skill,
    )
    expect(summary.steps.some((each) => each.label === "templates")).toBe(false)
  })

  test("says an older copy it keeps is older, and records no version for it", async () => {
    const at = project(oldSkill)
    const summary = await runInit(at, scratchForm(false))
    expect(read(at.repo, skillPath)).toBe(oldSkill)
    expect(summary.steps.map(stepLine)).toContain(
      `! templates  ${skillPath} is older than tutti's create-check-suite skill template, which has since changed ${passingHeading}: tutti init --update takes those sections`,
    )
    expect(summary.next).toContain("Take the templates' changes with: tutti init --update")
    expect((await settingsOf(at.repo)).templates.check_suite_skill).toBe(0)
  })
})
