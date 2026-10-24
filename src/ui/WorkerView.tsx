// The worker view (§ 7.5, § 7.3, § 7.11): tutti's transcript of one worker, drawn by tutti, under
// orchestra-style chrome: `← Dashboard`, then the worker's card head (number, mark, ticket, status,
// elapsed time), the ticket's type and priority, and its title in bold, wrapped onto more lines in
// a narrow pane, then the resource line (ResourceLine.tsx: what the worker consumes; a click opens
// what it spent), and under it the ticket's description, or its whole ticket while `t` has it open
// (TicketHead.tsx), over a rule. Below the transcript, the attention panel shows the worker's open
// requests with the card's buttons and rules (attentionKeys.ts), each with its description, its
// reason and its whole input, and a conflict hand-back waiting for a steered worker (§ 4.3) as a
// notice with Hand it the conflict now. Answer in view, for what a card can't hold, opens the
// answer form over the view (AnswerForm.tsx). Under them and the rule, the composer (Composer.tsx):
// the held line while the ticket waits to merge or merges, the steered line with its Release
// button, your messages still queued or held, the field.
//
// The items (transcriptItems.ts): assistant text as Markdown (<markdown>, in the theme's heading,
// code and link roles); each tool call `Tool  summary`, wrapped, its result at the end of it (`✓`,
// an error's first line, `+N −M`); a message sent to the worker wrapped, `› ` before it. Enter or a
// click expands one: an edit's diff (<diff>), a command's output (<code>), a read's range, an Agent
// call's subagent work behind a faint `│`, a message's lines past the first `itemLines`.
// Thinking is hidden. While the view is open, its transcript's open flag is set, and partial text
// shows as it streams.
//
// Bounded rendering: the window of the transcript mounted is at most the last 200 items, sticking
// to the bottom while you're there; scrolling past the top (the wheel, PgUp, `g`) loads 200 older
// from the file, letting the newest beyond 600 go, and keeps your place. Collapsed items are a fixed
// height, their lines wrapped beforehand to the pane's width, at most `itemLines` (#1514).
//
// The keys, in the view's layer: `Tab`, `Shift+Tab` and the arrows move between the items and the
// panel's requests, and between a request's buttons; `Enter` expands or collapses the selected item
// or presses the focused button; `1`–`4` pick a question's option; `d`, `Shift+D`, `a` and `r`
// answer the selected request, or the oldest; PgUp/PgDn and `g`/`G` scroll; `i` or a click focuses
// the composer; `t` or a click on `▾ whole ticket` opens the whole ticket, which PgUp/PgDn then
// scroll, and `t`, a click on `▴ less` or `Esc` closes it; `Ctrl+X` asks, then interrupts the
// worker's turn; `Ctrl+R` releases a steered worker; once the worker has finished, `Ctrl+T` files
// the composer's text as a ticket; `Esc` leaves the composer, then closes the whole ticket, then
// goes back to the dashboard, as a click on `← Dashboard` does. No key switches workers: `Tab` is
// the items', so another worker is opened from the dashboard (§ 7.3). While you write in the
// composer, it takes the printable keys, `t` too, Enter and the arrows; PgUp/PgDn, Ctrl+X, Ctrl+R,
// Ctrl+T and Esc still work.
//
// The transcript, the panel, the selection, the composer and the keys are shared with the
// Interview view (transcriptView.ts), as are the head, the pane, the panel and the hint below.
//
// Branding (§ 7.5): tutti's own glyphs and layout, and the scheme's colours; the chrome names
// neither Claude nor its product.
import {
  BoxRenderable,
  type MarkdownOptions,
  type MouseEvent,
  RGBA,
  SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/react"
import {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { AttentionRequest } from "../agent/Attention.ts"
import { settled as hasSettled } from "../agent/WorkerState.ts"
import { UiCommand } from "../run/commands.ts"
import { holdsMessages } from "../run/held.ts"
import type { Card, Key } from "../run/runView.ts"
import { AttentionLines, type ButtonSegment } from "./AttentionCard.tsx"
import { buttonsOf, picksOptions, requestText } from "./attentionKeys.ts"
import { headOf, statusLook } from "./Card.tsx"
import {
  Composer,
  FinishedLine,
  fileWords,
  finishedWords,
  heldLine,
  InterruptQuestion,
  interruptCommands,
  QueuedLines,
  queuedLines,
  SteeredLine,
} from "./Composer.tsx"
import { clickable } from "./click.ts"
import { useFilingDesk } from "./filingDesk.tsx"
import { hintLines } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { type Command, type HelpRow, hintOf, useCommands } from "./keyCommands.ts"
import { Box, useInput } from "./keys.ts"
import {
  boxed,
  boxSides,
  cut,
  Line,
  Lines,
  padded,
  plainFg,
  Section,
  type Segments,
  seg,
  styled,
  widthOf,
  wrap,
} from "./line.tsx"
import { ResourceLine, SpentBox } from "./ResourceLine.tsx"
import { requestInputLines } from "./requestInput.ts"
import { sanitize, sanitizeLine } from "./sanitize.ts"
import {
  badgesOf,
  DescriptionView,
  descriptionLimit,
  descriptionLines,
  panelLines,
  TicketPanelView,
  titleSegment,
  useTicketPanel,
} from "./TicketHead.tsx"
import { useHintHeight } from "./Toasts.tsx"
import type { Role, Theme } from "./theme.ts"
import {
  type Entry,
  expansionOf,
  type Mark,
  markOf,
  nests,
  type ToolEntry,
} from "./transcriptItems.ts"
import {
  entryId,
  inertTranscript,
  type Panel,
  requestKey,
  type Selection,
  type TranscriptActions,
  type TranscriptWindow,
  transcriptCommands,
  useComposer,
  usePanel,
  useSelection,
  useTranscriptKeys,
  useTranscriptWindow,
} from "./transcriptView.ts"
import {
  useCommand,
  useHandBacks,
  useNow,
  useRunViewPart,
  useSpinner,
  useTheme,
} from "./useRunView.ts"

export { entryId, panelRequests, requestKey, selectable } from "./transcriptView.ts"

/** The most lines of a command's output an expanded item shows. */
export const outputLines = 400

/**
 * The fewest lines a request's input scrolls in while the panel shows more than one; it gets a
 * quarter of the pane when that's more, and the panel has room.
 */
export const inputLines = 3

/** The rows the transcript keeps over the request panel, however tall the panel's requests. */
export const transcriptRows = 3

/**
 * The lines of a transcript view's parts but the transcript and the request panel: the head, the
 * ticket under it, the hand-back notice, the held line, the finished or steered line, the queued
 * messages, the composer and the hint. The Interview view has no ticket, hand-back, held or steered
 * line.
 */
export interface ViewChrome {
  readonly head: number
  /**
   * The worker view's resource line under the head (ResourceLine.tsx), none in the Interview view:
   * a short pane gives it up before the request panel's lines, so it is left out of panelBudget.
   */
  readonly resources: number
  /** The ticket's description under the head, or its whole ticket while that is open (§ 7.5). */
  readonly ticket: number
  readonly handBack: number
  readonly held: number
  readonly line: number
  readonly queued: number
  readonly composer: number
  readonly hint: number
}

/** A transcript view's lines, part by part, adding up to the pane's (viewLayout). */
export interface ViewLayout extends ViewChrome {
  /** The rules under the head and over the composer's lines: a line each. */
  readonly rules: readonly [number, number]
  readonly transcript: number
  readonly panel: number
}

/** The rules' lines, under the head and over the composer's. */
const ruleLines = 2

/**
 * The lines the request panel may take in a pane `height` tall: what `chrome`, the rules and the
 * transcript's `transcriptRows` leave it (tutti-7nzv).
 */
export const panelBudget = (height: number, chrome: ViewChrome): number => {
  const { resources: _, ...rest } = chrome
  return (
    height -
    ruleLines -
    transcriptRows -
    Object.values(rest).reduce((sum: number, lines: number) => sum + lines, 0)
  )
}

/**
 * A transcript view's lines in a pane `height` tall, handed out in priority order, each part as
 * many as it needs of what is left, so that they add up to `height`: the hint, the head, the
 * rules, the composer, the finished or steered line, the held line, the queued messages, the
 * hand-back notice and the ticket, then the transcript's `transcriptRows`, then the `panel` lines
 * the request panel takes (panelBudget's at most, but for one request too tall for it), then the
 * resource line, and the transcript the rest.
 */
export const viewLayout = (height: number, chrome: ViewChrome, panel: number): ViewLayout => {
  let rest = Math.max(height, 0)
  const take = (lines: number): number => {
    const got = Math.min(Math.max(lines, 0), rest)
    rest -= got
    return got
  }
  const hint = take(chrome.hint)
  const head = take(chrome.head)
  const rules = [take(1), take(1)] as const
  const composer = take(chrome.composer)
  const line = take(chrome.line)
  const held = take(chrome.held)
  const queued = take(chrome.queued)
  const handBack = take(chrome.handBack)
  const ticket = take(chrome.ticket)
  const kept = take(transcriptRows)
  const panelLines = take(panel)
  const resources = take(chrome.resources)
  const transcript = kept + take(rest)
  return {
    head,
    resources,
    ticket,
    handBack,
    held,
    line,
    queued,
    composer,
    hint,
    rules,
    transcript,
    panel: panelLines,
  }
}

/** The selection key of the hand-back notice. */
const handBackKey = "handback"

/** The Markdown and code styles, from the theme's roles (§ 7.11 "Markdown"). */
export interface Looks {
  readonly theme: Theme
  readonly markdown: SyntaxStyle
  /** The Markdown's quotes and rules, drawn faint (markdownBlocks). */
  readonly blocks: NonNullable<MarkdownOptions["renderNode"]>
  /** A command's output, faint; and an error's, `needsYou`. */
  readonly output: SyntaxStyle
  readonly error: SyntaxStyle
  /** The Markdown's, the output's and the diffs' tree-sitter client, if not OpenTUI's shared one. */
  readonly highlighter: { readonly treeSitterClient?: TreeSitterClient }
}

export const LooksContext = createContext<Looks | null>(null)

/**
 * The tree-sitter client the transcript highlights with: OpenTUI's shared one when undefined. The
 * UI tests put OpenTUI's MockTreeSitterClient here, to resolve the highlighting when they capture a
 * frame rather than wait for tree-sitter's (test/render.ts).
 */
export const HighlighterContext = createContext<TreeSitterClient | undefined>(undefined)

const useLooks = (): Looks => {
  const looks = useContext(LooksContext)
  if (looks === null) throw new Error("a transcript item is drawn outside its worker view")
  return looks
}

/** The longest a Markdown rule is drawn (§ 7.11 "Markdown"). */
export const ruleWidth = 40

/**
 * OpenTUI draws a quote's bar and a rule as box borders, in a colour with no attributes, and the
 * rule the whole width. This keeps its boxes, which it updates in place as the text streams, with
 * their borders off: a quote's draws a faint `│ ` on each of its lines, a rule's a faint `─` at
 * most `ruleWidth` long.
 */
const markdownBlocks = (theme: Theme): NonNullable<MarkdownOptions["renderNode"]> => {
  const faint = theme.styles.dim
  const fg = faint.fg ?? plainFg
  const renderNode: NonNullable<MarkdownOptions["renderNode"]> = (token, context) => {
    if (token.type !== "blockquote" && token.type !== "hr") return undefined
    const box = context.defaultRender()
    if (!(box instanceof BoxRenderable)) return box
    // No sides, not false: OpenTUI sets the colour of a quote it updates, which gives a box with
    // its border false all four.
    box.border = []
    if (token.type === "blockquote") {
      box.paddingLeft = 2
      box.renderAfter = function (buffer) {
        for (let y = 0; y < this.height; y++) {
          buffer.drawText("│", this.x, this.y + y, fg, undefined, faint.attributes)
        }
      }
    } else {
      box.maxWidth = ruleWidth
      box.renderAfter = function (buffer) {
        buffer.drawText("─".repeat(this.width), this.x, this.y, fg, undefined, faint.attributes)
      }
    }
    return box
  }
  // OpenTUI's flag for a renderNode that leaves the other blocks to it: the paragraphs stay
  // coalesced, with the blank lines between them.
  return Object.assign(renderNode, { codeBlockOnly: true })
}

/** The syntax styles of `theme`, made in the renderer's native scene and freed with it. */
export const useSyntaxStyles = (theme: Theme): Looks => {
  const renderer = useRenderer()
  const client = useContext(HighlighterContext)
  const looks = useMemo(() => {
    const role = (name: Role) => ({ fg: theme.rgba(name, "fg") })
    // A style with no role of its own is the terminal's text colour: OpenTUI's own is white.
    const plain = { fg: plainFg }
    const make = (styles: Parameters<typeof SyntaxStyle.fromStyles>[0]) =>
      SyntaxStyle.fromStyles(styles, renderer.nativeScene)
    return {
      theme,
      markdown: make({
        default: plain,
        "markup.heading.1": { ...role("heading1"), bold: true },
        "markup.heading.2": { ...role("heading2"), bold: true },
        // H3 and below: a heading's scope names its level, and no style falls back to another.
        ...Object.fromEntries(
          [3, 4, 5, 6].map((level) => [
            `markup.heading.${level}`,
            { ...role("heading3"), bold: true },
          ]),
        ),
        "markup.heading": { ...role("heading3"), bold: true },
        "markup.raw": role("code"),
        "markup.raw.block": role("code"),
        "markup.link": { ...plain, dim: true },
        "markup.link.label": role("link"),
        "markup.link.url": { ...plain, dim: true },
        "markup.strong": { ...plain, bold: true },
        "markup.italic": { ...plain, italic: true },
        "markup.quote": { ...plain, dim: true, italic: true },
        "markup.list": plain,
        conceal: { ...plain, dim: true },
      }),
      blocks: markdownBlocks(theme),
      output: make({ default: { ...plain, dim: true } }),
      error: make({ default: role("needsYou") }),
      highlighter: client === undefined ? {} : { treeSitterClient: client },
    }
  }, [renderer, theme, client])
  useEffect(
    () => () => {
      looks.markdown.destroy()
      looks.output.destroy()
      looks.error.destroy()
    },
    [looks],
  )
  return looks
}

/** A collapsed tool call's mark, at the end of its line (§ 7.11's worker view). */
const markSegments = (mark: Mark, theme: Theme, room: number): Segments => {
  switch (mark._tag) {
    case "Pending":
      return []
    case "Done":
      return [seg("✓", theme.look("done"))]
    case "Error":
      return cut([seg(mark.line, theme.look("needsYou"))], Math.max(room, 1))
    case "Edit":
      return [
        seg(`+${mark.added}`, theme.look("added")),
        seg(" "),
        seg(`−${mark.removed}`, theme.look("removed")),
      ]
  }
}

/** What goes before an item's line: `▸ ` when it is selected. */
const gutter = (selected: boolean, theme: Theme): Segments => [
  seg(selected ? "▸ " : "  ", theme.styles.key),
]

/** The most lines a collapsed tool call or message takes; the last is cut with `…` (§ 7.5). */
export const itemLines = 6

/**
 * A tool call's lines, `width` wide: `▸ Bash  scripts/check-fast.sh` wrapped under its summary, and
 * its mark at the end of the last line, or on a line of its own when it doesn't fit there; at most
 * `itemLines`. How many there are depends only on the call and `width`, and they only grow as its
 * result comes.
 */
export const toolLines = (
  tool: ToolEntry,
  theme: Theme,
  width: number,
  selected: boolean,
): ReadonlyArray<Segments> => {
  const head: Segments = [
    ...gutter(selected, theme),
    seg(tool.name, theme.styles.key),
    ...(tool.summary === "" ? [] : [seg("  "), seg(tool.summary)]),
    ...(tool.live ? [seg("  …", theme.styles.dim)] : []),
  ]
  // Under the summary, or under the name when that's more than half the line.
  const indent =
    tool.summary === "" ? 4 : Math.min(2 + widthOf([seg(tool.name)]) + 2, Math.floor(width / 2))
  const lines = wrap(head, width, { indent, limit: itemLines })
  const mark = markSegments(markOf(tool), theme, Math.floor(width / 2))
  if (mark.length === 0) return lines
  const room = Math.max(width - widthOf(mark) - 2, 0)
  const withMark = (lines: ReadonlyArray<Segments>): ReadonlyArray<Segments> => {
    const last = lines.at(-1) ?? []
    return widthOf(last) <= room
      ? [...lines.slice(0, -1), [...padded(last, room), seg("  "), ...mark]]
      : [...lines, [...padded([], room), seg("  "), ...mark]]
  }
  const marked = withMark(lines)
  // A mark on a line of its own takes the last of `itemLines` from the summary.
  return marked.length <= itemLines
    ? marked
    : withMark(wrap(head, width, { indent, limit: itemLines - 1 }))
}

/**
 * A message sent to the worker, `width` wide: `› Carry on with the ticket`, its lines wrapped under
 * its text, at most `limit` of them.
 */
const promptLines = (
  text: string,
  theme: Theme,
  width: number,
  selected: boolean,
  limit: number,
): ReadonlyArray<Segments> => {
  const lines = sanitize(text).replace(/\t/g, " ").split("\n")
  const from = lines.findIndex((line) => line.trim() !== "")
  const to = lines.findLastIndex((line) => line.trim() !== "")
  const body = from === -1 ? "" : lines.slice(from, to + 1).join("\n")
  return wrap([...gutter(selected, theme), seg("› ", theme.styles.dim), seg(body)], width, {
    indent: 4,
    limit,
  })
}

/** What a list of entries is drawn with besides them. */
interface ListProps {
  readonly width: number
  /** The key selected, if any. */
  readonly selected: string | null
  /** The keys of the entries open. */
  readonly expanded: ReadonlySet<string>
  /** Selects the entry, and expands or collapses it, as a click does. */
  readonly click: (key: string) => void
}

/**
 * What an entry is drawn with: only what concerns it, so that memo(EntryView) holds while the
 * selection moves or another entry opens elsewhere.
 */
interface EntryProps extends ListProps {
  readonly entry: Entry
  /** Whether it is open. */
  readonly open: boolean
}

/** The expanded set of an entry with no children to open. */
const noneOpen: ReadonlySet<string> = new Set()

/** Whether `key` is `entry`'s, or one of the entries under it. */
const holds = (entry: Entry, key: string): boolean =>
  entry.key === key ||
  ((entry._tag === "Tool" || entry._tag === "Nested") &&
    entry.children.some((child) => holds(child, key)))

/**
 * Rows of a fixed height, as many as its lines, that a click selects and expands: lines wrapped
 * beforehand to the pane's width, so that OpenTUI never lays them out a second time (#1514).
 */
const ClickLines = ({
  lines,
  onClick,
}: {
  readonly lines: ReadonlyArray<Segments>
  readonly onClick: () => void
}) => (
  <box flexDirection="column" height={lines.length} flexShrink={0} {...clickable(onClick)}>
    {lines.map((segments, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the lines are drawn anew in order
      <Line key={i} segments={segments} />
    ))}
  </box>
)

/**
 * Entries one under the other, `width` wide, each given the selection only when it is in it, and
 * the expanded set only when it nests.
 */
export const EntryList = ({
  entries,
  selected,
  expanded,
  ...props
}: ListProps & { readonly entries: ReadonlyArray<Entry> }) => (
  <>
    {entries.map((entry) => (
      <EntryView
        key={entry.key}
        entry={entry}
        open={expanded.has(entry.key)}
        selected={selected !== null && holds(entry, selected) ? selected : null}
        expanded={nests(entry) ? expanded : noneOpen}
        {...props}
      />
    ))}
  </>
)

/** An Agent call's subagent work, or a group of it, behind a faint `│`. */
const Children = ({
  entries,
  width,
  ...props
}: ListProps & { readonly entries: ReadonlyArray<Entry> }) => {
  const { theme } = useLooks()
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginLeft={2}
      paddingLeft={1}
      border={["left"]}
      borderStyle="single"
      borderColor={theme.rgba("frame")}
    >
      {entries.length === 0 ? (
        <Line segments={[seg("nothing yet", theme.styles.dim)]} />
      ) : (
        <EntryList entries={entries} width={Math.max(width - 4, 1)} {...props} />
      )}
    </box>
  )
}

/** A transparent colour, for what <diff> would otherwise fill. */
const clear = RGBA.fromValues(0, 0, 0, 0)

/** `role`'s colour, faint, behind a diff's added or removed lines; nothing under NO_COLOR. */
const tint = (theme: Theme, role: Role): RGBA => {
  if (theme.noColor) return clear
  const colour = theme.rgba(role, "fg")
  return RGBA.fromValues(colour.r, colour.g, colour.b, 0.18)
}

/** `text` with at most `limit` lines, and a faint count of the rest. */
const capped = (text: string, limit: number): { readonly text: string; readonly more: number } => {
  const lines = text.split("\n")
  return lines.length <= limit
    ? { text, more: 0 }
    : { text: lines.slice(0, limit).join("\n"), more: lines.length - limit }
}

/** What an expanded tool call shows under its line. */
const Expanded = ({ tool, ...props }: ListProps & { readonly tool: ToolEntry }) => {
  const looks = useLooks()
  const { theme } = looks
  const expansion = expansionOf(tool)
  switch (expansion._tag) {
    case "Children":
      return <Children entries={tool.children} {...props} />
    case "Diff":
      return (
        <box paddingLeft={4} flexShrink={0}>
          <diff
            diff={expansion.diff}
            view="unified"
            // The gutter holds each line's sign, so that colour isn't the only one (§ 7.11); its
            // numbers count from the replacement's first line (editOf).
            showLineNumbers
            lineNumberFg={theme.rgba("frame", "fg")}
            lineNumberBg={clear}
            addedLineNumberBg={clear}
            removedLineNumberBg={clear}
            syntaxStyle={looks.markdown}
            {...looks.highlighter}
            wrapMode="char"
            addedSignColor={theme.rgba("added", "fg")}
            removedSignColor={theme.rgba("removed", "fg")}
            addedBg={tint(theme, "added")}
            removedBg={tint(theme, "removed")}
            contextBg={clear}
            addedContentBg={tint(theme, "added")}
            removedContentBg={tint(theme, "removed")}
            contextContentBg={clear}
          />
        </box>
      )
    case "Output": {
      const shown = capped(expansion.text, outputLines)
      return (
        <box paddingLeft={4} flexDirection="column" flexShrink={0}>
          <code
            content={shown.text}
            filetype="text"
            wrapMode="char"
            syntaxStyle={expansion.error ? looks.error : looks.output}
            {...looks.highlighter}
          />
          {shown.more > 0 ? (
            <Line segments={[seg(`… ${shown.more} more lines`, theme.styles.dim)]} />
          ) : null}
        </box>
      )
    }
    case "Range":
      return (
        <box paddingLeft={4} height={1} flexShrink={0}>
          <Line segments={[seg(expansion.text, theme.styles.dim)]} />
        </box>
      )
    case "Nothing":
      return (
        <box paddingLeft={4} height={1} flexShrink={0}>
          <Line
            segments={[seg(tool.result === null ? "no result yet" : "no output", theme.styles.dim)]}
          />
        </box>
      )
  }
}

/** One entry of the transcript, and what it shows expanded. */
export const EntryView = memo(({ entry, open, ...props }: EntryProps) => {
  const looks = useLooks()
  const { theme } = looks
  const { width, selected, click } = props
  const isSelected = selected === entry.key
  switch (entry._tag) {
    case "Text":
      return (
        <box id={entryId(entry.key)} paddingLeft={2} flexShrink={0}>
          {/* Only live text grows: OpenTUI's <markdown> not streaming keeps the blocks the new
              text starts with, so a quote grown a line there is two. The entry its message lands
              as has a key of its own, and a new <markdown> parses it whole. */}
          <markdown
            content={entry.text}
            syntaxStyle={looks.markdown}
            renderNode={looks.blocks}
            {...looks.highlighter}
            conceal
            streaming={entry.live}
          />
        </box>
      )
    case "Prompt":
      return (
        <box id={entryId(entry.key)} flexDirection="column" flexShrink={0}>
          {/* Expanded, the whole message, in place of the lines it shows collapsed. */}
          <ClickLines
            lines={promptLines(
              entry.text,
              theme,
              width,
              isSelected,
              open ? Number.POSITIVE_INFINITY : itemLines,
            )}
            onClick={() => click(entry.key)}
          />
        </box>
      )
    case "Nested":
      return (
        <box id={entryId(entry.key)} flexDirection="column" flexShrink={0}>
          <ClickLines
            lines={[
              cut(
                [
                  ...gutter(isSelected, theme),
                  seg("Agent", theme.styles.key),
                  seg("  "),
                  seg("subagent work of an earlier call", theme.styles.dim),
                ],
                width,
              ),
            ]}
            onClick={() => click(entry.key)}
          />
          {open ? <Children entries={entry.children} {...props} /> : null}
        </box>
      )
    case "Tool":
      return (
        <box id={entryId(entry.key)} flexDirection="column" flexShrink={0}>
          <ClickLines
            lines={toolLines(entry, theme, width, isSelected)}
            onClick={() => click(entry.key)}
          />
          {open ? <Expanded tool={entry} {...props} /> : null}
        </box>
      )
  }
})

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
  const button = (label: string, index: number): ButtonSegment => ({
    text: `[ ${label} ]`,
    look: index === options.focus ? theme.form.focusedButton : theme.form.button,
    button: index,
  })
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
  readonly press: (index: number) => void
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
      <AttentionLines lines={parts.head} press={press} />
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
  const press: ButtonSegment = {
    text: "[ Hand it the conflict now ]",
    look: options.selected ? theme.form.focusedButton : theme.form.button,
    button: 0,
  }
  return boxed(
    [
      [seg("A merge conflict waits for this worker", theme.styles.deferred)],
      [seg("You steered it, so it wasn't handed over.", theme.styles.dim)],
      [press],
    ],
    options.width,
    theme.look("notice"),
    options.selected ? "heavy" : "rounded",
  )
}

