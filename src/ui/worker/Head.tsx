// A transcript view's head (§ 7.5): a blank line above it, as the dashboard has above its title
// line, then the link back and what the view shows, on as many lines as it takes; and the worker
// view's own line 1, on one line: its worker's mark, ticket and status, then what it consumes
// (figures.ts), and where the ticket's box isn't drawn, at the minimum size, its type and priority,
// which the box has in its top border otherwise (TicketHead.tsx); and the ticket's title in bold.
import { useEffect, useRef } from "react"
import type { Resources } from "../../run/resources.ts"
import type { Card } from "../../run/runView.ts"
import type { TicketId } from "../../services/Beads.ts"
import { cardMark, statusLook } from "../Card.tsx"
import { finishedWords } from "../Composer.tsx"
import { clickable } from "../click.ts"
import { minHeight, minWidth } from "../Dashboard.tsx"
import { type FitPart, fitParts } from "../fit.ts"
import { cut, Line, Lines, type Press, type Segments, seg, styled, wrap } from "../line.tsx"
import { sanitizeLine } from "../sanitize.ts"
import { badgeLabel, badgesOf, titleSegment } from "../TicketHead.tsx"
import type { Theme } from "../theme.ts"
import { useNow, useRunViewPart, useSpinner, useTheme } from "../useRunView.ts"
import { type FigureInputs, figureParts, fromTheEnd, gap } from "./figures.ts"

/**
 * The blank lines above a transcript view's head in a pane `width` by `height`: one, as the
 * dashboard has above its title line, so the top row stays put between the screens; none where the
 * dashboard leaves its own out, below the minimum size (§ 7.7).
 */
export const aboveLines = (width: number, height: number): number =>
  width < minWidth || height < minHeight ? 0 : 1

/**
 * The head of a transcript's view: `link`, which a click follows as `leave`, then `head` at the
 * shell's clock and the spinner's frame, wrapped rather than cut (tutti-rfs). Its lines after the
 * first are under the link, not in the transcript's scrollbox, so their height doesn't touch #1514.
 * The clock and the spinner tick here, in a leaf, so that the view over it isn't drawn anew ten
 * times a second while `spinning` (tutti-k2n1); `counted` hears how many lines it takes, as that
 * changes, for the view's request panel (tutti-7nzv). With `press`, a click on the head's
 * segments with a target presses it.
 */
export const ViewHead = ({
  link,
  leave,
  head,
  spinning,
  width,
  counted,
  press,
}: {
  readonly link: string
  readonly leave: () => void
  readonly head: (now: number, spin: string) => Segments
  readonly spinning: boolean
  readonly width: number
  readonly counted?: (lines: number) => void
  readonly press?: Press
}) => {
  const theme = useTheme()
  const now = useNow()
  const spin = useSpinner(spinning)
  const lines = wrap([seg("   "), ...head(now, spin)], width, {
    indent: 4,
    long: "line",
    start: Bun.stringWidth(link),
  })
  useEffect(() => counted?.(lines.length), [counted, lines.length])
  return (
    <>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text wrapMode="none" height={1} {...styled(theme.styles.key)} {...clickable(leave)}>
          {link}
        </text>
        <Line segments={lines[0] ?? []} {...(press === undefined ? {} : { press })} />
      </box>
      {lines.length > 1 ? (
        <Lines lines={lines.slice(1)} {...(press === undefined ? {} : { press })} />
      ) : null}
    </>
  )
}

/** The worker view's link back to the dashboard. */
const workerLink = " ← Dashboard"

/** What line 1 shows of a worker, beside its card. */
export interface LineOneInputs {
  /** Its status's segments: the card's, or finished. */
  readonly status: Segments
  readonly spin: string
  /** What its ticket consumes, none before the run has any. */
  readonly resources: Resources | undefined
  readonly figures: Omit<FigureInputs, "took" | "memory">
  /** Whether it ends with the ticket's type and priority: only where its box isn't drawn. */
  readonly badges: boolean
}

