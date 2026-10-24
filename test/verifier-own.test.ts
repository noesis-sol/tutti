// A project's own verifier (§ 8.3): a .claude/agents/verifier.md that isn't a copy of tutti's
// template, without its opening words or the sections of its own, takes none of the template's
// changes: a run says nothing of it, and `tutti init --update` leaves it as it is. A copy of the
// template, worded the project's way in places, is still noticed.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { verifierPath, verifierText } from "../src/init/checks.ts"
import {
  latestVersion,
  promptChanges,
  sections,
  templateNotes,
  verifierOpening,
} from "../src/init/templates.ts"
import { updateTemplates } from "../src/init/update.ts"
import { readConfigFile } from "../src/project/configFile.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { Settings } from "../src/project/settings.ts"

/** A subagent of the project's own named verifier, with a Rules section as tutti's has. */
const ownVerifier = `---
name: verifier
description: Reviews a pull request against our style guide.
tools: Read, Grep
---
You review a pull request for our house style.

## Rules

- Flag every use of \`any\`.
`

/** The verifier of 2026-10-19, from before tutti recorded the verifier's versions. */
const oldVerifier = readFileSync(
  join(import.meta.dir, "fixtures", "templates", "verifier-2026-10-19.md"),
  "utf8",
)

/**
 * A project set up with an up-to-date worker prompt and the verifier `verifier`; the settings record
 * the worker prompt's version and none for the verifier.
 */
const project = (verifier: string) => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-verifier-own-"))), "repo")
  mkdirSync(join(repo, ".git"), { recursive: true })
  write(repo, ".tutti/worker-prompt.md", builtInWorkerPrompt)
  const templates = { worker_prompt: latestVersion(promptChanges) }
  write(repo, ".tutti/settings.json", `${JSON.stringify({ templates }, null, 2)}\n`)
  write(repo, verifierPath, verifier)
  return repo
}

const write = (repo: string, path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const notesOf = async (repo: string) => {
  const settings = await run(readConfigFile(Settings, join(repo, ".tutti", "settings.json")))
  return run(templateNotes(repo, settings.templates, true))
}

describe("a project's own verifier", () => {
  test("a run says nothing of it, and tutti init --update leaves it as it is", async () => {
    const repo = project(ownVerifier)
    expect(await notesOf(repo)).toEqual([])
    const result = await run(updateTemplates(repo))
    expect(result.updates).toEqual([])
    expect(readFileSync(join(repo, verifierPath), "utf8")).toBe(ownVerifier)
  })

  test("tutti's template opens with the words that tell a copy of it", () => {
    const template = verifierText(["TypeScript"], ["pnpm lint"], [])
    expect(template).toContain(verifierOpening)
    expect(oldVerifier).toContain(verifierOpening)
    const titles = sections(template).map((each) => each.title)
    expect(titles).toContain("Its checks")
    expect(titles).toContain("How to verify")
  })

  test("a copy of the template is noticed by its opening words or by its sections", async () => {
    expect(await notesOf(project(oldVerifier))).toHaveLength(1)
    // Its opening reworded, the copy is still tutti's by its sections.
    const reworded = oldVerifier.replace(verifierOpening, "You check a change")
    expect(reworded).not.toContain(verifierOpening)
    const notes = await notesOf(project(reworded))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`templates: ${verifierPath} is older than tutti's verifier template`)
    // Its sections dropped, the copy is still tutti's by its opening words.
    const opening = sections(oldVerifier)[0]?.text ?? ""
    expect(await notesOf(project(opening))).toHaveLength(1)
  })
})
