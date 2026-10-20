// init's questions a line at a time (§ 7.1), with the line forms' select, confirm and text
// (src/ui/plain/forms.ts): the offer to import from orchestra, the Workers step and the Checks step
// under their headers, and the offer to mark an untrusted main checkout trusted. The scout runs to
// its end, as in huh's accessible form; a checklist is the numbers of the suites ticked, and the MCP
// servers their names. The end of input (Ctrl+D) cancels, as Esc does in the renderer.
import { Effect } from "effect"
import { confirm, type LineIO, select, text } from "../ui/plain/forms.ts"
import { type Fields, initForm } from "./form.ts"
import type { InitForm } from "./init.ts"
import { parseMcpNames } from "./workers.ts"

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

/** init's fields in lines, on `io`. */
export const lineFields = (io: LineIO): Fields => {
  const { form } = io.theme
  return {
    step: (name) => Effect.sync(() => io.write(`${form.fieldTitle.paint(name)}\n\n`)),
    note: (line) => Effect.sync(() => io.write(`${form.description.paint(line)}\n\n`)),
    confirm: (field) => confirm(io, field),
    select: (field) => select(io, field),
    text: (field) => text(io, field),
    checklist: (field) =>
      Effect.gen(function* () {
        const count = field.options.length
        const listed = field.options.map((option, at) => `${at + 1}. ${option}`).join("\n")
        const typed = yield* text(io, {
          title: field.title,
          description: `${field.description}\n${listed}\nNumbers, comma-separated; - for none; Enter keeps ${field.ticked.length === 0 ? "none" : field.ticked.map((at) => at + 1).join(", ")}.`,
          validate: (answer) => {
            const read = readTicked(answer, count, field.ticked)
            return "error" in read ? read.error : null
          },
        })
        const read = readTicked(typed, count, field.ticked)
        return "ok" in read ? read.ok : []
      }),
    servers: ({ available, chosen }) =>
      Effect.gen(function* () {
        const typed = yield* text(io, {
          title: "MCP servers workers get",
          description: `Defined here: ${available.join(", ")}. Names, comma-separated; - for none; Enter keeps ${chosen.length === 0 ? "none" : chosen.join(", ")}.`,
          validate: (answer) => {
            const read = readServers(answer, chosen, available)
            return "error" in read ? read.error : null
          },
        })
        const read = readServers(typed, chosen, available)
        return "ok" in read ? read.ok : chosen
      }),
    scout: (search) =>
      Effect.gen(function* () {
        io.write(
          `${form.description.paint("Looking for the project's suites (up to 5 minutes)…")}\n`,
        )
        return yield* search.pipe(
          Effect.match({
            onSuccess: (found) => ({ found }),
            onFailure: (failed) => ({ failed }),
          }),
        )
      }),
  }
}

/** init's form in lines, on `io`. */
export const lineForm = (io: LineIO): InitForm => initForm(lineFields(io))
