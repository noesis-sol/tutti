// Claude Code's tools, in one table: what a call of each is doing (§ 4.2), and the input field that
// says what it is about, which the worker view, the permission requests and DENIED lines, and
// triage all show. Each reader keeps its own cut and sanitising; the field is chosen here once.
import { Predicate } from "effect"
import { asRecord } from "./untrusted.ts"

/** What a working worker is doing, from its hook callbacks, as orchestra classifies it. */
export type Doing = "testing" | "editing" | "reading" | "subagent" | "working"

/** A tool: what a call of it is doing, and the input field that says what the call is about. */
export interface Tool {
  readonly doing: Doing
  readonly about?: string
}

// Grep's and Glob's pattern, not their path: the pattern is what the call looks for, the path only
// where. Bash's doing is "working" here; classify makes it "testing" when it runs a check.
export const tools: Readonly<Record<string, Tool>> = {
  Bash: { doing: "working", about: "command" },
  Read: { doing: "reading", about: "file_path" },
  Grep: { doing: "reading", about: "pattern" },
  Glob: { doing: "reading", about: "pattern" },
  LS: { doing: "reading", about: "path" },
  WebFetch: { doing: "reading", about: "url" },
  WebSearch: { doing: "reading", about: "query" },
  Edit: { doing: "editing", about: "file_path" },
  MultiEdit: { doing: "editing", about: "file_path" },
  Write: { doing: "editing", about: "file_path" },
  NotebookEdit: { doing: "editing", about: "notebook_path" },
  Agent: { doing: "subagent", about: "description" },
  Task: { doing: "subagent", about: "description" },
  Skill: { doing: "working", about: "skill" },
}

/** The table's entry for `tool`, or undefined for a tool it doesn't know (an MCP tool's). */
export const toolOf = (tool: string): Tool | undefined =>
  Object.hasOwn(tools, tool) ? tools[tool] : undefined

// A string with anything on it.
const telling = (value: unknown): value is string =>
  Predicate.isString(value) && value.trim() !== ""

/**
 * What a call of `tool` is about, as its input says, unsanitised: the table's field for a tool it
 * knows, another tool's first string field; undefined when that is missing or blank.
 */
export const aboutOf = (tool: string, input: unknown): string | undefined => {
  const fields = asRecord(input)
  if (fields === undefined) return undefined
  const field = toolOf(tool)?.about
  const value = field === undefined ? Object.values(fields).find(telling) : fields[field]
  return telling(value) ? value : undefined
}