/** Where the worker view's keys are: what its hint names depends on it. */
export interface WorkerViewAt {
  /** Whether the panel has requests open. */
  readonly requests: boolean
  /** Whether you write in the composer now: the hint names the composer's keys. */
  readonly composing: boolean
  readonly steered: boolean
  /** Whether the worker has finished: nothing is sent to it, and Ctrl+T files what you wrote. */
  readonly finished: boolean
  /** Whether the whole ticket is open (TicketHead.tsx): `t` or `Esc` closes it. */
  readonly ticketOpen?: boolean
}

/** What the worker view's keys do: the transcript's, and its own. */
export interface WorkerViewActions extends TranscriptActions {
  readonly interrupt: () => void
  readonly release: () => void
  readonly fileAsTicket: () => void
  /** `t`: opens or closes the whole ticket. */
  readonly ticket: () => void
}

const nothing = () => {}

/** Keys that do nothing, for the hint as the layout counts it, before the keys are bound. */
const inertWorkerView: WorkerViewActions = {
  ...inertTranscript,
  interrupt: nothing,
  release: nothing,
  fileAsTicket: nothing,
  ticket: nothing,
}

const writeRow: HelpRow = [
  "i, a click on the composer",
  "write to the worker; Enter sends, Alt+Enter or Ctrl+J a new line",
]
const moveRow: HelpRow = [
  "Tab, Shift+Tab, arrows",
  "move between items; between a request's buttons",
]
const denyRow: HelpRow = ["d, Shift+D", "deny the request; deny with a reason"]
const scrollRow: HelpRow = [
  "the wheel, PgUp/PgDn",
  "scroll; past the top loads earlier items; the whole ticket, open",
]
const jumpRow: HelpRow = ["g, G", "jump to the top or the end"]
const pickRow: HelpRow = ["1–4 in a question", "pick an option"]

