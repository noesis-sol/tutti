// The worker view (§ 7.5, § 7.3, § 7.11): tutti's transcript of one worker, drawn by tutti, under
// orchestra-style chrome: `← Dashboard`, then the worker's card head (number, mark, ticket, status,
// elapsed time) and its title, over a rule. Below the transcript, the attention panel shows the
// worker's open requests with the card's buttons and rules (attentionKeys.ts), each with its
// description, its reason and its whole input, and a conflict hand-back waiting for a steered
// worker (§ 4.3) as a notice with Hand it the conflict now. Answer in view, for what a card can't
// hold, opens the answer form over the view (AnswerForm.tsx). Under them and the rule, the composer
// (Composer.tsx): the steered line with its Release button, your messages still queued, the field.
//
// The items (transcriptItems.ts): assistant text as Markdown (<markdown>, in the theme's heading,
// code and link roles); each tool call one line, `Tool  summary`, its result at the end of it (`✓`,
// an error's first line, `+N −M`); Enter or a click expands one: an edit's diff (<diff>), a
// command's output (<code>), a read's range, an Agent call's subagent work behind a faint `│`.
// Thinking is hidden. While the view is open, its transcript's open flag is set, and partial text
// shows as it streams.
//
// Bounded rendering: the window of the transcript mounted is at most the last 200 items, sticking
// to the bottom while you're there; scrolling past the top (the wheel, PgUp, `g`) loads 200 older
// from the file, letting the newest beyond 600 go, and keeps your place. Collapsed items are one
// line tall, a fixed height (#1514).
//
// The keys, in the view's layer: `Tab`, `Shift+Tab` and the arrows move between the items and the
// panel's requests, and between a request's buttons; `Enter` expands or collapses the selected item
// or presses the focused button; `1`–`9` switch workers (or pick a question's option); `d`,
// `Shift+D`, `a` and `r` answer the selected request, or the oldest; PgUp/PgDn and `g`/`G` scroll;
// `i` or a click focuses the composer; `Ctrl+X` asks, then interrupts the worker's turn; `Ctrl+R`
// releases a steered worker; `Esc` leaves the composer, then goes back to the dashboard, as a click
// on `← Dashboard` does. While you write in the composer, it takes the printable keys, Enter and
// the arrows; PgUp/PgDn, Ctrl+X, Ctrl+R and Esc still work.
//
// Branding (§ 7.5): tutti's own glyphs and layout, and the scheme's colours; the chrome names
// neither Claude nor its product.
import {
  type MouseEvent,
  RGBA,
  type ScrollBoxRenderable,
  SyntaxStyle,
  type TextareaRenderable,
} from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/react"
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { AttentionRequest } from "../agent/Attention.ts"
import { settled as hasSettled } from "../agent/WorkerState.ts"
import { UiCommand } from "../run/commands.ts"
import type { Card } from "../run/runView.ts"
import { AttentionLines, answerBindings, type ButtonSegment } from "./AttentionCard.tsx"
import { buttonsOf, optionKeys, picksOptions, requestText, useAnswering } from "./attentionKeys.ts"
import { headOf, statusLook } from "./Card.tsx"
import {
  Composer,
  InterruptQuestion,
  QueuedLines,
  queuedLines,
  SteeredLine,
  useSends,
} from "./Composer.tsx"
import { Hint, hintSegments } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { Box, type KeyBinding, useInput, useLayer } from "./keys.ts"
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
} from "./line.tsx"
import { sanitize, sanitizeLine } from "./sanitize.ts"
import type { Role, Theme } from "./theme.ts"
import {
  bounded,
  type Entry,
  emptyTranscript,
  entriesOf,
  expansionOf,
  type Mark,
  markOf,
  mounted,
  type OpenTranscript,
  type ToolEntry,
  type TranscriptState,
} from "./transcriptItems.ts"
import {
  external,
  useCommand,
  useHandBacks,
  useNow,
  useRunView,
  useSpinner,
  useTheme,
  useTranscripts,
} from "./useRunView.ts"

/** The most lines of a command's output an expanded item shows. */
export const outputLines = 400

/** The fewest lines a request's input scrolls in; it gets a quarter of the pane when that's more. */
export const inputLines = 3

