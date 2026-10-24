// The request panel (§ 7.5, § 4.5) under a worker view's or the Interview view's transcript: the
// worker's open requests, each in a box framed `needsYou`, heavy when selected, with its line, its
// description and reason faint, its buttons, and its whole input scrolling under them; and the
// hand-back notice (§ 4.3) of a conflict waiting for a steered worker. A request's parts are worked
// out once a request, theme and width (tutti-k2n1, tutti-x4wu), and the panel takes what the view's
// other parts leave it (tutti-7nzv).
import type { MouseEvent } from "@opentui/core"
import { useMemo, useRef, useState } from "react"
import type { AttentionRequest } from "../../agent/Attention.ts"
import { buttonsOf, picksOptions, requestText } from "../attentionKeys.ts"
import { boxed, boxSides, Line, Lines, type Press, type Segments, seg, wrap } from "../line.tsx"
import { requestInputLines } from "../requestInput.ts"
import { sanitize, sanitizeLine } from "../sanitize.ts"
import type { Theme } from "../theme.ts"
import { type Panel, requestKey, type Selection } from "../transcriptView.ts"
import { useTheme } from "../useRunView.ts"

/**
 * The fewest lines a request's input scrolls in while the panel shows more than one; it gets a
 * quarter of the pane when that's more, and the panel has room.
 */
export const inputLines = 3
/** A request's box in the panel: its lines over its input, its input, and its frame's foot. */
export interface PanelParts {
  readonly head: ReadonlyArray<Segments>
  /**
   * Its whole input, one line a line within the frame, scrolled within the box when it is long. The
   * box puts only the lines it shows in the frame's sides (`sides`), so a long input costs a
   * selection or a focused button no more than a short one (tutti-x4wu).
   */
  readonly input: ReadonlyArray<Segments>
  readonly sides: (lines: ReadonlyArray<Segments>) => ReadonlyArray<Segments>
  readonly foot: ReadonlyArray<Segments>
}

/**
 * A request's input as its box in the panel, `width` wide, shows it: wrapped within the frame's
 * sides and the space each side of them, never cut (§ 4.5). The costly part of a request's box,
 * worked out once a request and width, apart from its selection and its focused button.
 */
