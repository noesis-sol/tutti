// A transcript view's head (§ 7.5): the link back, then what the view shows, on as many lines as
// it takes; and the worker view's own, its worker's card head, the ticket's type and priority, and
// its title in bold.
import { useEffect, useRef } from "react"
import type { Card } from "../../run/runView.ts"
import { headOf, statusLook } from "../Card.tsx"
import { finishedWords } from "../Composer.tsx"
import { clickable } from "../click.ts"
import { Line, Lines, type Segments, seg, styled, wrap } from "../line.tsx"
import { sanitizeLine } from "../sanitize.ts"
import { badgesOf, titleSegment } from "../TicketHead.tsx"
import { useNow, useSpinner, useTheme } from "../useRunView.ts"

/**
 * The head of a transcript's view: `link`, which a click follows as `leave`, then `head` at the
 * shell's clock and the spinner's frame, wrapped rather than cut (tutti-rfs). Its lines after the
 * first are under the link, not in the transcript's scrollbox, so their height doesn't touch #1514.
 * The clock and the spinner tick here, in a leaf, so that the view over it isn't drawn anew ten
 * times a second while `spinning` (tutti-k2n1); `counted` hears how many lines it takes, as that
 * changes, for the view's request panel (tutti-7nzv).
 */
export const ViewHead = ({
  link,
  leave,
  head,
  spinning,
  width,
  counted,
}: {
  readonly link: string
  readonly leave: () => void
  readonly head: (now: number, spin: string) => Segments
  readonly spinning: boolean
  readonly width: number
  readonly counted?: (lines: number) => void
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
        <Line segments={lines[0] ?? []} />
      </box>
      {lines.length > 1 ? <Lines lines={lines.slice(1)} /> : null}
    </>
  )
}

/**
 * The worker view's head: ` ← Dashboard`, which a click follows as `leave`, then the worker's card
 * head (number, mark, ticket, status, elapsed time), the ticket's type and priority, and its title
 * in bold. Once the worker has `finished`, its card gone, the head says finished, its time stopped
 * where the view first drew it gone (tutti-2n7y). `card` is the last seen: none, the ticket has
 * no worker.
 */
export const WorkerHead = ({
  ticket,
  card,
  finished,
  leave,
  width,
  counted,
}: {
  readonly ticket: string
  readonly card: Card | undefined
  readonly finished: boolean
  readonly leave: () => void
  readonly width: number
  readonly counted: (lines: number) => void
}) => {
  const theme = useTheme()
  // When the view first drew the worker finished: its head's clock stops there.
  const ended = useRef<number | undefined>(undefined)
  if (!finished) ended.current = undefined
  const head = (now: number, spin: string): Segments => {
    if (card === undefined) return [seg(`${sanitizeLine(ticket)} has no worker`, theme.styles.dim)]
    if (finished) ended.current ??= now
    const shown: Card = finished ? { ...card, motion: "•", steered: false } : card
    const status = finished
      ? seg(finishedWords(ticket).status, theme.styles.done)
      : seg(card.status, statusLook(card, theme))
    const badges = badgesOf(card.issue)
    return [
      ...headOf(shown, theme, ended.current ?? now, spin, [status]),
      ...(badges === "" ? [] : [seg("  "), seg(badges, theme.styles.dim)]),
      seg("   "),
      titleSegment(sanitizeLine(card.title), theme),
    ]
  }
  return (
    <ViewHead
      link=" ← Dashboard"
      leave={leave}
      head={head}
      spinning={!finished && card?.motion === "spinner"}
      width={width}
      counted={counted}
    />
  )
}
