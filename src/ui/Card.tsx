// The dashboard's Current section (§ 5.1 "How the phases are shown", § 7.2, § 7.11): under its
// `Current` label, a card for each ticket with work under way, in its worker's number order, a
// number the card doesn't show (§ 7.2). A card says its mark (the spinner while the worker works,
// `◼` to merge, `◆` merging, `•` once its turn has ended), its ticket, its status (`steered` beside
// it), how long it has been in its phase, the memory its worker's processes take once the run has
// read it (`1.2 GB`, `? GB` when they can't be found, src/run/load.ts), its title, and its action
// line: the phase's (a merge's step, a recheck), or else the worker's latest action behind `▸`, a
// denied call `notice` for its 10 seconds, blank while it has none: a full card is always 3 lines
// inside its frame, so that it doesn't grow with its first action (tutti-pgl6).
//
// A card is framed `live` while its worker works and `needsYou` when it waits for you, `frame`
// otherwise; the highlighted one keeps its colour, bold in the heavy border style. From 120 columns
// the cards go two to a row, a row as tall as its tallest card. When the pane can't hold a card each,
// they go one line each in a single compact box, framed `needsYou` when any of them waits for you,
// their tickets, statuses, times and memory lined up as columns, each as wide as the widest.
// A card whose worker has a request open grows to show it and its buttons (AttentionCard.tsx).
// With no card, a box as tall as a full card says what the run does on its first line: `picking the
// next ticket…`, or `stopping…`, or, while the end-of-run full check runs, its step, command and
// time: `setting up the full check: bun install · 12s`, then `full check: scripts/check-full.sh ·
// 1m12s`.
import { memo, useCallback, useMemo } from "react"
import type { FullCheckRun } from "../run/fullcheck.ts"
import { pad } from "../run/localTime.ts"
import { activityRows } from "../run/phase.ts"
import type { Card, ShownRequest } from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import { attentionInside, attentionLines } from "./AttentionCard.tsx"
import { clickable } from "./click.ts"
import { workerMemory } from "./LoadLine.tsx"
import {
  type Border,
  boxed,
  boxSides,
  Line,
  Lines,
  type Look,
  type Segment,
  type Segments,
  seg,
  widthOf,
} from "./line.tsx"
import { lookOf, marks, motionTones } from "./marks.ts"
import type { Theme } from "./theme.ts"
import { useNow, useSpinner } from "./useRunView.ts"

/** From this many columns the cards go two to a row (§ 7.2). */
export const twoUpWidth = 120

/** The Current label's line. */
export const labelLines = 1

/** The lines inside a full card's frame, but an attention card's: its head, title and action line. */
const fullCardInside = 3

/** A full card's lines, but an attention card's: its frame, head, title and action line. */
const fullCardLines = fullCardInside + 2

/** The lines of the box with no worker in it, as many as a full card's: its frame and 3 lines. */
export const idleLines = fullCardLines

/**
 * The fewest lines the Current section is drawn in: its label and a box with a line in it, the idle
 * box cut to its first line or the compact box with only its `+N more` line.
 */
export const fewestCurrentLines = labelLines + 3

/** The workers the dashboard keeps Current room for a full card each, as many as the run may have. */
export const keptCards = 6

/** Cards a row in a pane `width` wide: 1, or 2 from 120 columns. */
const acrossOf = (width: number): number => (width >= twoUpWidth ? 2 : 1)

/** How long a card has been in its phase: `42s`, `6m31s`, `1h05m`. */
export const elapsed = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
}

/**
 * Whether the card's worker waits for you: a request open, the CLI says it needs you, or its
 * ticket is Blocked with its conflict hand-back waiting (§ 4.3).
 */
export const waitsForYou = (card: Card): boolean =>
  card.requests.length > 0 || card.state?._tag === "NeedsYou" || card.phase._tag === "Blocked"

/** The look of a card's status (§ 7.11's Statuses), its tone as RunView worked it out. */
export const statusLook = (card: Card, theme: Theme): Look => lookOf(card.tone, theme)

