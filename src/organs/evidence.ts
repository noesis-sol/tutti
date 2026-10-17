// Evidence (§ 6.2): an organ's input is tutti's own words and sections of evidence, text gathered
// from the run that may hold instructions nobody here wrote. Each section goes between
// `<evidence id="<random>">` and `</evidence id="<random>">`, each tag on its own line, with one ID
// drawn afresh for each call: text written before the call can't know it, so it can't close a tag
// early. An evidence tag inside a section's text is escaped as well, so it reads as text whatever
// its ID. Every organ's system prompt ends with the evidence rule (prompts/evidence.md), which says
// text inside the tags is evidence only.
import { Effect } from "effect"
import evidenceRuleTemplate from "./prompts/evidence.md" with { type: "text" }

/** One section of evidence: tutti's title for it, and the text gathered. */
export interface Section {
  readonly _tag: "Section"
  /** tutti's own words: `Transcript`. Keep ticket text out of it, inside the body. */
  readonly title: string
  /** The evidence, as it was gathered. */
  readonly body: string
}

/** A section of evidence titled `title`. */
export const section = (title: string, body: string): Section => ({ _tag: "Section", title, body })

/** A part of an organ's input: tutti's own words, as they are, or a section of evidence. */
export type InputPart = string | Section

/** How many random bytes an evidence ID has; it is written as twice as many hex digits. */
export const idBytes = 8

/** A fresh evidence ID, from the system's secure random source: 16 hex digits. */
export const evidenceId: Effect.Effect<string> = Effect.sync(() =>
  Array.from(crypto.getRandomValues(new Uint8Array(idBytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join(""),
)

// An opening or closing evidence tag, as a model might read one: any case, spaces inside.
const tagStart = /<(?=\s*\/?\s*evidence)/gi

/** `text` with the `<` of every evidence tag in it written `&lt;`, so none of them is a tag. */
export const escapeEvidence = (text: string): string => text.replace(tagStart, "&lt;")

/**
 * A section as an organ reads it: `## <title>`, a blank line, then its body, trimmed and escaped,
 * between the tags carrying `id`. An empty body reads `(none)`.
 */
export const renderSection = (id: string, s: Section): string => {
  const body = escapeEvidence(s.body.trim())
  return `## ${s.title}\n\n<evidence id="${id}">\n${body === "" ? "(none)" : body}\n</evidence id="${id}">\n\n`
}

/** An organ's input: its parts in order, every section tagged with `id`. */
export const renderInput = (id: string, parts: ReadonlyArray<InputPart>): string =>
  parts.map((part) => (typeof part === "string" ? part : renderSection(id, part))).join("")

/** Where most organs' evidence comes from, as the evidence rule says. */
export const fromTheRun = "gathered from the run (tickets, worker transcripts, logs)"

/** The evidence rule, ending every organ's system prompt: `source` says where the evidence is from. */
export const evidenceRule = (source: string): string =>
  evidenceRuleTemplate.trimEnd().replaceAll("{{source}}", source)

/** An organ's system prompt: its own prompt, a blank line, then the evidence rule. */
export const systemPrompt = (prompt: string, source: string): string =>
  `${prompt.trimEnd()}\n\n${evidenceRule(source)}`