/**
 * The worker view's keys (§ 7.3), its hint's and its key help's: the keys there are; the composer's
 * while you write in it. Once the worker has `finished`, nothing is sent to it, so the hint has no
 * Enter send, Ctrl+X or Ctrl+R (tutti-2n7y), and has Ctrl+T, which files what you typed as a
 * ticket (tutti-g0wd). `t` opens the whole ticket; while it is open, `t/Esc` closes it.
 */
export const workerViewCommands = (
  at: WorkerViewAt,
  act: WorkerViewActions = inertWorkerView,
): ReadonlyArray<Command> => {
  const keys = transcriptCommands(act)
  const viewing = !at.composing
  const named = (shown: boolean, keys: string, does: string) => (shown ? { keys, does } : undefined)
  return [
    // The composer's own keys, which its field binds.
    {
      keys: [],
      run: nothing,
      hint: named(at.composing && !at.finished, "Enter", "send"),
      help: writeRow,
    },
    {
      keys: [],
      run: nothing,
      hint: named(at.composing, "Alt+Enter/Ctrl+J", "new line"),
      help: writeRow,
    },
    {
      ...keys.escape,
      hint: at.composing
        ? { keys: "Esc", does: "leave" }
        : at.ticketOpen === true
          ? { keys: "t/Esc", does: "less" }
          : { keys: "Esc", does: "dashboard" },
      help: [
        "Esc, ← Dashboard",
        "leave the composer; close the whole ticket; back to the dashboard",
      ],
    },
    // Esc, then the dashboard's keys: the view has no key of its own for it (§ 7.3).
    {
      keys: [],
      run: nothing,
      help: ["Esc, Tab, Enter", "switch workers, by way of the dashboard"],
    },
    // A click on the resource line opens what the worker spent (ResourceLine.tsx).
    {
      keys: [],
      run: nothing,
      help: ["a click on resources", "what the worker spent: tokens, calls, dollars, context"],
    },
    { ...keys.write, hint: named(viewing, "i", "write"), help: writeRow },
    {
      keys: ["t"],
      run: act.ticket,
      hint: named(viewing && at.ticketOpen !== true, "t", "ticket"),
      help: ["t, ▾ whole ticket", "the whole ticket; t, ▴ less or Esc closes it"],
    },
    { ...keys.deny, hint: named(viewing && at.requests, "d", "deny"), help: denyRow },
    { ...keys.denyWithReason, help: denyRow },
    { ...keys.allow, help: ["a", "allow the request, unless it opens on Deny"] },
    { ...keys.forRun, help: ["r", "allow for this run"] },
    {
      keys: ["ctrl+x"],
      run: act.interrupt,
      hint: named(!at.finished, "Ctrl+X", "interrupt"),
      help: ["Ctrl+X", "interrupt the worker's turn (asks first)"],
    },
    {
      keys: ["ctrl+r"],
      run: act.release,
      hint: named(at.steered && !at.finished, "Ctrl+R", "release"),
      help: ["Ctrl+R, Release", "release a steered worker"],
    },
    {
      keys: ["ctrl+t"],
      run: act.fileAsTicket,
      hint: named(at.finished, "Ctrl+T", "file as ticket"),
      help: [
        "Ctrl+T, File as ticket",
        "once the worker has finished, file what you wrote as a ticket",
      ],
    },
    { ...keys.down, hint: named(viewing, "↑↓", "select"), help: moveRow },
    { ...keys.up, help: moveRow },
    { ...keys.next, help: moveRow },
    { ...keys.previous, help: moveRow },
    {
      ...keys.enter,
      hint: named(viewing, "Enter", "expand"),
      help: ["Enter, a click", "expand or collapse the item; press the focused button"],
    },
    { ...keys.help, hint: named(viewing, "?", "keys"), help: ["?", "these keys"] },
    { ...keys.pageUp, hint: named(viewing, "PgUp/PgDn", "scroll"), help: scrollRow },
    { ...keys.pageDown, help: scrollRow },
    { ...keys.top, hint: named(viewing, "g/G", "top/end"), help: jumpRow },
    { ...keys.end, help: jumpRow },
    ...keys.picks.map((pick) => ({ ...pick, help: pickRow })),
    {
      keys: [],
      run: nothing,
      help: ["Answer in view", "the answer form: ↑↓ move, Space picks, Enter presses"],
    },
  ]
}

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
 * The transcript's part of a view, `lines` tall: mounted even with none, so that its scrollbox keeps
 * its place while a short pane leaves it no lines.
 */
