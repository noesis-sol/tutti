// The transcript's items (§ 7.5, § 7.11; transcriptItems.ts), as a worker view and the Interview
// view draw them: assistant text as Markdown (<markdown>, in the theme's heading, code and link
// roles); each tool call `Tool  summary`, wrapped, its result at the end of it (`✓`, an error's
// first line, `+N −M`); a message sent to the worker wrapped, `› ` before it. Enter or a click
// expands one: an edit's diff (<diff>), a command's output (<code>), a read's range, an Agent call's
// subagent work behind a faint `│`, a message's lines past the first `itemLines`. Collapsed items
// are a fixed height, their lines wrapped beforehand to the pane's width, at most `itemLines`
// (#1514). Each takes plain props: the view's state is transcriptView.ts's.
import { RGBA } from "@opentui/core"
import { memo, type ReactNode } from "react"
import { clickable } from "../click.ts"
import { cut, Line, padded, type Segments, seg, widthOf, wrap } from "../line.tsx"
import { marks } from "../marks.ts"
import { sanitize } from "../sanitize.ts"
import type { Role, Theme } from "../theme.ts"
import {
  type Entry,
  expansionOf,
  type Mark,
  markOf,
  nests,
  type ToolEntry,
} from "../transcriptItems.ts"
import { entryId, type Selection, type TranscriptWindow } from "../transcriptView.ts"
import { useTheme } from "../useRunView.ts"
import { useLooks } from "./Looks.tsx"

/** The most lines of a command's output an expanded item shows. */
export const outputLines = 400
/** A collapsed tool call's mark, at the end of its line (§ 7.11's worker view). */
const markSegments = (mark: Mark, theme: Theme, room: number): Segments => {
  switch (mark._tag) {
    case "Pending":
      return []
    case "Done":
      return [seg(marks.done, theme.look("done"))]
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
  seg(selected ? `${marks.selected} ` : "  ", theme.styles.key),
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
  return wrap(
    [...gutter(selected, theme), seg(`${marks.said} `, theme.styles.dim), seg(body)],
    width,
    {
      indent: 4,
      limit,
    },
  )
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
