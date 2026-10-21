// The worker prompt (§ 4.11): the standing rules each worker gets in its system prompt. It comes
// from --prompt (or TUTTI_PROMPT), else the project's .tutti/worker-prompt.md, else tutti's
// built-in template. TICKET_ID is its placeholder for the ticket's ID. With
// workers.ask_user_question off (§ 15, Q3), the paragraphs that mention AskUserQuestion are dropped,
// since the workers don't get the tool.
import { isAbsolute, join, relative, resolve } from "node:path"
import { Effect, FileSystem, Option } from "effect"
import { type AppConfigValue, SetupProblem, workerPromptFile } from "../cli/AppConfig.ts"
import { settingsFile } from "./settings.ts"
import builtIn from "./templates/worker-prompt.md" with { type: "text" }

/** tutti's built-in worker prompt, as `tutti init` writes it to .tutti/worker-prompt.md. */
export const builtInWorkerPrompt: string = builtIn

/** The worker prompt's placeholder for the ticket's ID. */
export const ticketIdPlaceholder = "TICKET_ID"

/** The tool the paragraphs dropped without workers.ask_user_question name. */
export const askUserQuestionTool = "AskUserQuestion"

/** A run's worker prompt, TICKET_ID still in it, and where it came from. */
export interface WorkerPrompt {
  readonly text: string
  /** The file it was read from, absolute; null for the built-in template. */
  readonly file: string | null
}

const bullet = /^\s*[-*+] /
const heading = /^#/

/**
 * `prompt` without the paragraphs that mention AskUserQuestion. A paragraph is a list item with
 * its continuation lines, a heading, or the lines between those and blank lines; a nested item is
 * its own.
 */
export const withoutAskUserQuestion = (prompt: string): string => {
  const kept: Array<string> = []
  let paragraph: Array<string> = []
  const end = () => {
    if (!paragraph.some((line) => line.includes(askUserQuestionTool))) kept.push(...paragraph)
    paragraph = []
  }
  for (const line of prompt.split("\n")) {
    if (line.trim() === "") {
      end()
      kept.push(line)
    } else {
      if (bullet.test(line) || heading.test(line)) end()
      paragraph.push(line)
      if (heading.test(line)) end()
    }
  }
  end()
  return kept.join("\n")
}

/** The worker prompt for ticket `id`: its standing rules. */
export const forTicket = (prompt: WorkerPrompt, id: string): string =>
  prompt.text.replaceAll(ticketIdPlaceholder, id)

/** `file` as a problem names it: from the project's top when it is inside it. */
const shown = (repo: string, file: string): string => {
  const rel = relative(repo, file)
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? file : rel
}

/**
 * The run's worker prompt, with workers.ask_user_question applied. A --prompt file that is missing,
 * empty or unreadable is a setup problem; so is a project file that is empty or unreadable, one
 * missing where `tutti init` set the project up (.tutti/settings.json is there), as in orchestra,
 * and a prompt without TICKET_ID. A missing project file in a project init hasn't set up gives the
 * built-in template.
 */
export const loadWorkerPrompt = (config: Pick<AppConfigValue, "repo" | "prompt" | "settings">) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    // AppConfig resolves the default to the project's file; any other file came from --prompt.
    const own = config.prompt !== resolve(config.repo, workerPromptFile)
    const name = shown(config.repo, config.prompt)
    const from = own ? " (from --prompt or TUTTI_PROMPT)" : ""
    const problem = (sentence: string) => new SetupProblem({ problems: [sentence] })
    const setUp = fs.exists(join(config.repo, settingsFile)).pipe(Effect.orElseSucceed(() => true))
    const read = yield* fs.readFileString(config.prompt).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" && !own
          ? Effect.flatMap(setUp, (there) =>
              there
                ? Effect.fail(
                    problem(`Worker prompt not found: ${name}. Recreate it with: tutti init`),
                  )
                : Effect.succeedNone,
            )
          : error.reason._tag === "NotFound"
            ? Effect.fail(problem(`Worker prompt not found: ${name}${from}.`))
            : Effect.fail(problem(`Worker prompt can't be read: ${name}${from}: ${error.message}`)),
      ),
    )
    const prompt: WorkerPrompt = Option.match(read, {
      onNone: () => ({ text: builtInWorkerPrompt, file: null }),
      onSome: (text) => ({ text, file: config.prompt }),
    })
    if (prompt.text.trim() === "") {
      return yield* problem(`Worker prompt is empty: ${name}${from}.`)
    }
    if (!prompt.text.includes(ticketIdPlaceholder)) {
      return yield* problem(
        `Worker prompt has no ${ticketIdPlaceholder} placeholder: ${name}${from}.`,
      )
    }
    return config.settings.workers.ask_user_question
      ? prompt
      : { ...prompt, text: withoutAskUserQuestion(prompt.text) }
  })
