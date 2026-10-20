// init's questions (§ 8.3), asked in its two steps, Workers and Checks, and the offers before and
// after them: what each step asks, in order, and what its answers make. The form that asks them is
// made of fields (Fields): the renderer's (src/ui/InitForm.tsx), under a stepper, or the line forms'
// (lineForm.ts), for TERM=dumb. The fields differ in how they look and read; the questions, their
// words and their order are the same in both, so both are asked from here.
import { Effect } from "effect"
import type { Scouting } from "../organs/scout.ts"
import type { FormCancelled } from "../ui/questions.ts"
import {
  type ChecksAnswers,
  type ChecksChoice,
  type ChecksQuestions,
  checksOptions,
  chooseFound,
  filesTestWork,
  runnersDiffer,
  runsDescription,
  type ScoutResult,
  settleScout,
  skillDir,
  suiteLabel,
  verifierDescription,
} from "./checks.ts"
import { offerDescription } from "./import.ts"
import type { InitForm } from "./init.ts"
import { fastRunner, fullRunner } from "./runners.ts"
import {
  concurrencyNote,
  normalPrefix,
  prefixProblem,
  renamedId,
  type WorkersAnswers,
  type WorkersQuestions,
} from "./workers.ts"

/** init's two steps, in order. */
export const stepNames = ["Workers", "Checks"] as const

export type StepName = (typeof stepNames)[number]

/** A yes or no. */
export interface ConfirmField {
  readonly question: string
  readonly description?: string
  /** The answer Enter gives; false by default. */
  readonly initial?: boolean
}

/** One of `options`, by its index. */
export interface SelectField {
  readonly title: string
  readonly description?: string
  readonly options: ReadonlyArray<string>
  /** The option selected at first; the first by default. */
  readonly initial?: number
}

/** A line of text, asked again while `validate` says what is wrong with it. */
export interface TextField {
  readonly title: string
  readonly description?: string
  readonly validate?: (answer: string) => string | null
}

/** Any of `options`, `ticked` (their indexes) at first. */
export interface ChecklistField {
  readonly title: string
  readonly description: string
  readonly options: ReadonlyArray<string>
  readonly ticked: ReadonlyArray<number>
}

/** The MCP servers question: those defined for the project, and those chosen now. */
export type ServersField = NonNullable<WorkersQuestions["mcp"]>

/**
 * What init's form is made of. Each field fails with FormCancelled when it is cancelled (Esc or
 * Ctrl+C in the renderer, the end of input in lines).
 */
export interface Fields {
  /** A step begins. */
  readonly step: (name: StepName) => Effect.Effect<void>
  /** A line that says something, among the step's questions. */
  readonly note: (line: string) => Effect.Effect<void>
  readonly confirm: (field: ConfirmField) => Effect.Effect<boolean, FormCancelled>
  readonly select: (field: SelectField) => Effect.Effect<number, FormCancelled>
  /** The line, trimmed. */
  readonly text: (field: TextField) => Effect.Effect<string, FormCancelled>
  /** The indexes ticked, in order. */
  readonly checklist: (field: ChecklistField) => Effect.Effect<ReadonlyArray<number>, FormCancelled>
  /** The servers chosen. */
  readonly servers: (field: ServersField) => Effect.Effect<ReadonlyArray<string>, FormCancelled>
  /** Runs the scout's search: what it found, or why not, skipped included where it can be. */
  readonly scout: (
    search: Effect.Effect<Scouting, string>,
  ) => Effect.Effect<ScoutResult, FormCancelled>
}

/** The concurrency typed, or what is wrong with it; "" keeps `initial`. */
export const readConcurrency = (
  answer: string,
  initial: number,
  max: number,
): { readonly ok: number } | { readonly error: string } => {
  const typed = answer.trim()
  if (typed === "") return { ok: initial }
  const n = /^\d+$/.test(typed) ? Number(typed) : Number.NaN
  return n >= 1 && n <= max ? { ok: n } : { error: `Enter a whole number from 1 to ${max}.` }
}

