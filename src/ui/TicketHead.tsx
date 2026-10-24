// The ticket in the worker view's head (§ 7.5; D1 of the worker-view design, tutti-cxgo): under
// line 1, the ticket's description, its first lines wrapped at words in the normal text colour,
// inline Markdown shown (bold, code, a link's label) but no headings or lists, 2 lines or 3 on a
// pane of 40 rows or more, none at the minimum size; cut with `…`. `▾ whole ticket  t` ends the last
// line, right aligned, when there is more than shows. `t` or a click on it opens the whole ticket in
// place of those lines: a framed panel of the description, design, acceptance criteria as a
// checklist, notes, links and labels, drawn with <markdown>, up to 60% of the pane, scrolling with
// PgUp/PgDn and the wheel, `↓ N more lines` in its bottom border while there is more. `t`, a click on
// `▴ less` or Esc closes it. Opening it reads the ticket again with bd show (ReadTicket), so that
// notes added during the run show.
//
// All of it is text a ticket author or a worker wrote, sanitised where it enters RunView (§ 7.10,
// runView.ts's ticketText); the links' IDs and the labels are escaped for the Markdown.
import type { OptimizedBuffer, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { type RefObject, useRef, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { TicketLink, TicketText } from "../run/runView.ts"
import { clickable } from "./click.ts"
import { minHeight } from "./Dashboard.tsx"
import {
  cut,
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
import type { Looks } from "./WorkerView.tsx"

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

/** Whether the ticket has more than its description: design, acceptance criteria, notes, links. */
export const hasMore = (issue: TicketText): boolean =>
  issue.design.trim() !== "" ||
  issue.acceptance.trim() !== "" ||
  issue.notes.trim() !== "" ||
  issue.links.length > 0

/** `▾ whole ticket  t`, in the link colour and its key's. */
export const moreControl = (theme: Theme): Segments => [
  seg("▾ whole ticket", theme.look("link")),
  seg("  "),
  seg("t", theme.styles.key),
]

/** The description's lines, `width` wide, and the control that ends the last one, if it has one. */
export interface DescriptionLines {
  /** Its lines, the last padded to where the control starts when there is one. */
  readonly lines: ReadonlyArray<Segments>
  readonly control: Segments | null
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
  if (limit <= 0) return { lines: [], control: null }
  const prose = proseOf(issue.description)
  const wrapped =
    prose === ""
      ? [[seg("No description.", theme.styles.dim)]]
      : wrap(inlineSegments(prose, theme), width, { limit: limit + 1, long: "line" })
  const cutShort = wrapped.length > limit
  const shown = wrapped.slice(0, limit)
  if (!cutShort && !hasMore(issue)) return { lines: shown, control: null }
  const control = moreControl(theme)
  const room = Math.max(width - widthOf(control) - 2, 0)
  const last = shown.at(-1) ?? []
  const ended = cutShort || widthOf(last) > room ? cut([...last, seg("…")], room) : last
  return {
    lines: [...shown.slice(0, -1), padded(ended, Math.max(width - widthOf(control), 0))],
    control,
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
}) => {
  const { control } = lines
  const last = lines.lines.at(-1)
  if (control === null || last === undefined) return <Lines lines={lines.lines} />
  return (
    <>
      {lines.lines.length > 1 ? <Lines lines={lines.lines.slice(0, -1)} /> : null}
      <box flexDirection="row" height={1} flexShrink={0}>
        <box width={widthOf(last)} height={1} flexShrink={0}>
          <Line segments={last} />
        </box>
        <box height={1} flexShrink={0} {...clickable(open)}>
          <Line segments={control} />
        </box>
      </box>
    </>
  )
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
export const useTicketPanel = (ticket: string): TicketPanel => {
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
 * The lines the whole ticket takes in a pane `height` tall, `width` wide with its frame: its
 * Markdown's lines as written, wrapped within the frame, which its marks concealed take no more
 * of, and the frame's two; at most `panelCap`.
 */
export const panelLines = (issue: TicketText | undefined, height: number, width: number) => {
  const inner = Math.max(width - 4, 1)
  const content =
    issue === undefined
      ? 1
      : wholeTicket(issue)
          .split("\n")
          .reduce((sum, line) => sum + wrapText(line, inner).length, 0)
  return Math.min(panelCap(height), content + 2)
}

/** The frame's top: `▴ less  t · Esc` at its right, which a click on closes the panel. */
const topLines = (theme: Theme, width: number) => {
  const frame = theme.look("frame")
  const label: Segments = [
    seg("▴ less", theme.look("link")),
    seg("  "),
    seg("t", theme.styles.key),
    seg(" · ", theme.styles.dim),
    seg("Esc", theme.styles.key),
  ]
  const fill = Math.max(width - widthOf(label) - 5, 0)
  return {
    left: [seg(`╭${"─".repeat(fill)} `, frame)] as Segments,
    label: cut(label, Math.max(width - 4, 0)),
    right: [seg(" ─╮", frame)] as Segments,
  }
}

/** The frame's bottom, `↓ 12 more lines` at its right while there is more below. */
export const bottomLine = (theme: Theme, width: number, more: number): Segments => {
  const frame = theme.look("frame")
  if (more <= 0) return [seg(`╰${"─".repeat(Math.max(width - 2, 0))}╯`, frame)]
  const label = `↓ ${more} more ${more === 1 ? "line" : "lines"}`
  const fill = Math.max(width - Bun.stringWidth(label) - 5, 0)
  return [seg(`╰${"─".repeat(fill)} `, frame), seg(label, theme.styles.dim), seg(" ─╯", frame)]
}

/**
 * The whole ticket, `width` wide and `lines` tall with its frame: `issue` drawn with <markdown> in a
 * scrollbox, which the wheel scrolls; `Reading the ticket…` until the run has read it. The bottom
 * border counts the lines below as it is drawn, from the scrollbox as it is then, so that the
 * Markdown laid out and scrolled changes no state.
 */
export const TicketPanelView = ({
  issue,
  panel,
  looks,
  width,
  lines,
}: {
  readonly issue: TicketText | undefined
  readonly panel: TicketPanel
  readonly looks: Looks
  readonly width: number
  readonly lines: number
}) => {
  const theme = useTheme()
  const inside = Math.max(lines - 2, 0)
  const top = topLines(theme, width)
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
      <box flexDirection="row" height={1} flexShrink={0}>
        <Line segments={top.left} />
        <box height={1} flexShrink={0} {...clickable(panel.close)}>
          <Line segments={top.label} />
        </box>
        <Line segments={top.right} />
      </box>
      <box
        height={inside}
        flexShrink={0}
        border={["left", "right"]}
        borderStyle="rounded"
        borderColor={theme.rgba("frame")}
        paddingLeft={1}
        paddingRight={1}
      >
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
      </box>
      <box height={1} flexShrink={0} renderAfter={bottom} />
    </box>
  )
}