/** The card's mark: the spinner's frame `spin` while its worker works, else its static mark. */
export const cardMark = (card: Card, theme: Theme, spin: string): Segment =>
  seg(
    card.motion === "spinner" ? spin : marks[card.motion],
    lookOf(motionTones[card.motion], theme),
  )

/** The card's frame: `needsYou` when it waits for you, `live` while its worker works. */
const frameOf = (card: Card, theme: Theme): Look =>
  waitsForYou(card)
    ? theme.look("needsYou")
    : card.motion === "spinner"
      ? theme.look("live")
      : theme.look("frame")

/** `steered` beside a status, `emphasis`, when you steered the card's worker. */
const steeredOf = (card: Card, theme: Theme): Segments =>
  card.steered ? [seg("  "), seg("steered", theme.look("emphasis"))] : []

/** The cells of a card's first line but its mark: its ticket, status, elapsed time and memory. */
interface HeadCells {
  readonly ticket: Segments
  /** Its status, `steered` beside it. */
  readonly status: Segments
  readonly time: Segments
  /** None before the run has read it. */
  readonly memory: Segments
}

/** The widths of the compact box's columns: the widest ticket, status, time and memory on screen. */
type HeadColumns = { readonly [K in keyof HeadCells]: number }

const noColumns: HeadColumns = { ticket: 0, status: 0, time: 0, memory: 0 }

const cellsOf = (card: Card, theme: Theme, now: number, status: Segments): HeadCells => {
  const { styles } = theme
  return {
    ticket: [seg(card.label, styles.picked)],
    status: [...status, ...steeredOf(card, theme)],
    time: [seg(elapsed(now - card.since), styles.dim)],
    memory: card.memory === undefined ? [] : [seg(workerMemory(card.memory), styles.dim)],
  }
}

/** `cols` widened to hold `cells`. */
const fit = (cols: HeadColumns, cells: HeadCells): HeadColumns => ({
  ticket: Math.max(cols.ticket, widthOf(cells.ticket)),
  status: Math.max(cols.status, widthOf(cells.status)),
  time: Math.max(cols.time, widthOf(cells.time)),
  memory: Math.max(cols.memory, widthOf(cells.memory)),
})

/** The spaces that make `segments` `width` wide; none when they are as wide or wider. */
const padding = (segments: Segments, width: number): Segments => {
  const short = width - widthOf(segments)
  return short > 0 ? [seg(" ".repeat(short))] : []
}

/**
 * A card's first line from its cells and `mark`: its ticket in line with the lines below it, its
 * ticket and status padded to `cols`, and its time and memory right-aligned in them, so that their
 * digits line up with the other lines'.
 */
const headLine = (cells: HeadCells, mark: Segment, cols: HeadColumns): Segments => [
  mark,
  seg(" "),
  ...cells.ticket,
  ...padding(cells.ticket, cols.ticket),
  seg("  "),
  ...cells.status,
  ...padding(cells.status, cols.status),
  seg("  "),
  ...padding(cells.time, cols.time),
  ...cells.time,
  ...(cells.memory.length === 0 && cols.memory === 0
    ? []
    : [seg("  "), ...padding(cells.memory, cols.memory), ...cells.memory]),
]

/** The card's first line: its mark, ticket, status, elapsed time and memory. */
export const headOf = (
  card: Card,
  theme: Theme,
  now: number,
  spin: string,
  status: Segments,
): Segments => headLine(cellsOf(card, theme, now, status), cardMark(card, theme, spin), noColumns)

/** The card's action line: the phase's, else its worker's latest action behind `▸`; null for none. */
export const actionLine = (card: Card, theme: Theme): Segments | null => {
  const { styles } = theme
  if (card.action !== null) return [seg("  "), seg(card.action, styles.dim)]
  if (card.latest === null) return null
  return [
    seg("  "),
    seg(`${marks.latest} ${card.latest.text}`, card.latest.denied ? styles.deferred : styles.dim),
  ]
}

