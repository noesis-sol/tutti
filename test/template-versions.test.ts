// The versions of tutti's templates (§ 8.3, src/init/templates.ts): a run's notice and init's of a
// worker prompt or verifier older than the templates, `tutti init --update` taking the sections
// changed since and keeping the rest, and the versions init records.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit, Option } from "effect"
import { readInitFlags } from "../src/cli/commands.ts"
import { suitesIntro, verifierPath, verifierSection, verifierText } from "../src/init/checks.ts"
import { type InitFlags, type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { fastScript, fullScript } from "../src/init/runners.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import {
  currentPrompt,
  currentTemplates,
  latestVersion,
  promptChanges,
  sections,
  type TemplateChange,
  templateNotes,
  unifiedDiff,
  updated,
  verifierChanges,
} from "../src/init/templates.ts"
import { initUpdate, updateLines, updateNext, updateTemplates } from "../src/init/update.ts"
import { readConfigFile } from "../src/project/configFile.ts"
import { builtInWorkerPrompt, withSuites } from "../src/project/prompt.ts"
import { Settings } from "../src/project/settings.ts"
import verifierTemplate from "../src/project/templates/verifier.md" with { type: "text" }
import { check } from "../src/run/startup.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"

// The templates as their last recorded versions have them. A change to a template is a new version
// of it: the first test fails until src/init/templates.ts records it.
const promptTemplateSum = "d3bad6b31253fece28a6a36b7013590f562312b4152d8ec7c7ca77f4ae0c3b7c"
const verifierTemplateSum = "4ba3193b5fe3b22299902405072ae30672f2ebba9b614c040ad0734bcf2c3151"

const sum = (text: string): string => createHash("sha256").update(text).digest("hex")

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", "templates", name), "utf8")

/** The project's own section, which no template has. */
const projectNotes = "\n## Project notes\n- Use pnpm, never npm.\n"

/**
 * A project set up on 2026-10-19, before tutti recorded template versions: the worker prompt of
 * 2026-10-17 with the project's own section and, with `verifier`, the Verify section and the
 * verifier of 2026-10-19; the runners, and settings recording no versions.
 */
const oldProject = (verifier: boolean) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-templates-")))
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(join(repo, ".beads"))
  mkdirSync(home)
  const prompt = fixture("worker-prompt-2026-10-17.md") + projectNotes
  write(
    repo,
    ".tutti/worker-prompt.md",
    verifier ? prompt + fixture("verify-section-2026-10-19.md") : prompt,
  )
  if (verifier) write(repo, verifierPath, fixture("verifier-2026-10-19.md"))
  write(repo, ".tutti/settings.json", `${JSON.stringify({ concurrent: 2 }, null, 2)}\n`)
  const lint = { name: "lint", command: "pnpm lint", foundIn: "package.json", serial: false }
  write(repo, "scripts/check-fast.sh", fastScript([lint]))
  write(repo, "scripts/check-full.sh", fullScript([], false))
  return { repo, home, commonDir: join(repo, ".git") }
}

type Project = ReturnType<typeof oldProject>

