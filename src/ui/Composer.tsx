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
//
// The prompt (`>`) is drawn `formAccent`, the cursor `formSelected`, the placeholder
// `formPlaceholder`, the text `formText`.
import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { type RefObject, useEffect, useMemo, useState } from "react"
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

/** A message you sent from the composer, by the uuid it was sent with. */
export interface Send {
  readonly uuid: string
  readonly ticket: string
  readonly text: string
}

// A value of an SDK message whose shape this tutti may not know, read without trusting it.
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

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
  /** The ticket's messages sent while a turn was under way that the CLI hasn't taken, oldest first. */
  readonly queued: ReadonlyArray<Send>
  /** Records a message sent with `uuid`: queued when a turn is under way. */
  readonly sent: (send: Send) => void
  /** Forgets the queued messages to `ticket`'s worker: an interrupt cancelled them. */
  readonly cancelled: (ticket: string) => void
}

/**
 * The messages you sent to the ticket's worker that are still queued, from its transcript's latest
 * `items`, while a turn is `underWay`. Those the transcript says were taken are let go, and all of
 * them once the worker settles.
 */
export const useSends = (
  ticket: string | undefined,
  items: ReadonlyArray<Item>,
  underWay: boolean,
): Sends => {
  const [sends, setSends] = useState<ReadonlyArray<Send>>([])
  const taken = useMemo(() => takenIn(items), [items])
  const waiting = (send: Send) => send.ticket !== ticket || (underWay && !taken.has(send.uuid))
  const queued = sends.filter((send) => send.ticket === ticket && waiting(send))
  // biome-ignore lint/correctness/useExhaustiveDependencies: waiting reads ticket, taken and underWay
  useEffect(() => {
    if (!sends.every(waiting)) setSends((now) => now.filter(waiting))
  }, [sends, ticket, taken, underWay])
  return {
    queued,
    sent: (send) => {
      if (underWay) setSends((now) => [...now, send])
    },
    cancelled: (worker) => setSends((now) => now.filter((send) => send.ticket !== worker)),
  }
}

/** A queued message's line, `width` wide: `› Please add tests too …  queued`. */
export const queuedLine = (send: Send, theme: Theme, width: number): Segments => {
  const lines = send.text.split("\n").filter((line) => line.trim() !== "")
  const mark: Segments = [seg("queued", theme.styles.dim)]
  const room = Math.max(width - widthOf(mark) - 2, 0)
  const head: Segments = [
    seg("  "),
    seg("› ", theme.styles.dim),
    seg(sanitizeLine(lines[0] ?? "")),
    ...(lines.length > 1 ? [seg(" …", theme.styles.dim)] : []),
  ]
  return [...padded(cut(head, room), room), seg("  "), ...mark]
}

/** The queued messages' lines, at most `queuedShown`, and a count of the rest. */
export const queuedLines = (
  queued: ReadonlyArray<Send>,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> => {
  const more = queued.length - queuedShown
  return [
    ...queued.slice(0, queuedShown).map((send) => queuedLine(send, theme, width)),
    ...(more > 0 ? [cut([seg(`  +${more} more queued`, theme.styles.dim)], width)] : []),
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
  focused,
  focus,
  send,
  placeholder = composerPlaceholder,
}: {
  readonly theme: Theme
  /** The field, which the view focuses and blurs as keys come. */
  readonly field: RefObject<TextareaRenderable | null>
  readonly focused: boolean
  /** Focuses it, as a click does. */
  readonly focus: () => void
  /** Sends a message: what you typed, without the blank lines and spaces around it. */
  readonly send: (text: string) => void
  /** Its placeholder, unfocused and focused: the worker view's when left out. */
  readonly placeholder?: (focused: boolean) => string
}) => {
  const { form } = theme
  const [lines, setLines] = useState(1)
  const fit = () => {
    const box = field.current
    const count = box === null ? 1 : Math.max(box.lineCount, box.virtualLineCount)
    const next = Math.min(Math.max(count, 1), composerLines)
    if (next !== lines) setLines(next)
  }
  const submit = () => {
    const box = field.current
    if (box === null) return
    const text = box.plainText.trim()
    if (text === "") return
    box.setText("")
    fit()
    send(text)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a terminal box, not the DOM's; `i` is its key
    <box
      flexDirection="row"
      height={lines}
      flexShrink={0}
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
    "Messages still queued are cancelled. tutti then sends the worker nothing until you release it (Ctrl+R).",
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
