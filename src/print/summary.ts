// The run's summary (§ 7.1, § 5 item 14 "Then"), printed on the main screen as plain ANSI once the
// dashboard has closed, whose alternate screen took the dashboard with it: the title, the totals,
// the run's figures (figures.ts) and every ticket of the run, as wide as the terminal and as long
// as they are, then the closing line and a scoped run's scope line. Its styles are § 7.11's ("The summary", and the title line,
// totals strip and ticket rows as the dashboard draws them), from the theme's styles only. Its
// lines are the dashboard's text, segments painted as ANSI (line.tsx's paint); the ticket rows are
// the dashboard's table itself, every row of it. With --auto-answer, the questions tutti answered
// follow, each with the option it chose, and how to find the question tickets later.
//
// Ticket IDs, titles and the words of a stop can quote a worker's or a ticket author's text, so
// all of it is sanitised to one line here (§ 7.10).
import { Data, type Effect } from "effect"
import { type FiguresLine, labelWidth } from "../run/figures.ts"
import type { Row, Totals } from "../run/runView.ts"
import { fit, framed, paint, type Segments, seg, widthOf } from "../ui/line.tsx"
import { marks } from "../ui/marks.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { ticketsLines } from "../ui/TicketsTable.tsx"
import { runTime } from "../ui/TitleLine.tsx"
import type { Style, Theme } from "../ui/theme.ts"
import type { Printer } from "./organLine.ts"

/** A question tutti answered by --auto-answer, as the summary lists it. */
export interface AutoAnsweredItem {
  /** The ticket whose worker asked it. */
  readonly ticket: string
  /** The question ticket's ID; absent for a question asked in the worker's session. */
  readonly question?: string
  /** The question ticket's title, or what the session's question asked. */
  readonly title: string
  /** The option chosen: the recommended one, each question's, `, ` apart. */
  readonly choice: string
}

/** How to find the question tickets --auto-answer answered, once the run is over. */
export const autoAnsweredHint = "bd list --all --label auto-answered"

/** The heading of the summary's list of what --auto-answer answered. */
export const autoAnsweredHeading = "Answered by --auto-answer, not by you"

/** The lines listing what --auto-answer answered under its heading: each, then the hint. */
export const autoAnsweredTexts = (
  items: ReadonlyArray<AutoAnsweredItem>,
): ReadonlyArray<string> => {
  if (items.length === 0) return []
  const each = items.map((item) =>
    item.question === undefined
      ? `${item.ticket}'s worker: ${item.title} → ${item.choice}`
      : `${item.question} (${item.title}), for ${item.ticket} → ${item.choice}`,
  )
  const tickets = items.some((item) => item.question !== undefined)
  return [...each, ...(tickets ? [`find them later with: ${autoAnsweredHint}`] : [])]
}

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
  /** The questions --auto-answer answered, in the order it did; none without it. */
  readonly autoAnswered?: ReadonlyArray<AutoAnsweredItem>
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

