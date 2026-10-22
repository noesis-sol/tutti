// A request's input as the worker view's panel shows it whole (§ 4.5): wrapped to the panel's
// width, never cut. A permission is drawn by its tool, from the structured input canUseTool gives:
// a Bash command as its own lines, an Edit as its diff, a Write as its path and content, and what
// else the input holds as key and value lines.
import type { AttentionRequest } from "../agent/Attention.ts"
import { type Look, roleLook, type Segments, seg, wrap } from "./line.tsx"
import { sanitize, sanitizeLine } from "./sanitize.ts"
import type { Theme } from "./theme.ts"
import { editOf } from "./transcriptItems.ts"

/** How far a line wrapped onto the next is indented, past the line's own start. */
const continued = 2

/**
 * The indent of a line wrapped `start` columns past the line's own start, `width` wide: at most two
 * columns short of the width, so that a wide character still fits after it.
 */
const indentOf = (start: number, width: number): number =>
  Math.min(start + continued, Math.max(width - 2, 0))

/** Columns to a tab stop: a tab is drawn as the spaces to the next. */
const tabStop = 4

/** `line` with its tabs as the spaces to the next tab stop. */
const untabbed = (line: string): string => {
  if (!line.includes("\t")) return line
  return line
    .split("\t")
    .reduce((out, text) => out + " ".repeat(tabStop - (Bun.stringWidth(out) % tabStop)) + text)
}

/** `text`'s lines, sanitised, its tabs spaces; a newline at its end makes no empty line after it. */
const linesOf = (text: string): ReadonlyArray<string> => {
  const lines = sanitize(text).split("\n").map(untabbed)
  return lines.length > 1 && lines.at(-1) === "" ? lines.slice(0, -1) : lines
}

/** The columns `line` starts in: the width of its leading spaces. */
const leading = (line: string): number => line.length - line.trimStart().length

/**
 * `text` in `look`, each of its lines wrapped to `width` after `prefix`, a wrapped line indented
 * past where the line starts.
 */
const block = (
  text: string,
  look: Look | null,
  width: number,
  prefix = "",
): ReadonlyArray<Segments> =>
  linesOf(text).flatMap((line) =>
    wrap([...(prefix === "" ? [] : [seg(prefix)]), seg(line, look)], width, {
      indent: indentOf(prefix.length + leading(line), width),
    }),
  )

/** A value of the input as text: a string as it is, anything else as its JSON. */
const textOf = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value))

/**
 * `fields` as `key: value` lines, the key faint: a value of one line beside its key, one of more
 * under it, indented.
 */
const fieldLines = (
  fields: ReadonlyArray<readonly [string, unknown]>,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> =>
  fields.flatMap(([key, value]) => {
    const name = `${sanitizeLine(key)}:`
    const text = textOf(value)
    const lines = linesOf(text)
    return lines.length === 1
      ? wrap([seg(name, theme.styles.dim), seg(" "), seg(lines[0] ?? "")], width, {
          indent: continued,
        })
      : [[seg(name, theme.styles.dim)], ...block(text, null, width, " ".repeat(continued))]
  })

/** The input's fields but those named in `shown`, in the order the worker gave them. */
const restOf = (
  input: Readonly<Record<string, unknown>>,
  shown: ReadonlyArray<string>,
): ReadonlyArray<readonly [string, unknown]> =>
  Object.entries(input).filter(([key]) => !shown.includes(key))

/** An Edit's change as diff lines: removed lines and added ones in their roles, the rest plain. */
const diffLines = (
  input: Readonly<Record<string, unknown>>,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> => {
  const diff = editOf("Edit", input)?.diff ?? ""
  const looks: Readonly<Record<string, Look | null>> = {
    "-": roleLook(theme, "removed"),
    "+": roleLook(theme, "added"),
    " ": null,
  }
  return diff
    .split("\n")
    .filter((line) => line !== "" && !/^(---|\+\+\+|@@) /.test(line))
    .flatMap((line) =>
      wrap(
        [seg(line.slice(0, 1) + untabbed(line.slice(1)), looks[line[0] ?? " "] ?? null)],
        width,
        {
          indent: indentOf(1 + leading(line.slice(1)), width),
        },
      ),
    )
}

/**
 * A permission's input, `width` wide: a Bash or Monitor command as its lines, an Edit's file and
 * diff, a Write's file and content, then the input's other fields. The call's `description`, which
 * the request's own lines show already, isn't shown again.
 */
export const permissionLines = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  theme: Theme,
  width: number,
  description?: string,
): ReadonlyArray<Segments> => {
  const said = (key: string) =>
    key === "description" && description !== undefined && input[key] === description
  const rest = (shown: ReadonlyArray<string>) =>
    fieldLines(
      restOf(input, shown).filter(([key]) => !said(key)),
      theme,
      width,
    )
  const path = (key: string): ReadonlyArray<Segments> =>
    wrap([seg(sanitize(String(input[key])), theme.styles.key)], width, { indent: continued })
  const strings = (...keys: ReadonlyArray<string>) =>
    keys.every((key) => typeof input[key] === "string")
  if ((tool === "Bash" || tool === "Monitor") && strings("command")) {
    return [...block(input.command as string, null, width), ...rest(["command"])]
  }
  if (tool === "Edit" && strings("file_path", "old_string", "new_string")) {
    return [
      ...path("file_path"),
      ...diffLines(input, theme, width),
      ...rest(["file_path", "old_string", "new_string"]),
    ]
  }
  if (tool === "Write" && strings("file_path", "content")) {
    return [
      ...path("file_path"),
      ...block(input.content as string, null, width),
      ...rest(["file_path", "content"]),
    ]
  }
  return rest([])
}

/**
 * A request's input, `width` wide, as the panel shows it whole (§ 4.5, § 7.5): a permission's by
 * its tool, a question's questions and options, an elicitation's message and fields.
 */
export const requestInputLines = (
  request: AttentionRequest,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> => {
  const kind = request.kind
  const faint = (text: string, prefix = "") => block(text, theme.styles.dim, width, prefix)
  switch (kind._tag) {
    case "Permission":
      return permissionLines(kind.tool, kind.input, theme, width, request.description)
    case "Question":
      return kind.questions.flatMap((question) => [
        ...faint(question.question),
        ...question.options.flatMap((option, i) =>
          faint(
            `${i + 1} ${sanitizeLine(option.label)}${option.description ? ` — ${sanitizeLine(option.description)}` : ""}`,
            "  ",
          ),
        ),
      ])
    case "Elicitation": {
      const fields = Object.keys(
        (kind.requestedSchema?.properties as Record<string, unknown> | undefined) ?? {},
      )
      return [
        ...faint(kind.message),
        ...(fields.length === 0 ? [] : faint(`fields: ${fields.map(sanitizeLine).join(", ")}`)),
      ]
    }
  }
}
