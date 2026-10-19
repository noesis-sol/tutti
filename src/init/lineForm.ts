// init's questions a line at a time (§ 7.1), with the line forms' select, confirm and text
// (src/ui/plain/forms.ts): the offer to import from orchestra, the Workers step and the Checks step
// under their headers, and the offer to mark an untrusted main checkout trusted. The scout runs to
// its end, as in huh's accessible form; a checklist is the numbers of the suites ticked. The end of
// input (Ctrl+D) cancels, as Esc does in the renderer.
import { Effect } from "effect"
import { confirm, type LineIO, select, text } from "../ui/plain/forms.ts"
import {
  type ChecksAnswers,
  type ChecksChoice,
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
  parseMcpNames,
  prefixProblem,
  renamedId,
  type WorkersAnswers,
} from "./workers.ts"

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

/** The MCP servers typed, or what is wrong with them: names, "" keeping `chosen`, "-" none. */
export const readServers = (
  answer: string,
  chosen: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): { readonly ok: ReadonlyArray<string> } | { readonly error: string } => {
  const typed = answer.trim()
  if (typed === "") return { ok: chosen }
  if (typed === "-") return { ok: [] }
  const names = parseMcpNames(typed)
  const unknown = names.filter((name) => !available.includes(name))
  return unknown.length === 0
    ? { ok: names }
    : { error: `Not defined here: ${unknown.join(", ")}. Choose from ${available.join(", ")}.` }
}

/**
 * The suites ticked in a checklist of `count`, typed as their numbers from 1, or what is wrong with
 * them: "" keeps `initial`, "-" ticks none. Their positions in the checklist, from 0.
 */
export const readTicked = (
  answer: string,
  count: number,
  initial: ReadonlyArray<number>,
): { readonly ok: ReadonlyArray<number> } | { readonly error: string } => {
  const typed = answer.trim()
  if (typed === "") return { ok: initial }
  if (typed === "-") return { ok: [] }
  const words = typed.split(/[\s,]+/).filter((word) => word !== "")
  const numbers = words.map((word) => (/^\d+$/.test(word) ? Number(word) : Number.NaN))
  return numbers.every((n) => n >= 1 && n <= count)
    ? { ok: [...new Set(numbers.map((n) => n - 1))].sort((a, b) => a - b) }
    : { error: `Enter numbers from 1 to ${count}, comma-separated; - for none.` }
}

