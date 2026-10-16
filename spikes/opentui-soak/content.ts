// Synthetic worker output for the soak: Markdown text, tool calls whose results are code or a
// diff, all deterministic from an index so that runs are comparable.

export type Item =
  | { readonly kind: "markdown"; readonly id: number; readonly text: string }
  | { readonly kind: "code"; readonly id: number; readonly title: string; readonly code: string }
  | { readonly kind: "diff"; readonly id: number; readonly title: string; readonly diff: string }

const words = [
  "undo",
  "stack",
  "property",
  "edit",
  "group",
  "drag",
  "history",
  "worker",
  "ticket",
  "merge",
  "check",
  "scheduler",
  "transcript",
  "renderer",
]

const word = (n: number): string => words[n % words.length] ?? "x"

const sentence = (seed: number, length: number): string =>
  Array.from({ length }, (_, i) => word(seed * 7 + i * 3)).join(" ")

/** Markdown with a heading, emphasis, inline code, a list and, every third item, a fenced block. */
export const markdownText = (id: number): string => {
  const lines = [
    `### Step ${id}`,
    "",
    `The **${word(id)}** ${sentence(id, 9)}, so \`${word(id + 1)}()\` ${sentence(id + 2, 6)}.`,
    "",
    `- ${sentence(id + 3, 5)}`,
    `- ${sentence(id + 4, 7)} *${word(id + 5)}*`,
    `- [${word(id + 6)}](https://example.com/${id})`,
  ]
  if (id % 3 === 0) {
    lines.push("", "```ts", `const ${word(id)}${id} = ${id} * 2`, "```")
  }
  return lines.join("\n")
}

export const codeText = (id: number): string =>
  [
    `// ${sentence(id, 6)}`,
    `export function ${word(id)}${id}(input: number): number {`,
    `  const ${word(id + 1)} = input + ${id}`,
    `  if (${word(id + 1)} > ${id * 3}) {`,
    `    return ${word(id + 1)} - 1`,
    "  }",
    `  return "${sentence(id + 2, 3)}".length + ${word(id + 1)}`,
    "}",
  ].join("\n")

export const diffText = (id: number): string =>
  [
    `--- a/src/${word(id)}.ts`,
    `+++ b/src/${word(id)}.ts`,
    "@@ -1,5 +1,7 @@",
    ` import { ${word(id + 1)} } from "./${word(id + 1)}"`,
    " ",
    `-export const ${word(id)} = (n: number) => n + ${id}`,
    `+export const ${word(id)} = (n: number): number => {`,
    `+  // ${sentence(id + 3, 4)}`,
    `+  return n + ${id + 1}`,
    "+}",
    " ",
    ` export default ${word(id)}`,
  ].join("\n")

export const makeItem = (id: number): Item => {
  switch (id % 3) {
    case 0:
      return { kind: "markdown", id, text: markdownText(id) }
    case 1:
      return { kind: "code", id, title: `Read  src/${word(id)}.ts`, code: codeText(id) }
    default:
      return { kind: "diff", id, title: `Edit  src/${word(id)}.ts  +4 −1`, diff: diffText(id) }
  }
}

/** The streaming tail: the first `chars` characters of a long assistant message. */
export const streamingText = (id: number, chars: number): string => {
  const full = Array.from({ length: 12 }, (_, i) => `${sentence(id + i, 12)}.`).join(" ")
  return `### Thinking aloud ${id}\n\n${full.slice(0, chars)}`
}

export const STREAMING_LENGTH = streamingText(0, Number.MAX_SAFE_INTEGER).length

export const activities = [
  "Read  src/history/undo.ts",
  "Edit  src/history/undo.ts",
  "Bash  scripts/check-fast.sh",
  "Grep  useSyncExternalStore",
  "thinking",
  "Write docs/spikes/05-opentui-soak.md",
]