/** The summary's parts in `theme`'s styles, `width` columns wide. */
const parts = (theme: Theme, width: number) => {
  const { styles } = theme
  const w = Math.max(width, minWidth)
  const zero = (text: string) => seg(text, styles.dim)

  /** The pill, the version, the branch, a scoped run's ticket and the run's time. */
  const title = (s: Summary): Segments => {
    const head = [seg(" Tutti ", styles.title), seg(" ")]
    const version = fit(s.version, Math.max(w - 8, 1))
    const scoped = s.scope === null ? "" : ` · ticket ${sanitizeLine(s.scope)}`
    const used = 8 + Bun.stringWidth(version) + 3
    const where = fit(`${sanitizeLine(s.branch)}${scoped} · ${runTime(s.took)}`, w - used)
    return used >= w
      ? [...head, seg(version, styles.dim)]
      : [...head, seg(version, styles.dim), seg("   "), seg(where, styles.dim)]
  }

  /** The totals strip: a column a total, its label faint over its count; zeros faint. */
  const totals = (t: Totals): ReadonlyArray<Segments> => {
    const count = (n: number, mark: string, style: Style): Segments => [
      n === 0 ? zero("0") : seg(`${mark} ${n}`, style),
    ]
    const setAside = t.deferred + t.review
    const workers: Segments =
      t.workers === 0
        ? [zero(`0 of ${t.slots}`)]
        : [seg(String(t.workers), styles.picked), seg(` of ${t.slots}`, styles.dim)]
    const queue: Segments = [
      t.queued === 0 ? zero("0") : seg(String(t.queued)),
      ...(t.heldBack > 0 ? [seg(` · ${t.heldBack} held back`, styles.heldBack)] : []),
      ...(t.queueHeld ? [seg(" · held", styles.windDown)] : []),
    ]
    const columns: ReadonlyArray<readonly [string, Segments]> = [
      ["Completed", count(t.completed, marks.done, styles.closed)],
      ["Set aside", count(setAside, marks.setAside, styles.deferred)],
      ["Needs you", count(t.needsYou, marks.asked, styles.stop)],
      ["Workers", workers],
      ["In queue", queue],
    ]
    const natural = columns.map(([label, value]) =>
      Math.max(Bun.stringWidth(label), widthOf(value)),
    )
    const need = natural.reduce((sum, n) => sum + n + 3, 1)
    if (need > w) {
      // Too narrow for the strip: the totals on one line.
      const one = (n: number, mark: string, style: Style) => seg(`${mark} ${n}`, style)
      const each: ReadonlyArray<Segments> = [
        [one(t.completed, marks.done, styles.closed)],
        [one(setAside, marks.setAside, styles.deferred)],
        [one(t.needsYou, marks.asked, styles.stop)],
        [one(t.workers, marks.working, styles.picked), seg(`/${t.slots}`, styles.dim)],
        [seg(`queue ${t.queued}`, styles.dim)],
      ]
      return [[seg(" "), ...each.flatMap((part, i) => (i === 0 ? part : [zero(" · "), ...part]))]]
    }
    const extra = w - need
    const widths = natural.map(
      (n, i) => n + Math.floor(extra / natural.length) + (i < extra % natural.length ? 1 : 0),
    )
    return framed(
      [columns.map(([label]) => [seg(label, styles.dim)]), columns.map(([, value]) => value)],
      widths,
      theme.look("frame"),
    )
  }

  /**
   * The run's figures under the totals, a line each: its label faint, then its parts ` · ` apart,
   * an estimate in its colour; the parts that don't fit cut, the first of them with `…`.
   */
  const figures = (lines: ReadonlyArray<FiguresLine>): ReadonlyArray<Segments> =>
    lines.map((each) => {
      let room = w - 2 - (labelWidth + 2)
      const drawn: Array<Segments[number]> = [
        seg("  "),
        seg(each.label.padEnd(labelWidth + 2), styles.dim),
      ]
      for (const [i, part] of each.parts.entries()) {
        const gap = i === 0 ? 0 : 3
        if (room <= gap) break
        const text = sanitizeLine(part.text)
        const shown = Bun.stringWidth(text) <= room - gap ? text : fit(text, room - gap)
        if (gap > 0) drawn.push(seg(" · ", styles.dim))
        drawn.push(seg(shown, part.estimate === true ? styles.estimate : null))
        room -= gap + Bun.stringWidth(shown)
        if (shown !== text) break
      }
      return drawn
    })

  /** The Tickets label and the dashboard's table under it: every row, and no blank one. */
  const tickets = (rows: ReadonlyArray<Row>): ReadonlyArray<Segments> =>
    ticketsLines(rows, theme, w, { fill: false })

  /** What --auto-answer answered: its heading as the Tickets label is, each, the hint faint. */
  const autoAnswered = (items: ReadonlyArray<AutoAnsweredItem>): ReadonlyArray<Segments> => {
    const texts = autoAnsweredTexts(items)
    if (texts.length === 0) return []
    const hint = texts.length > items.length ? texts.at(-1) : undefined
    return [
      [seg(autoAnsweredHeading, styles.tickets)],
      ...texts.map(
        (text): Segments => [
          seg("  "),
          seg(fit(sanitizeLine(text), Math.max(w - 2, 1)), text === hint ? styles.dim : null),
        ],
      ),
    ]
  }

  return { title, totals, figures, tickets, autoAnswered }
}

/**
 * The summary `width` columns wide (`minWidth` at the least), in `theme`'s styles: a blank line,
 * the title, the totals and, when the run took any up, its figures and every ticket; then what
 * --auto-answer answered, if anything.
 */
export const summary = (s: Summary, theme: Theme, width: number): string => {
  const p = parts(theme, width)
  return [
    [],
    p.title(s),
    ...p.totals(s.totals),
    ...(s.rows.length === 0 ? [] : [...p.figures(s.figures), ...p.tickets(s.rows)]),
    ...p.autoAnswered(s.autoAnswered ?? []),
  ]
    .map(paint)
    .join("\n")
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
  const first: Segments =
    ending._tag === "Stopped"
      ? [seg(`${marks.stopped} ${text}`, styles.stop)]
      : [
          seg(`${marks.end} ${headline(text, ending.limit, ending.tickets)}`, styles.closed),
          seg("  "),
          seg(
            ending.took >= 1000
              ? `${ticketCount(ending.tickets)} · ${runTime(ending.took)}`
              : ticketCount(ending.tickets),
            styles.dim,
          ),
        ]
  if (scope === null) return paint(first)
  const style = scope.startsWith("SCOPE_DONE") ? styles.done : styles.deferred
  return `${paint(first)}\n${paint([seg(`  ${scope}`, style)])}`
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
