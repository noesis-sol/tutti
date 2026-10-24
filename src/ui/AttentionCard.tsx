// Attention cards (§ 4.5 "What the UI shows", § 7.2, § 7.11): a card whose worker waits for you
// grows to show its oldest request and its buttons. Under the card's head and title come the
// request's line in the default text colour, the input's summary and the reason faint, then the
// buttons: a permission's or an elicitation's on one line, a question's options one a line, and
// `+N more` faint when the worker has more requests. The buttons are in the form roles, the focused
// one `formAccentText` on `formAccent`, the others `formText` on `formButton`. Each is a click
// target; a click elsewhere on the card opens the worker's view, as on any card.
//
// A card in the compact one-line layout can't show its request: Enter on it opens the Answer box,
// the same card over the middle of the pane, with the same keys. Shift+D opens the reason box, a
// small field for the reason a denial gives the worker. The keys are attentionKeys.ts's.
import { type InputRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useSyncExternalStore } from "react"
import type { Card } from "../run/runView.ts"
import {
  type Answering,
  type AnswerKey,
  buttonsOf,
  picksOptions,
  requestText,
  useAnswering,
  useSendAnswer,
} from "./attentionKeys.ts"
import { hintSegments } from "./Hint.tsx"
import { type Command, hintOf, useCommands } from "./keyCommands.ts"
import { useInput, useLayer } from "./keys.ts"
import {
  type Border,
  boxed,
  FrameRow,
  Line,
  Lines,
  type Look,
  type Segments,
  seg,
} from "./line.tsx"
import { Backdrop, modalMaxWidth } from "./Modal.tsx"
import type { Theme } from "./theme.ts"
import { useLatestRunView, useRunViewPart, useTheme } from "./useRunView.ts"

/** The lines inside an attention card besides its head and title: its request's and its buttons'. */
const requestLines = (card: Card, theme: Theme, focus: number | null): ReadonlyArray<Segments> => {
  const request = card.requests[0]
  if (request === undefined) return []
  const text = requestText(request)
  const button = (label: string, index: number) =>
    seg(`[ ${label} ]`, index === focus ? theme.form.focusedButton : theme.form.button, index)
  const buttons = buttonsOf(request).map((each, i) => button(each.label, i))
  const rows: Array<Segments> = picksOptions(request)
    ? buttons.map((each) => [seg("  "), each])
    : [[seg("  "), ...buttons.flatMap((each, i) => (i === 0 ? [each] : [seg("  "), each]))]]
  const more = card.requests.length - 1
  const last = rows.length - 1
  if (more > 0) rows[last] = [...(rows[last] ?? []), seg(`  +${more} more`, theme.styles.dim)]
  return [
    [seg("  "), seg(text.line)],
    ...text.faint.map((faint) => [seg("  "), seg(faint, theme.styles.dim)]),
    ...rows,
  ]
}

/** The lines inside an attention card: its head and title (`head`), its request and its buttons. */
export const attentionInside = (card: Card): number => {
  const request = card.requests[0]
  if (request === undefined) return 0
  const buttons = picksOptions(request) ? buttonsOf(request).length : 1
  return 2 + 1 + requestText(request).faint.length + buttons
}

/**
 * An attention card's lines `width` wide, framed `needsYou`, heavy when it is highlighted: `head`
 * (its first line and its title), then its request with `focus` the focused button. A button is a
 * segment whose target is its index, while the card's width holds it whole.
 */
export const attentionLines = (
  card: Card,
  theme: Theme,
  head: ReadonlyArray<Segments>,
  options: {
    readonly width: number
    readonly highlighted: boolean
    readonly focus: number | null
  },
): ReadonlyArray<Segments> => {
  const border: Border = options.highlighted ? "heavy" : "rounded"
  return boxed(
    [...head, ...requestLines(card, theme, options.focus)],
    options.width,
    theme.look("needsYou"),
    border,
  )
}

