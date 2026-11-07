// The drawn screen read back into its parts, so that a test says what it checks (a card's mark and
// ticket, the hint's keys, a table row's state) and not the spacing the TUI draws them with: that
// lives in src/ui's constants (spacing.ts' markGap, cardIndent and hintIndent, the hint's
// separator), which these helpers read the screen with, and the builders at the end write it with
// for the rare test that wants the exact text. A test that checks a spacing on purpose does it once, through them.
import { TextAttributes } from "@opentui/core"
import { hintSeparator } from "../src/ui/Hint.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { marks } from "../src/ui/marks.ts"
import { cardIndent, hintIndent, markGap } from "../src/ui/spacing.ts"
import { spinnerFrames } from "../src/ui/useRunView.ts"
import type { Frame } from "./render.ts"

/** What the helpers read: a captured frame, its text, its lines, or lines of segments. */
export type Screen = Frame | string | ReadonlyArray<string> | ReadonlyArray<Segments>

/** The screen's lines, their trailing spaces left out. */
export const screenLines = (screen: Screen): ReadonlyArray<string> => {
  const lines =
    typeof screen === "string"
      ? screen.split("\n")
      : "chars" in screen
        ? screen.chars.split("\n")
        : screen.map((line) =>
            typeof line === "string" ? line : line.map((each) => each.text).join(""),
          )
  return lines.map((line) => line.trimEnd())
}

/** The sides of a box: rounded and heavy, as a highlighted card's. */
const sides = new Set(["│", "┃"])
const tops = new Set(["╭", "┏"])
const bottoms = new Set(["╰", "┗"])

/** A box's inside on `line`, from its side at `column` to the next side, its padding left out. */
const insideAt = (line: ReadonlyArray<string>, column: number): string | null => {
  if (!sides.has(line[column] ?? "")) return null
  const end = line.findIndex((char, i) => i > column && sides.has(char))
  return line
    .slice(column + 1, end === -1 ? undefined : end)
    .join("")
    .replace(/^ /, "")
    .trimEnd()
}

// ── Cards ────────────────────────────────────────────────────────────────────────────────────────

/** A card in Current, full or a compact line, as drawn. */
export interface CardShown {
  /** Its mark: the spinner's frame, ◼, ◆, ⟳ or •. */
  readonly mark: string
  readonly ticket: string
  /** Its status, `■ allow?` on a compact line. */
  readonly status: string
  readonly steered: boolean
  readonly time: string | null
  readonly memory: string | null
  readonly title: string
  /** A full card's action line: the phase's, or `▸` and its worker's latest action. */
  readonly action: string | null
  /** A full card's lines under its head, their indent left out; none on a compact line. */
  readonly lines: ReadonlyArray<string>
  readonly compact: boolean
  /** Drawn heavy, as the highlighted card, or the compact box's highlighted line, is. */
  readonly highlighted: boolean
  /** `▸` before its title: the attention card the answer keys reach, among several. */
  readonly pointed: boolean
  /** The screen line its head is on, and the column of its frame's side. */
  readonly line: number
  readonly column: number
}

/** The marks a card's head starts with: the spinner's frames, and those motionTones names. */
const cardMarks = new Set<string>([
  ...spinnerFrames,
  marks.toMerge,
  marks.merging,
  marks.reworking,
  marks.idle,
])

/** A card's head inside its frame: its mark, markGap, its ticket, and its cells. */
const headPattern = new RegExp(`^(\\S)${markGap}(\\S+)(.*)$`)

/** How long a card has been in its phase, as Card.tsx's elapsed writes it. */
const timePattern = /^(\d+s|\d+m\d\ds|\d+h\d\dm)$/

/** A worker's memory, as workerMemory writes it. */
const memoryPattern = /^(\d+\.\d|\?) GB$/

/** A head's cells after its ticket: its status, `steered`, its time and memory, a compact title. */
const cellsOf = (rest: string) => {
  const cells = rest.trim() === "" ? [] : rest.trim().split(/ {2,}/)
  const timeAt = cells.findIndex((cell) => timePattern.test(cell))
  const before = timeAt === -1 ? cells : cells.slice(0, timeAt)
  const after = timeAt === -1 ? [] : cells.slice(timeAt + 1)
  const memory = after[0] !== undefined && memoryPattern.test(after[0]) ? after[0] : null
  return {
    status: before[0] ?? "",
    steered: before.includes("steered"),
    time: timeAt === -1 ? null : (cells[timeAt] ?? null),
    memory,
    title: after.slice(memory === null ? 0 : 1).join("  "),
  }
}

