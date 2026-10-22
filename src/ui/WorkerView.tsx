// The worker view (§ 7.5, § 7.3, § 7.11): tutti's transcript of one worker, drawn by tutti, under
// orchestra-style chrome: `← Dashboard`, then the worker's card head (number, mark, ticket, status,
// elapsed time) and its title, wrapped onto more lines in a narrow pane, over a rule. Below the
// transcript, the attention panel shows the worker's open requests with the card's buttons and
// rules (attentionKeys.ts), each with its description, its reason and its whole input, and a
// conflict hand-back waiting for a steered worker (§ 4.3) as a notice with Hand it the conflict
// now. Answer in view, for what a card can't hold, opens the answer form over the view
// (AnswerForm.tsx). Under them and the rule, the composer (Composer.tsx): the held line while the
// ticket waits to merge or merges, the steered line with its Release button, your messages still
// queued or held, the field.
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
// the composer; `Ctrl+X` asks, then interrupts the worker's turn; `Ctrl+R` releases a steered
// worker; once the worker has finished, `Ctrl+T` files the composer's text as a ticket; `Esc` leaves
// the composer, then goes back to the dashboard, as a click on `← Dashboard`
// does. No key switches workers: `Tab` is the items', so another worker is opened from the
// dashboard (§ 7.3). While you write in the composer, it takes the printable keys, Enter and
// the arrows; PgUp/PgDn, Ctrl+X, Ctrl+R, Ctrl+T and Esc still work.
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
import { createContext, memo, useContext, useEffect, useMemo, useRef } from "react"
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
  QueuedLines,
  queuedLines,
  SteeredLine,
} from "./Composer.tsx"
import { hintLines } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { Box, useInput, useLayer } from "./keys.ts"
import {
  boxed,
  cut,
  Line,
  Lines,
  padded,
  plainFg,
  roleLook,
  type Segments,
  seg,
  styled,
  widthOf,
  wrap,
} from "./line.tsx"
import { requestInputLines } from "./requestInput.ts"
import { sanitize, sanitizeLine } from "./sanitize.ts"
import { useHintHeight } from "./Toasts.tsx"
import type { Role, Theme } from "./theme.ts"
import { type Entry, expansionOf, type Mark, markOf, type ToolEntry } from "./transcriptItems.ts"
import {
  entryId,
  type Panel,
  requestKey,
  type Selection,
  type TranscriptWindow,
  useComposer,
  usePanel,
  useSelection,
  useTranscriptKeys,
  useTranscriptWindow,
} from "./transcriptView.ts"
import {
  useCommand,
  useFilings,
  useHandBacks,
  useNow,
  useRunView,
  useSpinner,
  useTheme,
} from "./useRunView.ts"

export { entryId, panelRequests, requestKey, selectable } from "./transcriptView.ts"

/** The most lines of a command's output an expanded item shows. */
export const outputLines = 400

/** The fewest lines a request's input scrolls in; it gets a quarter of the pane when that's more. */
export const inputLines = 3

/** The selection key of the hand-back notice. */
const handBackKey = "handback"

