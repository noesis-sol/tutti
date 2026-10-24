// The composer (§ 7.5, § 7.3, § 4.3, § 7.11), under a worker view's transcript: your messages to
// the worker, and the steering keys beside it.
//
// `i` or a click focuses it; Enter sends what you typed as a SendMessage command, Alt+Enter or
// Ctrl+J start a new line (Ctrl+J for terminals whose legacy encoding can't tell Alt+Enter from
// Enter, § 7.7), and Esc leaves it. The composer draws the uuid each message is sent with: a
// message sent while a turn is under way is shown `queued` until the transcript says the CLI took
// it (`started`, `completed` or `cancelled` in its `command_lifecycle`, or a `result` listing it),
// or the worker settles. Ctrl+X asks, then sends Interrupt, which cancels the messages still
// queued, so their marks go; Ctrl+R, or the Release button on the steered line, sends Release.
// Once the worker has finished, its card gone, the composer says so and sends nothing: Enter keeps
// what you typed, and a toast says it wasn't sent (tutti-ceo). Ctrl+T, or the File as ticket button
// on the finished line, files what you typed as a new ticket instead, and empties the composer once
// bd has it (tutti-g0wd, run/fileTicket.ts). While its ticket waits to merge or
// merges, the run holds your messages until the merge is over (held.ts): the held line says so over
// the composer, and each message is shown `held` till it is sent, or `not sent` once the worker has
// finished with it still held.
//
// The prompt (`>`) is drawn `formAccent`, the cursor `formSelected`, the placeholder
// `formPlaceholder`, the text `formText`.
import { type BoxRenderable, TextAttributes, type TextareaRenderable } from "@opentui/core"
import { Predicate } from "effect"
import { type RefObject, useEffect, useMemo, useRef, useState } from "react"
import type { Item } from "../agent/Transcripts.ts"
import { AttentionLines, type ButtonSegment } from "./AttentionCard.tsx"
import { cut, Line, padded, type Segments, seg, widthOf } from "./line.tsx"
import { Modal } from "./Modal.tsx"
import { descriptionKeys } from "./StartQuestion.tsx"
import { sanitizeLine } from "./sanitize.ts"
import type { Theme } from "./theme.ts"

/** The most lines the composer grows to; longer messages scroll inside it. */
export const composerLines = 6

/** The most queued messages shown one a line; the rest are counted under them. */
export const queuedShown = 3

/** The composer's placeholder, unfocused and focused. */
export const composerPlaceholder = (focused: boolean): string =>
  focused ? "your message to the worker" : "i to write to the worker"

/** What the composer and head say once `ticket`'s worker has finished; what Enter toasts then. */
export const finishedWords = (ticket: string) => ({
  finished: `${sanitizeLine(ticket)}'s worker has finished`,
  line: ": tutti can't send it messages",
  placeholder: "the worker has finished",
  status: "finished",
  toast: `${sanitizeLine(ticket)}'s worker has finished: your message wasn't sent`,
})

/** What filing the composer's text as a ticket says: its button, and its toasts (tutti-g0wd). */
export const fileWords = {
  button: "[ File as ticket ]",
  nothing: "nothing to file: write the ticket in the composer first",
  filing: "filing it as a ticket…",
  already: "still filing the last one as a ticket",
  filed: (id: string, title: string) => `filed ${sanitizeLine(id)}: ${sanitizeLine(title)}`,
  notFiled: (why: string) => `couldn't file it as a ticket: ${sanitizeLine(why)}`,
}

/**
 * The finished line, `width` wide, over the composer of a worker that has finished: what it means,
 * and the File as ticket button, which files what you typed as a new ticket (tutti-g0wd).
 */
