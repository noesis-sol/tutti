// The ticket in the worker view's head (§ 7.5; D1 of the worker-view design, tutti-cxgo): under
// line 1, the ticket's description, its first lines wrapped at words in the normal text colour,
// inline Markdown shown (bold, code, a link's label) but no headings or lists, 2 lines or 3 on a
// pane of 40 rows or more, none at the minimum size; cut with `…`. `▾ whole ticket  t` ends the last
// line, right aligned, when there is more than shows. `t` or a click on it opens the whole ticket in
// place of those lines: a framed panel of the description, design, acceptance criteria as a
// checklist, notes, links and labels, drawn with <markdown>, up to 60% of the pane, scrolling with
// PgUp/PgDn and the wheel, `↓ N more lines` in its bottom border while there is more. `t`, a click on
// `▴ less` or Esc closes it. Opening it reads the ticket again with bd show (ReadTicket), so that
// notes added during the run show. Its last section is what the worker spent, `Spent`
// (ResourceLine.tsx's spentLines), which a click on the resource line opens the panel scrolled to.
//
// All of it is text a ticket author or a worker wrote, sanitised where it enters RunView (§ 7.10,
// runView.ts's ticketText); the links' IDs and the labels are escaped for the Markdown.
import type { BoxRenderable, OptimizedBuffer, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { type RefObject, useMemo, useRef, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { TicketLink, TicketText } from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import { minHeight } from "./Dashboard.tsx"
import {
  cut,
  FrameRow,
  frameEdge,
  Line,
  Lines,
  padded,
  plainFg,
  type Segments,
  seg,
  widthOf,
  wrap,
  wrapText,
} from "./line.tsx"
import { escapeMarkdown } from "./sanitize.ts"
import type { Theme } from "./theme.ts"
import { useCommand, useTheme } from "./useRunView.ts"
import type { Looks } from "./worker/Looks.tsx"

/** The description's lines in a pane `height` tall: 3 from 40 rows, none at the minimum size. */
export const descriptionLimit = (height: number): number =>
  height >= 40 ? 3 : height > minHeight ? 2 : 0

/** The most of a pane's height the whole ticket takes, its frame with it. */
export const panelShare = 0.6

/** The lines the whole ticket may take in a pane `height` tall: its frame and a line at least. */
export const panelCap = (height: number): number => Math.max(Math.floor(height * panelShare), 3)

/** A ticket's type and priority as line 1 shows them after its ID: `bug · P2`; "" for neither. */
export const badgesOf = (issue: TicketText | undefined): string =>
  issue === undefined
    ? ""
    : [issue.type, issue.priority === null ? "" : `P${issue.priority}`]
        .filter((each) => each !== "")
        .join(" · ")

/** A title in bold, as line 1 shows it. */
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

/** The description's lines, `width` wide, and whether the control ends the last one. */
export interface DescriptionLines {
  /** Its lines, the last ending in the control, right aligned, when there is one. */
  readonly lines: ReadonlyArray<Segments>
  readonly more: boolean
}

/**
 * `issue`'s description as the head shows it, `width` wide, at most `limit` lines: its prose wrapped
 * at words, the last line cut with `…` when there is more of it, `▾ whole ticket  t` at its end,
 * right aligned, when the ticket has more than shows. No description: `No description.`, faint.
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
  if (!cutShort && !hasMore(issue)) return { lines: shown, more: false }
  const control = moreControl(theme)
  const room = Math.max(width - widthOf(control) - 2, 0)
  const last = shown.at(-1) ?? []
  const ended = cutShort || widthOf(last) > room ? cut([...last, seg("…")], room) : last
  return {
    lines: [
      ...shown.slice(0, -1),
      [...padded(ended, Math.max(width - widthOf(control), 0)), ...control],
    ],
    more: true,
  }
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

/** The description's lines in the head: the control at the end of the last, which a click opens. */
export const DescriptionView = ({
  lines,
  open,
}: {
  readonly lines: DescriptionLines
  readonly open: () => void
}) => <Lines lines={lines.lines} press={open} />

/** The whole ticket's state in a worker view: open or not, and its scrollbox. */
export interface TicketPanel {
  readonly open: boolean
  /** Opens it, reading the ticket again, or closes it. */
  readonly toggle: () => void
  /** Opens it, or keeps it open, scrolled to its `Spent` section. */
  readonly openSpent: () => void
  readonly close: () => void
  /** PgUp or PgDn: a page less a line. */
  readonly page: (step: 1 | -1) => void
  readonly scroll: RefObject<ScrollBoxRenderable | null>
  /**
   * Whether the panel is to show its `Spent` section at its top, and where it last put it there:
   * kept, as the Markdown above it is laid out, until you scroll.
   */
  readonly toSpent: RefObject<{ readonly at?: number } | null>
}

/** The whole ticket of `ticket`'s worker view, closed as the view opens. */
export const useTicketPanel = (ticket: TicketId): TicketPanel => {
  const command = useCommand()
  const [open, setOpen] = useState(false)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const toSpent = useRef<{ readonly at?: number } | null>(null)
  return {
    open,
    toggle: () => {
      if (!open) command(UiCommand.ReadTicket({ ticket }))
      toSpent.current = null
      setOpen(!open)
    },
    openSpent: () => {
      if (!open) command(UiCommand.ReadTicket({ ticket }))
      toSpent.current = {}
      setOpen(true)
      // Open already, nothing else draws the panel anew for it to scroll.
      scroll.current?.requestRender()
    },
    close: () => setOpen(false),
    page: (step) => {
      const box = scroll.current
      box?.scrollBy(step * Math.max(box.viewport.height - 1, 1))
    },
    scroll,
    toSpent,
  }
}

/**
 * The lines the whole ticket takes in a pane `height` tall, `width` wide with its frame: its
 * Markdown's lines as written, wrapped within the frame, which its marks concealed take no more
 * of, its `Spent` section's `spent` lines and the line over them, and the frame's two; at most
 * `panelCap`.
 */
export const panelLines = (
  issue: TicketText | undefined,
  height: number,
  width: number,
  spent = 0,
) => {
  const inner = Math.max(width - 4, 1)
  const content =
    issue === undefined
      ? 1
      : wholeTicket(issue)
          .split("\n")
          .reduce((sum, line) => sum + wrapText(line, inner).length, 0)
  return Math.min(panelCap(height), content + (spent > 0 ? spent + 1 : 0) + 2)
}

/** The frame's top: `▴ less  t · Esc` at its right, a click on which presses target 0. */
const topLine = (theme: Theme, width: number): Segments =>
  frameEdge("top", width, theme.look("frame"), "rounded", [
    seg("▴ less", theme.look("link"), 0),
    seg("  ", null, 0),
    seg("t", theme.styles.key, 0),
    seg(" · ", theme.styles.dim, 0),
    seg("Esc", theme.styles.key, 0),
  ])

/** The frame's bottom, `↓ 12 more lines` at its right while there is more below. */
export const bottomLine = (theme: Theme, width: number, more: number): Segments =>
  frameEdge(
    "bottom",
    width,
    theme.look("frame"),
    "rounded",
    more <= 0 ? [] : [seg(`↓ ${more} more ${more === 1 ? "line" : "lines"}`, theme.styles.dim)],
  )

/**
 * The whole ticket, `width` wide and `lines` tall with its frame: `issue` drawn with <markdown> in a
 * scrollbox, which the wheel scrolls; `Reading the ticket…` until the run has read it; then `spent`,
 * what its worker spent, `width - 4` wide, where it has one. The bottom border counts the lines
 * below as it is drawn, from the scrollbox as it is then, so that the Markdown laid out and
 * scrolled changes no state; so the scrollbox puts `Spent` at its top as it is drawn, while the
 * panel was opened to it, until you scroll.
 */
export const TicketPanelView = ({
  issue,
  spent,
  panel,
  looks,
  width,
  lines,
}: {
  readonly issue: TicketText | undefined
  readonly spent: ReadonlyArray<Segments> | null
  readonly panel: TicketPanel
  readonly looks: Looks
  readonly width: number
  readonly lines: number
}) => {
  const theme = useTheme()
  const inside = Math.max(lines - 2, 0)
  const spentBox = useRef<BoxRenderable>(null)
  const toSpent = function (this: ScrollBoxRenderable) {
    const section = spentBox.current
    const asked = panel.toSpent.current
    if (section === null || asked === null) return
    // A scroll since it was put there is yours: it stays where you put it.
    if (asked.at !== undefined && this.scrollTop !== asked.at) {
      panel.toSpent.current = null
      return
    }
    const offset = Math.min(
      section.y - this.content.y,
      Math.max(this.scrollHeight - this.viewport.height, 0),
    )
    if (this.scrollTop !== offset) this.scrollTop = offset
    panel.toSpent.current = { at: this.scrollTop }
  }
  const top = useMemo(() => topLine(theme, width), [theme, width])
  const bottom = function (this: Renderable, buffer: OptimizedBuffer) {
    const box = panel.scroll.current
    const more =
      box === null ? 0 : Math.max(box.scrollHeight - box.scrollTop - box.viewport.height, 0)
    let x = this.x
    for (const each of bottomLine(theme, width, more)) {
      const look = each.look
      buffer.drawText(each.text, x, this.y, look?.fg ?? plainFg, look?.bg, look?.attributes ?? 0)
      x += Bun.stringWidth(each.text)
    }
  }
  return (
    <box flexDirection="column" height={lines} flexShrink={0}>
      <Line segments={top} press={panel.close} />
      <FrameRow width={width} frame={theme.look("frame")} lines={inside}>
        <scrollbox
          ref={panel.scroll}
          renderBefore={toSpent}
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
          {spent === null ? null : (
            <box ref={spentBox} flexDirection="column" flexShrink={0} marginTop={1}>
              <Lines lines={spent} />
            </box>
          )}
        </scrollbox>
      </FrameRow>
      <box height={1} flexShrink={0} renderAfter={bottom} />
    </box>
  )
}
