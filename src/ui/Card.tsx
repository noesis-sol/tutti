// The dashboard's Current section (§ 5.1 "How the phases are shown", § 7.2, § 7.11): under its
// `Current` label, a card for each ticket with work under way, in its worker's number order. A card
// says its worker's stable number, its mark (the spinner while the worker works, `◷` to merge, `◆`
// merging, `•` once its turn has ended), its ticket, its status (`steered` beside it), how long it
// has been in its phase, its title, and its action line: the phase's (a merge's step, a recheck), or
// else the worker's latest action behind `▸`, a denied call `notice` for its 10 seconds.
//
// A card is framed `live` while its worker works and `needsYou` when it waits for you, `frame`
// otherwise; the highlighted one keeps its colour, bold in the heavy border style. From 120 columns
// the cards go two to a row, every one as tall as the tallest. When the pane can't hold a card each,
// they go one line each in a single compact box, framed `needsYou` when any of them waits for you.
// A card whose worker has a request open grows to show it and its buttons (AttentionCard.tsx).
// With no card, a box says what the run does: `picking the next ticket…`, or `stopping…`.
import { type MouseEvent, TextAttributes } from "@opentui/core"
import type { Card } from "../run/runView.ts"
import { AttentionLines, attentionInside, attentionLines } from "./AttentionCard.tsx"
import {
  type Border,
  boxed,
  frameLook,
  Lines,
  type Look,
  roleLook,
  type Segments,
  seg,
} from "./line.tsx"
import { sanitizeLine } from "./sanitize.ts"
import type { Theme } from "./theme.ts"

/** From this many columns the cards go two to a row (§ 7.2). */
export const twoUpWidth = 120

/** The Current label's line. */
export const labelLines = 1

/** The lines of the box with no worker in it: its frame and its line. */
export const idleLines = 3

/** How long a card has been in its phase: `42s`, `6m31s`, `1h05m`. */
export const elapsed = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
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

/** The look of a card's status (§ 7.11's Statuses). */
export const statusLook = (card: Card, theme: Theme): Look => {
  const { styles } = theme
  if (waitsForYou(card)) return styles.stop
  switch (card.phase._tag) {
    case "ToMerge":
      return styles.toMerge
    case "Merging":
      return styles.merging
    case "Resolving":
    case "Fixing":
      return styles.deferred
  }
  const state = card.state
  switch (state?._tag) {
    case "Starting":
    case "Closed":
      return styles.dim
    case "Working":
      return state.doing === "testing" ? styles.testing : styles.picked
    case "Retrying":
    case "UsageLimited":
      return styles.deferred
    case "Idle":
      return styles.done
    case "Failed":
      return state.interrupted ? styles.deferred : roleLook(theme, "needsYou")
    case "Gone":
      return roleLook(theme, "needsYou")
  }
  if (card.phase._tag !== "Working") return styles.dim
  switch (card.phase.activity) {
    case "testing":
      return styles.testing
    case "starting":
      return styles.dim
    case "retrying":
    case "limit":
      return styles.deferred
    case "allow":
    case "answer":
      return styles.stop
  }
  return styles.picked
}

/** The card's mark: the spinner's frame `spin` while its worker works, else its static mark. */
const markOf = (card: Card, theme: Theme, spin: string) => {
  const { styles } = theme
  switch (card.motion) {
    case "spinner":
      return seg(spin, styles.picked)
    case "◷":
      return seg("◷", styles.toMerge)
    case "◆":
      return seg("◆", styles.merging)
    case "•":
      return seg("•", styles.done)
  }
}

/** The card's frame: `needsYou` when it waits for you, `live` while its worker works. */
const frameOf = (card: Card, theme: Theme): Look =>
  waitsForYou(card)
    ? roleLook(theme, "needsYou")
    : card.motion === "spinner"
      ? roleLook(theme, "live")
      : frameLook(theme)

