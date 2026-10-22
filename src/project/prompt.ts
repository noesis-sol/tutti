// The worker prompt (§ 4.11): the standing rules each worker gets in its system prompt. It comes
// from --prompt (or TUTTI_PROMPT), else the project's .tutti/worker-prompt.md, else tutti's
// built-in template. TICKET_ID is its placeholder for the ticket's ID. With
// workers.ask_user_question off (§ 15, Q3), the paragraphs that mention AskUserQuestion are dropped,
// since the workers don't get the tool.
import { isAbsolute, join, relative, resolve } from "node:path"
import { Effect, FileSystem, Option } from "effect"
import { coresVariable, orchestraCoresVariable } from "../agent/env.ts"
import { type AppConfigValue, SetupProblem, workerPromptFile } from "../cli/AppConfig.ts"
import { settingsFile } from "./settings.ts"
import builtIn from "./templates/worker-prompt.md" with { type: "text" }

/** tutti's built-in worker prompt, as `tutti init` writes it to .tutti/worker-prompt.md. */
export const builtInWorkerPrompt: string = builtIn

/**
 * The template's lines on how to run each suite on part of the project, where init doesn't know the
 * suites: they say where the suites are. Where it knows them, init puts a bullet a suite in their
 * place (`withSuites`).
 */
export const unknownSuitesLines =
  "  The suites are the commands `scripts/check-fast.sh` and `scripts/check-full.sh` list, a command a\n" +
  "  line: run each on part of the project where its tool allows it (`go test ./<package>/...`,\n" +
  "  `pytest <paths>`, `eslint <files>`), and whole where it doesn't.\n"

/**
 * `prompt` with `lines` on how to run each suite on part of the project; as it is with none. A
 * function puts them in, as a replacement string would read the commands' $$, $&, $` and $'.
 */
export const withSuites = (prompt: string, lines: string): string =>
  lines === "" ? prompt : prompt.replace(unknownSuitesLines, () => lines)

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
  prompt.text.replaceAll(ticketIdPlaceholder, () => id)

/**
 * The file in a worktree that checkNote has a worker save a check's whole output to, under its
 * .tutti/run/, which git ignores: not check.log, which holds the output of the run's own check.
 */
export const workerCheckLog = ".tutti/run/worker-check.log"

/**
 * The note appended to a worker's standing rules that has it run a check once, its whole output in
 * workerCheckLog and its exit status printed, then read the file rather than run the check again to
 * see what it said: workers piped a check through tail, which hides its exit status, then ran it
 * again, minutes of a full check each time, to learn whether it passed. Its example is the
 * worker's own check (checks.own.command) when the project has one, else its merge check
 * (checks.fast.command). It ends with coresNote.
 */
export const checkNote = (command: string | null): string =>
  `\n\nRun a check (tests, linters, a build) once, its whole output saved to a file in .tutti/run ` +
  `(never committed) and its exit status printed, as in ` +
  `'${command ?? "<the check>"} > ${workerCheckLog} 2>&1; echo "exit $?"', then read the file's ` +
  `end or search it, rather than running the check again to see its output or whether it ` +
  `passed. Piping a check through tail hides its exit status. ${coresNote}\n`

/**
 * The check note's last sentence: a worker's environment gives it its share of the machine's
 * cores (src/agent/env.ts's coreVariables), for its checks to keep to, as orchestra 0.9.0's does.
 */
export const coresNote =
  `Other workers' checks run on this machine beside yours: ${coresVariable} in your environment ` +
  `(and ${orchestraCoresVariable}, for scripts written for orchestra) is your share of its cores, ` +
  `so a check that runs things side by side (test files or packages, a linter's jobs, a build) ` +
  `runs no more than that many at once; GOFLAGS has Go's commands keep to it already (-p).`

/** The words of the worker prompt's rule on the requires list, as orchestra's RequiresRule. */
export const requiresRule = "never by hand outside the list"

/**
 * The note appended to a worker's standing rules on the project's requires list (`requires` in
 * .tutti/settings.json, src/project/requires.ts), naming the entries it has now, `names`: a ticket
 * that needs a tool, service or permission the list lacks adds an entry for it, commits it with the
 * ticket, and installs it with that entry's own install, so that the next machine has it too;
 * workers installed what they found missing by hand, and nothing recorded it. A worker prompt,
 * `prompt`, that says so already (requiresRule), as tutti's template does since its version 6, is
 * told only what the list has. Where the main checkout has a README.md (`readme`), a worker that
 * changes the list is asked to write the README's section on what to install from it again, in the
 * same commit. A worker given tutti's requires tools (`tools`, src/agent/requiresTools.ts) is told
 * to check and install with requires_check, and to write the README's section with
 * requires_readme; one without them, to run tutti requires --readme.
 */
export const requiresNote = (
  names: ReadonlyArray<string>,
  prompt: string,
  readme: boolean,
  tools = false,
): string => {
  const where = `"requires" in ${settingsFile}`
  const has = names.length === 0 ? "which has no entries yet" : `which has ${names.join(", ")} now`
  const toolsNote = tools
    ? " tutti's requires_check tool checks the list in your worktree, and installs what is " +
      "missing with each entry's own install command."
    : ""
  const readmeNote = !readme
    ? ""
    : tools
      ? " A ticket that changes the list calls tutti's requires_readme tool, which writes " +
        "README.md's section on what to install from it, and commits that with the list."
      : " A ticket that changes the list runs tutti requires --readme, which writes README.md's " +
        "section on what to install from it, and commits that with the list."
  if (prompt.includes(requiresRule)) {
    return `\n\nThe project's requires list is ${where}, ${has}.${toolsNote}${readmeNote}\n`
  }
  return (
    `\n\nWhat this project needs of the machine (a tool, a service, a permission) is its requires ` +
    `list, ${where}, ${has}. A ticket that needs one the list doesn't have adds an entry for it (a ` +
    "name, a check, and an install command that runs without sudo, or a manual step for a person), " +
    "commits it with the ticket, and installs it with that entry's own install command, " +
    `${requiresRule}: what isn't on the list isn't on the next machine. A manual step is asked of ` +
    `the maintainer as a question.${toolsNote}${readmeNote}\n`
  )
}

/**
 * The note appended to a worker's standing rules after checkNote on the account's usage limit, as
 * orchestra 0.8.1's: a worker stopped by the limit waits in the run's hold and is told to carry on
 * after the reset (§ 4.12), so it commits what it has and stops, rather than deferring or closing
 * its ticket. A note, not a line of the template, so a project's own worker prompt gets it too.
 */
export const usageLimitNote =
  "\nAt the account's usage limit, commit what you have and stop, without deferring or closing " +
  "the ticket for it: you'll carry on after the reset.\n"

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