const write = (repo: string, path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

const read = (repo: string, path: string) => readFileSync(join(repo, path), "utf8")

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const settingsOf = (repo: string) =>
  run(readConfigFile(Settings, join(repo, ".tutti", "settings.json")))

const notesOf = async (repo: string, prompt = true) =>
  run(templateNotes(repo, (await settingsOf(repo)).templates, prompt))

describe("the templates' versions", () => {
  test("each change to a template is recorded as a version of it", () => {
    const prompt = sum(builtInWorkerPrompt + verifierSection)
    expect(
      prompt,
      `worker-prompt.md or verifierSection changed. Record the change in src/init/templates.ts: a change in promptChanges with the next version (${latestVersion(promptChanges) + 1}), the section it changed, what changed and a marker only the new text has; then set promptTemplateSum to ${prompt}`,
    ).toBe(promptTemplateSum)
    const verifier = sum(verifierTemplate)
    expect(
      verifier,
      `verifier.md changed. Record the change in src/init/templates.ts: a change in verifierChanges with the next version (${latestVersion(verifierChanges) + 1}), the section it changed, what changed and a marker only the new text has; then set verifierTemplateSum to ${verifier}`,
    ).toBe(verifierTemplateSum)
  })

  // Else every project would lack it.
  test("each change's marker is in the template now, in the section it names", () => {
    const check = (text: string, changes: ReadonlyArray<TemplateChange>) => {
      const all = sections(text)
      for (const change of changes) {
        const section = all.find((each) => each.title === change.section)
        expect({ change, there: section?.text.includes(change.marker) ?? false }).toEqual({
          change,
          there: true,
        })
      }
    }
    check(currentPrompt(verifierSection), promptChanges)
    check(verifierText(["TypeScript"], ["pnpm lint"], []), verifierChanges)
    expect(currentTemplates).toEqual({
      worker_prompt: latestVersion(promptChanges),
      verifier: latestVersion(verifierChanges),
    })
  })

  test("sections split a file at its headings, and give it back joined", () => {
    const text = "intro\n## A\na\n\n## B\nb"
    expect(sections(text)).toEqual([
      { title: "", text: "intro\n" },
      { title: "A", text: "## A\na\n\n" },
      { title: "B", text: "## B\nb" },
    ])
    for (const each of [builtInWorkerPrompt, verifierTemplate, "", "\n\n", "## only"]) {
      expect(
        sections(each)
          .map((part) => part.text)
          .join(""),
      ).toBe(each)
    }
  })
})

describe("an older worker prompt or verifier", () => {
  test("an older worker prompt is noticed, with its sections named", async () => {
    const { repo } = oldProject(false)
    const notes = await notesOf(repo)
    expect(notes).toHaveLength(1)
    const note = notes[0] ?? ""
    for (const want of [
      "templates: .tutti/worker-prompt.md is older than tutti's worker prompt template, which has since changed ",
      "the opening (a removal Claude Code's safety check holds is refused outright in auto mode; a worker passes Bash no timeout of its own, as tutti raises Bash's default to the merge check's limit; a worker checks its own change and leaves the whole suite to the merge check)",
      " and Close (a ticket closes once the worker's own checks pass)",
      ": tutti init --update rewrites those sections from the template",
    ]) {
      expect(note).toContain(want)
    }
    // The Verify section of a prompt that doesn't run the verifier isn't named, nor its own section.
    expect(note).not.toContain("Verify")
    expect(note).not.toContain("Project notes")
  })

  test("an older verifier is noticed, and the prompt's Verify section", async () => {
    const { repo } = oldProject(true)
    const notes = await notesOf(repo)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain(
      "Verify (the worker gives the verifier the commit at which its checks passed",
    )
    for (const want of [
      `templates: ${verifierPath} is older than tutti's verifier template`,
      "the opening (its description asks",
      "Its checks (how to run each suite on what a change touches)",
      "How to verify (it quotes the worker's passing checks",
      "Rules (it passes Bash no timeout",
    ]) {
      expect(notes[1]).toContain(want)
    }
    // A run with a worker prompt of its own (--prompt) hears only of the verifier.
    expect(await notesOf(repo, false)).toEqual([notes[1] ?? ""])
  })

  test("a recorded version is taken as it is, though a section is worded the project's way", async () => {
    const { repo } = oldProject(false)
    const latest = latestVersion(promptChanges)
    write(repo, ".tutti/settings.json", JSON.stringify({ templates: { worker_prompt: latest } }))
    expect(await notesOf(repo)).toEqual([])
    write(repo, ".tutti/settings.json", JSON.stringify({ templates: { worker_prompt: 3 } }))
    const notes = await notesOf(repo)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("the opening (a worker checks its own change")
    expect(notes[0]).not.toContain("auto mode")
  })

  test("a worker prompt with every change's words records no version and is up to date", async () => {
    const { repo } = oldProject(false)
    write(repo, ".tutti/worker-prompt.md", builtInWorkerPrompt + projectNotes)
    expect(await notesOf(repo)).toEqual([])
  })

  test("a run says it under its START line", async () => {
    const { repo, home } = oldProject(false)
    const exit = await Effect.runPromise(
      Effect.exit(
        check({
          cwd: repo,
          env: {},
          config: (top) => Effect.succeed(TestAppConfig.appConfig({}, top)),
          beads: () => TestBeads.layer(),
          claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
          account: TestAccount.layer(),
        }),
      ).pipe(
        Effect.provide(TestGit.layer({ dir: repo })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } }))),
        Effect.provide(BunServices.layer),
      ),
    )
    if (Exit.isFailure(exit)) throw new Error(`the checks failed: ${Cause.pretty(exit.cause)}`)
    const notes = exit.value.warnings.filter((each) => each.startsWith("templates: "))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(".tutti/worker-prompt.md is older than tutti's worker prompt")
  })
})

