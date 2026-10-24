import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import fc from "fast-check"
import { summarize } from "../src/agent/Attention.ts"
import { toolSummary } from "../src/agent/Transcripts.ts"
import { aboutOf, tools } from "../src/agent/tools.ts"
import { asRecord, asString } from "../src/agent/untrusted.ts"
import { classify } from "../src/agent/WorkerState.ts"
import { itemLines } from "../src/organs/triage.ts"

// What triage reads of one call of `tool` with `input`, after its "tool <name>: ".
const triageLine = (tool: string, input: unknown): string => {
  const message = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: tool, input }] },
    parent_tool_use_id: null,
  }
  const [line] = itemLines({
    v: 1,
    seq: 1,
    session: "s-1",
    time: "2026-10-24T09:00:00.000Z",
    message: message as SDKMessage,
  })
  return (line ?? "").slice(`tool ${tool}: `.length)
}

// What each of the three readers shows of a call: the worker view, the permission request and
// DENIED line, and triage.
const shown = (tool: string, input: Readonly<Record<string, unknown>>) => [
  toolSummary(tool, input),
  summarize(tool, input),
  triageLine(tool, input),
]

describe("the table of tools", () => {
  test.each([
    ["Bash", { command: "bun test", description: "Run the tests" }, "bun test"],
    ["Read", { file_path: "src/a.ts", offset: 3 }, "src/a.ts"],
    ["Grep", { pattern: "TODO", path: "src" }, "TODO"],
    ["Glob", { pattern: "**/*.ts", path: "src" }, "**/*.ts"],
    ["LS", { path: "src" }, "src"],
    ["Edit", { file_path: "src/b.ts", old_string: "a", new_string: "b" }, "src/b.ts"],
    ["NotebookEdit", { notebook_path: "n.ipynb", new_source: "x" }, "n.ipynb"],
    ["Agent", { description: "Verify", prompt: "Check the change" }, "Verify"],
    ["WebFetch", { url: "https://example.com", prompt: "Read it" }, "https://example.com"],
    ["WebSearch", { query: "effect", allowed_domains: [] }, "effect"],
    ["Skill", { skill: "run", args: "x" }, "run"],
    ["mcp__beads__show", { id: "tut-1" }, "tut-1"],
  ] as const)("a %s call is about the same field everywhere", (tool, input, about) => {
    expect(aboutOf(tool, input)).toBe(about)
    expect(shown(tool, input)).toEqual([about, about, about])
  })

  test("a call whose field is missing or blank is about nothing; the requests and triage show JSON", () => {
    expect(aboutOf("Grep", { path: "src" })).toBeUndefined()
    expect(aboutOf("Bash", { command: "  " })).toBeUndefined()
    expect(aboutOf("TodoWrite", { todos: [] })).toBeUndefined()
    expect(aboutOf("Bash", "not an object")).toBeUndefined()
    expect(shown("Grep", { path: "src" })).toEqual(["", '{"path":"src"}', '{"path":"src"}'])
  })

  test("classify reads its doing from the table, Bash running a check being testing", () => {
    expect(classify("Read", {})).toBe("reading")
    expect(classify("Grep", { pattern: "x" })).toBe("reading")
    expect(classify("MultiEdit", {})).toBe("editing")
    expect(classify("Task", {})).toBe("subagent")
    expect(classify("Skill", {})).toBe("working")
    expect(classify("Bash", { command: "ls" })).toBe("working")
    expect(classify("Bash", { command: "scripts/check.sh" }, ["scripts/check.sh"])).toBe("testing")
    expect(classify("Bash", { command: "bun test" })).toBe("testing")
    // A name on Object.prototype is no tool of the table's.
    expect(classify("constructor", {})).toBe("working")
    expect(aboutOf("toString", { x: "y" })).toBe("y")
  })

  test("a known tool's call is about its field's text, whatever the rest of its input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(tools)),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.string(),
        (tool, rest, value) => {
          const field = tools[tool]?.about ?? ""
          const about = aboutOf(tool, { ...rest, [field]: value })
          expect(about).toBe(value.trim() === "" ? undefined : value)
        },
      ),
    )
  })
})

describe("reading an SDK message's values without trusting them", () => {
  test("asRecord takes objects only, asString strings only", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([1])).toBeUndefined()
    expect(asRecord(null)).toBeUndefined()
    expect(asRecord("x")).toBeUndefined()
    expect(asString("x")).toBe("x")
    expect(asString(1)).toBeUndefined()
    expect(asString(undefined)).toBeUndefined()
  })
})
