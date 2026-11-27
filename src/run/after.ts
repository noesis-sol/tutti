// Why a held ticket waits, in the words the log and Up next share (§ 7.2, tutti-zv69): each reason
// starts `after` and names the ticket or tickets it waits for, which the panel draws in the live
// role: `after t-1: both touch src/a.ts`, `after t-1 merges`, `after t-1, t-2 merge`,
// `after t-1 (solo)`, `after its subtickets: t-1.1, t-1.2, then +3`; the solo ticket next, its own
// words, `next, alone: after t-1, t-2 finish`. afterParts finds the names again in a reason as the
// log said it.

/** How many of a parent's subtickets its reason names before `then +N`. */
const subticketsNamed = 2

/** `after <id>: both touch <what>`: it overlaps the running ticket `id` at `what`. */
export const afterOverlap = (id: string, what: string): string => `after ${id}: both touch ${what}`

/** `after <id> merges`, `after <a>, <b> merge`: it waits for `ids` to merge. */
export const afterMerging = (ids: ReadonlyArray<string>): string =>
  `after ${ids.join(", ")} ${ids.length === 1 ? "merges" : "merge"}`

/** `after <id> (solo)`: it waits for the solo ticket `id`, running or next. */
export const afterSolo = (id: string): string => `after ${id} (solo)`

/** How many running tickets the solo ticket next names before `then +N`. */
const runningNamed = 3

/**
 * `next, alone: after <id> finishes`, `next, alone: after <a>, <b> finish`, `…, then +N finish`:
 * the solo ticket next waits for the tickets running, and those past their work, `ids`, to finish;
 * `next, alone` while it waits for none.
 */
export const soloNextAfter = (ids: ReadonlyArray<string>): string => {
  if (ids.length === 0) return "next, alone"
  const named = ids.slice(0, runningNamed)
  const rest = ids.length - named.length
  const finish = ids.length === 1 ? "finishes" : "finish"
  return `next, alone: after ${named.join(", ")}${rest > 0 ? `, then +${rest}` : ""} ${finish}`
}

/** The solo ticket next, in a run that won't start it: winding down, stopping or at --limit. */
export const soloNextRun = "alone, in the next run"

/** `after its subtickets: <a>, <b>, then +N`: it waits for its subtickets `ids`. */
export const afterSubtickets = (ids: ReadonlyArray<string>): string => {
  const named = ids.slice(0, subticketsNamed)
  const rest = ids.length - named.length
  return `after its subtickets: ${named.join(", ")}${rest > 0 ? `, then +${rest}` : ""}`
}

/** A piece of a reason: a ticket it waits for (`id`), or the words around one. */
export interface AfterPart {
  readonly text: string
  readonly id: boolean
}

// `after `, `after its subtickets: ` or `next, alone: after `, then the names, `, ` between them,
// then the rest. A name holds no space, comma, colon or bracket, and doesn't start with `+`;
// `then +N` ends the names.
const name = String.raw`[^\s,:()+][^\s,:()]*`
const shape = new RegExp(
  String.raw`^((?:next, alone: )?after (?:its subtickets: )?)(${name}(?:, (?!then \+)${name})*)([\s\S]*)$`,
)

/**
 * `reason` in pieces, the tickets it waits for apart from the words around them; the whole of it
 * as words where it names none, as a reason not of afterOverlap's and the others' shapes.
 */
export const afterParts = (reason: string): ReadonlyArray<AfterPart> => {
  const found = shape.exec(reason)
  if (found === null) return [{ text: reason, id: false }]
  const [, head = "", names = "", tail = ""] = found
  const ids = names.split(", ")
  return [
    { text: head, id: false },
    ...ids.flatMap((id, i) => [
      ...(i === 0 ? [] : [{ text: ", ", id: false }]),
      { text: id, id: true },
    ]),
    ...(tail === "" ? [] : [{ text: tail, id: false }]),
  ]
}