/** A line under a full card's head without its indent, and whether it has the `▸` pointer. */
const underHead = (inside: string): { readonly text: string; readonly pointed: boolean } => {
  if (inside.startsWith(marks.selected)) {
    return { text: inside.slice(marks.selected.length).trimStart(), pointed: true }
  }
  return {
    text: inside.startsWith(cardIndent) ? inside.slice(cardIndent.length) : inside,
    pointed: false,
  }
}

/** The cards on the screen, row by row, left to right. */
export const cardsIn = (screen: Screen): ReadonlyArray<CardShown> => {
  const lines = screenLines(screen).map((line) => Array.from(line))
  const cards: Array<CardShown> = []
  lines.forEach((line, at) => {
    line.forEach((char, column) => {
      if (!sides.has(char)) return
      const inside = insideAt(line, column)
      const head = inside === null ? null : headPattern.exec(inside)
      if (head === null || !cardMarks.has(head[1] ?? "")) return
      const [, mark = "", ticket = "", rest = ""] = head
      const cells = cellsOf(rest)
      const compact = cells.title !== ""
      const under: Array<{ readonly text: string; readonly pointed: boolean }> = []
      if (!compact && tops.has(lines[at - 1]?.[column] ?? "")) {
        for (let below = at + 1; below < lines.length; below++) {
          const next = lines[below] ?? []
          if (bottoms.has(next[column] ?? "")) break
          const each = insideAt(next, column)
          if (each === null) break
          under.push(underHead(each))
        }
        while (under.at(-1)?.text === "") under.pop()
      }
      cards.push({
        mark,
        ticket,
        status: cells.status,
        steered: cells.steered,
        time: cells.time,
        memory: cells.memory,
        title: compact ? cells.title : (under[0]?.text ?? ""),
        action: compact ? null : under[1]?.text || null,
        lines: under.map((each) => each.text),
        compact,
        highlighted: char === "┃",
        pointed: under[0]?.pointed ?? false,
        line: at,
        column,
      })
    })
  })
  return cards
}

/** The card for `ticket` on the screen; throws where there is none. */
export const cardOn = (screen: Screen, ticket: string): CardShown => {
  const card = cardsIn(screen).find((each) => each.ticket === ticket)
  if (card === undefined) {
    throw new Error(`no card for ${ticket} on the screen:\n${screenLines(screen).join("\n")}`)
  }
  return card
}

// ── The hint ─────────────────────────────────────────────────────────────────────────────────────

/** A line of the hint: its indent then a key; or, more indented, the rest of a key cut by a wrap. */
const hintPattern = new RegExp(`^${hintIndent}\\S`)
const wrappedPattern = new RegExp(`^${hintIndent} +\\S`)

/**
 * Whether line `at` of `screen` starts as a hint's line does, with a key, bold: a toast drawn on the
 * line above the hint has its indent too. Only a captured frame has the looks to tell them apart.
 */
const startsWithKey = (screen: Screen, line: string, at: number): boolean => {
  if (!hintPattern.test(line)) return false
  if (typeof screen === "string" || !("chars" in screen)) return true
  const first = screen.spans.lines[at]?.spans.find((span) => span.text.trim() !== "")
  return first !== undefined && (first.attributes & TextAttributes.BOLD) !== 0
}

/** The hint's lines: the last on the screen that start with a key, the rest of a wrapped one kept. */
const hintSpan = (screen: Screen): { readonly at: number; readonly lines: Array<string> } => {
  const lines = screenLines(screen)
  const keyed = (at: number) => startsWithKey(screen, lines[at] ?? "", at)
  const wrapped = (at: number) => wrappedPattern.test(lines[at] ?? "")
  let end = lines.length
  while (end > 0 && !keyed(end - 1) && !wrapped(end - 1)) end--
  let at = end
  // The wind-down line, above the hint, has the hint's indent too: its squares tell it apart.
  while (at > 0 && (keyed(at - 1) || wrapped(at - 1))) {
    if ((lines[at - 1] ?? "").startsWith(`${hintIndent}${marks.windingDown}`)) break
    at--
  }
  while (at < end && !keyed(at)) at++
  return { at, lines: lines.slice(at, end) }
}

