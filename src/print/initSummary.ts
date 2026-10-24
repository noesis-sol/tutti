// tutti init's title and summary on the main screen (§ 7.1, § 7.11), as orchestra init prints them:
// the title (the pill, `init` organ bold, the repository faint); each step with its mark, `✓` done,
// `•` faint, `✗` needsYou bold, `!` notice, its label bold and its detail faint (notice for a
// caution), wrapped under itself; what's left for you, numbered, in the Next box framed `pill`, its
// title organ bold and each command on its own line; then the sign-off, `♪ tutti is ready.` organ
// bold or `♪ Almost ready: …` notice. In the renderer's form the title is drawn above the steps;
// after it, once the renderer is gone, it heads the summary. Its faint parts are `formFaint`'s:
// faint where it is `default`, else drawn in it, lighter on dark than faint text.
import { homedir } from "node:os"
import type { InitSummary } from "../init/init.ts"
import { cancelledLine, signOff } from "../init/init.ts"
import { marks, type Step, type StepKind } from "../init/steps.ts"
import { wrapText } from "../ui/line.tsx"
import type { Line } from "../ui/questions.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import type { Style, Theme } from "../ui/theme.ts"

/** `path` with the home folder as `~`. */
export const tildify = (path: string, home: string = homedir()): string =>
  home !== "" && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path

/** init's title: the pill, `init`, and the repository it sets up. */
export const initTitle = (theme: Theme, repo: string): Line => {
  const { title, organ } = theme.styles
  return [
    { text: " Tutti ", style: title },
    { text: " ", style: null },
    { text: "init", style: organ },
    { text: "  ", style: null },
    { text: sanitizeLine(tildify(repo)), style: theme.form.faint },
  ]
}

/** What init says under its title. */
export const initAbout = " Sets this project up for tutti, in .tutti/."

const painted = (line: Line): string =>
  line.map((part) => (part.style === null ? part.text : part.style.paint(part.text))).join("")

/** The title as the line forms and the summary print it: a blank line above, init's words under. */
export const initHeader = (theme: Theme, repo: string): string =>
  ["", painted(initTitle(theme, repo)), theme.form.faint.paint(initAbout), ""].join("\n")

/** How long the scout has looked, as its spinner says it: m:ss. */
export const scoutClock = (millis: number): string => {
  const seconds = Math.max(0, Math.floor(millis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** A step's label is padded to this width; its detail starts past it. */
const labelWidth = 15

/** Where a step's detail starts: two spaces, its mark and a space, then its label. */
const detailIndent = 4 + labelWidth

/** The least a step's detail, or a Next item, is wrapped to. */
const leastWidth = 20

const markStyle = (theme: Theme, kind: StepKind): Style => {
  const { closed, stop, deferred } = theme.styles
  return { done: closed, kept: theme.form.faint, missing: stop, caution: deferred }[kind]
}

const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`

/** `text` after the ANSI sequence `open`, reset after it; as it is where `open` is empty. */
const paintWith = (open: string, text: string): string =>
  open === "" ? text : `${open}${text}\x1b[0m`

/**
 * The Next box `width` columns wide: `items` numbered, the part of each after a newline (a command)
 * on a line of its own.
 */
const nextBox = (theme: Theme, items: ReadonlyArray<string>, width: number): Array<string> => {
  const { organ, key } = theme.styles
  const { faint } = theme.form
  const frame = theme.ansi("pill", "fg")
  const inner = Math.max(width - 4, leastWidth)
  const rows: Array<{ readonly plain: string; readonly text: string }> = [
    { plain: "Next", text: organ.paint("Next") },
  ]
  items.forEach((item, at) => {
    const [said = "", ...commands] = item.split("\n")
    const number = `${at + 1}.`
    const indent = " ".repeat(number.length + 1)
    wrapText(sanitizeLine(said), inner - indent.length).forEach((line, n) => {
      rows.push(
        n === 0
          ? { plain: `${number} ${line}`, text: `${faint.paint(number)} ${line}` }
          : { plain: `${indent}${line}`, text: `${indent}${line}` },
      )
    })
    for (const command of commands) {
      const shown = sanitizeLine(command)
      rows.push({ plain: `${indent}${shown}`, text: `${indent}${key.paint(shown)}` })
    }
  })
  const side = paintWith(frame, "│")
  return [
    paintWith(frame, `╭${"─".repeat(inner + 2)}╮`),
    ...rows.map(
      (row) =>
        `${side} ${row.text}${" ".repeat(Math.max(0, inner - Bun.stringWidth(row.plain)))} ${side}`,
    ),
    paintWith(frame, `╰${"─".repeat(inner + 2)}╯`),
  ]
}

/** `steps` as the summary lists them, `width` columns wide, in `theme`'s styles. */
export const initSteps = (
  steps: ReadonlyArray<Step>,
  theme: Theme,
  width: number,
): Array<string> => {
  const { styles } = theme
  const lines: Array<string> = []
  for (const each of steps) {
    const detail = wrapText(sanitizeLine(each.detail), Math.max(width - detailIndent, leastWidth))
    const detailStyle = each.kind === "caution" ? styles.deferred : theme.form.faint
    const label = sanitizeLine(each.label)
    const [first, ...rest] = each.detail === "" ? [] : detail
    // The label bold whatever the colours, as the other faces are (§ 7.11).
    const head = `  ${markStyle(theme, each.kind).paint(marks[each.kind])} ${bold(label)}`
    lines.push(
      first === undefined
        ? head
        : `${head}${" ".repeat(Math.max(1, labelWidth - Bun.stringWidth(label)))}${detailStyle.paint(first)}`,
    )
    for (const line of rest) lines.push(`${" ".repeat(detailIndent)}${detailStyle.paint(line)}`)
  }
  return lines
}

/**
 * The summary `width` columns wide, in `theme`'s styles: the steps, the Next box when anything is
 * left for you, and the sign-off.
 */
export const initSummary = (summary: InitSummary, theme: Theme, width: number): string => {
  const { styles } = theme
  const lines = initSteps(summary.steps, theme, width)
  if (summary.next.length > 0) lines.push("", ...nextBox(theme, summary.next, width))
  const sign = signOff(summary.ready)
  lines.push(summary.ready ? styles.organ.paint(` ${sign}`) : styles.deferred.paint(` ${sign}`))
  return lines.join("\n")
}

/** What init prints when a stop stopped it, below the steps it took: `tutti init: stopped…`. */
export const initStoppedLine = (theme: Theme, words: string): string =>
  theme.styles.deferred.paint(`tutti init: stopped${words}`)

/** What init prints when its form was cancelled, in the notice role. */
export const initCancelled = (theme: Theme): string =>
  theme.styles.deferred.paint(`  ${cancelledLine}`)