export const finishedLine = (theme: Theme, ticket: string, width: number): Segments => {
  const words = finishedWords(ticket)
  // Its key, Ctrl+T, is the hint's: beside the button, it would cut the words in 80 columns.
  const button: ButtonSegment = { text: fileWords.button, look: theme.form.button, button: 0 }
  const room = Math.max(width - widthOf([button]) - 2, 0)
  const said: Segments = [
    seg("  "),
    seg(words.finished, theme.styles.key),
    seg(words.line, theme.styles.dim),
  ]
  return [...padded(cut(said, room), room), seg("  "), button]
}

/** The finished line, its File as ticket button pressed by a click. */
export const FinishedLine = ({
  theme,
  ticket,
  width,
  file,
}: {
  readonly theme: Theme
  readonly ticket: string
  readonly width: number
  readonly file: () => void
}) => <AttentionLines lines={[finishedLine(theme, ticket, width)]} press={file} />

/** What the held line says while `ticket` waits to merge (`merging` false) or merges. */
export const heldWords = (ticket: string, merging: boolean) => ({
  phase: `${sanitizeLine(ticket)} ${merging ? "is merging" : "waits to merge"}`,
  line: ": tutti holds your messages until its merge is over",
})

/** The held line, `width` wide, over the composer of a ticket waiting to merge or merging. */
export const heldLine = (
  theme: Theme,
  ticket: string,
  merging: boolean,
  width: number,
): Segments => {
  const words = heldWords(ticket, merging)
  return cut(
    [seg("  "), seg(words.phase, theme.styles.key), seg(words.line, theme.styles.dim)],
    width,
  )
}

/** A message you sent from the composer, by the uuid it was sent with. */
export interface Send {
  readonly uuid: string
  readonly ticket: string
  readonly text: string
  /** Sent while its ticket waited to merge or merged: the run holds it till the merge is over. */
  readonly held?: boolean
}

// A value of an SDK message whose shape this tutti may not know, read without trusting it.
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isObject(value) ? value : undefined

/** The lifecycle states that say the CLI has taken a send, or dropped it. */
const takenStates = new Set(["started", "completed", "cancelled"])

/**
 * The sends, by uuid, that `items` say the CLI has taken or dropped: `started`, `completed` or
 * `cancelled` in a `command_lifecycle`, or listed in a `result`'s `user_message_uuids` (§ 4.1).
 */
export const takenIn = (items: ReadonlyArray<Item>): ReadonlySet<string> => {
  const taken = new Set<string>()
  for (const item of items) {
    const m = asRecord(item.message)
    if (m === undefined) continue
    if (m.type === "command_lifecycle") {
      if (typeof m.command_uuid === "string" && takenStates.has(String(m.state))) {
        taken.add(m.command_uuid)
      }
    } else if (m.type === "result" && Array.isArray(m.user_message_uuids)) {
      for (const uuid of m.user_message_uuids) if (typeof uuid === "string") taken.add(uuid)
    }
  }
  return taken
}

/** Your messages to a worker, and which of them are still queued. */
export interface Sends {
  /**
   * The ticket's messages sent while a turn was under way that the CLI hasn't taken, and those
   * held while its ticket merges, oldest first.
   */
  readonly queued: ReadonlyArray<Send>
  /** The mark a message in `queued` has: `queued`, `held`, or `not sent`. */
  readonly mark: (send: Send) => string
  /** Records a message sent with `uuid`: queued when a turn is under way. */
  readonly sent: (send: Send) => void
  /** Forgets the queued messages to `ticket`'s worker: an interrupt cancelled them. */
  readonly cancelled: (ticket: string) => void
}

/**
 * The messages you sent to the ticket's worker that are still queued, from its transcript's latest
 * `items`, while a turn is `underWay`. Those the transcript says were taken are let go, and all of
 * them once the worker settles. Those sent while its ticket is `holding` them, waiting to merge or
 * merging, are kept while it is, and once the worker has `finished` with them still held.
 */
