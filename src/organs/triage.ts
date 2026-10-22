// Triage (§ 5 item 13, § 6.2, Appendix A): the organ that says, for each ticket set aside, where
// the cause lies: the environment, the instructions or the problem itself, as orchestra v0.7.7's
// triage does. Its prompt (prompts/triage.md) and answer schema are orchestra's, adapted to tutti's
// workers, which are sessions with no terminal. Its evidence is tutti's own record of the worker:
// the end of its transcript (§ 4.4), the attention requests it raised and their answers, the calls
// Claude Code denied it without asking, its compactions and its worktree's changes, with the ticket
// as bd show gives it. The ticket is named by its ID alone outside the tags, and tutti's line on how
// it was set aside comes last, as Claude reads long inputs best with the request at the end. When it
// is asked, and what becomes of its verdict, is run/triage.ts's.
import { Effect, Schema } from "effect"
import type { Item } from "../agent/Transcripts.ts"
import { denier, unknownDenier } from "../run/log.ts"
import { type InputPart, section } from "./evidence.ts"
import { make, type OrganError, Organs } from "./Organs.ts"
import prompt from "./prompts/triage.md" with { type: "text" }

/** Where the cause of a deferral lies. */
export const causes = ["environment", "instructions", "problem"] as const

/** How sure triage is of it. */
export const confidences = ["high", "medium", "low"] as const

/** Triage's answer, its verdict. */
export const TriageAnswer = Schema.Struct({
  cause: Schema.Literals(causes),
  confidence: Schema.Literals(confidences),
  summary: Schema.String,
  recommendation: Schema.String,
})

export type Verdict = typeof TriageAnswer.Type

export const triage = make("triage", { prompt, answer: TriageAnswer })

/** What goes into the ticket's notes: advice only, its status untouched. */
export const note = (v: Verdict): string =>
  `Triage (tutti): cause = ${v.cause} (${v.confidence} confidence). ${v.summary.trim()} ` +
  `Recommendation: ${v.recommendation.trim()}`

/** The verdict as the ticket's row shows it, after `◆ `: `environment · high · <summary>`. */
export const rowText = (v: Verdict): string => `${v.cause} · ${v.confidence} · ${v.summary.trim()}`

// ---------------------------------------------------------------------------------------------
// The worker's transcript, as text

/** The transcript items triage reads, from the end (§ 6.2). */
export const tailItems = 40

/** The most of their text it is given, from the end. */
export const tailCharacters = 8000

/** The most of one text or tool input. */
export const textCharacters = 400

/** The most of one tool error or failure, which says what went wrong. */
export const errorCharacters = 800

/** The most of one tool result that isn't an error. */
export const resultCharacters = 200

type Fields = Readonly<Record<string, unknown>>

const asRecord = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** `text` on one line, its runs of white space one space, cut to `limit` characters with `…`. */
export const oneLine = (text: string, limit: number): string => {
  const one = text
    .split(/\s+/u)
    .filter((word) => word !== "")
    .join(" ")
  const chars = Array.from(one)
  return chars.length <= limit ? one : `${chars.slice(0, limit - 1).join("")}…`
}

// The input field that says what a call is about, in the order they are looked for.
const inputKeys = ["command", "file_path", "notebook_path", "pattern", "url", "query", "prompt"]

/** What a tool was called with: a command, a file, a pattern, or else its input as JSON. */
const toolInput = (input: unknown): string => {
  const fields = asRecord(input)
  const key = fields === undefined ? undefined : inputKeys.find((k) => asString(fields[k]))
  if (fields !== undefined && key !== undefined) {
    return oneLine(asString(fields[key]) ?? "", textCharacters)
  }
  let json: string | undefined
  try {
    json = JSON.stringify(input)
  } catch {
    json = undefined
  }
  return oneLine(json ?? "", textCharacters)
}

/** A tool result's text: its content as a string, or its text blocks joined. */
const resultText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block) => {
      const b = asRecord(block)
      return b?.type === "text" ? [asString(b.text) ?? ""] : []
    })
    .join("\n")
}

const toolUses = new Set(["tool_use", "server_tool_use", "mcp_tool_use"])

/** A user or assistant message's lines: its text, its tool calls and their results. */
const contentLines = (role: string, content: unknown): ReadonlyArray<string> => {
  if (typeof content === "string") {
    const text = oneLine(content, textCharacters)
    return text === "" ? [] : [`${role}: ${text}`]
  }
  if (!Array.isArray(content)) return []
  return content.flatMap((block): ReadonlyArray<string> => {
    const b = asRecord(block)
    if (b === undefined) return []
    if (b.type === "text") {
      const text = oneLine(asString(b.text) ?? "", textCharacters)
      return text === "" ? [] : [`${role}: ${text}`]
    }
    if (toolUses.has(String(b.type))) {
      return [`tool ${oneLine(asString(b.name) ?? "?", textCharacters)}: ${toolInput(b.input)}`]
    }
    if (b.type === "tool_result") {
      return b.is_error === true
        ? [`tool error: ${oneLine(resultText(b.content), errorCharacters)}`]
        : [`tool result: ${oneLine(resultText(b.content), resultCharacters)}`]
    }
    return [] // thinking, images and the like
  })
}