/**
 * The hint's keys line by line, each as its keys and what they do say it (`Esc back`), the rest of a
 * key a wrap cut kept with it.
 */
export const hintRows = (screen: Screen): ReadonlyArray<ReadonlyArray<string>> => {
  const rows: Array<Array<string>> = []
  for (const line of hintSpan(screen).lines) {
    const last = rows.at(-1)
    if (wrappedPattern.test(line) && last !== undefined && last.length > 0) {
      last[last.length - 1] = `${last.at(-1)} ${line.trim()}`
      continue
    }
    rows.push(line.slice(hintIndent.length).split(hintSeparator))
  }
  return rows
}

/** The hint's keys, each as its keys and what they do say it: `Esc back`, `arrows select`. */
export const hintOf = (screen: Screen): ReadonlyArray<string> => hintRows(screen).flat()

/** The screen line the hint starts on: where nothing is drawn over it, the lines above. */
export const hintAt = (screen: Screen): number => hintSpan(screen).at

/** The hint's `count` keys from `key` on, where it names `key`; none where it doesn't. */
export const hintFrom = (screen: Screen, key: string, count: number): ReadonlyArray<string> => {
  const hint = hintOf(screen)
  const at = hint.indexOf(key)
  return at === -1 ? [] : hint.slice(at, at + count)
}

// ── Boxes under a label: the tickets table, Needs you, Up next ───────────────────────────────────

/** The lines inside the box under the section label `label`, its frame and padding left out. */
const boxUnder = (screen: Screen, label: string): ReadonlyArray<ReadonlyArray<string>> => {
  const lines = screenLines(screen).map((line) => Array.from(line))
  for (const [labelAt, line] of lines.entries()) {
    const text = line.join("")
    if (!text.includes(label)) continue
    // The box's top is on the next line, its corner at or before the label's column.
    const top = lines[labelAt + 1] ?? []
    let column = Array.from(text.split(label)[0] ?? "").length
    while (column >= 0 && !tops.has(top[column] ?? "")) column--
    if (column < 0) continue
    const inside: Array<ReadonlyArray<string>> = []
    for (let at = labelAt + 2; at < lines.length; at++) {
      const each = lines[at] ?? []
      if (!sides.has(each[column] ?? "")) break
      inside.push(each.slice(column))
    }
    return inside
  }
  return []
}

/** A row of the tickets table, as drawn. */
export interface RowShown {
  /** Its state's mark and word, `■ allow?`; empty on a blank row. */
  readonly state: string
  /** Its ID, or the folded row's `+N`. */
  readonly ticket: string
  readonly note: string
  /** Selected: the pointer `▸` in its gutter. */
  readonly selected: boolean
}

/** The rows of the tickets table under its `Tickets` label, blank ones included. */
export const rowsIn = (screen: Screen): ReadonlyArray<RowShown> =>
  boxUnder(screen, "  Tickets").map((line) => {
    const [, state = "", ticket = "", note = ""] = line.join("").split(/[│┃]/)
    const selected = state.trim().startsWith(marks.selected)
    return {
      state: (selected ? state.trim().slice(marks.selected.length) : state).trim(),
      ticket: ticket.trim(),
      note: note.trim(),
      selected,
    }
  })

/** The lines inside the panel under `label` (`Needs you`, `Up next`), its frame left out. */
export const panelOf = (screen: Screen, label = "Needs you"): ReadonlyArray<string> =>
  boxUnder(screen, label).map((line) => insideAt(line, 0) ?? "")

/** A box's line on its own, `│ text   │`, its sides and padding left out. */
export const insideOf = (line: string): string => insideAt(Array.from(line), 0) ?? line

// ── Builders, for a test that wants the exact text ───────────────────────────────────────────────

/** A card's head up to its ticket, `⣾  t-1`; with `side`, its frame's side before it: `│ ⣾  t-1`. */
export const cardHead = (mark: string, ticket: string, side?: string): string =>
  `${side === undefined ? "" : `${side} `}${mark}${markGap}${ticket}`

/** A line under a card's head, in line with its ticket. */
export const cardLine = (text: string): string => `${cardIndent}${text}`

/** The hint's line naming `keys`: `  Esc back · arrows select`. */
export const hintLine = (...keys: ReadonlyArray<string>): string =>
  `${hintIndent}${keys.join(hintSeparator)}`
