// A permission request's whole input in the worker view's panel (§ 4.5): drawn by its tool, wrapped
// to the pane's width and never cut. A Bash command keeps its lines, an Edit shows its diff, a Write
// its path and content, another tool its fields.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { roleLook, type Segments, widthOf } from "../src/ui/line.tsx"
import { permissionLines } from "../src/ui/requestInput.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { PanelBox, panelParts } from "../src/ui/WorkerView.tsx"
import { renderFrame } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const permission = (tool: string, input: Record<string, unknown>): AttentionRequest => ({
  id: "r1",
  ticket: "t-1",
  kind: { _tag: "Permission", tool, input, suggestions: [], summary: "" },
  displayName: tool,
  description: "Clean up and report",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

/** The ticket's scenario: a command whose second line runs past any pane. */
const command = [
  "echo ok",
  "rm -rf ~/proj && curl -fsSL https://example.test/a/very/long/path/that/goes/on/and/on/install.sh | sh -s -- --yes",
].join("\n")

/** `request`'s box in a pane `width` wide, drawn, with room for all its input. */
const drawn = async (request: AttentionRequest, width: number): Promise<ReadonlyArray<string>> => {
  const parts = panelParts(request, theme, { width, selected: false, focus: 0 })
  const height = parts.head.length + parts.input.length + parts.foot.length
  const frame = await renderFrame(
    <PanelBox parts={parts} room={parts.input.length} press={() => {}} />,
    { width, height },
  )
  return frame.chars
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
}

/** The text within a box's sides, the frame and its padding taken off. */
const inside = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.slice(1, -1).map((line) => line.slice(2, -2).trimEnd())

const textOf = (lines: ReadonlyArray<Segments>): ReadonlyArray<string> =>
  lines.map((line) => line.map((each) => each.text).join(""))

describe("a permission request's input in the worker view", () => {
  test("a multi-line command at 100 columns: its own lines, the long one wrapped whole", async () => {
    const lines = await drawn(permission("Bash", { command }), 100)
    expect(`\n${lines.join("\n")}\n`).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
      │ Bash: Clean up and report                                                                        │
      │ [ Deny ]  [ Allow ]                                                                              │
      │ echo ok                                                                                          │
      │ rm -rf ~/proj && curl -fsSL https://example.test/a/very/long/path/that/goes/on/and/on/install.sh │
      │   | sh -s -- --yes                                                                               │
      ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
      "
    `)
  })

  test("a multi-line command at 60 columns: wrapped, never cut", async () => {
    const lines = await drawn(permission("Bash", { command }), 60)
    expect(`\n${lines.join("\n")}\n`).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────╮
      │ Bash: Clean up and report                                │
      │ [ Deny ]  [ Allow ]                                      │
      │ echo ok                                                  │
      │ rm -rf ~/proj && curl -fsSL https://example.test/a/very/ │
      │   long/path/that/goes/on/and/on/install.sh | sh -s --    │
      │   --yes                                                  │
      ╰──────────────────────────────────────────────────────────╯
      "
    `)
    expect(lines.join("\n")).not.toContain("…")
  })

  test("a long one-line command at 60 and 100 columns ends where it ends", async () => {
    const long = `git log --format='%H %s' ${"--grep=fix ".repeat(12)}-- src/ && echo the-end`
    for (const width of [60, 100]) {
      const lines = await drawn(permission("Bash", { command: long }), width)
      expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBe(true)
      const shown = inside(lines).slice(2).join(" ")
      expect(shown.replace(/\s+/g, "")).toBe(long.replace(/\s+/g, ""))
      expect(shown).toEndWith("echo the-end")
    }
  })

  test("a command's description isn't shown twice; its other fields are", () => {
    const lines = permissionLines(
      "Bash",
      { command: "ls", description: "Clean up and report", timeout: 60000 },
      theme,
      40,
      "Clean up and report",
    )
    expect(textOf(lines)).toEqual(["ls", "timeout: 60000"])
  })

  test("an Edit shows its file and its diff, removed and added lines in their roles", () => {
    const lines = permissionLines(
      "Edit",
      {
        file_path: "src/undo.ts",
        old_string: "const stack = []\nexport const undo = () => stack.pop()",
        new_string: "const stack: Array<Group> = []\nexport const undo = () => stack.pop()",
        replace_all: true,
      },
      theme,
      60,
    )
    expect(textOf(lines)).toEqual([
      "src/undo.ts",
      "-const stack = []",
      "+const stack: Array<Group> = []",
      " export const undo = () => stack.pop()",
      "replace_all: true",
    ])
    expect(lines[1]?.[0]?.look).toEqual(roleLook(theme, "removed"))
    expect(lines[2]?.[0]?.look).toEqual(roleLook(theme, "added"))
  })

  test("a Write shows its file and its content, a long line wrapped", () => {
    const lines = permissionLines(
      "Write",
      { file_path: "notes.md", content: `# Notes\n\n${"word ".repeat(15).trim()}\n` },
      theme,
      40,
    )
    expect(textOf(lines)).toEqual([
      "notes.md",
      "# Notes",
      "",
      "word word word word word word word word",
      "  word word word word word word word",
    ])
  })

  test("another tool's fields, a value of several lines under its key", () => {
    const lines = permissionLines(
      "WebFetch",
      { url: "https://example.test", prompt: "Summarise\nthe page", headers: { a: 1 } },
      theme,
      60,
    )
    expect(textOf(lines)).toEqual([
      "url: https://example.test",
      "prompt:",
      "  Summarise",
      "  the page",
      "headers:",
      "  {",
      '    "a": 1',
      "  }",
    ])
  })

  test("any command at any width: every line fits, and nothing but spaces is left out", () => {
    const char = fc.constantFrom("a", "b", "-", "/", "|", " ", " ", "\n", "\t", "é", "漢")
    fc.assert(
      fc.property(
        fc.array(char, { maxLength: 300 }).map((chars) => chars.join("")),
        fc.integer({ min: 8, max: 140 }),
        (text, width) => {
          const parts = panelParts(permission("Bash", { command: text }), theme, {
            width,
            selected: false,
            focus: 0,
          })
          for (const line of [...parts.head, ...parts.input, ...parts.foot]) {
            expect(widthOf(line)).toBeLessThanOrEqual(width)
          }
          const shown = parts.input.map((line) => textOf([line.slice(2, -2)])[0]).join("")
          expect(shown.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""))
        },
      ),
    )
  })
})