/** The lines inside a card: its head, its title, and its action line when it has one. */
export const contentOf = (
  card: Card,
  theme: Theme,
  now: number,
  spin: string,
): ReadonlyArray<Segments> => {
  const head = headOf(card, theme, now, spin, [seg(card.status, statusLook(card, theme))])
  const action = actionLine(card, theme)
  return [head, [seg("  "), seg(card.title)], ...(action === null ? [] : [action])]
}

/**
 * A card's lines `width` wide, `inside` lines between its frame's top and bottom, padded out below
 * with blank lines, the action line's while it has none; heavy when it is highlighted.
 */
export const cardLines = (
  card: Card,
  theme: Theme,
  options: {
    readonly now: number
    readonly spin: string
    readonly width: number
    readonly inside: number
    readonly highlighted: boolean
  },
): ReadonlyArray<Segments> => {
  const content = [...contentOf(card, theme, options.now, options.spin)]
  while (content.length < options.inside) content.push([])
  const border: Border = options.highlighted ? "heavy" : "rounded"
  return boxed(content, options.width, frameOf(card, theme), border)
}

/** A compact line's status: an attention request's row status, `■ allow?` or `■ answer?`. */
const compactStatus = (card: Card, theme: Theme): Segments => {
  const first = card.requests[0]
  if (first === undefined) return [seg(card.status, statusLook(card, theme))]
  const shown = activityRows[first.kind._tag === "Question" ? "answer" : "allow"]
  return [seg(`${marks[shown.mark]} ${shown.word}`, lookOf(shown.tone, theme))]
}

/**
 * A card on one line, for the compact box: its head, its cells padded to `cols`, then its title
 * faint.
 */
const compactLine = (
  card: Card,
  theme: Theme,
  now: number,
  spin: string,
  cols: HeadColumns,
): Segments => [
  ...headLine(
    cellsOf(card, theme, now, compactStatus(card, theme)),
    cardMark(card, theme, spin),
    cols,
  ),
  seg("  "),
  seg(card.title, theme.styles.dim),
]

/** The compact box's left bar on the highlighted card's line: heavy, bold, in the box's colour. */
const heavyBar = (frame: Look) => seg("┃", frame.bold())

/**
 * The cards the compact box has a line for in `lines` lines, its frame included: all of them when
 * they fit, else as many as fit beside a `+N more` line, the highlighted card first, then those
 * waiting for you, then the rest, in their order.
 */
export const compactShown = (
  cards: ReadonlyArray<Card>,
  highlighted: string | null,
  lines: number,
): ReadonlyArray<Card> => {
  if (cards.length + 2 <= lines) return cards
  const rank = (card: Card) => (card.ticket === highlighted ? 0 : waitsForYou(card) ? 1 : 2)
  const kept = new Set(
    [...cards].sort((a, b) => rank(a) - rank(b)).slice(0, Math.max(lines - 3, 0)),
  )
  return cards.filter((card) => kept.has(card))
}

/**
 * The compact box's lines `width` wide, a line a card, its ticket, status and time in
 * columns: framed `needsYou` when any of them waits for you, `live` while any works, `frame`
 * otherwise. The highlighted card's line has a heavy left bar. In fewer `lines` than a line each,
 * the cards compactShown leaves out are a `+N more` line at the box's foot.
 */