export const panelInput = (
  request: AttentionRequest,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> => requestInputLines(request, theme, Math.max(width - 4, 1))

/**
 * A request's box in the panel, `width` wide, framed `needsYou`, heavy when it is selected: the
 * request's line, a URL elicitation's URL, its description and reason faint, its buttons (`focus`
 * the focused one), then its whole input faint (`input`, its panelInput, where it is known
 * already), under the buttons so that a long one never hides them.
 */
export const panelParts = (
  request: AttentionRequest,
  theme: Theme,
  options: {
    readonly width: number
    readonly selected: boolean
    readonly focus: number | null
    readonly input?: ReadonlyArray<Segments>
  },
): PanelParts => {
  const { styles } = theme
  const text = requestText(request)
  // Within the frame's sides and the space each side of them; wrapped there, never cut (§ 4.5).
  const inner = Math.max(options.width - 4, 1)
  const faint = (lines: ReadonlyArray<string>): ReadonlyArray<Segments> =>
    lines.flatMap((line) => wrap([seg(line, styles.dim)], inner, { indent: 2 }))
  const description =
    request.description === undefined || text.line.includes(sanitizeLine(request.description))
      ? []
      : sanitize(request.description).split("\n")
  const reason =
    request.decisionReason === undefined ? [] : sanitize(request.decisionReason).split("\n")
  // The URL Open URL opens, whole, so that you see where it goes before you press it.
  const url =
    request.kind._tag === "Elicitation" && request.kind.url !== undefined
      ? [sanitizeLine(request.kind.url)]
      : []
  const input = options.input ?? panelInput(request, theme, options.width)
  const button = (label: string, index: number) =>
    seg(
      `[ ${label} ]`,
      index === options.focus ? theme.form.focusedButton : theme.form.button,
      index,
    )
  const buttons = buttonsOf(request).map((each, i) => button(each.label, i))
  const rows: ReadonlyArray<Segments> = picksOptions(request)
    ? buttons.map((each) => [each])
    : [buttons.flatMap((each, i) => (i === 0 ? [each] : [seg("  "), each]))]
  const above = [
    ...wrap([seg(text.line)], inner, { indent: 2 }),
    ...faint(url),
    ...faint(description),
    ...faint(reason),
    ...rows,
  ]
  const frame = theme.look("needsYou")
  const border = options.selected ? "heavy" : "rounded"
  const lines = boxed(above, options.width, frame, border)
  return {
    head: lines.slice(0, -1),
    input,
    sides: (shown) => boxSides(shown, options.width, frame, border),
    foot: lines.slice(-1),
  }
}

/**
 * A request's box in the panel: its input scrolls in at most `room` lines, by the wheel, and only
 * the lines in view are drawn (tutti-x4wu); buttons are pressed.
 */
export const PanelBox = ({
  parts,
  room,
  press,
}: {
  readonly parts: PanelParts
  readonly room: number
  readonly press: Press
}) => {
  const height = Math.max(Math.min(parts.input.length, room), 0)
  const last = parts.input.length - height
  const [scrolled, setScrolled] = useState(0)
  const top = Math.min(scrolled, last)
  const shown = useMemo(
    () => parts.sides(parts.input.slice(top, top + height)),
    [parts, top, height],
  )
  const wheel = (event: MouseEvent) => {
    const step = event.scroll?.direction === "down" ? 1 : event.scroll?.direction === "up" ? -1 : 0
    const by = step * Math.max(event.scroll?.delta ?? 1, 1)
    if (by !== 0) setScrolled((at) => Math.max(Math.min(Math.min(at, last) + by, last), 0))
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      <Lines lines={parts.head} press={press} />
      {height === 0 ? null : (
        <box height={height} flexShrink={0} onMouseScroll={wheel}>
          <Lines lines={shown} />
        </box>
      )}
      <Lines lines={parts.foot} />
    </box>
  )
}

/** The hand-back notice's lines (§ 4.3): a conflict waits for the steered worker. */
export const handBackLines = (
  theme: Theme,
  options: { readonly width: number; readonly selected: boolean },
): ReadonlyArray<Segments> => {
  const button = seg(
    "[ Hand it the conflict now ]",
    options.selected ? theme.form.focusedButton : theme.form.button,
    0,
  )
  return boxed(
    [
      [seg("A merge conflict waits for this worker", theme.styles.deferred)],
      [seg("You steered it, so it wasn't handed over.", theme.styles.dim)],
      [button],
    ],
    options.width,
    theme.look("notice"),
    options.selected ? "heavy" : "rounded",
  )
}
/**
 * A request's parts in the panel, worked out again only when what they show changes: its input is
 * put as JSON and sanitized (tutti-k2n1), once a request, theme and width, not again as the
 * selection or the focused button moves (tutti-x4wu).
 */
export const usePanelParts = (
  request: AttentionRequest,
  theme: Theme,
  options: { readonly width: number; readonly selected: boolean; readonly focus: number | null },
): PanelParts => {
  const { width, selected, focus } = options
  const input = useMemo(() => panelInput(request, theme, width), [request, theme, width])
  return useMemo(
    () => panelParts(request, theme, { width, selected, focus, input }),
    [request, theme, width, selected, focus, input],
  )
}

/** A request's box in the panel, its parts worked out again only when what they show changes. */
const PanelRequest = ({
  request,
  width,
  selected,
  focus,
  room,
  press,
}: {
  readonly request: AttentionRequest
  readonly width: number
  readonly selected: boolean
  readonly focus: number | null
  readonly room: number
  readonly press: (index: number) => void
}) => {
  const parts = usePanelParts(request, useTheme(), { width, selected, focus })
  return <PanelBox parts={parts} room={room} press={press} />
}

/**
 * The input rooms, in lines, of the panel's oldest requests whose `parts` fit in `budget` lines, in a
 * pane `height` tall, `more` others waiting after them: one room a request drawn. Each input scrolls
 * in a quarter of the pane (`inputLines` at least); where the requests don't fit, their rooms shrink
 * first, the longest first (the newer of two as long), down to `inputLines`; then the panel draws
 * fewer, down to one, whose room is what is left, a line at least, and counts the rest under it.
 */
export const panelRooms = (
  parts: ReadonlyArray<PanelParts>,
  budget: number,
  height: number,
  more: number,
): ReadonlyArray<number> => {
  const most = Math.max(inputLines, Math.floor(height / 4))
  for (let shown = parts.length; shown > 0; shown--) {
    const drawn = parts.slice(0, shown)
    const counted = more + parts.length - shown > 0 ? 1 : 0
    const rooms = drawn.map((each) => Math.min(each.input.length, most))
    const floors = drawn.map((each) => Math.min(each.input.length, shown === 1 ? 1 : inputLines))
    const used = (lines: ReadonlyArray<number>) =>
      drawn.reduce((sum, each, i) => sum + each.head.length + (lines[i] ?? 0) + each.foot.length, 0)
    let over = used(rooms) + counted - budget
    while (over > 0) {
      let longest = -1
      rooms.forEach((room, i) => {
        if (room > (floors[i] ?? 0) && (longest < 0 || room >= (rooms[longest] ?? 0))) longest = i
      })
      if (longest < 0) break
      rooms[longest] = (rooms[longest] ?? 0) - 1
      over--
    }
    if (over <= 0 || shown === 1) return rooms
  }
  return []
}

/**
 * The panel's fit, its requests `width` wide in `budget` lines of a pane `height` tall: the input
 * rooms of the requests it draws (panelRooms), for its oldest `requests`, `more` waiting after them,
 * and the lines it takes with them drawn.
 * A request's parts are worked out once a theme and width (tutti-k2n1); its lines don't change with
 * its selection or its focused button.
 */
export const usePanelRooms = (theme: Theme, width: number, budget: number, height: number) => {
  const known = useRef({ theme, width, parts: new WeakMap<AttentionRequest, PanelParts>() })
  if (known.current.theme !== theme || known.current.width !== width)
    known.current = { theme, width, parts: new WeakMap() }
  const partsOf = (request: AttentionRequest) => {
    const found = known.current.parts.get(request)
    if (found !== undefined) return found
    const parts = panelParts(request, theme, { width, selected: false, focus: null })
    known.current.parts.set(request, parts)
    return parts
  }
  const rooms = (requests: ReadonlyArray<AttentionRequest>, more: number): ReadonlyArray<number> =>
    panelRooms(requests.map(partsOf), budget, height, more)
  /** The lines the panel takes with `requests` drawn, `more` counted under them. */
  const lines = (requests: ReadonlyArray<AttentionRequest>, more: number): number => {
    const roomed = rooms(requests, more)
    return (
      requests.reduce((sum, request, i) => {
        const parts = partsOf(request)
        const input = Math.max(Math.min(parts.input.length, roomed[i] ?? inputLines), 0)
        return sum + parts.head.length + input + parts.foot.length
      }, 0) + (more > 0 ? 1 : 0)
    )
  }
  return { rooms, lines }
}

/** The panel's requests, each in its box `width` wide, its input in its room, and how many more. */
export const RequestPanel = ({
  panel,
  selection,
  width,
  rooms,
}: {
  readonly panel: Panel
  readonly selection: Selection
  readonly width: number
  readonly rooms: ReadonlyArray<number>
}) => {
  const theme = useTheme()
  const { answering } = panel
  return (
    <>
      {panel.requests.map((request, i) => {
        const at = panel.cards[i]
        return at === undefined ? null : (
          <PanelRequest
            key={request.id}
            request={request}
            width={width}
            selected={selection.selected === requestKey(request)}
            focus={answering.focusOf(at)}
            room={rooms[i] ?? inputLines}
            press={(index) => answering.press(at, index)}
          />
        )
      })}
      {panel.more > 0 ? (
        <Line segments={[seg(`  +${panel.more} more requests`, theme.styles.dim)]} />
      ) : null}
    </>
  )
}