/** A system message's line, for those that say what happened to the worker; none for the rest. */
const systemLines = (m: Fields): ReadonlyArray<string> => {
  switch (m.subtype) {
    case "compact_boundary": {
      const meta = asRecord(m.compact_metadata)
      const trigger = asString(meta?.trigger) ?? "unknown"
      const tokens =
        typeof meta?.pre_tokens === "number" ? `, ${meta.pre_tokens} tokens before` : ""
      return [`system: context compacted (${oneLine(trigger, textCharacters)}${tokens})`]
    }
    case "permission_denied": {
      const by = denier(asString(m.decision_reason_type) ?? unknownDenier)
      const reason = asString(m.decision_reason) ?? asString(m.message) ?? ""
      const why = reason.trim() === "" ? "" : `: ${reason}`
      return [
        `system: ${oneLine(`${asString(m.tool_name) ?? "a tool call"} denied by ${by}${why}`, errorCharacters)}`,
      ]
    }
    case "api_retry": {
      const status = typeof m.error_status === "number" ? `, status ${m.error_status}` : ""
      const error = oneLine(asString(m.error) ?? "unknown", textCharacters)
      return [`system: API request failed (${error}${status}), retried`]
    }
  }
  return []
}

/** A result message's line: how the turn ended, with its errors. */
const resultLines = (m: Fields): ReadonlyArray<string> => {
  const subtype = oneLine(asString(m.subtype) ?? "unknown", textCharacters)
  const errors = Array.isArray(m.errors)
    ? m.errors.filter((e): e is string => typeof e === "string")
    : []
  const failure =
    errors.length > 0 ? errors.join("; ") : m.is_error === true ? (asString(m.result) ?? "") : ""
  return failure.trim() === ""
    ? [`turn ended: ${subtype}`]
    : [`turn ended: ${subtype}: ${oneLine(failure, errorCharacters)}`]
}

/**
 * One transcript item as lines of text: a message, each tool call and result, a compaction, a
 * denial, an API failure, how a turn ended. A subagent's lines say so. The model's thinking, and
 * the messages that say nothing of what the worker did, have none.
 */
export const itemLines = (item: Item): ReadonlyArray<string> => {
  const m = asRecord(item.message)
  if (m === undefined) return []
  const lines: ReadonlyArray<string> = (() => {
    switch (m.type) {
      case "assistant": {
        const error = asString(m.error)
        return [
          ...contentLines("assistant", asRecord(m.message)?.content),
          ...(error === undefined ? [] : [`assistant error: ${oneLine(error, errorCharacters)}`]),
        ]
      }
      case "user":
        return contentLines("user", asRecord(m.message)?.content)
      case "system":
        return systemLines(m)
      case "result":
        return resultLines(m)
    }
    return []
  })()
  const sub = m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined
  return sub ? lines.map((each) => `subagent ${each}`) : lines
}

/**
 * The end of a transcript as triage reads it: the lines of its last `tailItems` items, cut to
 * `tailCharacters` from the end, a line cut in its middle left out.
 */
export const transcriptText = (items: ReadonlyArray<Item>): string => {
  const text = items.slice(-tailItems).flatMap(itemLines).join("\n")
  const chars = Array.from(text)
  if (chars.length <= tailCharacters) return text
  const end = chars.slice(chars.length - tailCharacters).join("")
  const cut = end.indexOf("\n")
  return cut === -1 ? end : end.slice(cut + 1)
}

/** `once`, `twice`, `3 times`. */
const times = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`)

/**
 * What a transcript's compactions say, from its items: how often its context was compacted, how
 * and when; empty when it never was.
 */
export const compactionsText = (items: ReadonlyArray<Item>): string => {
  const found = items.flatMap((item) => {
    const m = asRecord(item.message)
    if (m?.type !== "system" || m.subtype !== "compact_boundary") return []
    const trigger = asString(asRecord(m.compact_metadata)?.trigger) ?? "unknown"
    return [`${oneLine(trigger, textCharacters)} at ${item.time}`]
  })
  if (found.length === 0) return ""
  return (
    `Its context was compacted ${times(found.length)} (${found.join(", ")}): the summary that ` +
    "replaced its earlier messages may have lost some of what it was told or found."
  )
}

// ---------------------------------------------------------------------------------------------
// The input

/** The evidence gathered for one deferred ticket, as text. */
export interface Evidence {
  /** The ticket's ID: tutti's to name it by. */
  readonly ticket: string
  /** How it was set aside, in tutti's words. */
  readonly how: string
  /** The ticket as bd show gives it. */
  readonly shown: string
  /** The end of its worker's transcript (transcriptText). */
  readonly transcript: string
  /** Its attention requests and their answers, and Claude Code's denials. */
  readonly attention: string
  /** Its compactions (compactionsText). */
  readonly compactions: string
  /** Its worktree's changes: uncommitted, committed, and the files its branch changed. */
  readonly worktree: string
  /** The error its worker's last turn failed with, when it did. */
  readonly failed?: string
}

/** Triage's input: the evidence, in sections, then how the ticket was set aside. */
export const triageInput = (e: Evidence): ReadonlyArray<InputPart> => [
  section("Ticket (bd show)", e.shown),
  section("End of the worker's transcript (messages, tool calls, results)", e.transcript),
  section(
    "The worker's attention requests and their answers, and the calls Claude Code denied it without asking (the classifier, the safety check)",
    e.attention,
  ),
  section("The worker's compactions", e.compactions),
  section("Worktree state", e.worktree),
  ...(e.failed === undefined
    ? []
    : [section("The error the worker's last turn failed with", e.failed)]),
  `Ticket ${e.ticket} was set aside: ${e.how}\n`,
]

/** Triage's verdict on the deferred ticket the evidence is about. */
export const judge = (e: Evidence): Effect.Effect<Verdict, OrganError, Organs> =>
  Effect.flatMap(Organs, (organs) => organs.ask(triage, triageInput(e), { ticket: e.ticket }))