export const useSends = (
  ticket: string | undefined,
  items: ReadonlyArray<Item>,
  underWay: boolean,
  holding = false,
  finished = false,
): Sends => {
  const [sends, setSends] = useState<ReadonlyArray<Send>>([])
  const taken = useMemo(() => takenIn(items), [items])
  const waiting = (send: Send) =>
    send.ticket !== ticket ||
    (!taken.has(send.uuid) && (underWay || holding || (send.held === true && finished)))
  const queued = sends.filter((send) => send.ticket === ticket && waiting(send))
  // biome-ignore lint/correctness/useExhaustiveDependencies: waiting reads ticket, taken, underWay, holding and finished
  useEffect(() => {
    if (!sends.every(waiting)) setSends((now) => now.filter(waiting))
  }, [sends, ticket, taken, underWay, holding, finished])
  return {
    queued,
    mark: (send) => (holding ? "held" : send.held === true && finished ? "not sent" : "queued"),
    sent: (send) => {
      if (holding) setSends((now) => [...now, { ...send, held: true }])
      else if (underWay) setSends((now) => [...now, send])
    },
    cancelled: (worker) => setSends((now) => now.filter((send) => send.ticket !== worker)),
  }
}

/** A queued message's line, `width` wide: `› Please add tests too …  queued` (or `held`, …). */
export const queuedLine = (send: Send, theme: Theme, width: number, word = "queued"): Segments => {
  const lines = send.text.split("\n").filter((line) => line.trim() !== "")
  const mark: Segments = [seg(word, theme.styles.dim)]
  const room = Math.max(width - widthOf(mark) - 2, 0)
  const head: Segments = [
    seg("  "),
    seg("› ", theme.styles.dim),
    seg(sanitizeLine(lines[0] ?? "")),
    ...(lines.length > 1 ? [seg(" …", theme.styles.dim)] : []),
  ]
  return [...padded(cut(head, room), room), seg("  "), ...mark]
}

/** The queued messages' lines, at most `queuedShown`, and a count of the rest, each `mark`ed. */
export const queuedLines = (
  queued: ReadonlyArray<Send>,
  theme: Theme,
  width: number,
  mark: (send: Send) => string = () => "queued",
): ReadonlyArray<Segments> => {
  const more = queued.length - queuedShown
  const rest = queued[queuedShown]
  return [
    ...queued.slice(0, queuedShown).map((send) => queuedLine(send, theme, width, mark(send))),
    ...(rest !== undefined
      ? [cut([seg(`  +${more} more ${mark(rest)}`, theme.styles.dim)], width)]
      : []),
  ]
}

/** The steered line, `width` wide: what steering means, and the Release button (§ 4.3). */
export const steeredLine = (theme: Theme, width: number): Segments => {
  const button: ButtonSegment = { text: "[ Release ]", look: theme.form.button, button: 0 }
  const keys: Segments = [seg("  "), seg("Ctrl+R", theme.styles.key)]
  const room = Math.max(width - widthOf([button, ...keys]) - 2, 0)
  const words: Segments = [
    seg("  "),
    seg("steered", theme.styles.key),
    seg(": tutti sends it nothing until you release it", theme.styles.dim),
  ]
  return [...padded(cut(words, room), room), seg("  "), button, ...keys]
}

/** The steered line, its Release button pressed by a click. */
export const SteeredLine = ({
  theme,
  width,
  release,
}: {
  readonly theme: Theme
  readonly width: number
  readonly release: () => void
}) => <AttentionLines lines={[steeredLine(theme, width)]} press={release} />

/** The queued messages, one a line. */
export const QueuedLines = ({ lines }: { readonly lines: ReadonlyArray<Segments> }) => (
  <box flexDirection="column" height={lines.length} flexShrink={0}>
    {lines.map((segments, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the lines are drawn anew in order
      <Line key={i} segments={segments} />
    ))}
  </box>
)