/** The keys that answer a card's request, for the view's or the Answer box's layer. */
export const answerBindings = (answering: Answering, card: () => Card | undefined) => {
  const on = (run: (card: Card) => void) => () => {
    const target = card()
    if (target !== undefined) run(target)
  }
  const keys: ReadonlyArray<AnswerKey> = ["d", "a", "r"]
  return [
    ...keys.map((key) => ({ key, run: on((target) => answering.key(target, key)) })),
    { key: "shift+d", run: on((target) => answering.denyWithReason(target)) },
  ]
}

/** The widest the Answer box gets. */
export const answerBoxWidth = 72

/**
 * The Answer box (Box.Answer): the attention card of the box's worker over the middle of the pane,
 * for a card drawn on one line. `Tab`, `Shift+Tab` and the arrows move between its buttons,
 * `Enter` presses the focused one, `1`–`4` pick an option, `d`, `Shift+D`, `a` and `r` answer as
 * on the dashboard, and `Esc` closes it. It closes once an answer is sent, or the worker no longer
 * waits for you. Mounted while no box is open too, so that its keys are bound before it opens.
 */
export const AnswerBox = () => {
  const theme = useTheme()
  const { width, height } = useTerminalDimensions()
  const { box } = useInput()
  const open = useSyncExternalStore(box.subscribe, box.get)
  const ticket = open?._tag === "Answer" ? open.ticket : null
  // Its worker's card while the box is open; nothing while it is closed, drawn anew by no change.
  const card = useRunViewPart((view) =>
    ticket === null
      ? undefined
      : view.cards.find((each) => each.ticket === ticket && each.requests.length > 0),
  )
  const close = () => {
    if (box.get()?._tag === "Answer") box.set(null)
  }
  const answering = useAnswering(card === undefined ? [] : [card], close)
  answering.target(card)
  const gone = ticket !== null && card === undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: close reads the box as it is then
  useEffect(() => {
    if (gone) close()
  }, [gone])
  // A key pressed as the box opens, before it is drawn, finds the card in the RunView now; its
  // request isn't shown yet, so the guard keeps it from answering.
  const latest = useLatestRunView()
  const target = () => {
    if (card !== undefined) return card
    const shown = box.get()
    return shown?._tag === "Answer"
      ? latest().cards.find((each) => each.ticket === shown.ticket && each.requests.length > 0)
      : undefined
  }
  const on = (run: (card: Card) => void) => () => {
    const at = target()
    if (at !== undefined) run(at)
  }
  useLayer(
    "box",
    [
      ...["tab", "right"].map((key) => ({ key, run: on((at) => answering.step(at, 1)) })),
      ...["shift+tab", "left"].map((key) => ({ key, run: on((at) => answering.step(at, -1)) })),
      ...["return", "enter"].map((key) => ({ key, run: on((at) => answering.pressFocused(at)) })),
      ...answerBindings(answering, target),
      ...[1, 2, 3, 4].map((n) => ({ key: String(n), run: on((at) => answering.pick(at, n)) })),
      { key: "escape", run: () => box.set(null) },
    ],
    "Answer",
  )
  if (card === undefined) return null
  const outer = Math.max(Math.min(width - 4, answerBoxWidth), 8)
  const head: ReadonlyArray<Segments> = [
    [
      seg("  "),
      seg(card.label, theme.styles.picked),
      seg("  "),
      seg(card.status, theme.styles.stop),
    ],
    [seg("  "), seg(card.title)],
  ]
  const lines = attentionLines(card, theme, head, {
    width: outer,
    highlighted: false,
    focus: answering.focusOf(card),
  })
  return (
    <>
      <Backdrop />
      <box
        position="absolute"
        zIndex={10}
        left={Math.max(Math.floor((width - outer) / 2), 0)}
        top={Math.max(Math.floor((height - lines.length) / 2), 0)}
        width={outer}
        height={lines.length}
        // Opaque, in the terminal's own background: the view's text doesn't show through its spaces.
        backgroundColor={RGBA.defaultBackground()}
      >
        <Lines lines={lines} press={(index) => answering.press(card, index)} />
      </box>
    </>
  )
}

