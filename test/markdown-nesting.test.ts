import { describe, expect, test } from "bun:test"
import { renderMarkdown } from "../src/print/markdown.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { makeTheme } from "../src/ui/theme.ts"

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: false })

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is stripped
const sgr = /\x1b\[[0-9;]*m/g

/** `text` without its styles. */
const strip = (text: string): string => text.replace(sgr, "")

/** `markdown` inside `depth` quotes. */
const quoted = (markdown: string, depth: number) =>
  markdown
    .split("\n")
    .map((line) => `${"> ".repeat(depth)}${line}`)
    .join("\n")

/** `markdown` inside `depth` list items, each an item's text and then the level within. */
const listed = (markdown: string, depth: number) => {
  let lines = markdown.split("\n")
  for (let i = 0; i < depth; i++) lines = ["- item", "", ...lines.map((line) => `  ${line}`)]
  return lines.join("\n")
}

const blocks = {
  rule: "---",
  table: "| a | bee |\n|---|---|\n| 1 | 2 |",
  "code block": "```sh\nbd ready\n```",
}

describe("Markdown nested deeper than the width", () => {
  for (const [name, markdown] of Object.entries(blocks)) {
    for (const [how, nest] of [
      ["quotes", quoted],
      ["lists", listed],
    ] as const) {
      for (const width of [1, 20, 80]) {
        test(`a ${name} 50 ${how} deep at width ${width} is drawn`, () => {
          const out = strip(renderMarkdown(nest(markdown, 50), theme, width))
          const shown = name === "rule" ? "─" : name === "table" ? "bee" : "bd ready"
          expect(out).toContain(shown)
        })
      }
    }
  }

  test("a rule too deep for its width is a dash", () => {
    const lines = strip(renderMarkdown(quoted("---", 12), theme, 20)).split("\n")
    expect(lines.at(-1)).toBe(`${"│ ".repeat(12)}─`)
  })
})