/** The most requests the panel shows whole; the rest are counted under them. */
export const panelRequests = 2

/** The id of an entry's renderable in the scrollbox, to find it by. */
export const entryId = (key: string): string => `entry-${key}`

/** The selection key of a request in the panel, and of the hand-back notice. */
const requestKey = (request: AttentionRequest): string => `request:${request.id}`
const handBackKey = "handback"

/** The Markdown and code styles, from the theme's roles (§ 7.11 "Markdown"). */
interface Looks {
  readonly theme: Theme
  readonly markdown: SyntaxStyle
  /** A command's output, faint; and an error's, `needsYou`. */
  readonly output: SyntaxStyle
  readonly error: SyntaxStyle
}

const LooksContext = createContext<Looks | null>(null)

const useLooks = (): Looks => {
  const looks = useContext(LooksContext)
  if (looks === null) throw new Error("a transcript item is drawn outside its worker view")
  return looks
}

/** The syntax styles of `theme`, made in the renderer's native scene and freed with it. */
const useSyntaxStyles = (theme: Theme): Looks => {
  const renderer = useRenderer()
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
      output: make({ default: { ...plain, dim: true } }),
      error: make({ default: role("needsYou") }),
    }
  }, [renderer, theme])
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

/** A tool call's line, `width` wide: `▸ Bash  scripts/check-fast.sh` and its mark at the end. */
export const toolLine = (
  tool: ToolEntry,
  theme: Theme,
  width: number,
  selected: boolean,
): Segments => {
  const head: Segments = [
    ...gutter(selected, theme),
    seg(tool.name, theme.styles.key),
    ...(tool.summary === "" ? [] : [seg("  "), seg(tool.summary)]),
    ...(tool.live ? [seg("  …", theme.styles.dim)] : []),
  ]
  const mark = markSegments(markOf(tool), theme, Math.floor(width / 2))
  if (mark.length === 0) return cut(head, width)
  const room = Math.max(width - widthOf(mark) - 2, 0)
  return [...padded(cut(head, room), room), seg("  "), ...mark]
}

/** A message sent to the worker, on one line: `› Carry on with the ticket …`. */
const promptLine = (text: string, theme: Theme, width: number, selected: boolean): Segments => {
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  const first = sanitizeLine(lines[0] ?? "")
  return cut(
    [
      ...gutter(selected, theme),
      seg("› ", theme.styles.dim),
      seg(first),
      ...(lines.length > 1 ? [seg(" …", theme.styles.dim)] : []),
    ],
    width,
  )
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

/** A one-line, fixed-height row that a click selects and expands. */
const ClickLine = ({
  segments,
  onClick,
}: {
  readonly segments: Segments
  readonly onClick: () => void
}) => (
  // biome-ignore lint/a11y/noStaticElementInteractions: a terminal box, not the DOM's; Enter is its key
  <box
    height={1}
    flexShrink={0}
    onMouseDown={(event: MouseEvent) => {
      if (event.button !== 0) return
      event.stopPropagation()
      onClick()
    }}
  >
    <Line segments={segments} />
  </box>
)

/** Entries one under the other, `width` wide. */
const EntryList = ({
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
          <markdown
            content={entry.text}
            syntaxStyle={looks.markdown}
            conceal
            streaming={entry.live}
          />
        </box>
      )
    case "Prompt":
      return (
        <box id={entryId(entry.key)} flexDirection="column" flexShrink={0}>
          <ClickLine
            segments={promptLine(entry.text, theme, width, isSelected)}
            onClick={() => click(entry.key)}
          />
          {open ? (
            <box paddingLeft={4} flexShrink={0}>
              <text wrapMode="word" {...styled(theme.styles.dim)}>
                {sanitize(entry.text)}
              </text>
            </box>
          ) : null}
        </box>
      )
    case "Nested":
      return (
        <box id={entryId(entry.key)} flexDirection="column" flexShrink={0}>
          <ClickLine
            segments={cut(
              [
                ...gutter(isSelected, theme),
                seg("Agent", theme.styles.key),
                seg("  "),
                seg("subagent work of an earlier call", theme.styles.dim),
              ],
              width,
            )}
            onClick={() => click(entry.key)}
          />
          {open ? <Children entries={entry.children} {...props} /> : null}
        </box>
      )
    case "Tool":
      return (
        <box id={entryId(entry.key)} flexDirection="column" flexShrink={0}>
          <ClickLine
            segments={toolLine(entry, theme, width, isSelected)}
            onClick={() => click(entry.key)}
          />
          {open ? <Expanded tool={entry} {...props} /> : null}
        </box>
      )
  }
})