describe("tutti init --update", () => {
  test("rewrites the sections changed since, and keeps the rest", async () => {
    const { repo } = oldProject(true)
    const result = await run(updateTemplates(repo))
    expect(result.updates.map((each) => each.path)).toEqual([
      ".tutti/worker-prompt.md",
      verifierPath,
    ])

    const prompt = read(repo, ".tutti/worker-prompt.md")
    for (const want of [
      "- Leave the whole suite to tutti: its merge check, `scripts/check-fast.sh`, runs",
      "- Close the ticket only when your checks pass after your last change.",
      "commit at which your checks passed",
      `${projectNotes}\n## Verify\n`,
      "in auto mode refuses it outright",
    ]) {
      expect(prompt).toContain(want)
    }
    for (const gone of ["Check your work with", "and nothing of your reasoning. Run"]) {
      expect(prompt).not.toContain(gone)
    }
    // The sections no change touched are the project's copy's, as they were.
    const old = sections(fixture("worker-prompt-2026-10-17.md") + projectNotes)
    const now = sections(prompt)
    expect(now.find((each) => each.title === "Working unattended")).toEqual(
      old.find((each) => each.title === "Working unattended"),
    )
    expect(prompt.endsWith(verifierSection)).toBe(true)
    expect(prompt.split("## Verify").length).toBe(2)

    const verifier = read(repo, verifierPath)
    for (const want of [
      "## The project\n\n- TypeScript\n- vitest\n",
      "  - `pnpm lint`\n",
      "Leave the whole suite to tutti",
      "the commands you ran there",
      "Give a check its time",
    ]) {
      expect(verifier).toContain(want)
    }

    const settings = await settingsOf(repo)
    expect(settings.templates).toEqual(currentTemplates)
    expect(settings.concurrent).toBe(2)
    expect(await notesOf(repo)).toEqual([])

    const diff = unifiedDiff(
      ".tutti/worker-prompt.md",
      result.updates[0]?.before ?? "",
      result.updates[0]?.after ?? "",
    )
    for (const want of [
      "--- a/.tutti/worker-prompt.md\n+++ b/.tutti/worker-prompt.md\n@@ -",
      "\n-- Check your work with",
      "\n+- Leave the whole suite to tutti",
    ]) {
      expect(diff).toContain(want)
    }
    expect(diff).not.toContain("Project notes")
    const lines = updateLines(result)
    expect(lines).toContain(
      "✓ worker prompt  rewrote the opening, Close and Verify in .tutti/worker-prompt.md from the template; the rest is as it was",
    )
    expect(lines.join("\n")).toContain(diff.trimEnd())
    expect(updateNext(result).at(-1)).toBe(
      `Commit .tutti/worker-prompt.md, ${verifierPath} and .tutti/settings.json.`,
    )

    // Again, there is nothing to do.
    const again = await run(updateTemplates(repo))
    expect(again.updates).toEqual([])
    expect(again.steps.map(stepLine)).toEqual([
      "• worker prompt  .tutti/worker-prompt.md has every change to its template",
      `• verifier  ${verifierPath} has every change to its template`,
    ])
    expect(updateNext(again)).toEqual([
      "Nothing to commit: the worker prompt and the verifier have every change to their templates.",
    ])
  })

  test("keeps the worker prompt's lines on running each suite", async () => {
    const { repo } = oldProject(false)
    const bullets = `${suitesIntro}  - unit: \`go test ./<package>/...\`\n`
    // As init writes it where it knew the suites, with the opening older than the template's.
    const prompt = withSuites(builtInWorkerPrompt, bullets).replace(
      "Leave the whole suite to tutti",
      "Leave the whole suite alone",
    )
    expect(prompt).toContain(bullets)
    write(repo, ".tutti/worker-prompt.md", prompt)
    await run(updateTemplates(repo))
    const after = read(repo, ".tutti/worker-prompt.md")
    expect(after).toContain(`${bullets}- Leave the whole suite to tutti`)
    expect(after).not.toContain("The suites are the commands")
  })

  test("records the versions alone where nothing else is out of date", async () => {
    const { repo } = oldProject(false)
    write(repo, ".tutti/worker-prompt.md", builtInWorkerPrompt)
    const result = await run(updateTemplates(repo))
    expect(result.updates).toEqual([])
    expect(result.steps.map(stepLine)).toEqual([
      "• worker prompt  .tutti/worker-prompt.md has every change to its template",
      `✓ settings  recorded the versions of the templates the files now have (worker prompt ${currentTemplates.worker_prompt})`,
    ])
    expect(JSON.parse(read(repo, ".tutti/settings.json"))).toEqual({
      concurrent: 2,
      templates: { worker_prompt: currentTemplates.worker_prompt },
    })
  })

  test("is refused in a project init hasn't set up, and while a run holds the lock", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-templates-")))
    const refused = await Effect.runPromise(
      Effect.flip(updateTemplates(root)).pipe(Effect.provide(BunServices.layer)),
    )
    expect(refused.message).toBe("no .tutti/worker-prompt.md to update: run tutti init first")

    const project = oldProject(false)
    const options = { ...project, branch: "main", version: "0.1.0" }
    const held = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RunLock
          yield* lock.acquire({
            repo: project.repo,
            commonDir: project.commonDir,
            holder: { pid: process.pid, started: "now", version: "0.1.0", branch: "main" },
          })
          return yield* Effect.flip(initUpdate(options))
        }),
      ).pipe(Effect.provide(RunLock.layer), Effect.provide(BunServices.layer)),
    )
    expect(held.message).toContain("update between runs")
    expect(read(project.repo, ".tutti/worker-prompt.md")).toBe(
      fixture("worker-prompt-2026-10-17.md") + projectNotes,
    )
  })

  test("takes no other flag", () => {
    const none = Option.none<string>()
    const texts = {
      checkFast: none,
      checkFull: none,
      checkFastTimeout: none,
      checkFullTimeout: none,
      setup: none,
      concurrent: none,
      mcp: none,
      changelogUnion: none,
      installBeads: none,
      verifier: none,
      prefix: none,
      force: false,
    }
    const alone = readInitFlags({ ...texts, update: true })
    expect(alone._tag === "Success" && alone.success.update).toBe(true)
    for (const other of [
      { ...texts, update: true, force: true },
      { ...texts, update: true, concurrent: Option.some("2") },
    ]) {
      const flags = readInitFlags(other)
      expect(flags._tag === "Failure" && flags.failure).toEqual([
        "--update takes no other flag: run tutti init without it to change the rest",
      ])
    }
  })
})