export const compactLines = (
  cards: ReadonlyArray<Card>,
  theme: Theme,
  options: {
    readonly now: number
    readonly spin: string
    readonly width: number
    /** The highlighted card's ticket. */
    readonly highlighted: string | null
    /** The most lines the box takes, its frame included; as many as it needs when left out. */
    readonly lines?: number
  },
): ReadonlyArray<Segments> => {
  const frame = cards.some(waitsForYou)
    ? theme.look("needsYou")
    : cards.some((card) => card.motion === "spinner")
      ? theme.look("live")
      : theme.look("frame")
  const shown = compactShown(cards, options.highlighted, options.lines ?? cards.length + 2)
  const more = cards.length - shown.length
  // The tickets, statuses and times line up as columns, each as wide as the widest.
  const cols = shown.reduce(
    (widths, card) => fit(widths, cellsOf(card, theme, options.now, compactStatus(card, theme))),
    noColumns,
  )
  const lines = boxed(
    [
      ...shown.map((card) => compactLine(card, theme, options.now, options.spin, cols)),
      ...(more > 0 ? [[seg(`+${more} more`, theme.styles.dim)]] : []),
    ],
    options.width,
    frame,
  )
  return lines.map((line, i) => {
    const card = shown[i - 1]
    if (card === undefined || card.ticket !== options.highlighted) return line
    return [heavyBar(frame), ...line.slice(1)]
  })
}

/**
 * What the box with no worker in it says at `now`: `stopping…`, else what the end-of-run full check
 * runs and for how long, else `picking the next ticket…`.
 */
export const idleText = (
  stopping: boolean,
  fullCheck: FullCheckRun | null,
  now: number,
): string => {
  if (stopping) return "stopping…"
  if (fullCheck === null) return "picking the next ticket…"
  const what = fullCheck.step === "setup" ? "setting up the full check" : "full check"
  return `${what}: ${fullCheck.command} · ${elapsed(now - fullCheck.began)}`
}

/**
 * The box with no worker in it, saying `text` on its first line: the spinner `live`, its text faint,
 * framed `frame`. It is `lines` lines tall, its frame included, as tall as a full card unless the
 * pane has fewer lines for it, and never fewer than its frame and its text.
 */
export const idleBox = (
  text: string,
  theme: Theme,
  spin: string,
  width: number,
  lines: number = idleLines,
): ReadonlyArray<Segments> => {
  const content: Array<Segments> = [
    [seg(spin, theme.look("live")), seg(" "), seg(text, theme.styles.dim)],
  ]
  while (content.length < Math.min(lines, idleLines) - 2) content.push([])
  return boxed(content, width, theme.look("frame"))
}

/** How the Current section is laid out in `room` lines, `width` wide. */
export type CardsLayout =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Cards"
      /** Cards a row: 1, or 2 from 120 columns. */
      readonly across: number
      /** The lines inside each card but an attention card: 3, its action line blank without one. */
      readonly inside: number
      /** Each row's lines, frames included: its tallest card's, an attention card's own. */
      readonly rows: ReadonlyArray<number>
    }
  | { readonly _tag: "Compact" }

/** Whether the card grows to show its worker's oldest request: an attention card (§ 7.2). */
export const grows = (card: Card): boolean => card.requests.length > 0

/**
 * The Current section's layout: full cards when they fit `room` lines, else the compact box. A full
 * card is 3 lines inside its frame whether or not it has an action line, so that it keeps its height
 * as actions come and go, but an attention card is as tall as its request needs, and a row as tall
 * as its tallest card.
 */
export const layoutOf = (cards: ReadonlyArray<Card>, width: number, room: number): CardsLayout => {
  if (cards.length === 0) return { _tag: "Idle" }
  const across = acrossOf(width)
  const inside = fullCardInside
  const rows: Array<number> = []
  for (let i = 0; i < cards.length; i += across) {
    const row = cards.slice(i, i + across)
    rows.push(2 + Math.max(...row.map((card) => (grows(card) ? attentionInside(card) : inside))))
  }
  return labelLines + rows.reduce((sum, lines) => sum + lines, 0) <= room
    ? { _tag: "Cards", across, inside, rows }
    : { _tag: "Compact" }
}

/** The lines the Current section takes in `layout`, its label included. */
export const sectionLines = (layout: CardsLayout, count: number): number => {
  switch (layout._tag) {
    case "Idle":
      return labelLines + idleLines
    case "Compact":
      return labelLines + count + 2
    case "Cards":
      return labelLines + layout.rows.reduce((sum, lines) => sum + lines, 0)
  }
}

