// init's questions a line at a time (§ 7.1), with the line forms' select, confirm and text
// (src/ui/plain/forms.ts): the offer to import from orchestra, the Workers step under its header,
// and the offer to mark an untrusted main checkout trusted. The end of input (Ctrl+D) cancels, as Esc does in the renderer.
import { Effect } from "effect"
import { confirm, type LineIO, text } from "../ui/plain/forms.ts"
import { offerDescription } from "./import.ts"
import type { InitForm } from "./init.ts"
import { concurrencyNote, parseMcpNames, type WorkersAnswers } from "./workers.ts"

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
