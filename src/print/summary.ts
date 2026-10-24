// The run's summary (§ 7.1, § 5 item 14 "Then"), printed on the main screen as plain ANSI once the
// dashboard has closed, whose alternate screen took the dashboard with it: the title, the totals,
// the run's figures (figures.ts) and every ticket of the run, as wide as the terminal and as long
// as they are, then the closing line and a scoped run's scope line. Its styles are § 7.11's ("The summary", and the title line,
// totals strip and ticket rows as the dashboard draws them), from the theme's styles only.
//
// Ticket IDs, titles and the words of a stop can quote a worker's or a ticket author's text, so
// all of it is sanitised to one line here (§ 7.10).
import { Data, Duration, type Effect } from "effect"
import { formatDuration } from "../project/configFile.ts"
import { type FiguresLine, labelWidth } from "../run/figures.ts"
import type { Row, Totals } from "../run/runView.ts"
import { oneLine } from "../ui/oneLine.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import type { Style, Theme } from "../ui/theme.ts"
import type { Printer } from "./organLine.ts"

/** What the summary is made from. */
export interface Summary {
  readonly version: string
  /** Where finished tickets landed. */
  readonly branch: string
  /** The ticket a scoped run (`--ticket`) worked on; null for none. */
  readonly scope: string | null
  /** How long the run took, in milliseconds. */
  readonly took: number
  readonly totals: Totals
  /** The run's figures, each line with something to say (figures.ts); none shown without rows. */
  readonly figures: ReadonlyArray<FiguresLine>
  /** Every ticket the run took up, in the order it took them up. */
  readonly rows: ReadonlyArray<Row>
}

/** How the run ended, for its closing line. */
export type Ending = Data.TaggedEnum<{
  /**
   * By itself: `text` starts READY_EMPTY, LIMIT_REACHED or DRAINED, and a scoped run's is followed
   * by `; SCOPE_DONE: …` or `; SCOPE_OPEN: …`.
   */
  Done: {
    readonly text: string
    /** The tickets the run started. */
    readonly tickets: number
    /** The ticket limit, if any. */
    readonly limit: number | null
    /** How long the run took, in milliseconds. */
    readonly took: number
  }
  /** On a stop: `text` is the stops' line, `PAUSED: …`, with a scoped run's part as above. */
  Stopped: { readonly text: string }
}>

export const Ending = Data.taggedEnum<Ending>()

/** The narrowest the summary is drawn. */
export const minWidth = 40

/** The run's time to the second: `2m5s`, `45s`, `1h12m`. */
export const runTime = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  return seconds === 0 ? "0s" : formatDuration(Duration.seconds(seconds))
}

/** `text` sanitised, on one line, cut to `width` columns with `…` when it is wider (`oneLine`). */
export const fit = (text: string, width: number): string =>
  oneLine(sanitizeLine(text), Math.max(width, 1))

/** `text` padded with spaces to `width` columns. */
const pad = (text: string, width: number): string =>
  text + " ".repeat(Math.max(width - Bun.stringWidth(text), 0))

/** The row style of each status word, as § 7.11's ticket rows give them, and whether the rest of
 * the row is faint, as a finished ticket's is. */
export const rowLooks: Readonly<
  Record<string, { readonly style: StyleOf; readonly faint: boolean }>
> = {
  working: { style: "picked", faint: false },
  editing: { style: "picked", faint: false },
  reading: { style: "picked", faint: false },
  subagent: { style: "picked", faint: false },
  starting: { style: "picked", faint: false },
  testing: { style: "testing", faint: false },
  done: { style: "closed", faint: true },
  deferred: { style: "deferred", faint: true },
  review: { style: "deferred", faint: true },
  resolving: { style: "deferred", faint: false },
  fixing: { style: "deferred", faint: false },
  retrying: { style: "deferred", faint: false },
  limit: { style: "deferred", faint: false },
  stopped: { style: "stop", faint: false },
  blocked: { style: "stop", faint: false },
  "for you": { style: "stop", faint: false },
  "allow?": { style: "stop", faint: false },
  "answer?": { style: "stop", faint: false },
  "to merge": { style: "toMerge", faint: false },
  merging: { style: "merging", faint: false },
  waiting: { style: "dim", faint: true },
  queued: { style: "dim", faint: true },
  "held back": { style: "dim", faint: true },
}

export type StyleOf =
  | "picked"
  | "testing"
  | "closed"
  | "deferred"
  | "stop"
  | "toMerge"
  | "merging"
  | "dim"