/** What the reason box asks. */
export const reasonQuestion = (ticket: string): string => `Deny ${ticket}'s request, saying why:`

/**
 * The reason box (Box.Reason): Shift+D's small field for the reason to deny the request
 * `requestId` with. `Enter` denies it with what you typed, `Esc` closes it. The answer names the
 * request Shift+D was pressed on, and is dropped with a toast when it is no longer open.
 */
/** The reason box's keys: `Enter` is its field's; `Esc` closes it. */
const reasonCommands = (close: () => void): ReadonlyArray<Command> => [
  { keys: [], run: () => {}, hint: { keys: "Enter", does: "deny" } },
  { keys: ["escape"], run: close, hint: { keys: "Esc", does: "cancel" } },
]

/** The reason box's Esc, bound while no box is open too, so that it works from the moment it opens. */
export const ReasonKeys = () => {
  const { box } = useInput()
  useCommands(
    "box",
    reasonCommands(() => box.set(null)),
    "Reason",
  )
  return null
}

export const ReasonBox = ({
  requestId,
  ticket,
  label,
}: {
  readonly requestId: string
  readonly ticket: string
  /** The ticket's ID as drawn (§ 7.10). */
  readonly label: string
}) => {
  const theme = useTheme()
  const { form } = theme
  const { width, height } = useTerminalDimensions()
  const { box } = useInput()
  const answer = useSendAnswer()
  const field = useRef<InputRenderable>(null)
  const close = () => box.set(null)
  const submit = (typed: string) => {
    close()
    const reason = typed.trim()
    answer({ id: requestId, ticket }, { _tag: "Deny", ...(reason === "" ? {} : { reason }) })
  }
  const frame: Look = theme.look("needsYou")
  const outer = Math.max(Math.min(width - 4, modalMaxWidth), 12)
  const inner = outer - 4
  // The box's rows: its question, a blank line, the field's row, which a FrameRow draws in its
  // place, a blank line and the keys.
  const framed = boxed(
    [
      [seg(reasonQuestion(label), frame.bold())],
      [],
      [],
      [],
      hintSegments(hintOf(reasonCommands(close)), theme, inner + 2).slice(1),
    ],
    outer,
    frame,
  )
  const [above, below] = [framed.slice(0, 3), framed.slice(4)]
  return (
    <>
      <Backdrop />
      <box
        position="absolute"
        zIndex={10}
        left={Math.max(Math.floor((width - outer) / 2), 0)}
        top={Math.max(Math.floor((height - framed.length) / 2), 0)}
        width={outer}
        height={framed.length}
        // Opaque, in the terminal's own background: the view's text doesn't show through its spaces.
        backgroundColor={RGBA.defaultBackground()}
        flexDirection="column"
      >
        <Lines lines={above} />
        <FrameRow width={outer} frame={frame}>
          <box flexDirection="row" height={1}>
            <Line segments={[seg("> ", theme.form.selector)]} />
            <input
              focused
              width={Math.max(inner - 2, 1)}
              ref={field}
              onSubmit={() => submit(field.current?.value ?? "")}
              placeholder="what the worker is told"
              {...(form.option.fg === undefined ? {} : { textColor: form.option.fg })}
              {...(form.option.fg === undefined ? {} : { focusedTextColor: form.option.fg })}
              {...(form.placeholder.fg === undefined
                ? {}
                : { placeholderColor: form.placeholder.fg })}
              {...(form.selected.fg === undefined ? {} : { cursorColor: form.selected.fg })}
            />
          </box>
        </FrameRow>
        <Lines lines={below} />
      </box>
    </>
  )
}