export const TranscriptSection = ({
  lines,
  children,
}: {
  readonly lines: number
  readonly children: ReactNode
}) => (
  <box flexDirection="column" height={Math.max(lines, 0)} flexShrink={0} overflow="hidden">
    {children}
  </box>
)

/**
 * The transcript's items, `width` wide, in a scrollbox that sticks to the bottom. It takes no focus,
 * so a click on it leaves the composer's where it is (tutti-yzkg).
 */
export const TranscriptPane = ({
  transcript,
  selection,
  width,
}: {
  readonly transcript: TranscriptWindow
  readonly selection: Selection
  readonly width: number
}) => {
  const theme = useTheme()
  return (
    <scrollbox
      ref={transcript.scroll}
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      focusable={false}
      scrollbarOptions={{ visible: false }}
      onMouseScroll={transcript.wheel}
    >
      {transcript.loading ? (
        <box height={1} flexShrink={0}>
          <Line segments={[seg("  loading earlier items…", theme.styles.dim)]} />
        </box>
      ) : null}
      <EntryList
        entries={transcript.shown}
        width={width}
        selected={selection.selected}
        expanded={transcript.expanded}
        click={selection.click}
      />
    </scrollbox>
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

/** A view's hint, `width` wide: every key, on as many lines as it takes; toasts go above them. */
export const ViewHint = ({
  keys,
  width,
}: {
  readonly keys: ReadonlyArray<Key>
  readonly width: number
}) => {
  const theme = useTheme()
  const input = useInput()
  const lines = hintLines(keys, theme, width)
  useHintHeight(input.toasts, lines.length)
  return <Lines lines={lines} />
}

/** The view of the ticket's worker, while the run shows it. */
export const WorkerView = ({ ticket: viewed }: { readonly ticket: string }) => {
  // Its card alone: another worker's card or the load changing doesn't draw the view anew.
  const found = useRunViewPart((view) => view.cards.find((each) => each.ticket === viewed))
  const theme = useTheme()
  const looks = useSyntaxStyles(theme)
  const command = useCommand()
  const handBacks = useHandBacks()
  const { width, height } = useTerminalDimensions()
  // The card last seen, so that the view still shows a worker that has just finished.
  const last = useRef<Card | undefined>(found)
  if (found !== undefined) last.current = found
  // When the view first drew the worker finished: its head's clock stops there.
  const ended = useRef<number | undefined>(undefined)
  if (found !== undefined) ended.current = undefined
  const card = found ?? last.current
  const ticket = card?.ticket
  // What its worker consumes, the last seen kept as its card is (ResourceLine.tsx).
  const foundResources = useRunViewPart((view) =>
    view.resources.find((each) => each.ticket === viewed),
  )
  const lastResources = useRef(foundResources)
  if (foundResources !== undefined) lastResources.current = foundResources
  const resources = foundResources ?? lastResources.current
  // While its ticket waits to merge or merges, the run holds your messages (held.ts).
  const holding = found !== undefined && holdsMessages(found.phase)
  const transcript = useTranscriptWindow(
    ticket,
    found?.state != null && !hasSettled(found.state),
    holding,
    found === undefined,
  )
  const { sends } = transcript
  const handBack = ticket !== undefined && handBacks.includes(ticket)
  const composer = useComposer()
  const input = useInput()
  // Once the worker has finished, its card gone, nothing is sent: what you typed stays, and a toast
  // says why (tutti-ceo).
  const finished = found === undefined
  const inner = Math.max(width, 1)
  const panelWidth = Math.max(inner - 2, 8)
  const queued = queuedLines(sends.queued, theme, inner, sends.mark)
  // The panel has the height the view's other parts leave it, and a few of the transcript's
  // (tutti-7nzv), the hint as it is with requests.
  const [headLines, setHeadLines] = useState(1)
  // The ticket under the head (TicketHead.tsx): its description, or its whole ticket while open,
  // two columns in.
  const ticketPanel = useTicketPanel(viewed)
  const issue = card?.issue
  const ticketWidth = Math.max(inner - 2, 1)
  const description = useMemo(
    () =>
      issue === undefined
        ? null
        : descriptionLines(issue, theme, ticketWidth, descriptionLimit(height)),
    [issue, theme, ticketWidth, height],
  )
  const ticketLines =
    card === undefined
      ? 0
      : ticketPanel.open
        ? panelLines(issue, height, ticketWidth)
        : (description?.lines.length ?? 0)
  const steered = card?.steered === true
  const chrome = (requests: boolean): ViewChrome => ({
    head: headLines,
    resources: resources === undefined ? 0 : 1,
    ticket: ticketLines,
    handBack: handBack ? handBackLines(theme, { width: panelWidth, selected: false }).length : 0,
    held: holding ? 1 : 0,
    line: finished || steered ? 1 : 0,
    queued: queued.length,
    composer: composer.lines,
    hint: hintLines(
      hintOf(
        workerViewCommands({
          requests,
          composing: composer.typing,
          steered,
          finished,
          ticketOpen: ticketPanel.open,
        }),
      ),
      theme,
      inner,
    ).length,
  })
  const fit = usePanelRooms(theme, panelWidth, panelBudget(height, chrome(true)), height)
  // The requests open now: a finished worker's card, kept for its head, has none.
  const panel = usePanel(
    found,
    (requests, waiting) => fit.rooms(requests, waiting - requests.length).length,
  )
  const laid = viewLayout(
    height,
    chrome(panel.requests.length > 0),
    fit.lines(panel.requests, panel.more),
  )
  const selection = useSelection(transcript, panel, handBack ? [handBackKey] : [])

  const send = (text: string) => {
    if (found === undefined) {
      input.toasts.show(finishedWords(viewed).toast)
      return false
    }
    const uuid = crypto.randomUUID()
    sends.sent({ uuid, ticket: found.ticket, text })
    command(UiCommand.SendMessage({ ticket: found.ticket, text, uuid }))
    return true
  }
  // Once it has finished, Ctrl+T or File as ticket files what you typed as a new ticket; the composer
  // keeps it until bd has it, and while it isn't filed (tutti-g0wd). The desk keeps the filing while
  // bd answers, past the view: reopened, the composer has its text again (tutti-fgr2).
  const desk = useFilingDesk()
  // biome-ignore lint/correctness/useExhaustiveDependencies: once a view, as it opens
  useEffect(() => {
    const text = desk.opening(viewed)
    if (text !== "") composer.field.current?.setText(text)
    return desk.attach(viewed, composer.field)
  }, [desk, viewed])
  const fileAsTicket = () => {
    if (found !== undefined) return
    const text = composer.field.current?.plainText.trim() ?? ""
    if (text === "") return input.toasts.show(fileWords.nothing)
    if (desk.pending(viewed) !== undefined) return input.toasts.show(fileWords.already)
    const uuid = crypto.randomUUID()
    desk.ask(viewed, { uuid, text })
    command(UiCommand.FileTicket({ from: viewed, text, uuid }))
    input.toasts.show(fileWords.filing)
  }
  // Ctrl+X asks first; `y` interrupts the turn the question names, and its queued messages go.
  const interrupt = () => {
    if (found === undefined) return
    composer.blur()
    input.box.set(Box.Interrupt({ ticket: found.ticket }))
  }
  const answerInterrupt = (yes: boolean) => {
    const asked = input.box.get()
    if (asked?._tag !== "Interrupt") return
    input.box.set(null)
    composer.refocus()
    if (!yes) return
    sends.cancelled(asked.ticket)
    command(UiCommand.Interrupt({ ticket: asked.ticket }))
  }
  useCommands(
    "box",
    interruptCommands(
      () => answerInterrupt(true),
      () => answerInterrupt(false),
    ),
    "Interrupt",
  )
  // A click on the resource line opens what the worker spent, over the view; Esc or a click closes it.
  const openSpent = () => {
    composer.blur()
    input.box.set(Box.Spent({ ticket: viewed }))
  }
  const closeSpent = () => {
    if (input.box.get()?._tag !== "Spent") return
    input.box.set(null)
    composer.refocus()
  }
  useCommands("box", [{ keys: ["escape"], run: closeSpent }], "Spent")
  // The view draws its Interrupt and Spent boxes and binds their keys: unmounted with one open,
  // nothing would, and the box would hold the keys of the view after it (tutti-por).
  useEffect(
    () => () => {
      const open = input.box.get()?._tag
      if (open === "Interrupt" || open === "Spent") input.box.set(null)
    },
    [input],
  )
  const release = () => {
    if (found?.steered === true) command(UiCommand.Release({ ticket: found.ticket }))
  }
  const handBackNow = () => {
    if (ticket !== undefined) command(UiCommand.HandBackNow({ ticket }))
  }
  const close = () => command(UiCommand.CloseWorker())
  const { help, actions, unlessHelp } = useTranscriptKeys({
    transcript,
    panel,
    selection,
    composer,
    // Esc closes the whole ticket before it leaves the view.
    back: () => (ticketPanel.open ? ticketPanel.close() : close()),
    enter: () => (selection.current() === handBackKey ? handBackNow() : selection.enter()),
    page: (step) => (ticketPanel.open ? ticketPanel.page(step) : transcript.page(step)),
  })
  const keys = useCommands(
    "view",
    workerViewCommands(
      {
        requests: panel.requests.length > 0,
        composing: composer.typing,
        steered,
        finished,
        ticketOpen: ticketPanel.open,
      },
      {
        ...actions,
        interrupt: unlessHelp(interrupt),
        release: unlessHelp(release),
        fileAsTicket: unlessHelp(fileAsTicket),
        ticket: unlessHelp(ticketPanel.toggle),
      },
    ),
  )

  const rule: Segments = [seg("─".repeat(inner), theme.look("frame"))]
  const head = (now: number, spin: string): Segments => {
    if (card === undefined) return [seg(`${sanitizeLine(viewed)} has no worker`, theme.styles.dim)]
    // Once its card has gone, the head says finished, its time stopped where the view first saw it
    // gone (tutti-2n7y).
    if (finished) ended.current ??= now
    const shown: Card = finished ? { ...card, motion: "•", steered: false } : card
    const status = finished
      ? seg(finishedWords(viewed).status, theme.styles.done)
      : seg(card.status, statusLook(card, theme))
    const badges = badgesOf(card.issue)
    return [
      ...headOf(shown, theme, ended.current ?? now, spin, [status]),
      ...(badges === "" ? [] : [seg("  "), seg(badges, theme.styles.dim)]),
      seg("   "),
      titleSegment(sanitizeLine(card.title), theme),
    ]
  }
  const { box } = composer
  return (
    <LooksContext.Provider value={looks}>
      <box flexDirection="column" width={width} height={height}>
        <Section lines={laid.head}>
          <ViewHead
            link=" ← Dashboard"
            leave={close}
            head={head}
            spinning={!finished && card?.motion === "spinner"}
            width={inner}
            counted={setHeadLines}
          />
        </Section>
        <Section lines={laid.resources}>
          {resources === undefined ? null : (
            <ResourceLine
              resources={resources}
              memory={card?.memory}
              finished={finished}
              width={inner}
              open={openSpent}
            />
          )}
        </Section>
        <Section lines={laid.ticket}>
          <box paddingLeft={2} flexDirection="column" height={laid.ticket} flexShrink={0}>
            {ticketPanel.open ? (
              <TicketPanelView
                issue={issue}
                panel={ticketPanel}
                looks={looks}
                width={ticketWidth}
                lines={laid.ticket}
              />
            ) : description === null ? null : (
              <DescriptionView lines={description} open={ticketPanel.toggle} />
            )}
          </box>
        </Section>
        <Section lines={laid.rules[0]}>
          <Line segments={rule} />
        </Section>
        <TranscriptSection lines={laid.transcript}>
          <TranscriptPane transcript={transcript} selection={selection} width={inner} />
        </TranscriptSection>
        <Section lines={laid.handBack}>
          <AttentionLines
            lines={handBackLines(theme, {
              width: panelWidth,
              selected: selection.selected === handBackKey,
            })}
            press={handBackNow}
          />
        </Section>
        <Section lines={laid.panel}>
          <RequestPanel
            panel={panel}
            selection={selection}
            width={panelWidth}
            rooms={fit.rooms(panel.requests, panel.more)}
          />
        </Section>
        <Section lines={laid.rules[1]}>
          <Line segments={rule} />
        </Section>
        <Section lines={laid.held}>
          <Line segments={heldLine(theme, viewed, found?.phase._tag === "Merging", inner)} />
        </Section>
        <Section lines={laid.line}>
          {finished ? (
            <FinishedLine theme={theme} ticket={viewed} width={inner} file={fileAsTicket} />
          ) : (
            <SteeredLine theme={theme} width={inner} release={release} />
          )}
        </Section>
        <Section lines={laid.queued}>
          <QueuedLines lines={queued} />
        </Section>
        <Section lines={laid.composer}>
          <Composer
            theme={theme}
            field={composer.field}
            lines={composer.lines}
            setLines={composer.setLines}
            focused={composer.typing}
            focus={() => composer.setComposing(true)}
            send={send}
            {...(finished ? { placeholder: () => finishedWords(viewed).placeholder } : {})}
          />
        </Section>
        <Section lines={laid.hint}>
          <ViewHint keys={keys.hint} width={inner} />
        </Section>
        {help ? <KeyHelp theme={theme} width={width} height={height} keys={keys.help} /> : null}
        {box?._tag === "Spent" ? <SpentBox ticket={box.ticket} close={closeSpent} /> : null}
        {box?._tag === "Interrupt" ? (
          <InterruptQuestion
            theme={theme}
            ticket={box.ticket}
            yes={() => answerInterrupt(true)}
            no={() => answerInterrupt(false)}
          />
        ) : null}
      </box>
    </LooksContext.Provider>
  )
}