/**
 * The lines the dashboard keeps for the Current section in a pane `width` wide, from the `slots`
 * workers the run may have, not the cards there are: its label and a full card for each of up to
 * `keptCards` workers, two to a row from 120 columns, and no fewer than a compact line each, a
 * line each for all `cards` too where tickets merging without a worker's slot make them more.
 */
export const keptLines = (width: number, slots: number, cards: number): number => {
  const workers = Math.max(slots, 1)
  const rows = Math.ceil(Math.min(workers, keptCards) / acrossOf(width))
  return Math.max(
    labelLines + rows * fullCardLines,
    sectionLines({ _tag: "Compact" }, Math.max(workers, cards)),
  )
}

/**
 * The box with no worker in it, its spinner turning: it reads the spinner and the clock itself, so
 * that nothing over it is drawn anew ten times a second (tutti-axpo.5).
 */
const IdleBox = ({
  stopping,
  fullCheck,
  theme,
  width,
  lines,
}: {
  readonly stopping: boolean
  readonly fullCheck: FullCheckRun | null
  readonly theme: Theme
  readonly width: number
  /** The box's lines, its frame included: as many as a full card's where the room has them. */
  readonly lines: number
}) => {
  const text = idleText(stopping, fullCheck, useNow())
  return <Lines lines={idleBox(text, theme, useSpinner(true), width, lines)} />
}

/**
 * The compact box in `lines` lines, its frame included, a click on a card's line opening its worker;
 * its clock and spinner are read here, the spinner while any of its cards works.
 */
const CompactBox = ({
  cards,
  theme,
  width,
  lines,
  highlighted,
  open,
}: {
  readonly cards: ReadonlyArray<Card>
  readonly theme: Theme
  readonly width: number
  readonly lines: number
  readonly highlighted: string | null
  readonly open: (ticket: TicketId) => void
}) => {
  const now = useNow()
  const spin = useSpinner(cards.some((card) => card.motion === "spinner"))
  const drawn = compactLines(cards, theme, { now, spin, width, highlighted, lines })
  const shown = compactShown(cards, highlighted, lines)
  return drawn.map((line, i) => {
    const card = shown[i - 1]
    return (
      <box
        // biome-ignore lint/suspicious/noArrayIndexKey: the box's lines are drawn anew in order
        key={i}
        height={1}
        {...(card === undefined ? {} : clickable(() => open(card.ticket)))}
      >
        <Lines lines={[line]} />
      </box>
    )
  })
}

/**
 * A card's head between its frame's sides, `width` wide: its clock and spinner tick here, the spinner
 * while its worker works, so that a tick draws this line anew and nothing else of the card.
 */
const CardHead = ({
  card,
  theme,
  width,
  border,
}: {
  readonly card: Card
  readonly theme: Theme
  readonly width: number
  readonly border: Border
}) => {
  const now = useNow()
  const spin = useSpinner(card.motion === "spinner")
  const head = headOf(card, theme, now, spin, [seg(card.status, statusLook(card, theme))])
  return <Line segments={boxSides([head], width, frameOf(card, theme), border)[0] ?? []} />
}

/**
 * A full card `width` wide, an attention card with its request's buttons, drawn anew only when what
 * it shows changes: its lines are worked out then, and only its head (CardHead) ticks.
 */
