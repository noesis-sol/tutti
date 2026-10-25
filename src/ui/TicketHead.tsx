// The ticket in the worker view's head (§ 7.5; D1 of the worker-view design, tutti-cxgo, its box
// tutti-cxgo.4 and .6): under line 1, one box in the whole ticket's rounded frame, the pane's
// width, named `Ticket` in bold at the left of its top border, the ticket's type and priority at
// its right, coloured (bug red, feature green, …; P0 red, P1 orange), a narrow pane dropping the
// priority, then the type. In it, the ticket's title in bold, wrapped at words on up to 2 lines; a
// blank line; and its description, its first lines wrapped at words in the normal text colour,
// inline Markdown shown (bold, code, a link's label) but no headings or lists, up to 5 lines, cut
// with `…`; `▾ whole ticket  t` in its bottom border at the right when there is more than shows. A
// short pane gives some of the lines up, then the box (WorkerView.tsx's viewLayout); there is none
// at the minimum size, where line 1 ends with the type and priority and the title stands alone
// under it. `t` or a click on the control grows the same box into the whole ticket: under the title
// and its blank line, which stay, the description, design, acceptance criteria as a checklist,
// notes, links and labels, drawn with <markdown>, up to 60% of the pane, scrolling with PgUp/PgDn
// and the wheel, `↓ N more lines ── ▴ less  t · Esc` in its bottom border while there is more. `t`,
// a click on `▴ less` or Esc shrinks it back. Opening it reads the ticket again with bd show
// (ReadTicket), so that notes added during the run show.
//
// All of it is text a ticket author or a worker wrote, sanitised where it enters RunView (§ 7.10,
// runView.ts's ticketText); the links' IDs and the labels are escaped for the Markdown.
import type { OptimizedBuffer, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { type RefObject, useMemo, useRef, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { TicketLink, TicketText } from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import { minHeight } from "./Dashboard.tsx"
import {
  boxSides,
  cut,
  FrameRow,
  frameEdge,
  Line,
  Lines,
  type Look,
  plainFg,
  type Segments,
  seg,
  widthOf,
  wrap,
  wrapText,
} from "./line.tsx"
import { escapeMarkdown, sanitizeLine } from "./sanitize.ts"
import type { Role, Theme } from "./theme.ts"
import { useCommand, useTheme } from "./useRunView.ts"
import type { Looks } from "./worker/Looks.tsx"

/** The most lines of description the box holds. */
export const descriptionMost = 5

/** The description's lines a short pane keeps before it gives up the blank lines and the box. */
export const descriptionLeast = 2

/** Whether a pane `height` tall has the description's box: not at the minimum size. */
export const hasBox = (height: number): boolean => height > minHeight

/** The most of a pane's height the whole ticket takes, its frame with it. */
export const panelShare = 0.6

/** The lines the whole ticket may take in a pane `height` tall: its frame and a line at least. */
export const panelCap = (height: number): number => Math.max(Math.floor(height * panelShare), 3)

/** The role of a ticket's type, its colour: null, the text's own, for a type with none. */
export const typeRole = (type: string): Role | null => {
  switch (type) {
    case "bug":
      return "typeBug"
    case "feature":
      return "typeFeature"
    case "task":
      return "typeTask"
    case "epic":
      return "typeEpic"
    case "chore":
      return "typeChore"
  }
  return null
}

/** The look of a ticket's priority: P0 `priorityUrgent`, P1 `priorityHigh`, P2 to P4 faint. */
export const priorityLook = (priority: number, theme: Theme): Look =>
  priority === 0
    ? theme.look("priorityUrgent")
    : priority === 1
      ? theme.look("priorityHigh")
      : theme.styles.dim

/** A ticket's type and priority as segments, each in its colour; none for one it hasn't. */
export interface Badges {
  readonly type: Segments
  readonly priority: Segments
}

/** `issue`'s type and priority, coloured: `bug`, `P2`; none before the run has read it. */
export const badgesOf = (issue: TicketText | undefined, theme: Theme): Badges => {
  const type = issue === undefined ? "" : sanitizeLine(issue.type)
  return {
    type: type === "" ? [] : [seg(type, theme.look(typeRole(type)))],
    priority:
      issue === undefined || issue.priority === null
        ? []
        : [seg(`P${issue.priority}`, priorityLook(issue.priority, theme))],
  }
}

/** `badges` as one label, `bug · P2`, the ` · ` between them faint; none for neither. */
export const badgeLabel = (badges: Badges, theme: Theme): Segments =>
  badges.type.length > 0 && badges.priority.length > 0
    ? [...badges.type, seg(" · ", theme.styles.dim), ...badges.priority]
    : [...badges.type, ...badges.priority]

/** The box's name, at the left of its top border. */
export const boxName = "Ticket"

/** The `─` a top border keeps at least between its name and the type and priority. */
const borderRoom = 3

/**
 * The box's top border, `width` wide: `╭─ Ticket ─────── bug · P2 ─╮`, `Ticket` bold, the type and
 * priority (badgeLabel) at its right. Where they don't fit with `borderRoom` of the border between,
 * it drops the priority, then the type; `Ticket` is cut only once it stands alone.
 */
export const ticketEdge = (theme: Theme, width: number, badges: Badges): Segments => {
  const frame = theme.look("frame")
  const name = [seg("╭─ ", frame), seg(boxName, theme.styles.tickets), seg(" ", frame)]
  const forms = [badgeLabel(badges, theme), badges.type, []]
  const label =
    forms.find(
      (form) => form.length === 0 || widthOf(name) + borderRoom + widthOf(form) + 4 <= width,
    ) ?? []
  if (label.length === 0) {
    const left = cut(name, Math.max(width - 1, 0))
    return [...left, seg(`${"─".repeat(Math.max(width - widthOf(left) - 1, 0))}╮`, frame)]
  }
  const fill = width - widthOf(name) - widthOf(label) - 4
  return [...name, seg(`${"─".repeat(fill)} `, frame), ...label, seg(" ─╮", frame)]
}

/** A title in bold, as the box and the head show it. */
export const titleSegment = (title: string, theme: Theme) => seg(title, theme.look(null, "bold"))

// What the description's lines leave out: a fence, a heading, a rule; and what starts a quote or a
// list item, whose text stays.
const fence = /^\s{0,3}(```|~~~)/
const heading = /^\s{0,3}#{1,6}(\s|$)/
const rule = /^\s{0,3}([-*_=])(\s*\1){2,}\s*$/
const quote = /^\s*(>\s?)+/
const listItem = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/

/**
 * A description as the head's lines show it: one paragraph of its prose, without its code blocks,
 * headings and rules, its quotes' and list items' text kept without their marks.
 */
export const proseOf = (text: string): string => {
  const kept: Array<string> = []
  let fenced = false
  for (const line of text.split("\n")) {
    if (fence.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || heading.test(line) || rule.test(line)) continue
    kept.push(line.replace(quote, "").replace(listItem, ""))
  }
  return kept.join(" ").replace(/\s+/g, " ").trim()
}

// Inline Markdown the head shows: code, bold, a link's label; what doesn't match stays as written.
const inline = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\([^)]*\)/g

/** `prose`'s segments: its code in the code colour, its bold bold, a link's label in the link's. */
export const inlineSegments = (prose: string, theme: Theme): Segments => {
  const out: Array<ReturnType<typeof seg>> = []
  let at = 0
  for (const match of prose.matchAll(inline)) {
    if (match.index > at) out.push(seg(prose.slice(at, match.index)))
    const [, code, strong, under, label] = match
    if (code !== undefined) out.push(seg(code, theme.look("code")))
    else if (strong !== undefined || under !== undefined)
      out.push(seg(strong ?? under ?? "", theme.look(null, "bold")))
    else out.push(seg(label ?? "", theme.look("link")))
    at = match.index + match[0].length
  }
  if (at < prose.length) out.push(seg(prose.slice(at)))
  return out
}

/**
 * Whether the ticket has more than its description: design, acceptance criteria, notes, links (a
 * ticket depending on it among them, counted before bd show has listed it).
 */
export const hasMore = (issue: TicketText): boolean =>
  issue.design.trim() !== "" ||
  issue.acceptance.trim() !== "" ||
  issue.notes.trim() !== "" ||
  issue.links.length > 0 ||
  issue.dependents > 0

/** `▾ whole ticket  t`, in the link colour and its key's, a click on it pressing target 0. */
export const moreControl = (theme: Theme): Segments => [
  seg("▾ whole ticket", theme.look("link"), 0),
  seg("  ", null, 0),
  seg("t", theme.styles.key, 0),
]

/** The description's lines, `width` wide, and whether the box's border has the control. */
export interface DescriptionLines {
  readonly lines: ReadonlyArray<Segments>
  /** Whether there is more than shows: the description cut, or other fields. */
  readonly more: boolean
}

/**
 * `issue`'s description as the box shows it, `width` wide within its frame, at most `limit` lines:
 * its prose wrapped at words, the last line cut with `…` when there is more of it; `more` when the
 * ticket has more than shows. No description: `No description.`, faint.
 */
export const descriptionLines = (
  issue: TicketText,
  theme: Theme,
  width: number,
  limit: number,
): DescriptionLines => {
  if (limit <= 0) return { lines: [], more: false }
  const prose = proseOf(issue.description)
  const wrapped =
    prose === ""
      ? [[seg("No description.", theme.styles.dim)]]
      : wrap(inlineSegments(prose, theme), width, { limit: limit + 1, long: "line" })
  const cutShort = wrapped.length > limit
  const shown = wrapped.slice(0, limit)
  if (!cutShort) return { lines: shown, more: hasMore(issue) }
  const last = shown.at(-1) ?? []
  return { lines: [...shown.slice(0, -1), cut([...last, seg("…")], width)], more: true }
}

/**
 * What a link is called in the whole ticket: `parent`, `blocked by`, `discovered from`, …; one
 * from a ticket that depends on this one, `blocks`, `child`, `found` …
 */
export const linkWord = (link: TicketLink): string => {
  switch (link.type) {
    case "parent-child":
      return link.dependent ? "child" : "parent"
    case "blocks":
      return link.dependent ? "blocks" : "blocked by"
    case "discovered-from":
      return link.dependent ? "found" : "discovered from"
    default:
      return link.type.replace(/[-_]/g, " ")
  }
}

/** `text` with a closing fence when a code block in it is left open, so that it ends there. */
const fenced = (text: string): string =>
  text.split("\n").filter((line) => fence.test(line)).length % 2 === 0 ? text : `${text}\n\`\`\``

const checked = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?\[([ xX])\]\s*(.*)$/
const bulleted = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

/**
 * Acceptance criteria as a checklist: `☐` before each, `☑` before one ticked (`[x]`), a list's mark
 * left off, an indented line kept with the item before it.
 */
export const checklist = (text: string): string => {
  const items: Array<string> = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const box = checked.exec(line)
    const item = bulleted.exec(line)
    if (box !== null) items.push(`${box[1]?.trim() ? "☑" : "☐"} ${box[2] ?? ""}`)
    else if (item !== null) items.push(`☐ ${item[1] ?? ""}`)
    else if (/^\s/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`
    else items.push(`☐ ${line.trim()}`)
  }
  return items.join("  \n")
}

/**
 * The whole ticket as Markdown: the description whole, then its design, acceptance criteria as a
 * checklist, notes, links and labels, each left out when empty.
 */
export const wholeTicket = (issue: TicketText): string => {
  const section = (name: string, text: string): ReadonlyArray<string> =>
    text.trim() === "" ? [] : [`### ${name}\n\n${fenced(text.trim())}`]
  const links = issue.links.map((link) => `${linkWord(link)} ${escapeMarkdown(link.id)}`)
  return [
    issue.description.trim() === "" ? "*No description.*" : fenced(issue.description.trim()),
    ...section("Design", issue.design),
    ...(issue.acceptance.trim() === "" ? [] : [`### Acceptance\n\n${checklist(issue.acceptance)}`]),
    ...section("Notes", issue.notes),
    ...(links.length === 0 ? [] : [`**Links**  ${links.join(" · ")}`]),
    ...(issue.labels.length === 0
      ? []
      : [`**Labels**  ${issue.labels.map(escapeMarkdown).join(" · ")}`]),
  ].join("\n\n")
}

/** The box's bottom border, `width` wide, with `label` at its right. */
const boxEdge = (theme: Theme, width: number, label: Segments = []) =>
  frameEdge("bottom", width, theme.look("frame"), "rounded", label)

/**
 * The box closed, `width` wide: its top border (ticketEdge), the `title`'s lines, a blank line
 * when `gap`, the description's lines, its bottom border with `▾ whole ticket  t` at the right when
 * there is more, which a click opens. Only the control is a click target, so a drag over the lines
 * selects them.
 */
export const TicketBox = ({
  top,
  title,
  gap,
  lines,
  width,
  open,
}: {
  readonly top: Segments
  readonly title: ReadonlyArray<Segments>
  readonly gap: boolean
  readonly lines: DescriptionLines
  readonly width: number
  readonly open: () => void
}) => {
  const theme = useTheme()
  const drawn = useMemo(
    () => [
      top,
      ...boxSides([...title, ...(gap ? [[]] : []), ...lines.lines], width, theme.look("frame")),
      boxEdge(theme, width, lines.more ? moreControl(theme) : []),
    ],
    [theme, top, title, gap, width, lines],
  )
  return <Lines lines={drawn} press={open} />
}

/** The whole ticket's state in a worker view: open or not, and its scrollbox. */
export interface TicketPanel {
  readonly open: boolean
  /** Opens it, reading the ticket again, or closes it. */
  readonly toggle: () => void
  readonly close: () => void
  /** PgUp or PgDn: a page less a line. */
  readonly page: (step: 1 | -1) => void
  readonly scroll: RefObject<ScrollBoxRenderable | null>
}

/** The whole ticket of `ticket`'s worker view, closed as the view opens. */
export const useTicketPanel = (ticket: TicketId): TicketPanel => {
  const command = useCommand()
  const [open, setOpen] = useState(false)
  const scroll = useRef<ScrollBoxRenderable>(null)
  return {
    open,
    toggle: () => {
      if (!open) command(UiCommand.ReadTicket({ ticket }))
      setOpen(!open)
    },
    close: () => setOpen(false),
    page: (step) => {
      const box = scroll.current
      box?.scrollBy(step * Math.max(box.viewport.height - 1, 1))
    },
    scroll,
  }
}

/**
 * The lines the whole ticket takes in a pane `height` tall, `width` wide with its frame: the `head`
 * lines at its top (the title and the blank line under it), its Markdown's lines as written,
 * wrapped within the frame, which its marks concealed take no more of, and the frame's two; at most
 * `panelCap`.
 */
export const panelLines = (
  issue: TicketText | undefined,
  height: number,
  width: number,
  head = 0,
) => {
  const inner = Math.max(width - 4, 1)
  const content =
    issue === undefined
      ? 1
      : wholeTicket(issue)
          .split("\n")
          .reduce((sum, line) => sum + wrapText(line, inner).length, 0)
  return Math.min(panelCap(height), head + content + 2)
}

/** `▴ less  t · Esc`, in the link colour and its keys', a click on it pressing target 0. */
export const lessControl = (theme: Theme): Segments => [
  seg("▴ less", theme.look("link"), 0),
  seg("  ", null, 0),
  seg("t", theme.styles.key, 0),
  seg(" · ", theme.styles.dim, 0),
  seg("Esc", theme.styles.key, 0),
]

/**
 * The open box's bottom border, `width` wide: `↓ 12 more lines ── ▴ less  t · Esc` at its right
 * while there is more below, `▴ less  t · Esc` alone when there isn't.
 */
export const bottomLine = (theme: Theme, width: number, more: number): Segments =>
  boxEdge(theme, width, [
    ...(more <= 0
      ? []
      : [
          seg(`↓ ${more} more ${more === 1 ? "line" : "lines"}`, theme.styles.dim),
          seg(" ── ", theme.look("frame")),
        ]),
    ...lessControl(theme),
  ])

/** `line`'s segments before its first click target, and from it on. */
const splitAtTarget = (line: Segments): readonly [Segments, Segments] => {
  const at = line.findIndex((each) => each.target !== undefined)
  return at < 0 ? [line, []] : [line.slice(0, at), line.slice(at)]
}

/**
 * The whole ticket, `width` wide and `lines` tall with its frame: its `top` border (ticketEdge),
 * the `head` lines (the title and the blank line under it), which stay, then `issue` drawn with
 * <markdown> in a scrollbox, which the wheel scrolls; `Reading the ticket…` until the run has read
 * it. The bottom border counts the lines below as it is drawn, from the scrollbox as it is then, so
 * that the Markdown laid out and scrolled changes no state. `▴ less  t · Esc` ends the bottom
 * border, its own line so that a click on it closes the panel, the count before it drawn as the
 * border is.
 */
export const TicketPanelView = ({
  issue,
  top,
  head,
  panel,
  looks,
  width,
  lines,
}: {
  readonly issue: TicketText | undefined
  readonly top: Segments
  readonly head: ReadonlyArray<Segments>
  readonly panel: TicketPanel
  readonly looks: Looks
  readonly width: number
  readonly lines: number
}) => {
  const theme = useTheme()
  const above = useMemo(
    () => boxSides(head.slice(0, Math.max(lines - 2, 0)), width, theme.look("frame")),
    [head, lines, width, theme],
  )
  const inside = Math.max(lines - 2 - above.length, 0)
  // The control's part of the border is the same however many lines are below.
  const control = useMemo(() => splitAtTarget(bottomLine(theme, width, 0))[1], [theme, width])
  const before = Math.max(width - widthOf(control), 0)
  const bottom = function (this: Renderable, buffer: OptimizedBuffer) {
    const box = panel.scroll.current
    const more =
      box === null ? 0 : Math.max(box.scrollHeight - box.scrollTop - box.viewport.height, 0)
    let x = this.x
    for (const each of cut(splitAtTarget(bottomLine(theme, width, more))[0], before)) {
      const look = each.look
      buffer.drawText(each.text, x, this.y, look?.fg ?? plainFg, look?.bg, look?.attributes ?? 0)
      x += Bun.stringWidth(each.text)
    }
  }
  return (
    <box flexDirection="column" height={lines} flexShrink={0}>
      <Line segments={top} />
      <Lines lines={above} />
      <FrameRow width={width} frame={theme.look("frame")} lines={inside}>
        <scrollbox
          ref={panel.scroll}
          flexGrow={1}
          focusable={false}
          scrollbarOptions={{ visible: false }}
        >
          {issue === undefined ? (
            <Line segments={[seg("Reading the ticket…", theme.styles.dim)]} />
          ) : (
            <markdown
              content={wholeTicket(issue)}
              syntaxStyle={looks.markdown}
              renderNode={looks.blocks}
              {...looks.highlighter}
              conceal
            />
          )}
        </scrollbox>
      </FrameRow>
      <box flexDirection="row" height={1} flexShrink={0}>
        <box width={before} height={1} flexShrink={0} renderAfter={bottom} />
        <Line segments={control} press={panel.close} />
      </box>
    </box>
  )
}
