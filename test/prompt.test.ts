import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Option, Result } from "effect"
import fc from "fast-check"
import {
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  resolve,
  type SetupProblem,
} from "../src/cli/AppConfig.ts"
import { noFlags } from "../src/cli/flags.ts"
import {
  askUserQuestionTool,
  builtInWorkerPrompt,
  forTicket,
  loadWorkerPrompt,
  type WorkerPrompt,
  withoutAskUserQuestion,
} from "../src/project/prompt.ts"
import { appConfig } from "../src/testing/AppConfig.ts"

const project = (prompt?: string): string => {
  const repo = mkdtempSync(join(tmpdir(), "tutti-prompt-"))
  if (prompt !== undefined) {
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(join(repo, ".tutti", "worker-prompt.md"), prompt)
  }
  return repo
}

/** The configuration of a run in `repo` given `--prompt <flag>`, as AppConfig resolves it. */
const withFlag = (repo: string, flag: string): AppConfigValue => {
  const resolved = resolve({
    repo,
    flags: { ...noFlags, prompt: Option.some(flag) },
    env: () => undefined,
    user: defaultUserConfig,
    settings: defaultSettings,
  })
  if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
  return resolved.success
}

const withoutQuestions = (config: AppConfigValue): AppConfigValue => ({
  ...config,
  settings: {
    ...config.settings,
    workers: { ...config.settings.workers, ask_user_question: false },
  },
})

const load = (config: AppConfigValue) =>
  Effect.runPromise(
    Effect.exit(Effect.provide(loadWorkerPrompt(config), BunServices.layer)),
  ) as Promise<Exit.Exit<WorkerPrompt, SetupProblem>>

const loaded = async (config: AppConfigValue): Promise<WorkerPrompt> => {
  const exit = await load(config)
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}

const problems = async (config: AppConfigValue): Promise<ReadonlyArray<string>> => {
  const exit = await load(config)
  if (Exit.isSuccess(exit)) throw new Error("the prompt loaded")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(String(exit.cause))
  return error.error.problems
}

describe("the built-in worker prompt", () => {
  test("has no tmux-era or orchestra wording", () => {
    expect(builtInWorkerPrompt).not.toMatch(/\btabs?\b/i)
    expect(builtInWorkerPrompt).not.toContain(".orchestra")
    expect(builtInWorkerPrompt).not.toContain("wt/")
    expect(builtInWorkerPrompt).not.toMatch(/orchestra/i)
    expect(builtInWorkerPrompt).not.toMatch(/tmux|herdr|cmux|pane|paste/i)
    expect(builtInWorkerPrompt).not.toContain("look idle")
  })

  test("carries orchestra's rules with § 4.11's changes", () => {
    const rules = forTicket({ text: builtInWorkerPrompt, file: null }, "bd-7")
    expect(rules).toContain("on branch tutti/bd-7")
    expect(rules).toContain("tutti merges your branch")
    expect(rules).toContain("Never push.")
    expect(rules).toContain("with the ticket ID in the message")
    expect(rules).toContain("Close the ticket only when `scripts/check-fast.sh` passes")
    expect(rules).toContain("Run the checks in the foreground")
    expect(rules).toContain("your ticket can't merge until the\n  command ends")
    expect(rules).toContain("--labels human --deps blocks:bd-7")
    expect(rules).toContain(askUserQuestionTool)
    expect(rules).toContain("## Working unattended")
    expect(rules).toContain(
      "The maintainer may sometimes send you a message: follow it, then carry on",
    )
    expect(rules).toContain("say DONE and stop")
    expect(rules).not.toContain("TICKET_ID")
  })

  test("leaves the time limit and the --ticket line to the first message", () => {
    expect(builtInWorkerPrompt).not.toContain("--ticket")
    expect(builtInWorkerPrompt).not.toMatch(/time limit|ticket-limit|minutes left/i)
  })
})