/** The Markdown and code styles, from the theme's roles (§ 7.11 "Markdown"). */
interface Looks {
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
      return [seg("✓", roleLook(theme, "done"))]
    case "Error":
      return cut([seg(mark.line, roleLook(theme, "needsYou"))], Math.max(room, 1))
    case "Edit":
      return [
        seg(`+${mark.added}`, roleLook(theme, "added")),
        seg(" "),
        seg(`−${mark.removed}`, roleLook(theme, "removed")),
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

/** What an entry is drawn with besides itself. */
interface EntryProps {
  readonly entry: Entry
  readonly width: number
  readonly selected: string | null
  readonly expanded: ReadonlySet<string>
  /** Selects the entry, and expands or collapses it, as a click does. */
  readonly click: (key: string) => void
}

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
  // biome-ignore lint/a11y/noStaticElementInteractions: a terminal box, not the DOM's; Enter is its key
  <box
    flexDirection="column"
    height={lines.length}
    flexShrink={0}
    onMouseDown={(event: MouseEvent) => {
      if (event.button !== 0) return
      event.stopPropagation()
      onClick()
    }}
  >
    {lines.map((segments, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the lines are drawn anew in order
      <Line key={i} segments={segments} />
    ))}
  </box>
)

/** Entries one under the other, `width` wide. */
export const EntryList = ({
  entries,
  ...props
}: Omit<EntryProps, "entry"> & { readonly entries: ReadonlyArray<Entry> }) => (
  <>
    {entries.map((entry) => (
      <EntryView key={entry.key} entry={entry} {...props} />
    ))}
  </>
)

/** An Agent call's subagent work, or a group of it, behind a faint `│`. */
const Children = ({
  entries,
  width,
  ...props
}: Omit<EntryProps, "entry"> & { readonly entries: ReadonlyArray<Entry> }) => {
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
const Expanded = ({ tool, ...props }: Omit<EntryProps, "entry"> & { readonly tool: ToolEntry }) => {
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
const EntryView = memo(({ entry, ...props }: EntryProps) => {
  const looks = useLooks()
  const { theme } = looks
  const { width, selected, expanded, click } = props
  const open = expanded.has(entry.key)
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
  /** Its whole input, one framed line a line, scrolled within the box when it is long. */
  readonly input: ReadonlyArray<Segments>
  readonly foot: ReadonlyArray<Segments>
}

/**
 * A request's box in the panel, `width` wide, framed `needsYou`, heavy when it is selected: the
 * request's line, its description and reason faint, its buttons (`focus` the focused one), then
 * its whole input faint, under the buttons so that a long one never hides them.
 */
export const panelParts = (
  request: AttentionRequest,
  theme: Theme,
  options: { readonly width: number; readonly selected: boolean; readonly focus: number | null },
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
  const input = requestInputLines(request, theme, inner)
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
    ...faint(description),
    ...faint(reason),
    ...rows,
  ]
  const lines = boxed(
    [...above, ...input],
    options.width,
    roleLook(theme, "needsYou"),
    options.selected ? "heavy" : "rounded",
  )
  return {
    head: lines.slice(0, 1 + above.length),
    input: lines.slice(1 + above.length, -1),
    foot: lines.slice(-1),
  }
}

/** A request's box in the panel: its input scrolls in at most `room` lines; buttons are pressed. */
export const PanelBox = ({
  parts,
  room,
  press,
}: {
  readonly parts: PanelParts
  readonly room: number
  readonly press: (index: number) => void
}) => (
  <box flexDirection="column" flexShrink={0}>
    <AttentionLines lines={parts.head} press={press} />
    {parts.input.length === 0 ? null : (
      <scrollbox
        height={Math.min(parts.input.length, room)}
        flexShrink={0}
        scrollbarOptions={{ visible: false }}
      >
        <Lines lines={parts.input} />
      </scrollbox>
    )}
    <Lines lines={parts.foot} />
  </box>
)

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
    roleLook(theme, "notice"),
    options.selected ? "heavy" : "rounded",
  )
}

/**
 * The worker view's hint: the keys there are; the composer's while you write in it. Once the worker
 * has `finished`, nothing is sent to it, so the hint has no Enter send, Ctrl+X or Ctrl+R (tutti-2n7y),
 * and has Ctrl+T, which files what you typed as a ticket (tutti-g0wd).
 */
const hintKeys = (requests: boolean, composing: boolean, steered: boolean, finished: boolean) => {
  const steering = finished
    ? [{ keys: "Ctrl+T", does: "file as ticket" }]
    : [
        { keys: "Ctrl+X", does: "interrupt" },
        ...(steered ? [{ keys: "Ctrl+R", does: "release" }] : []),
      ]
  return composing
    ? [
        ...(finished ? [] : [{ keys: "Enter", does: "send" }]),
        { keys: "Alt+Enter/Ctrl+J", does: "new line" },
        { keys: "Esc", does: "leave" },
        ...steering,
      ]
    : [
        { keys: "Esc", does: "dashboard" },
        { keys: "i", does: "write" },
        ...(requests ? [{ keys: "d", does: "deny" }] : []),
        ...steering,
        { keys: "↑↓", does: "select" },
        { keys: "Enter", does: "expand" },
        { keys: "?", does: "keys" },
        { keys: "PgUp/PgDn", does: "scroll" },
        { keys: "g/G", does: "top/end" },
      ]
}

/** The worker view's keys, for its key help (§ 7.3's table). */
export const workerViewKeys: ReadonlyArray<readonly [string, string]> = [
  ["Tab, Shift+Tab, arrows", "move between items; between a request's buttons"],
  ["Enter, a click", "expand or collapse the item; press the focused button"],
  [
    "i, a click on the composer",
    "write to the worker; Enter sends, Alt+Enter or Ctrl+J a new line",
  ],
  ["Esc, ← Dashboard", "leave the composer; back to the dashboard"],
  ["Esc, Tab, Enter", "switch workers, by way of the dashboard"],
  ["Ctrl+X", "interrupt the worker's turn (asks first)"],
  ["Ctrl+R, Release", "release a steered worker"],
  ["Ctrl+T, File as ticket", "once the worker has finished, file what you wrote as a ticket"],
  ["d, Shift+D", "deny the request; deny with a reason"],
  ["a", "allow the request, unless it opens on Deny"],
  ["r", "allow for this run"],
  ["1–4 in a question", "pick an option"],
  ["Answer in view", "the answer form: ↑↓ move, Space picks, Enter presses"],
  ["the wheel, PgUp/PgDn", "scroll; past the top loads earlier items"],
  ["g, G", "jump to the top or the end"],
  ["Ctrl+C", "quit: stop after current, or quit now"],
  ["a drag", "select text and copy it"],
  ["?", "these keys"],
]

/**
 * The head of a transcript's view: `link`, which a click follows as `leave`, then `head` at the
 * shell's clock and the spinner's frame, wrapped rather than cut (tutti-rfs). Its lines after the
 * first are under the link, not in the transcript's scrollbox, so their height doesn't touch #1514.
 * The clock and the spinner tick here, in a leaf, so that the view over it isn't drawn anew ten
 * times a second while `spinning` (tutti-k2n1).
 */
export const ViewHead = ({
  link,
  leave,
  head,
  spinning,
  width,
}: {
  readonly link: string
  readonly leave: () => void
  readonly head: (now: number, spin: string) => Segments
  readonly spinning: boolean
  readonly width: number
}) => {
  const theme = useTheme()
  const now = useNow()
  const spin = useSpinner(spinning)
  const lines = wrap([seg("   "), ...head(now, spin)], width, {
    indent: 4,
    long: "line",
    start: Bun.stringWidth(link),
  })
  return (
    <>
      <box flexDirection="row" height={1} flexShrink={0}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a terminal's text, not the DOM's; Esc is its key */}
        <text
          wrapMode="none"
          height={1}
          {...styled(theme.styles.key)}
          onMouseDown={(event: MouseEvent) => {
            if (event.button !== 0) return
            event.stopPropagation()
            leave()
          }}
        >
          {link}
        </text>
        <Line segments={lines[0] ?? []} />
      </box>
      {lines.length > 1 ? <Lines lines={lines.slice(1)} /> : null}
    </>
  )
}