/** A rounded frame's lines around `cells`, rows of columns `widths` wide, padded a space each side. */
const framed = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  widths: ReadonlyArray<number>,
  frame: (text: string) => string,
): ReadonlyArray<string> => {
  const edge = (left: string, join: string, right: string) =>
    frame(left + widths.map((w) => "─".repeat(w + 2)).join(join) + right)
  return [
    edge("╭", "┬", "╮"),
    ...rows.map(
      (cells) =>
        frame("│") +
        cells.map((cell, i) => ` ${pad(cell, widths[i] ?? 0)} `).join(frame("│")) +
        frame("│"),
    ),
    edge("╰", "┴", "╯"),
  ]
}

/** The summary's parts in `theme`'s styles, `width` columns wide. */
const parts = (theme: Theme, width: number) => {
  const { styles } = theme
  const w = Math.max(width, minWidth)
  const frameOpen = theme.ansi("frame")
  const frame = (text: string) => (frameOpen === "" ? text : `${frameOpen}${text}\x1b[0m`)
  const zero = (text: string) => styles.dim.paint(text)

  /** The pill, the version, the branch, a scoped run's ticket and the run's time. */
  const title = (s: Summary): string => {
    const pill = styles.title.paint(" tutti ")
    const version = fit(s.version, Math.max(w - 8, 1))
    const scoped = s.scope === null ? "" : ` · ticket ${sanitizeLine(s.scope)}`
    const used = 8 + Bun.stringWidth(version) + 3
    const where = fit(`${sanitizeLine(s.branch)}${scoped} · ${runTime(s.took)}`, w - used)
    return used >= w
      ? `${pill} ${styles.dim.paint(version)}`
      : `${pill} ${styles.dim.paint(version)}   ${styles.dim.paint(where)}`
  }

  /** The totals strip: a column a total, its label faint over its count; zeros faint. */
  const totals = (t: Totals): ReadonlyArray<string> => {
    const count = (n: number, mark: string, style: Style) =>
      n === 0 ? zero("0") : style.paint(`${mark} ${n}`)
    const setAside = t.deferred + t.review
    const workers =
      t.workers === 0
        ? zero(`0 of ${t.slots}`)
        : `${styles.picked.paint(String(t.workers))}${styles.dim.paint(` of ${t.slots}`)}`
    const queue =
      (t.queued === 0 ? zero("0") : String(t.queued)) +
      (t.heldBack > 0 ? styles.heldBack.paint(` · ${t.heldBack} held back`) : "") +
      (t.queueHeld ? styles.windDown.paint(" · held") : "")
    const columns: ReadonlyArray<readonly [string, string]> = [
      ["Completed", count(t.completed, "✓", styles.closed)],
      ["Set aside", count(setAside, "↷", styles.deferred)],
      ["Needs you", count(t.needsYou, "?", styles.stop)],
      ["Workers", workers],
      ["In queue", queue],
    ]
    const natural = columns.map(([label, value]) =>
      Math.max(Bun.stringWidth(label), Bun.stringWidth(value)),
    )
    const need = natural.reduce((sum, n) => sum + n + 3, 1)
    if (need > w) {
      // Too narrow for the strip: the totals on one line.
      const one = (n: number, mark: string, style: Style) => style.paint(`${mark} ${n}`)
      return [
        ` ${[
          one(t.completed, "✓", styles.closed),
          one(setAside, "↷", styles.deferred),
          one(t.needsYou, "?", styles.stop),
          `${one(t.workers, "▶", styles.picked)}${styles.dim.paint(`/${t.slots}`)}`,
          styles.dim.paint(`queue ${t.queued}`),
        ].join(styles.dim.paint(" · "))}`,
      ]
    }
    const extra = w - need
    const widths = natural.map(
      (n, i) => n + Math.floor(extra / natural.length) + (i < extra % natural.length ? 1 : 0),
    )
    return framed(
      [columns.map(([label]) => styles.dim.paint(label)), columns.map(([, value]) => value)],
      widths,
      frame,
    )
  }

  /**
   * The run's figures under the totals, a line each: its label faint, then its parts ` · ` apart,
   * an estimate in its colour; the parts that don't fit cut, the first of them with `…`.
   */
  const figures = (lines: ReadonlyArray<FiguresLine>): ReadonlyArray<string> =>
    lines.map((each) => {
      let room = w - 2 - (labelWidth + 2)
      let drawn = ""
      for (const [i, part] of each.parts.entries()) {
        const gap = i === 0 ? 0 : 3
        if (room <= gap) break
        const text = sanitizeLine(part.text)
        const shown = Bun.stringWidth(text) <= room - gap ? text : fit(text, room - gap)
        const painted = part.estimate === true ? styles.estimate.paint(shown) : shown
        drawn += (gap === 0 ? "" : styles.dim.paint(" · ")) + painted
        room -= gap + Bun.stringWidth(shown)
        if (shown !== text) break
      }
      return `  ${styles.dim.paint(each.label.padEnd(labelWidth + 2))}${drawn}`
    })

  /** The Tickets label and its table: every row, its glyph, word and ID in its state's style. */
  const tickets = (rows: ReadonlyArray<Row>): ReadonlyArray<string> => {
    const stateWidth = 11
    const idWidth = Math.min(
      Math.max(7, ...rows.map((row) => Bun.stringWidth(row.label))),
      Math.max(Math.floor(w / 3), 7),
      // Room left for the note's eight columns at the least, so the table is never wider than w.
      w - 4 - (stateWidth + 2) - 2 - 2 - 8,
    )
    const aboutWidth = w - 4 - (stateWidth + 2) - (idWidth + 2) - 2
    const cells = rows.map((row) => {
      const look = rowLooks[row.word] ?? { style: "dim", faint: false }
      const style = styles[look.style]
      const about = fit(row.note, aboutWidth)
      return [
        style.paint(fit(`${row.mark} ${row.word}`, stateWidth)),
        style.paint(fit(row.label, idWidth)),
        look.faint ? styles.dim.paint(about) : about,
      ]
    })
    return [
      `  ${styles.tickets.paint("Tickets")}`,
      ...framed(cells, [stateWidth, idWidth, aboutWidth], frame),
    ]
  }

  return { title, totals, figures, tickets }
}