const CardBox = memo(
  ({
    card,
    theme,
    width,
    inside,
    highlighted,
    focus,
    press,
  }: {
    readonly card: Card
    readonly theme: Theme
    readonly width: number
    readonly inside: number
    readonly highlighted: boolean
    readonly focus: number | null
    /** Presses an attention card's button: the same function from one drawing to the next. */
    readonly press: (request: ShownRequest | undefined, index: number) => void
  }) => {
    // The card's lines but its head, which CardHead draws in their place, at the clock's time.
    const lines = useMemo(() => {
      const [now, spin] = [card.since, ""]
      return grows(card)
        ? attentionLines(card, theme, contentOf(card, theme, now, spin).slice(0, 2), {
            width,
            highlighted,
            focus,
          })
        : cardLines(card, theme, { now, spin, width, inside, highlighted })
    }, [card, theme, width, inside, highlighted, focus])
    const [top, below] = useMemo(() => [lines.slice(0, 1), lines.slice(2)], [lines])
    const pressed = useCallback((index: number) => press(card.requests[0], index), [press, card])
    return (
      <box flexDirection="column" height={lines.length} flexShrink={0}>
        <Lines lines={top} />
        <CardHead
          card={card}
          theme={theme}
          width={width}
          border={highlighted ? "heavy" : "rounded"}
        />
        {/* Only an attention card's buttons have targets to press. */}
        <Lines lines={below} press={pressed} />
      </box>
    )
  },
)

/**
 * The Current section: its label, then the cards as `layout` lays them out. Each card's head, the
 * compact box and the idle box read the shell's clock and spinner (tutti-axpo.5), so that a tick
 * draws them alone; a card is drawn anew whole only when it changes (tutti-rvzn.1).
 */
export const Cards = ({
  cards,
  theme,
  layout,
  width,
  room,
  stopping,
  fullCheck,
  highlighted,
  open,
  focusOf,
  press,
}: {
  readonly cards: ReadonlyArray<Card>
  readonly theme: Theme
  readonly layout: CardsLayout
  readonly width: number
  /** The section's lines, its label included: the compact box keeps within them. */
  readonly room: number
  readonly stopping: boolean
  /** What the end-of-run full check runs, for the box with no worker in it; null when it isn't. */
  readonly fullCheck: FullCheckRun | null
  /** The highlighted card's ticket. */
  readonly highlighted: string | null
  /** Opens the view of the ticket's worker. */
  readonly open: (ticket: TicketId) => void
  /** The focused button of an attention card. */
  readonly focusOf: (request: ShownRequest | undefined) => number | null
  /** Presses an attention card's button: the same function from one drawing to the next. */
  readonly press: (request: ShownRequest | undefined, index: number) => void
}) => {
  const label = <Lines lines={[[seg("  "), seg("Current", theme.styles.picked)]]} />
  switch (layout._tag) {
    case "Idle":
      return (
        <box flexDirection="column" flexShrink={0}>
          {label}
          <IdleBox
            stopping={stopping}
            fullCheck={fullCheck}
            theme={theme}
            width={width}
            lines={room - labelLines}
          />
        </box>
      )
    case "Compact":
      return (
        <box flexDirection="column" flexShrink={0}>
          {label}
          <CompactBox
            cards={cards}
            theme={theme}
            width={width}
            lines={room - labelLines}
            highlighted={highlighted}
            open={open}
          />
        </box>
      )
    case "Cards": {
      const rows: Array<ReadonlyArray<Card>> = []
      for (let i = 0; i < cards.length; i += layout.across) {
        rows.push(cards.slice(i, i + layout.across))
      }
      const first = Math.floor(width / layout.across)
      return (
        <box flexDirection="column" flexShrink={0}>
          {label}
          {rows.map((row, r) => {
            const tall = layout.rows[r] ?? layout.inside + 2
            return (
              <box key={row[0]?.ticket ?? ""} flexDirection="row" height={tall}>
                {row.map((card, i) => {
                  const w = i === 0 ? first : width - first
                  return (
                    <box
                      key={card.ticket}
                      width={w}
                      height={tall}
                      {...clickable(() => open(card.ticket))}
                    >
                      <CardBox
                        card={card}
                        theme={theme}
                        width={w}
                        inside={layout.inside}
                        highlighted={card.ticket === highlighted}
                        focus={focusOf(card.requests[0])}
                        press={press}
                      />
                    </box>
                  )
                })}
              </box>
            )
          })}
        </box>
      )
    }
  }
}