/** `steered` beside a status, `emphasis`, when you steered the card's worker. */
const steeredOf = (card: Card, theme: Theme): Segments =>
  card.steered ? [seg("  "), seg("steered", roleLook(theme, "emphasis"))] : []

/** The card's first line: its number, mark, ticket, status and elapsed time. */
export const headOf = (
  card: Card,
  theme: Theme,
  now: number,
  spin: string,
  status: Segments,
): Segments => {
  const { styles } = theme
  return [
    seg(String(card.worker), styles.key),
    seg(" "),
    markOf(card, theme, spin),
    seg("  "),
    seg(sanitizeLine(card.ticket), styles.picked),
    seg("  "),
    ...status,
    ...steeredOf(card, theme),
    seg("  "),
    seg(elapsed(now - card.since), styles.dim),
  ]
}

/** The card's action line: the phase's, else its worker's latest action behind `▸`; null for none. */
export const actionLine = (card: Card, theme: Theme): Segments | null => {
  const { styles } = theme
  if (card.action !== null) return [seg("  "), seg(card.action, styles.dim)]
  if (card.latest === null) return null
  return [
    seg("  "),
    seg(`▸ ${card.latest.text}`, card.latest.denied ? styles.deferred : styles.dim),
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
 * A card's lines `width` wide, `inside` lines between its frame's top and bottom, the title and
 * action line padded out below; heavy when it is highlighted.
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

/** A compact line's status: an attention request's row word, `■ allow?` or `■ answer?`. */
const compactStatus = (card: Card, theme: Theme): Segments => {
  const first = card.requests[0]
  if (first === undefined) return [seg(card.status, statusLook(card, theme))]
  return [seg(first.kind._tag === "Question" ? "■ answer?" : "■ allow?", theme.styles.stop)]
}

/** A card on one line, for the compact box: its head, then its title faint. */
export const compactLine = (card: Card, theme: Theme, now: number, spin: string): Segments => [
  ...headOf(card, theme, now, spin, compactStatus(card, theme)),
  seg("  "),
  seg(card.title, theme.styles.dim),
]

/** The compact box's left bar on the highlighted card's line: heavy, bold, in the box's colour. */
const heavyBar = (frame: Look) =>
  seg("┃", { ...frame, attributes: frame.attributes | TextAttributes.BOLD })

/**
 * The compact box's lines `width` wide, a line a card: framed `needsYou` when any of them waits for
 * you, `live` while any works, `frame` otherwise. The highlighted card's line has a heavy left bar.
 */
export const compactLines = (
  cards: ReadonlyArray<Card>,
  theme: Theme,
  options: {
    readonly now: number
    readonly spin: string
    readonly width: number
    readonly highlighted: number | null
  },
): ReadonlyArray<Segments> => {
  const frame = cards.some(waitsForYou)
    ? roleLook(theme, "needsYou")
    : cards.some((card) => card.motion === "spinner")
      ? roleLook(theme, "live")
      : frameLook(theme)
  const lines = boxed(
    cards.map((card) => compactLine(card, theme, options.now, options.spin)),
    options.width,
    frame,
  )
  return lines.map((line, i) => {
    const card = cards[i - 1]
    if (card === undefined || card.worker !== options.highlighted) return line
    return [heavyBar(frame), ...line.slice(1)]
  })
}

/** The box with no worker in it: the spinner `live`, its text faint, framed `frame`. */
export const idleBox = (
  stopping: boolean,
  theme: Theme,
  spin: string,
  width: number,
): ReadonlyArray<Segments> =>
  boxed(
    [
      [
        seg(spin, roleLook(theme, "live")),
        seg(" "),
        seg(stopping ? "stopping…" : "picking the next ticket…", theme.styles.dim),
      ],
    ],
    width,
    frameLook(theme),
  )

/** How the Current section is laid out in `room` lines, `width` wide. */
export type CardsLayout =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Cards"
      /** Cards a row: 1, or 2 from 120 columns. */
      readonly across: number
      /** The lines inside each card but an attention card: as many as the tallest's. */
      readonly inside: number
      /** Each row's lines, frames included: its tallest card's, an attention card's own. */
      readonly rows: ReadonlyArray<number>
    }
  | { readonly _tag: "Compact" }

/** Whether the card grows to show its worker's oldest request: an attention card (§ 7.2). */
export const grows = (card: Card): boolean => card.requests.length > 0

/**
 * The Current section's layout: full cards when they fit `room` lines, else the compact box. The
 * cards are as tall as the tallest, but an attention card is as tall as its request needs.
 */
export const layoutOf = (cards: ReadonlyArray<Card>, width: number, room: number): CardsLayout => {
  if (cards.length === 0) return { _tag: "Idle" }
  const across = width >= twoUpWidth ? 2 : 1
  const inside = Math.max(
    2,
    ...cards
      .filter((card) => !grows(card))
      .map((card) => (card.action !== null || card.latest !== null ? 3 : 2)),
  )
  const rows: Array<number> = []
  for (let i = 0; i < cards.length; i += across) {
    const row = cards.slice(i, i + across)
    rows.push(2 + Math.max(...row.map((card) => (grows(card) ? attentionInside(card) : inside))))
  }
  return labelLines + rows.reduce((sum, lines) => sum + lines, 0) <= room
    ? { _tag: "Cards", across, inside, rows }
    : { _tag: "Compact" }
}

/** A click with the left button on a card opens its worker's view. */
const clicked = (open: () => void) => (event: MouseEvent) => {
  if (event.button === 0) open()
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

/** The Current section: its label, then the cards as `layout` lays them out. */
export const Cards = ({
  cards,
  theme,
  layout,
  width,
  now,
  spin,
  stopping,
  highlighted,
  open,
  focusOf,
  press,
}: {
  readonly cards: ReadonlyArray<Card>
  readonly theme: Theme
  readonly layout: CardsLayout
  readonly width: number
  readonly now: number
  readonly spin: string
  readonly stopping: boolean
  readonly highlighted: number | null
  readonly open: (worker: number) => void
  /** The focused button of an attention card. */
  readonly focusOf: (card: Card) => number | null
  /** Presses an attention card's button. */
  readonly press: (card: Card, index: number) => void
}) => {
  const label = <Lines lines={[[seg("  "), seg("Current", theme.styles.picked)]]} />
  switch (layout._tag) {
    case "Idle":
      return (
        <box flexDirection="column" flexShrink={0}>
          {label}
          <Lines lines={idleBox(stopping, theme, spin, width)} />
        </box>
      )
    case "Compact": {
      const lines = compactLines(cards, theme, { now, spin, width, highlighted })
      return (
        <box flexDirection="column" flexShrink={0}>
          {label}
          {lines.map((line, i) => {
            const card = cards[i - 1]
            return (
              <box
                // biome-ignore lint/suspicious/noArrayIndexKey: the box's lines are drawn anew in order
                key={i}
                height={1}
                {...(card === undefined ? {} : { onMouseDown: clicked(() => open(card.worker)) })}
              >
                <Lines lines={[line]} />
              </box>
            )
          })}
        </box>
      )
    }
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
                  const lit = card.worker === highlighted
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: a terminal box, not the DOM's
                    <box
                      key={card.ticket}
                      width={w}
                      height={tall}
                      onMouseDown={clicked(() => open(card.worker))}
                    >
                      {grows(card) ? (
                        <AttentionLines
                          lines={attentionLines(
                            card,
                            theme,
                            contentOf(card, theme, now, spin).slice(0, 2),
                            { width: w, highlighted: lit, focus: focusOf(card) },
                          )}
                          press={(index) => press(card, index)}
                        />
                      ) : (
                        <Lines
                          lines={cardLines(card, theme, {
                            now,
                            spin,
                            width: w,
                            inside: layout.inside,
                            highlighted: lit,
                          })}
                        />
                      )}
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