describe("withoutAskUserQuestion", () => {
  test("drops the built-in prompt's AskUserQuestion paragraph and nothing else", () => {
    const dropped = withoutAskUserQuestion(builtInWorkerPrompt)
    expect(dropped).not.toContain(askUserQuestionTool)
    expect(dropped).toContain("ask it as a question ticket and stop")
    expect(dropped).toContain("- If the ticket depends on an answered question")
    const gone = builtInWorkerPrompt.split("\n").filter((line) => !dropped.includes(line))
    expect(gone).toHaveLength(5)
    expect(gone[0]).toStartWith("- A quick choice")
  })

  test("drops a nested item or a plain paragraph, keeping its neighbours", () => {
    const prompt = [
      "# Rules",
      "- one",
      "  - ask with AskUserQuestion",
      "    when you must",
      "  - two",
      "",
      "Use AskUserQuestion",
      "sparingly.",
      "",
      "Three.",
    ].join("\n")
    expect(withoutAskUserQuestion(prompt)).toBe(
      ["# Rules", "- one", "  - two", "", "", "Three."].join("\n"),
    )
  })

  test("never leaves AskUserQuestion, and leaves a prompt without it as it is", () => {
    const line = fc.oneof(
      fc.constantFrom(
        "",
        "# Close",
        "## AskUserQuestion",
        "- item",
        "  - nested",
        "  more",
        "* star",
        "AskUserQuestion",
      ),
      fc.string(),
    )
    fc.assert(
      fc.property(fc.array(line), (lines) => {
        const prompt = lines.join("\n")
        const dropped = withoutAskUserQuestion(prompt)
        expect(dropped).not.toContain(askUserQuestionTool)
        if (!prompt.includes(askUserQuestionTool)) expect(dropped).toBe(prompt)
        const given = prompt.split("\n")
        for (const kept of dropped.split("\n")) if (kept !== "") expect(given).toContain(kept)
      }),
    )
  })
})

describe("forTicket", () => {
  test("replaces every TICKET_ID", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.stringMatching(/^[a-z]+-[a-z0-9.]+$/), (parts, id) => {
        const rules = forTicket({ text: parts.join("TICKET_ID"), file: null }, id)
        expect(rules).toBe(parts.join(id))
      }),
    )
  })
})

describe("loadWorkerPrompt", () => {
  test("gives the built-in template when the project has no prompt", async () => {
    const repo = project()
    expect(await loaded(appConfig({}, repo))).toEqual({ text: builtInWorkerPrompt, file: null })
  })

  test("reads the project's .tutti/worker-prompt.md", async () => {
    const repo = project("Work on TICKET_ID.\n")
    expect(await loaded(appConfig({}, repo))).toEqual({
      text: "Work on TICKET_ID.\n",
      file: join(repo, ".tutti", "worker-prompt.md"),
    })
  })

  test("reads --prompt before the project's file", async () => {
    const repo = project("The project's TICKET_ID.\n")
    writeFileSync(join(repo, "mine.md"), "Mine: TICKET_ID.\n")
    expect(await loaded(withFlag(repo, "mine.md"))).toEqual({
      text: "Mine: TICKET_ID.\n",
      file: join(repo, "mine.md"),
    })
  })

  test("drops the AskUserQuestion paragraph with workers.ask_user_question off", async () => {
    const builtIn = await loaded(withoutQuestions(appConfig({}, project())))
    expect(builtIn.text).not.toContain(askUserQuestionTool)
    expect(builtIn.text).toBe(withoutAskUserQuestion(builtInWorkerPrompt))
    const own = await loaded(
      withoutQuestions(appConfig({}, project("TICKET_ID\n\n- Use AskUserQuestion.\n- Commit.\n"))),
    )
    expect(own.text).toBe("TICKET_ID\n\n- Commit.\n")
  })

  test("keeps the AskUserQuestion paragraph with workers.ask_user_question on", async () => {
    const { text } = await loaded(appConfig({}, project()))
    expect(text).toContain(askUserQuestionTool)
  })

  test("a missing --prompt file is a setup problem", async () => {
    const repo = project("TICKET_ID")
    expect(await problems(withFlag(repo, "missing.md"))).toEqual([
      "Worker prompt not found: missing.md (from --prompt or TUTTI_PROMPT).",
    ])
  })

  test("an empty --prompt file is a setup problem", async () => {
    const repo = project()
    writeFileSync(join(repo, "empty.md"), " \n")
    expect(await problems(withFlag(repo, "empty.md"))).toEqual([
      "Worker prompt is empty: empty.md (from --prompt or TUTTI_PROMPT).",
    ])
  })

  test("a --prompt file outside the project is named in full", async () => {
    const elsewhere = join(project(), "gone.md")
    expect(await problems(withFlag(project(), elsewhere))).toEqual([
      `Worker prompt not found: ${elsewhere} (from --prompt or TUTTI_PROMPT).`,
    ])
  })

  test("an empty project file, or a prompt without TICKET_ID, is a setup problem", async () => {
    expect(await problems(appConfig({}, project("")))).toEqual([
      `Worker prompt is empty: ${join(".tutti", "worker-prompt.md")}.`,
    ])
    expect(await problems(appConfig({}, project("No placeholder.\n")))).toEqual([
      `Worker prompt has no TICKET_ID placeholder: ${join(".tutti", "worker-prompt.md")}.`,
    ])
  })

  test("a prompt that can't be read is a setup problem", async () => {
    const repo = project()
    mkdirSync(join(repo, "folder.md"))
    const [problem] = await problems(withFlag(repo, "folder.md"))
    expect(problem).toStartWith(
      "Worker prompt can't be read: folder.md (from --prompt or TUTTI_PROMPT): ",
    )
  })
})