/** The transcript's items, `width` wide, in a scrollbox that sticks to the bottom. */
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
 * A request's box in the panel, its parts worked out again only when what they show changes: its
 * input is put as JSON and sanitized (tutti-k2n1).
 */
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
  const theme = useTheme()
  const parts = useMemo(
    () => panelParts(request, theme, { width, selected, focus }),
    [request, theme, width, selected, focus],
  )
  return <PanelBox parts={parts} room={room} press={press} />
}

/** The panel's requests, each in its box, `width` wide in a pane `height` tall, and how many more. */
export const RequestPanel = ({
  panel,
  selection,
  width,
  height,
}: {
  readonly panel: Panel
  readonly selection: Selection
  readonly width: number
  readonly height: number
}) => {
  const theme = useTheme()
  const { answering } = panel
  const inputRoom = Math.max(inputLines, Math.floor(height / 4))
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
            room={inputRoom}
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
  const view = useRunView()
  const theme = useTheme()
  const looks = useSyntaxStyles(theme)
  const command = useCommand()
  const handBacks = useHandBacks()
  const filings = useFilings()
  const { width, height } = useTerminalDimensions()
  const found = view.cards.find((each) => each.ticket === viewed)
  // The card last seen, so that the view still shows a worker that has just finished.
  const last = useRef<Card | undefined>(found)
  if (found !== undefined) last.current = found
  // When the view first drew the worker finished: its head's clock stops there.
  const ended = useRef<number | undefined>(undefined)
  if (found !== undefined) ended.current = undefined
  const card = found ?? last.current
  const ticket = card?.ticket
  // While its ticket waits to merge or merges, the run holds your messages (held.ts).
  const holding = found !== undefined && holdsMessages(found.phase)
  const transcript = useTranscriptWindow(
    ticket,
    found?.state != null && !hasSettled(found.state),
    holding,
    found === undefined,
  )
  const { sends } = transcript
  const panel = usePanel(card)
  const handBack = ticket !== undefined && handBacks.includes(ticket)
  const selection = useSelection(transcript, panel, handBack ? [handBackKey] : [])
  const composer = useComposer()
  const input = useInput()

  // Once the worker has finished, its card gone, nothing is sent: what you typed stays, and a toast
  // says why (tutti-ceo).
  const finished = found === undefined
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
  // keeps it until bd has it, and while it isn't filed (tutti-g0wd).
  const filing = useRef<{ readonly uuid: string; readonly text: string } | null>(null)
  const fileAsTicket = () => {
    if (found !== undefined) return
    const text = composer.field.current?.plainText.trim() ?? ""
    if (text === "") return input.toasts.show(fileWords.nothing)
    if (filing.current !== null) return input.toasts.show(fileWords.already)
    const uuid = crypto.randomUUID()
    filing.current = { uuid, text }
    command(UiCommand.FileTicket({ from: viewed, text, uuid }))
    input.toasts.show(fileWords.filing)
  }
  useEffect(() => {
    const asked = filing.current
    const done = asked === null ? undefined : filings.find((each) => each.uuid === asked.uuid)
    if (asked === null || done === undefined) return
    filing.current = null
    if (done.outcome._tag === "NotFiled") {
      input.toasts.show(fileWords.notFiled(done.outcome.why), { failure: true })
      return
    }
    // What you typed since is yours: only the text filed is emptied.
    const box = composer.field.current
    if (box !== null && box.plainText.trim() === asked.text) box.setText("")
    input.toasts.show(fileWords.filed(done.outcome.id, done.outcome.title))
  }, [filings, composer.field, input])
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
  useLayer(
    "box",
    [
      { key: "y", run: () => answerInterrupt(true) },
      { key: "n", run: () => answerInterrupt(false) },
      { key: "escape", run: () => answerInterrupt(false) },
    ],
    "Interrupt",
  )
  // The view draws its Interrupt box and binds its keys: unmounted with it open, nothing would, and the
  // box would hold the keys of the view after it (tutti-por).
  useEffect(
    () => () => {
      if (input.box.get()?._tag === "Interrupt") input.box.set(null)
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
  const help = useTranscriptKeys({
    transcript,
    panel,
    selection,
    composer,
    back: close,
    enter: () => (selection.current() === handBackKey ? handBackNow() : selection.enter()),
    own: [
      { key: "ctrl+x", run: interrupt },
      { key: "ctrl+r", run: release },
      { key: "ctrl+t", run: fileAsTicket },
    ],
  })

  const inner = Math.max(width, 1)
  const rule: Segments = [seg("─".repeat(inner), roleLook(theme, "frame"))]
  const head = (now: number, spin: string): Segments => {
    if (card === undefined) return [seg(`${sanitizeLine(viewed)} has no worker`, theme.styles.dim)]
    // Once its card has gone, the head says finished, its time stopped where the view first saw it
    // gone (tutti-2n7y).
    if (finished) ended.current ??= now
    const shown: Card = finished ? { ...card, motion: "•", steered: false } : card
    const status = finished
      ? seg(finishedWords(viewed).status, theme.styles.done)
      : seg(card.status, statusLook(card, theme))
    return [
      ...headOf(shown, theme, ended.current ?? now, spin, [status]),
      seg("   "),
      seg(sanitizeLine(card.title)),
    ]
  }
  const panelWidth = Math.max(inner - 2, 8)
  const { box } = composer
  return (
    <LooksContext.Provider value={looks}>
      <box flexDirection="column" width={width} height={height}>
        <ViewHead
          link=" ← Dashboard"
          leave={close}
          head={head}
          spinning={!finished && card?.motion === "spinner"}
          width={inner}
        />
        <Line segments={rule} />
        <TranscriptPane transcript={transcript} selection={selection} width={inner} />
        {handBack ? (
          <AttentionLines
            lines={handBackLines(theme, {
              width: panelWidth,
              selected: selection.selected === handBackKey,
            })}
            press={handBackNow}
          />
        ) : null}
        <RequestPanel panel={panel} selection={selection} width={panelWidth} height={height} />
        <Line segments={rule} />
        {holding ? (
          <Line segments={heldLine(theme, viewed, found?.phase._tag === "Merging", inner)} />
        ) : null}
        {finished ? (
          <FinishedLine theme={theme} ticket={viewed} width={inner} file={fileAsTicket} />
        ) : card?.steered === true ? (
          <SteeredLine theme={theme} width={inner} release={release} />
        ) : null}
        {sends.queued.length > 0 ? (
          <QueuedLines lines={queuedLines(sends.queued, theme, inner, sends.mark)} />
        ) : null}
        <Composer
          theme={theme}
          field={composer.field}
          focused={composer.typing}
          focus={() => composer.setComposing(true)}
          send={send}
          {...(finished ? { placeholder: () => finishedWords(viewed).placeholder } : {})}
        />
        <ViewHint
          keys={hintKeys(
            panel.requests.length > 0,
            composer.typing,
            card?.steered === true,
            finished,
          )}
          width={inner}
        />
        {help ? (
          <KeyHelp theme={theme} width={width} height={height} keys={workerViewKeys} />
        ) : null}
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