/** Whether the selection can rest on `entry`: one that expands. */
const selectable = (entry: Entry): boolean => entry._tag !== "Text"

/** A request's input, as the panel shows it whole (§ 7.5): its JSON, its questions, its form. */
export const inputOf = (request: AttentionRequest): ReadonlyArray<string> => {
  const kind = request.kind
  const lines = (text: string) => sanitize(text).split("\n")
  switch (kind._tag) {
    case "Permission":
      return lines(JSON.stringify(kind.input, null, 2) ?? "")
    case "Question":
      return kind.questions.flatMap((question) => [
        ...lines(question.question),
        ...question.options.map(
          (option, i) =>
            `  ${i + 1} ${sanitizeLine(option.label)}${option.description ? ` — ${sanitizeLine(option.description)}` : ""}`,
        ),
      ])
    case "Elicitation": {
      const fields = Object.keys(
        (kind.requestedSchema?.properties as Record<string, unknown> | undefined) ?? {},
      )
      return [
        ...lines(kind.message),
        ...(fields.length === 0 ? [] : [`fields: ${fields.map(sanitizeLine).join(", ")}`]),
      ]
    }
  }
}

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
  const faint = (line: string): Segments => [seg(line, styles.dim)]
  const description =
    request.description === undefined || text.line.includes(sanitizeLine(request.description))
      ? []
      : sanitize(request.description).split("\n")
  const reason =
    request.decisionReason === undefined ? [] : sanitize(request.decisionReason).split("\n")
  const input = inputOf(request)
  const button = (label: string, index: number): ButtonSegment => ({
    text: `[ ${label} ]`,
    look: index === options.focus ? theme.form.focusedButton : theme.form.button,
    button: index,
  })
  const buttons = buttonsOf(request).map((each, i) => button(each.label, i))
  const rows: ReadonlyArray<Segments> = picksOptions(request)
    ? buttons.map((each) => [each])
    : [buttons.flatMap((each, i) => (i === 0 ? [each] : [seg("  "), each]))]
  const above = [[seg(text.line)], ...description.map(faint), ...reason.map(faint), ...rows]
  const lines = boxed(
    [...above, ...input.map(faint)],
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
const PanelBox = ({
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

/** The worker view's hint: the keys there are; the composer's while you write in it. */
const hintKeys = (requests: boolean, composing: boolean, steered: boolean) => {
  const steering = [
    { keys: "Ctrl+X", does: "interrupt" },
    ...(steered ? [{ keys: "Ctrl+R", does: "release" }] : []),
  ]
  return composing
    ? [
        { keys: "Enter", does: "send" },
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
        { keys: "1–9", does: "workers" },
      ]
}

/** The worker view's keys, for its key help (§ 7.3's table). */
export const workerViewKeys: ReadonlyArray<readonly [string, string]> = [
  ["Tab, Shift+Tab, arrows", "move between items; between a request's buttons"],
  ["Enter, a click", "expand or collapse the item; press the focused button"],
  ["1–9", "switch to that worker"],
  [
    "i, a click on the composer",
    "write to the worker; Enter sends, Alt+Enter or Ctrl+J a new line",
  ],
  ["Esc, ← Dashboard", "leave the composer; back to the dashboard"],
  ["Ctrl+X", "interrupt the worker's turn (asks first)"],
  ["Ctrl+R, Release", "release a steered worker"],
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

/** The store a view without a transcript reads. */
const noTranscript = external<TranscriptState>(emptyTranscript)

/** The view of worker `worker`, while the run shows it. */
export const WorkerView = ({ worker }: { readonly worker: number }) => {
  const view = useRunView()
  const theme = useTheme()
  const looks = useSyntaxStyles(theme)
  const renderer = useRenderer()
  const now = useNow()
  const command = useCommand()
  const feed = useTranscripts()
  const handBacks = useHandBacks()
  const { width, height } = useTerminalDimensions()
  const found = view.cards.find((each) => each.worker === worker)
  // The card last seen, so that the view still shows a worker that has just finished.
  const last = useRef<Card | undefined>(found)
  if (found !== undefined) last.current = found
  const card = found ?? last.current
  const ticket = card?.ticket
  const spin = useSpinner(card?.motion === "spinner")

  // The transcript, open while the view shows this ticket.
  const [transcript, setTranscript] = useState<OpenTranscript | null>(null)
  useEffect(() => {
    if (feed === undefined || ticket === undefined) return
    const opened = feed.open(ticket)
    setTranscript(opened)
    return () => {
      opened.close()
      setTranscript(null)
    }
  }, [feed, ticket])
  const store = transcript?.state ?? noTranscript
  const state = useSyncExternalStore(store.subscribe, store.get)
  const window = state.window
  const entries = useMemo(() => entriesOf(window.items, state.live), [window.items, state.live])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const shown = bounded(entries, expanded, window.following)
  const flat = mounted(shown, expanded)

  // The panel: the worker's oldest open requests, each as a card of its own for the card's
  // answering. Only those drawn can be selected or answered; the rest are counted under them, and
  // each comes in as one before it is answered.
  const waiting = card === undefined ? [] : view.requests.filter((r) => r.ticket === card.ticket)
  const requests = waiting.slice(0, panelRequests)
  const more = waiting.length - requests.length
  const requestCards: ReadonlyArray<Card> =
    card === undefined ? [] : requests.map((request) => ({ ...card, requests: [request] }))
  const input = useInput()
  const answering = useAnswering(requestCards, undefined, (request) =>
    input.box.set(Box.Form({ requestId: request.id, ticket: request.ticket })),
  )
  const handBack = ticket !== undefined && handBacks.includes(ticket)

  // The composer: you write in it while it is chosen and no box is open over the view. It takes
  // the focus, or gives it up, as the key is pressed, so that the keys after it go where it says.
  // Your messages sent while a turn is under way are queued until the transcript says they were
  // taken.
  const box = useSyncExternalStore(input.box.subscribe, input.box.get)
  const field = useRef<TextareaRenderable>(null)
  const composingNow = useRef(false)
  const [composing, setComposingState] = useState(false)
  const setComposing = (on: boolean) => {
    composingNow.current = on
    setComposingState(on)
    if (!on) field.current?.blur()
    else if (input.box.get() === null) field.current?.focus()
  }
  const typing = composing && box === null
  const underWay = found?.state != null && !hasSettled(found.state)
  const sends = useSends(ticket, window.latest, underWay)
  const send = (text: string) => {
    if (found === undefined) return
    const uuid = crypto.randomUUID()
    sends.sent({ uuid, ticket: found.ticket, text })
    command(UiCommand.SendMessage({ ticket: found.ticket, text, uuid }))
  }
  // Ctrl+X asks first; `y` interrupts the turn the question names, and its queued messages go.
  const interrupt = () => {
    if (found === undefined) return
    field.current?.blur()
    input.box.set(Box.Interrupt({ ticket: found.ticket }))
  }
  const answerInterrupt = (yes: boolean) => {
    const asked = input.box.get()
    if (asked?._tag !== "Interrupt") return
    input.box.set(null)
    if (composingNow.current) field.current?.focus()
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
  const release = () => {
    if (found?.steered === true) command(UiCommand.Release({ ticket: found.ticket }))
  }

  // The selection names an entry, a request or the hand-back; with none chosen, the oldest request
  // is the target. Kept in a ref, so that keys arriving together each see the one before them.
  const chosen = useRef<string | null>(null)
  const [, redraw] = useState(0)
  const selectables = [
    ...flat.filter(selectable).map((entry) => entry.key),
    ...(handBack ? [handBackKey] : []),
    ...requests.map(requestKey),
  ]
  const current = (): string | null => {
    if (chosen.current !== null && selectables.includes(chosen.current)) return chosen.current
    const oldest = requests[0]
    return oldest !== undefined ? requestKey(oldest) : null
  }
  const selected = current()
  const scroll = useRef<ScrollBoxRenderable>(null)
  const choose = (key: string | null) => {
    chosen.current = key
    redraw((n) => n + 1)
    if (key !== null && !key.startsWith("request:") && key !== handBackKey) {
      scroll.current?.scrollChildIntoView(entryId(key))
    }
  }
  const toggle = (key: string) =>
    setExpanded((open) => {
      const next = new Set(open)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const click = (key: string) => {
    choose(key)
    toggle(key)
  }
  const selectedCard = (): Card | undefined => {
    const key = current()
    return requestCards.find((each) => each.requests[0] && requestKey(each.requests[0]) === key)
  }

  // Scrolling: past the top loads older items, keeping your place; the bottom follows the worker.
  const anchor = useRef<string | null>(null)
  const atTop = () => (scroll.current?.scrollTop ?? 0) <= 0
  const atEnd = () => {
    const box = scroll.current
    return box === null || box.scrollTop >= box.scrollHeight - box.viewport.height - 1
  }
  const older = () => {
    if (transcript === null || state.loading || window.start) return
    anchor.current = shown[0]?.key ?? null
    transcript.older()
  }
  const settled = () => {
    if (transcript === null) return
    if (atEnd()) transcript.follow()
    else transcript.scrolledBack()
  }
  const firstSeq = window.items[0]?.seq
  // biome-ignore lint/correctness/useExhaustiveDependencies: the place is kept once the older items are in
  useEffect(() => {
    const key = anchor.current
    if (key === null) return
    anchor.current = null
    let tries = 0
    const keep = () => {
      const box = scroll.current
      if (box === null || box.isDestroyed) return
      const child = box.content.getChildren().find((each) => each.id === entryId(key))
      const offset = child === undefined ? 0 : child.y - box.content.y
      if (offset > 0) box.scrollTop = offset
      else if (tries++ < 10) renderer.requestAnimationFrame(keep)
    }
    renderer.requestAnimationFrame(keep)
  }, [firstSeq])
  const page = (step: 1 | -1) => {
    const box = scroll.current
    if (box === null) return
    if (step === -1 && atTop()) older()
    box.scrollBy(step * Math.max(box.viewport.height - 1, 1))
    settled()
  }

  const move = (step: 1 | -1) => {
    if (selectables.length === 0) return
    // From none, the newest item: you're at the bottom.
    const at = selectables.indexOf(current() ?? "")
    const next =
      at === -1 ? selectables.length - 1 : Math.min(Math.max(at + step, 0), selectables.length - 1)
    answering.reset()
    choose(selectables[next] ?? null)
  }
  const stepOrMove = (step: 1 | -1) => {
    const target = selectedCard()
    if (target !== undefined && answering.step(target, step)) return
    move(step)
  }
  const handBackNow = () => {
    if (ticket !== undefined) command(UiCommand.HandBackNow({ ticket }))
  }
  const enter = () => {
    const key = current()
    if (key === null) return
    if (key === handBackKey) return handBackNow()
    const target = selectedCard()
    if (target !== undefined) {
      answering.pressFocused(target)
      return
    }
    toggle(key)
  }
  const number = (n: number) => () => {
    const target = selectedCard()
    if (target !== undefined && n <= optionKeys && answering.pick(target, n)) return
    if (n !== worker && view.cards.some((each) => each.worker === n)) {
      command(UiCommand.OpenWorker({ worker: n }))
    }
  }
  const targetCard = () => selectedCard() ?? requestCards[0]
  const close = () => command(UiCommand.CloseWorker())
  // With the key help open, `?` and `Esc` close it and the other keys do nothing.
  const [help, setHelp] = useState(false)
  const helpOpen = useRef(false)
  const showHelp = (shown: boolean) => {
    helpOpen.current = shown
    setHelp(shown)
  }
  // While you write, the composer takes the printable keys, Enter, Tab and the arrows (keys.ts).
  const keys: ReadonlyArray<KeyBinding> = [
    { key: "pageup", run: () => page(-1) },
    { key: "pagedown", run: () => page(1) },
    { key: "ctrl+x", run: interrupt },
    { key: "ctrl+r", run: release },
    { key: "i", run: () => setComposing(true) },
    { key: "down", run: () => move(1) },
    { key: "up", run: () => move(-1) },
    ...["tab", "right"].map((key) => ({ key, run: () => stepOrMove(1) })),
    ...["shift+tab", "left"].map((key) => ({ key, run: () => stepOrMove(-1) })),
    ...["return", "enter"].map((key) => ({ key, run: enter })),
    ...answerBindings(answering, targetCard),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ key: String(n), run: number(n) })),
    {
      key: "g",
      run: () => {
        if (atTop()) older()
        scroll.current?.scrollTo(0)
        settled()
      },
    },
    {
      key: "shift+g",
      run: () => {
        transcript?.follow()
        const box = scroll.current
        box?.scrollTo(box.scrollHeight)
      },
    },
  ]
  useLayer("view", [
    { key: "?", run: () => showHelp(!helpOpen.current) },
    {
      key: "escape",
      run: () =>
        helpOpen.current ? showHelp(false) : composingNow.current ? setComposing(false) : close(),
    },
    ...keys.map((binding) => ({
      key: binding.key,
      run: () => (helpOpen.current ? undefined : binding.run()),
    })),
  ])

  const inner = Math.max(width, 1)
  const rule: Segments = [seg("─".repeat(inner), roleLook(theme, "frame"))]
  const head: Segments =
    card === undefined
      ? [seg(`no worker ${worker}`, theme.styles.dim)]
      : [
          ...headOf(card, theme, now, spin, [seg(card.status, statusLook(card, theme))]),
          seg("   "),
          seg(sanitizeLine(card.title)),
        ]
  const dashboardLink = " ← Dashboard"
  const panelWidth = Math.max(inner - 2, 8)
  const inputRoom = Math.max(inputLines, Math.floor(height / 4))
  return (
    <LooksContext.Provider value={looks}>
      <box flexDirection="column" width={width} height={height}>
        <box flexDirection="row" height={1} flexShrink={0}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a terminal's text, not the DOM's; Esc is its key */}
          <text
            wrapMode="none"
            height={1}
            {...styled(theme.styles.key)}
            onMouseDown={(event: MouseEvent) => {
              if (event.button !== 0) return
              event.stopPropagation()
              close()
            }}
          >
            {dashboardLink}
          </text>
          <Line segments={cut([seg("   "), ...head], Math.max(inner - dashboardLink.length, 0))} />
        </box>
        <Line segments={rule} />
        <scrollbox
          ref={scroll}
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          scrollbarOptions={{ visible: false }}
          onMouseScroll={(event: MouseEvent) => {
            if (event.scroll?.direction === "up" && atTop()) older()
            queueMicrotask(settled)
          }}
        >
          {state.loading ? (
            <box height={1} flexShrink={0}>
              <Line segments={[seg("  loading earlier items…", theme.styles.dim)]} />
            </box>
          ) : null}
          <EntryList
            entries={shown}
            width={inner}
            selected={selected}
            expanded={expanded}
            click={click}
          />
        </scrollbox>
        {handBack ? (
          <AttentionLines
            lines={handBackLines(theme, { width: panelWidth, selected: selected === handBackKey })}
            press={handBackNow}
          />
        ) : null}
        {requests.map((request, i) => {
          const at = requestCards[i]
          return at === undefined ? null : (
            <PanelBox
              key={request.id}
              parts={panelParts(request, theme, {
                width: panelWidth,
                selected: selected === requestKey(request),
                focus: answering.focusOf(at),
              })}
              room={inputRoom}
              press={(index) => answering.press(at, index)}
            />
          )
        })}
        {more > 0 ? <Line segments={[seg(`  +${more} more requests`, theme.styles.dim)]} /> : null}
        <Line segments={rule} />
        {card?.steered === true ? (
          <SteeredLine theme={theme} width={inner} release={release} />
        ) : null}
        {sends.queued.length > 0 ? (
          <QueuedLines lines={queuedLines(sends.queued, theme, inner)} />
        ) : null}
        <Composer
          theme={theme}
          field={field}
          focused={typing}
          focus={() => setComposing(true)}
          send={send}
        />
        <Hint
          segments={hintSegments(
            hintKeys(requests.length > 0, typing, card?.steered === true),
            theme,
            inner,
          )}
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