/**
 * The worker view's line 1 after its link, `width` wide: the card's mark, ticket and status, never
 * left out; then the figures (figures.ts), the time among them never left out; then with `badges`
 * the ticket's type and priority, coloured as the box's top border has them. Where it doesn't fit,
 * it drops the memory, then the warning's reset time, then the compactions, then whole parts from
 * its end, the type and priority first, and is cut only once nothing more can go.
 */
export const lineOneSegments = (
  card: Card,
  inputs: LineOneInputs,
  theme: Theme,
  width: number,
): Segments => {
  const badges = inputs.badges ? badgeLabel(badgesOf(card.issue, theme), theme) : []
  const lead: FitPart = {
    forms: [
      [
        cardMark(card, theme, inputs.spin),
        seg(" "),
        seg(card.label, theme.styles.picked),
        seg(gap),
        ...inputs.status,
        ...(card.steered ? [seg(gap), seg("steered", theme.look("emphasis"))] : []),
      ],
    ],
    rank: 0,
  }
  const figures = figureParts(
    inputs.resources,
    {
      ...inputs.figures,
      took: inputs.resources?.took ?? card.since,
      ...(card.memory === undefined ? {} : { memory: card.memory }),
    },
    theme,
  )
  const type: ReadonlyArray<FitPart> =
    badges.length === 0 ? [] : [{ forms: [badges, []], rank: fromTheEnd }]
  return fitParts([lead, ...figures, ...type], width, [seg(gap)])
}

/**
 * The worker view's head: ` ← Dashboard`, which a click follows as `leave`, then line 1
 * (lineOneSegments) on one line, with the ticket's type and priority where `badges`. Once the
 * worker has `finished`, its card gone, the head says finished, its time stopped where the view
 * first drew it gone (tutti-2n7y). `card` is the last seen: none, the ticket has no worker.
 */
export const WorkerHead = ({
  ticket,
  card,
  resources,
  finished,
  leave,
  badges,
  width,
  counted,
}: {
  readonly ticket: TicketId
  readonly card: Card | undefined
  readonly resources: Resources | undefined
  readonly finished: boolean
  readonly leave: () => void
  readonly badges: boolean
  readonly width: number
  readonly counted: (lines: number) => void
}) => {
  const theme = useTheme()
  const usage = useRunViewPart((view) =>
    view.banners.flatMap((banner) => (banner._tag === "Usage" ? [banner] : [])).at(0),
  )
  // When the view first drew the worker finished: its head's clock stops there.
  const ended = useRef<number | undefined>(undefined)
  if (!finished) ended.current = undefined
  const head = (now: number, spin: string): Segments => {
    if (card === undefined) return [seg(`${sanitizeLine(ticket)} has no worker`, theme.styles.dim)]
    if (finished) ended.current ??= now
    const shown: Card = finished ? { ...card, motion: "idle", steered: false } : card
    const status = finished
      ? seg(finishedWords(ticket).status, theme.styles.done)
      : seg(card.status, statusLook(card, theme))
    return lineOneSegments(
      shown,
      {
        status: [status],
        spin,
        resources,
        figures: { usage: usage ?? null, now: ended.current ?? now },
        badges,
      },
      theme,
      // After the link and the three spaces ViewHead puts before the head.
      Math.max(width - Bun.stringWidth(workerLink) - 3, 1),
    )
  }
  return (
    <ViewHead
      link={workerLink}
      leave={leave}
      head={head}
      spinning={!finished && card?.motion === "spinner"}
      width={width}
      counted={counted}
    />
  )
}

/** The most lines the title takes. */
export const titleMost = 2

/**
 * The ticket's `title`, `width` wide: in bold, wrapped at words to at most `titleMost` lines and cut
 * with `…` after; in the ticket's box, or alone under line 1 where the box isn't drawn.
 */
export const titleLines = (title: string, theme: Theme, width: number): ReadonlyArray<Segments> => {
  const room = Math.max(width, 1)
  const wrapped = wrap([titleSegment(sanitizeLine(title), theme)], room, {
    limit: titleMost + 1,
    long: "line",
  })
  const shown = wrapped.slice(0, titleMost)
  const last = shown.at(-1) ?? []
  return wrapped.length > titleMost
    ? [...shown.slice(0, -1), cut([...last, titleSegment("…", theme)], room)]
    : shown
}