/** init's form in lines, on `io`. */
export const lineForm = (io: LineIO): InitForm => ({
  workers: (questions) =>
    Effect.gen(function* () {
      const { form } = io.theme
      io.write(`${form.fieldTitle.paint("Workers")}\n\n`)
      let answers: WorkersAnswers = {}
      if (questions.installBeads !== null) {
        const { method, command } = questions.installBeads
        const installBeads = yield* confirm(io, {
          question: "Install Beads?",
          description: `bd isn't installed. tutti can install it with ${method}: ${command}`,
          initial: true,
        })
        answers = { ...answers, installBeads }
      }
      if (questions.concurrent !== null) {
        const { initial, max } = questions.concurrent
        const typed = yield* text(io, {
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
          if (note !== null)
            io.write(`${form.description.paint(`${read.ok} workers: ${note}`)}\n\n`)
          answers = { ...answers, concurrent: read.ok }
        }
      }
      if (questions.mcp !== null) {
        const { available, chosen } = questions.mcp
        const typed = yield* text(io, {
          title: "MCP servers workers get",
          description: `Defined here: ${available.join(", ")}. Names, comma-separated; - for none; Enter keeps ${chosen.length === 0 ? "none" : chosen.join(", ")}.`,
          validate: (answer) => {
            const read = readServers(answer, chosen, available)
            return "error" in read ? read.error : null
          },
        })
        const read = readServers(typed, chosen, available)
        if ("ok" in read) answers = { ...answers, mcp: read.ok }
      }
      if (questions.changelogUnion) {
        const changelogUnion = yield* confirm(io, {
          question: "Merge CHANGELOG.md by union?",
          description:
            "Tickets that each add a changelog entry at the same spot conflict; CHANGELOG.md merge=union in .gitattributes has git keep both sides' lines.",
          initial: true,
        })
        answers = { ...answers, changelogUnion }
      }
      return answers
    }),
  checks: (questions) =>
    Effect.gen(function* () {
      const { form } = io.theme
      const note = (line: string) => io.write(`${form.description.paint(line)}\n\n`)
      io.write(`${form.fieldTitle.paint("Checks")}\n\n`)
      let answers: ChecksAnswers = {}
      let stack: ReadonlyArray<string> = []
      let choice: ChecksChoice | undefined
      if (questions.checks !== null) {
        const asked = questions.checks
        io.write(
          `${form.description.paint("Looking for the project's suites (up to 5 minutes)…")}\n`,
        )
        const result: ScoutResult = yield* asked.scout.pipe(
          Effect.match({
            onSuccess: (found) => ({ found }),
            onFailure: (failed) => ({ failed }),
          }),
        )
        const scouted = settleScout(result, asked.checkScript)
        stack = scouted.stack
        const picked = yield* select(io, {
          title: "The project's checks",
          description: scouted.why,
          options: checksOptions.map((option) => option.label),
          initial: checksOptions.findIndex((option) => option.kind === scouted.picked),
        })
        const kind = checksOptions[picked]?.kind ?? "manual"
        if (kind === "found") {
          const listed = (indexes: ReadonlyArray<number>) =>
            indexes
              .map((index, at) => {
                const suite = scouted.suites[index]
                return `${at + 1}. ${suite === undefined ? "" : suiteLabel(suite)}`
              })
              .join("\n")
          const all = scouted.suites.map((_, index) => index)
          const checklist = (
            title: string,
            about: string,
            offered: ReadonlyArray<number>,
            ticked: ReadonlyArray<number>,
          ) =>
            Effect.gen(function* () {
              if (offered.length === 0) return []
              const initial = ticked.map((index) => offered.indexOf(index))
              const typed = yield* text(io, {
                title,
                description: `${about}\n${listed(offered)}\nNumbers, comma-separated; - for none; Enter keeps ${initial.length === 0 ? "none" : initial.map((at) => at + 1).join(", ")}.`,
                validate: (answer) => {
                  const read = readTicked(answer, offered.length, initial)
                  return "error" in read ? read.error : null
                },
              })
              const read = readTicked(typed, offered.length, initial)
              return "ok" in read ? read.ok.flatMap((at) => offered[at] ?? []) : []
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
          const fileUntested = yield* confirm(io, {
            question: "Also file tickets for untested areas?",
            description:
              "A ticket asks a worker to map the project's features with the create-check-suite skill, and to file a ticket for each area no suite tests.",
          })
          choice = chooseFound(scouted, fast, full, fileUntested)
        } else if (kind === "scratch") {
          choice = { kind: "scratch" }
        } else {
          const typed = yield* text(io, {
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
          confirm(io, {
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
          const replaceSkill = yield* confirm(io, {
            question: `Replace ${skillDir}/?`,
            description: `${skillDir}/ is there, and differs from tutti's. The tickets init files ask workers to use the create-check-suite skill.`,
          })
          answers = { ...answers, replaceSkill }
        }
      }
      if (questions.setup !== null) {
        const { offer, lockfiles } = questions.setup
        const typed = yield* text(io, {
          title: "Setup command",
          description: `Installs the dependencies in a ticket's worktree before check-fast, when a rebase changes ${lockfiles.join(", ")}. Enter keeps '${offer}'; - for none.`,
        })
        answers = { ...answers, setup: typed === "" ? offer : typed === "-" ? "" : typed }
      }
      if (questions.prefix !== null) {
        const { current, isNew, tickets, example, refusal } = questions.prefix
        if (refusal !== null) {
          note(
            `The ticket prefix stays ${current} for now: the tickets can't be renamed while ${refusal}.`,
          )
        } else {
          const typed = yield* text(io, {
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
              (yield* confirm(io, {
                question: `Rename ${tickets === 1 ? "1 ticket" : `${tickets} tickets`}${example === null ? "" : `, ${example} → ${renamedId(example, current, prefix)}`}?`,
              }))
            if (rename) answers = { ...answers, prefix }
          }
        }
      }
      if (questions.verifier) {
        const verifier = yield* confirm(io, {
          question: "Add a verification step for workers?",
          description: verifierDescription(stack),
          initial: true,
        })
        answers = { ...answers, verifier }
      }
      return answers
    }),
  trust: (offer) =>
    confirm(io, {
      question: `Mark ${offer.checkout} trusted?`,
      description: `${offer.explanation} tutti would set ${offer.key} in ${offer.file}, as Claude Code suggests.`,
    }),
  import: (offer) =>
    confirm(io, {
      question: "Import orchestra's settings and worker prompt?",
      description: offerDescription(offer),
      initial: true,
    }),
})