describe("updated", () => {
  test("adds a section the copy lacks after the one before it", () => {
    const current = "intro\n\n## A\na\n\n## B\nb new\n\n## C\nc\n"
    expect(updated("intro\n\n## A\nmine\n\n## C\nc\n", current, [{ section: "B" }])).toBe(
      "intro\n\n## A\nmine\n\n## B\nb new\n\n## C\nc\n",
    )
    expect(updated("intro", current, [{ section: "C" }])).toBe("intro\n## C\nc\n")
    expect(updated("intro\n", current, [{ section: "D" }])).toBe("intro\n")
  })

  test("the diff shows only what changed", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${String.fromCharCode(97 + i)}\n`)
    const after = before.map((line, i) => (i === 10 ? "changed\n" : line))
    expect(unifiedDiff("f.md", before.join(""), after.join(""))).toBe(
      "--- a/f.md\n+++ b/f.md\n@@ -8,7 +8,7 @@\n line h\n line i\n line j\n-line k\n+changed\n line l\n line m\n line n\n",
    )
    expect(unifiedDiff("f.md", "a\n", "a\n")).toBe("")
    expect(unifiedDiff("f.md", "", "a\n")).toBe("--- a/f.md\n+++ b/f.md\n@@ -1,0 +1,1 @@\n+a\n")
  })
})

/** A machine on which every command succeeds, bd on the PATH. */
const machine = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

const runInit = async (
  project: Project,
  flags: InitFlags,
  form: InitForm | null = null,
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

describe("tutti init and the templates' versions", () => {
  test("says a prompt it keeps is older, and how to take the changes", async () => {
    const project = oldProject(true)
    const summary = await runInit(project, { force: false })
    const lines = summary.steps.map(stepLine)
    expect(lines).toContain(
      "! templates  .tutti/worker-prompt.md is older than tutti's worker prompt template, which has since changed the opening, Close and Verify: tutti init --update takes those sections",
    )
    expect(lines).toContain(
      `! templates  ${verifierPath} is older than tutti's verifier template, which has since changed the opening, Its checks, How to verify and Rules: tutti init --update takes those sections`,
    )
    expect(summary.next).toContain("Take the templates' changes with: tutti init --update")
    expect((await settingsOf(project.repo)).templates).toEqual({ worker_prompt: 0, verifier: 0 })
  })

  test("says an imported orchestra prompt is older, and records no version for it", async () => {
    const project = oldProject(false)
    rmSync(join(project.repo, ".tutti"), { recursive: true })
    cpSync(
      join(import.meta.dir, "fixtures", "orchestra-project", ".orchestra"),
      join(project.repo, ".orchestra"),
      { recursive: true },
    )
    const form: InitForm = {
      workers: () => Effect.succeed({}),
      checks: () => Effect.succeed({ verifier: false }),
      trust: () => Effect.succeed(false),
      import: () => Effect.succeed(true),
    }
    const summary = await runInit(project, { force: false }, form)
    const note = summary.steps.map(stepLine).find((line) => line.startsWith("! templates"))
    expect(note).toStartWith(
      "! templates  .tutti/worker-prompt.md is older than tutti's worker prompt template, which has since changed the opening",
    )
    expect((await settingsOf(project.repo)).templates.worker_prompt).toBe(0)
  })

  test("records the versions of the templates it writes", async () => {
    const project = oldProject(false)
    const summary = await runInit(project, { force: true, verifier: true })
    expect((await settingsOf(project.repo)).templates).toEqual(currentTemplates)
    expect(summary.steps.some((each) => each.label === "templates")).toBe(false)
    expect(await notesOf(project.repo)).toEqual([])
  })
})
