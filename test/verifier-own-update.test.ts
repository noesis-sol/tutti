// `tutti init --update` on a project whose .claude/agents/verifier.md is its own (§ 8.3), not a copy
// of tutti's template: it says the file is the project's own rather than that it has every change
// to its template, and the settings record no version of the verifier's template for it.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { verifierPath } from "../src/init/checks.ts"
import { stepLine } from "../src/init/steps.ts"
import {
  currentTemplates,
  latestVersion,
  ownVerifier,
  promptChanges,
} from "../src/init/templates.ts"
import { updateNext, updateTemplates } from "../src/init/update.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"

/** A subagent of the project's own named verifier. */
const ownVerifierText = `---
name: verifier
description: Reviews a pull request against our style guide.
tools: Read, Grep
---
You review a pull request for our house style.

## Rules

- Flag every use of \`any\`.
`

const ownLine = `• verifier  ${verifierPath} is the project's own subagent, not a copy of tutti's verifier template: kept as it is`

/** A project set up with an up-to-date worker prompt, its own verifier and `templates` recorded. */
const project = (templates: Record<string, number>) => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-verifier-own-update-"))), "repo")
  mkdirSync(join(repo, ".git"), { recursive: true })
  write(repo, ".tutti/worker-prompt.md", builtInWorkerPrompt)
  write(
    repo,
    ".tutti/settings.json",
    `${JSON.stringify({ keep_awake: true, templates }, null, 2)}\n`,
  )
  write(repo, verifierPath, ownVerifierText)
  return repo
}

const write = (repo: string, path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const settingsOf = (repo: string) =>
  JSON.parse(readFileSync(join(repo, ".tutti", "settings.json"), "utf8"))

describe("tutti init --update on a project's own verifier", () => {
  test("the verifier is the project's own", () => {
    expect(ownVerifier(ownVerifierText)).toBe(true)
  })

  test("says the verifier is the project's own and records no version for it", async () => {
    const repo = project({ worker_prompt: latestVersion(promptChanges) })
    const settings = readFileSync(join(repo, ".tutti", "settings.json"), "utf8")
    const result = await run(updateTemplates(repo))
    expect(result.updates).toEqual([])
    expect(result.steps.map(stepLine)).toEqual([
      "• worker prompt  .tutti/worker-prompt.md has every change to its template",
      ownLine,
    ])
    expect(readFileSync(join(repo, ".tutti", "settings.json"), "utf8")).toBe(settings)
    expect(updateNext(result)).toEqual([
      "Nothing to commit: the worker prompt has every change to its template.",
    ])
  })

  test("drops a version the settings recorded for it", async () => {
    const repo = project({
      worker_prompt: latestVersion(promptChanges),
      verifier: currentTemplates.verifier,
    })
    const result = await run(updateTemplates(repo))
    expect(result.steps.map(stepLine)).toContain(ownLine)
    expect(settingsOf(repo).templates).toEqual({ worker_prompt: latestVersion(promptChanges) })
    expect(readFileSync(join(repo, verifierPath), "utf8")).toBe(ownVerifierText)
    expect(updateNext(result)).toEqual(["Commit .tutti/settings.json."])
  })
})