/** init's form, asked with `fields`. */
export const initForm = (fields: Fields): InitForm => ({
  workers: (questions) =>
    Effect.gen(function* () {
      yield* fields.step("Workers")
      let answers: WorkersAnswers = {}
      if (questions.installBeads !== null) {
        const { method, command } = questions.installBeads
        const installBeads = yield* fields.confirm({
          question: "Install Beads?",
          description: `bd isn't installed. tutti can install it with ${method}: ${command}`,
          initial: true,
        })
        answers = { ...answers, installBeads }
      }
      if (questions.concurrent !== null) {
        const { initial, max } = questions.concurrent
        const typed = yield* fields.text({
          title: "Tickets to run at the same time",
          description: `1 to ${max}; each worker takes about 1 GiB of memory. Enter keeps ${initial}.`,
          validate: (answer) => {
            const read = readConcurrency(answer, initial, max)
            return "error" in read ? read.error : null
          },
        })
        const read = readConcurrency(typed, initial, max)
        if ("ok" in read) {
          const note = concurrencyNote(read.ok)
          if (note !== null) yield* fields.note(`${read.ok} workers: ${note}`)
          answers = { ...answers, concurrent: read.ok }
        }
      }
      if (questions.mcp !== null) {
        answers = { ...answers, mcp: yield* fields.servers(questions.mcp) }
      }
      if (questions.changelogUnion) {
        const changelogUnion = yield* fields.confirm({
          question: "Merge CHANGELOG.md by union?",
          description:
            "Tickets that each add a changelog entry at the same spot conflict; CHANGELOG.md merge=union in .gitattributes has git keep both sides' lines.",
          initial: true,
        })
        answers = { ...answers, changelogUnion }
      }
      return answers
    }),
  checks: (questions: ChecksQuestions) =>
    Effect.gen(function* () {
      yield* fields.step("Checks")
      let answers: ChecksAnswers = {}
      let stack: ReadonlyArray<string> = []
      let choice: ChecksChoice | undefined
      if (questions.checks !== null) {
        const asked = questions.checks
        const result = yield* fields.scout(asked.scout)
        const scouted = settleScout(result, asked.checkScript)
        stack = scouted.stack
        const picked = yield* fields.select({
          title: "The project's checks",
          description: scouted.why,
          options: checksOptions.map((option) => option.label),
          initial: checksOptions.findIndex((option) => option.kind === scouted.picked),
        })
        const kind = checksOptions[picked]?.kind ?? "manual"
        if (kind === "found") {
          const all = scouted.suites.map((_, index) => index)
          // The suites `offered`, `ticked` at first: those ticked, as indexes of all the suites.
          const checklist = (
            title: string,
            description: string,
            offered: ReadonlyArray<number>,
            ticked: ReadonlyArray<number>,
          ) =>
            Effect.gen(function* () {
              if (offered.length === 0) return []
              const at = yield* fields.checklist({
                title,
                description,
                options: offered.map((index) => {
                  const suite = scouted.suites[index]
                  return suite === undefined ? "" : suiteLabel(suite)
                }),
                ticked: ticked.map((index) => offered.indexOf(index)),
              })
              return at.flatMap((each) => offered[each] ?? [])
            })
          const fast = yield* checklist(
            "On every merge (check-fast)",
            `${fastRunner} runs these on every ticket rebased before it merges: the quick ones.`,
            all,
            scouted.fast,
          )
          const full = yield* checklist(
            "At the end of a run (check-full)",
            `${fullRunner} runs ${fastRunner}, then these, once at the end of a run. A suite ticked above as well runs in check-fast only.`,
            scouted.full,
            scouted.full,
          )
          const fileUntested = yield* fields.confirm({
            question: "Also file tickets for untested areas?",
            description:
              "A ticket asks a worker to map the project's features with the create-check-suite skill, and to file a ticket for each area no suite tests.",
          })
          choice = chooseFound(scouted, fast, full, fileUntested)
        } else if (kind === "scratch") {
          choice = { kind: "scratch" }
        } else {
          const typed = yield* fields.text({
            title: "Check command",
            description: `Lint, build and tests, the one command ${fastRunner} runs. ${
              asked.command === ""
                ? asked.keepsRunner
                  ? `Enter keeps ${fastRunner} as it is.`
                  : "Enter for a runner that checks nothing."
                : `Enter keeps '${asked.command}'; - for a runner that checks nothing.`
            }`,
          })
          choice = {
            kind: "manual",
            command: typed === "" ? asked.command : typed === "-" ? "" : typed,
          }
        }
        answers = { ...answers, checks: choice, stack }
        const differ = runnersDiffer(asked.runners, choice)
        const replace = (path: string, script: string | null) =>
          fields.confirm({
            question: `Replace ${path}?`,
            description: `${path} is there, and differs from the checks chosen. ${runsDescription(script ?? "")}`,
          })
        if (differ.fast) {
          answers = { ...answers, replaceFast: yield* replace(fastRunner, asked.runners.fast) }
        }
        if (differ.full) {
          answers = { ...answers, replaceFull: yield* replace(fullRunner, asked.runners.full) }
        }
        if (asked.skill === "differs" && filesTestWork(choice)) {
          const replaceSkill = yield* fields.confirm({
            question: `Replace ${skillDir}/?`,
            description: `${skillDir}/ is there, and differs from tutti's. The tickets init files ask workers to use the create-check-suite skill.`,
          })
          answers = { ...answers, replaceSkill }
        }
      }
      if (questions.setup !== null) {
        const { offer, lockfiles } = questions.setup
        const typed = yield* fields.text({
          title: "Setup command",
          description: `Installs the dependencies in a ticket's worktree before check-fast, when a rebase changes ${lockfiles.join(", ")}. Enter keeps '${offer}'; - for none.`,
        })
        answers = { ...answers, setup: typed === "" ? offer : typed === "-" ? "" : typed }
      }
      if (questions.prefix !== null) {
        const { current, isNew, tickets, example, refusal } = questions.prefix
        if (refusal !== null) {
          yield* fields.note(
            `The ticket prefix stays ${current} for now: the tickets can't be renamed while ${refusal}.`,
          )
        } else {
          const typed = yield* fields.text({
            title: "Ticket prefix",
            description: `Ticket IDs read <prefix>-<hash>. Enter keeps ${current}.`,
            validate: (answer) => {
              const prefix = normalPrefix(answer)
              return prefix === "" ? null : prefixProblem(prefix)
            },
          })
          const prefix = normalPrefix(typed)
          if (prefix !== "" && prefix !== current) {
            const rename =
              isNew ||
              (yield* fields.confirm({
                question: `Rename ${tickets === 1 ? "1 ticket" : `${tickets} tickets`}${example === null ? "" : `, ${example} → ${renamedId(example, current, prefix)}`}?`,
              }))
            if (rename) answers = { ...answers, prefix }
          }
        }
      }
      if (questions.verifier) {
        const verifier = yield* fields.confirm({
          question: "Add a verification step for workers?",
          description: verifierDescription(stack),
          initial: true,
        })
        answers = { ...answers, verifier }
      }
      return answers
    }),
  trust: (offer) =>
    fields.confirm({
      question: `Mark ${offer.checkout} trusted?`,
      description: `${offer.explanation} tutti would set ${offer.key} in ${offer.file}, as Claude Code suggests.`,
    }),
  import: (offer) =>
    fields.confirm({
      question: "Import orchestra's settings and worker prompt?",
      description: offerDescription(offer),
      initial: true,
    }),
})