/** The composer: the prompt and the field, `focused` while you write in it. */
export const Composer = ({
  theme,
  field,
  lines,
  setLines,
  focused,
  focus,
  send,
  placeholder = composerPlaceholder,
}: {
  readonly theme: Theme
  /** The field, which the view focuses and blurs as keys come. */
  readonly field: RefObject<TextareaRenderable | null>
  /**
   * Its height, as many lines as what you typed takes at the field's width, `composerLines` at
   * most; the view's to keep.
   */
  readonly lines: number
  readonly setLines: (lines: number) => void
  readonly focused: boolean
  /** Focuses it, as a click does. */
  readonly focus: () => void
  /**
   * Sends a message: what you typed, without the blank lines and spaces around it. The field is
   * emptied only when it returns true; false keeps what you typed, as nothing was sent.
   */
  readonly send: (text: string) => boolean
  /** Its placeholder, unfocused and focused: the worker view's when left out. */
  readonly placeholder?: (focused: boolean) => string
}) => {
  const { form } = theme
  // The row's width the field was last fitted to.
  const width = useRef(0)
  // The field's wrapped lines, all of them: its virtualLineCount counts only those it shows.
  const fit = () => {
    const box = field.current
    const count =
      box === null ? 1 : Math.max(box.lineCount, box.editorView.getTotalVirtualLineCount())
    const next = Math.min(Math.max(count, 1), composerLines)
    if (next !== lines) setLines(next)
  }
  const submit = () => {
    const box = field.current
    if (box === null) return
    const text = box.plainText.trim()
    if (text === "" || !send(text)) return
    box.setText("")
    fit()
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a terminal box, not the DOM's; `i` is its key
    <box
      flexDirection="row"
      height={lines}
      flexShrink={0}
      // A narrower pane wraps what you typed onto more lines, a wider one onto fewer. The field
      // takes no size change of its own, and has its new width only once the row's is laid out.
      onSizeChange={function (this: BoxRenderable) {
        if (this.width === width.current) return
        width.current = this.width
        queueMicrotask(() => field.current !== null && fit())
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        focus()
      }}
    >
      <Line segments={[seg(" "), seg(">", form.selector), seg(" ")]} />
      <textarea
        ref={field}
        focused={focused}
        flexGrow={1}
        // The row's width less the prompt's, not what you typed's: a long line wraps, not overflows.
        flexBasis={0}
        height={lines}
        wrapMode="word"
        keyBindings={descriptionKeys}
        onSubmit={submit}
        onContentChange={fit}
        placeholder={placeholder(focused)}
        {...(form.option.fg === undefined ? {} : { textColor: form.option.fg })}
        {...(form.option.fg === undefined ? {} : { focusedTextColor: form.option.fg })}
        {...(form.placeholder.fg === undefined ? {} : { placeholderColor: form.placeholder.fg })}
        {...(form.selected.fg === undefined ? {} : { cursorColor: form.selected.fg })}
      />
    </box>
  )
}

/** What the interrupt question asks and says (§ 7.5). */
export const interruptWords = (ticket: string) => ({
  ask: `Interrupt ${sanitizeLine(ticket)}'s turn?`,
  about:
    "Messages still queued or held are cancelled. tutti then sends the worker nothing until you release it (Ctrl+R).",
})

/** Ctrl+X's question, over the worker view: `y` interrupts, `n` or `Esc` leaves the turn be. */
export const InterruptQuestion = ({
  theme,
  ticket,
  yes,
  no,
}: {
  readonly theme: Theme
  readonly ticket: string
  readonly yes: () => void
  readonly no: () => void
}) => {
  const words = interruptWords(ticket)
  const notice = theme.rgba("notice")
  return (
    <Modal
      frame={{ fg: notice, bg: undefined, attributes: 0 }}
      paragraphs={[
        seg(words.ask, { fg: notice, bg: undefined, attributes: TextAttributes.BOLD }),
        seg(""),
        seg(words.about),
      ]}
      choices={[
        { name: "y", does: "interrupt", run: yes },
        { name: "n", does: "keep going", run: no },
      ]}
    />
  )
}