/**
 * The summary `width` columns wide (`minWidth` at the least), in `theme`'s styles: a blank line,
 * the title, the totals and, when the run took any up, its figures and every ticket.
 */
export const summary = (s: Summary, theme: Theme, width: number): string => {
  const p = parts(theme, width)
  return [
    "",
    p.title(s),
    ...p.totals(s.totals),
    ...(s.rows.length === 0 ? [] : [...p.figures(s.figures), ...p.tickets(s.rows)]),
  ].join("\n")
}

/** `1 ticket`, `n tickets` or `no tickets`. */
const ticketCount = (n: number): string =>
  n === 0 ? "no tickets" : n === 1 ? "1 ticket" : `${n} tickets`

/** How a run ended by itself, from the word its done line starts with; else the line itself. */
export const headline = (text: string, limit: number | null, tickets: number): string => {
  switch (text.split(" ", 1)[0]) {
    case "READY_EMPTY":
      return "Completed the Run"
    case "LIMIT_REACHED":
      return `Reached the ticket limit (${limit ?? tickets})`
    case "DRAINED":
      return "Stopped after the running tickets, as asked"
  }
  return text
}

/**
 * The closing line, and a scoped run's scope line below it: `♪ Completed the Run` (and the other
 * ends) `done` bold with its facts faint, or a stop's `■ PAUSED: …` `needsYou` bold; the scope
 * line `SCOPE_DONE` `done`, `SCOPE_OPEN` `notice`.
 */
export const closing = (ending: Ending, theme: Theme): string => {
  const { styles } = theme
  const [text, scope] = splitScope(sanitizeLine(ending.text))
  const first =
    ending._tag === "Stopped"
      ? styles.stop.paint(`■ ${text}`)
      : `${styles.closed.paint(`♪ ${headline(text, ending.limit, ending.tickets)}`)}  ${styles.dim.paint(
          ending.took >= 1000
            ? `${ticketCount(ending.tickets)} · ${runTime(ending.took)}`
            : ticketCount(ending.tickets),
        )}`
  if (scope === null) return first
  const style = scope.startsWith("SCOPE_DONE") ? styles.done : styles.deferred
  return `${first}\n${style.paint(`  ${scope}`)}`
}

/** A closing line's text and its scope part, `SCOPE_DONE: …` or `SCOPE_OPEN: …`, if it has one. */
export const splitScope = (text: string): readonly [string, string | null] => {
  const at = text.indexOf("; SCOPE_")
  return at < 0 ? [text, null] : [text.slice(0, at), text.slice(at + 2)]
}

/** Prints the summary `width` columns wide, then the closing line and the scope line. */
export const printSummary = (
  printer: Printer,
  s: Summary,
  ending: Ending,
  theme: Theme,
  width: number,
): Effect.Effect<void> => printer.print(`${summary(s, theme, width)}\n${closing(ending, theme)}`)
