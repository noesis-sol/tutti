// Editing JSON text in place, for tutti init and init --update on .tutti/settings.json: a value set
// at a key path, with the rest of the text, its indentation, line endings and one-line sections
// included, as it was. The text is JSON as JSON.parse reads it, whose value is an object; where a
// key is in an object more than once, the last is the one set, as JSON.parse keeps the last.
//
// A value replaced keeps the layout of the one it replaces: on one line where that was, spread over
// lines where that was; an empty object or a value that isn't a container takes its object's
// layout. A key added goes after its object's last one, laid out as that object is; a key path
// through a missing key, or through a value that isn't an object with keys, makes the objects it
// needs there.

/** A value in the text: where it starts and ends, and an object's keys, the last of each kept. */
interface Node {
  readonly start: number
  readonly end: number
  readonly kind: "object" | "array" | "other"
  readonly members: ReadonlyArray<Member>
}

interface Member {
  readonly key: string
  readonly keyStart: number
  readonly value: Node
}

const isSpace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\n" || char === "\r"

const skipSpace = (text: string, at: number) => {
  let index = at
  while (isSpace(text[index])) index++
  return index
}

/** The end of the string whose opening quote is at `at`. */
const stringEnd = (text: string, at: number) => {
  let index = at + 1
  while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1
  return index + 1
}

/** The value starting at `at`, after its whitespace, as JSON.parse reads it there. */
const scan = (text: string, at: number): Node => {
  const start = skipSpace(text, at)
  const char = text[start]
  if (char === '"') return { start, end: stringEnd(text, start), kind: "other", members: [] }
  if (char === "{") {
    const members = new Map<string, Member>()
    let index = skipSpace(text, start + 1)
    while (text[index] === '"') {
      const keyEnd = stringEnd(text, index)
      const key: string = JSON.parse(text.slice(index, keyEnd))
      const value = scan(text, skipSpace(text, keyEnd) + 1)
      // A key given again moves to where JSON.parse's object has it: its first place, kept.
      members.set(key, { key, keyStart: index, value })
      index = skipSpace(text, value.end)
      if (text[index] === ",") index = skipSpace(text, index + 1)
    }
    return { start, end: index + 1, kind: "object", members: [...members.values()] }
  }
  if (char === "[") {
    let index = skipSpace(text, start + 1)
    while (index < text.length && text[index] !== "]") {
      index = skipSpace(text, scan(text, index).end)
      if (text[index] === ",") index = skipSpace(text, index + 1)
    }
    return { start, end: index + 1, kind: "array", members: [] }
  }
  let end = start
  while (end < text.length && !isSpace(text[end]) && !",]}".includes(text[end] as string)) end++
  return { start, end, kind: "other", members: [] }
}

/** The whitespace that starts the line `at` is on. */
const lineIndent = (text: string, at: number) => {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1
  let index = lineStart
  while (text[index] === " " || text[index] === "\t") index++
  return text.slice(lineStart, index)
}

/** The text's indentation step: its first indented line's, or two spaces. */
const indentUnit = (text: string) => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  "

const lineEnd = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n")

/** `value` on one line, with a space after each comma and colon. */
const oneLine = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(oneLine).join(", ")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(
      ([key, each]) => `${JSON.stringify(key)}: ${oneLine(each)}`,
    )
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`
  }
  return JSON.stringify(value)
}

/** `value` as the text lays it out: on one line, or spread from a line indented by `indent`. */
const layout = (text: string, value: unknown, spread: boolean, indent: string) =>
  spread
    ? // JSON.stringify escapes the newlines in strings: each one here is between lines.
      JSON.stringify(value, null, indentUnit(text)).replaceAll("\n", `${lineEnd(text)}${indent}`)
    : oneLine(value)

const spreads = (text: string, node: Node) => text.slice(node.start, node.end).includes("\n")

/** Whether a value written over `node`, in an object that `objectSpreads`, spreads over lines. */
const spreadsOver = (text: string, node: Node, objectSpreads: boolean) =>
  spreads(text, node) || (objectSpreads && node.kind !== "array" && node.members.length === 0)

/** `value` at the end of `path`, each key on the way an object's. */
const nested = (path: ReadonlyArray<string>, value: unknown): unknown =>
  path.reduceRight<unknown>((inner, key) => Object.fromEntries([[key, inner]]), value)

const splice = (text: string, start: number, end: number, insert: string) =>
  `${text.slice(0, start)}${insert}${text.slice(end)}`

/** `text`, which holds an object, with `value` set at `path` in it and the rest as it was. */
export const setIn = (text: string, path: ReadonlyArray<string>, value: unknown): string => {
  let node = scan(text, 0)
  let objectSpreads = true
  let depth = 0
  while (depth < path.length && node.kind === "object" && node.members.length > 0) {
    const key = path[depth] as string
    const member = node.members.find((each) => each.key === key)
    if (member === undefined) {
      const last = node.members.reduce((one, other) =>
        one.keyStart > other.keyStart ? one : other,
      )
      const added = nested(path.slice(depth + 1), value)
      const name = JSON.stringify(key)
      if (!spreads(text, node)) {
        return splice(text, last.value.end, last.value.end, `, ${name}: ${oneLine(added)}`)
      }
      const indent = lineIndent(text, last.keyStart)
      const made = `,${lineEnd(text)}${indent}${name}: ${layout(text, added, true, indent)}`
      return splice(text, last.value.end, last.value.end, made)
    }
    objectSpreads = spreads(text, node)
    node = member.value
    depth++
  }
  const spread = spreadsOver(text, node, objectSpreads)
  const made = layout(text, nested(path.slice(depth), value), spread, lineIndent(text, node.start))
  return splice(text, node.start, node.end, made)
}
