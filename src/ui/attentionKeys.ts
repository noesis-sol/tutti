// Answering attention requests on the dashboard (§ 4.5 "What the UI shows", "Keys", "Answering the
// request you read"; § 7.3): the buttons a request has, which one is focused first, how Tab and the
// arrows move between them, what `d`, `a` and `r` answer, and useAnswering, which turns a key or a
// click into an Answer UiCommand.
//
// Every answer names the request drawn on the card when the key was pressed or the button clicked,
// never one opened since. One no longer open by then (answered elsewhere, by `tutti answer`, or
// withdrawn) is dropped with a toast. Open URL opens an elicitation's URL before it answers Accept
// (openUrl.ts). Input to a card is ignored for `settle` ms after its request appears or changes,
// or becomes the target the keys answer, so a key meant for the request before can't answer the
// next. Allow is never focused first: a permission opens on Deny, and one with `defaultToNo` has
// no one-key allow.
import { useContext, useRef } from "react"
import { type Answer, type AttentionRequest, allowsForRun } from "../agent/Attention.ts"
import { UiCommand } from "../run/commands.ts"
import type { Card } from "../run/runView.ts"
import { Box, useInput } from "./keys.ts"
import { type Opened, openedToast, urlCopiedToast, urlFailedToast } from "./openUrl.ts"
import { sanitizeLine } from "./sanitize.ts"
import { useKeyState } from "./useKeyState.ts"
import { ShellContext, useClock, useCommand, useLatestRunView } from "./useRunView.ts"

/**
 * How long input to a card is ignored after its request appears or changes, or becomes the target,
 * in ms (§ 4.5).
 */
export const settle = 500

/** What pressing a button does: answer the request, or open the worker view for what won't fit. */
export type Press = { readonly _tag: "Answer"; readonly answer: Answer } | { readonly _tag: "View" }

export interface Button {
  readonly label: string
  readonly press: Press
}

const answering = (label: string, answer: Answer): Button => ({
  label,
  press: { _tag: "Answer", answer },
})

/** The button for what the card can't hold: the worker view's answer form takes it (§ 4.5). */
export const answerInView: Button = { label: "Answer in view", press: { _tag: "View" } }

/** The most options a question shows on a card, as `1`–`4` pick them. */
export const optionKeys = 4

/** Whether an elicitation's form asks for any field. */
const hasFields = (schema: Readonly<Record<string, unknown>> | undefined): boolean => {
  const properties = schema?.properties
  return typeof properties === "object" && properties !== null && Object.keys(properties).length > 0
}

/** The question a card can answer with its options: the only one, not multiple choice. */
const cardQuestion = (request: AttentionRequest) => {
  if (request.kind._tag !== "Question" || request.kind.questions.length !== 1) return undefined
  const only = request.kind.questions[0]
  return only === undefined ||
    only.multiSelect ||
    only.options.length === 0 ||
    only.options.length > optionKeys
    ? undefined
    : only
}

/**
 * The request's buttons on a card (§ 4.5): Deny, Allow and, when it offers it, Allow for this run
 * for a permission; a question's options, numbered; Decline and Open URL for an elicitation. What
 * a card can't hold (several questions, multiple choice, a form's fields) is Answer in view.
 */
export const buttonsOf = (request: AttentionRequest): ReadonlyArray<Button> => {
  const kind = request.kind
  switch (kind._tag) {
    case "Permission":
      return [
        answering("Deny", { _tag: "Deny" }),
        answering("Allow", { _tag: "Allow" }),
        ...(allowsForRun(request)
          ? [answering("Allow for this run", { _tag: "AllowForRun" })]
          : []),
      ]
    case "Question": {
      const question = cardQuestion(request)
      if (question === undefined) return [answerInView]
      return question.options.map((option, i) =>
        answering(`${i + 1} ${option.label}`, { _tag: "Choose", answers: [option.label] }),
      )
    }
    case "Elicitation": {
      const decline = answering("Decline", { _tag: "Decline" })
      if (kind.mode === "url") return [decline, answering("Open URL", { _tag: "Accept" })]
      return hasFields(kind.requestedSchema)
        ? [decline, answerInView]
        : [decline, answering("Accept", { _tag: "Accept" })]
    }
  }
}

/** Whether the request's buttons are a question's options, one a line, which `1`–`4` pick. */
export const picksOptions = (request: AttentionRequest): boolean =>
  cardQuestion(request) !== undefined

/**
 * The button focused when the request appears: Deny or Decline, the first, never Allow; none for a
 * question, whose option you pick.
 */
export const defaultFocus = (request: AttentionRequest): number | null =>
  request.kind._tag === "Question" && picksOptions(request) ? null : 0

/**
 * The focus `step` buttons on from `focus`, among `count` buttons; "leave" past the last or before
 * the first (before none, for a question), where Tab goes on to the next card.
 */
export const stepFocus = (
  count: number,
  focus: number | null,
  step: 1 | -1,
  start: number | null,
): number | null | "leave" => {
  if (step === 1) {
    const next = focus === null ? 0 : focus + 1
    return next < count ? next : "leave"
  }
  if (focus === null) return "leave"
  if (focus === 0) return start === null ? null : "leave"
  return focus - 1
}

/** A key that answers the target request at once (§ 4.5's Keys). */
export type AnswerKey = "d" | "a" | "r"

/**
 * What `key` answers `request` with, or null when it answers nothing: `d` denies (declines an
 * elicitation), `a` allows a permission without `defaultToNo`, `r` allows one for this run. With
 * `defaultToNo` neither key allows: you move to the button and press Enter, or click it.
 */
export const keyAnswer = (request: AttentionRequest, key: AnswerKey): Answer | null => {
  switch (key) {
    case "d":
      return request.kind._tag === "Elicitation" ? { _tag: "Decline" } : { _tag: "Deny" }
    case "a":
      return request.kind._tag === "Permission" && !request.defaultToNo ? { _tag: "Allow" } : null
    case "r":
      return allowsForRun(request) && !request.defaultToNo ? { _tag: "AllowForRun" } : null
  }
}

/** The request's line on a card, and the faint lines under it (§ 4.5, § 7.11). */
export interface RequestText {
  readonly line: string
  readonly faint: ReadonlyArray<string>
}

/** `text` on one line: its first, sanitised. */
const oneLine = (text: string): string => sanitizeLine(text.split("\n")[0] ?? "").trim()

/**
 * The request's line: for a permission its title, else its display name (the tool's) and its
 * description (the input's summary); under it, faint, the input's summary when the line doesn't hold
 * it, then the reason. A question's line is its question, an elicitation's the server's message.
 */
export const requestText = (request: AttentionRequest): RequestText => {
  const kind = request.kind
  const reason = request.decisionReason === undefined ? [] : [oneLine(request.decisionReason)]
  switch (kind._tag) {
    case "Permission": {
      const name = oneLine(request.displayName ?? kind.tool) || kind.tool
      const line =
        request.title === undefined
          ? `${name}: ${oneLine(request.description ?? "") || kind.summary}`
          : oneLine(request.title)
      const summary = kind.summary === "" || line.includes(kind.summary) ? [] : [kind.summary]
      return { line, faint: [...summary, ...reason] }
    }
    case "Question": {
      const first = kind.questions[0]
      const more = kind.questions.length - 1
      return {
        line: oneLine(first?.question ?? "") + (more > 0 ? ` (and ${more} more)` : ""),
        faint: reason,
      }
    }
    case "Elicitation":
      return {
        line: `${kind.server}: ${oneLine(kind.message)}`,
        faint: [...(kind.url === undefined ? [] : [oneLine(kind.url)]), ...reason],
      }
  }
}

/** The toast for an answer to a request that is no longer open. */
export const staleToast = (ticket: string): string =>
  `${sanitizeLine(ticket)}'s request is no longer open`

/** The URL Accept opens first: a URL elicitation's, when it has one. */
export const urlToOpen = (request: AttentionRequest, answer: Answer): string | undefined =>
  request.kind._tag === "Elicitation" && request.kind.mode === "url" && answer._tag === "Accept"
    ? request.kind.url
    : undefined

/**
 * Sends `answer` to the request `request` names, if it is still open in the RunView as it is now;
 * else drops it with a toast. Accepting a URL elicitation opens its URL first, with the shell's
 * UrlOpener, and toasts how: the Accept is sent once it is opened or copied, if the request is
 * still open then, and not when it was neither.
 */
export const useSendAnswer = (): ((
  request: { readonly id: string; readonly ticket: string },
  answer: Answer,
) => void) => {
  const command = useCommand()
  const latest = useLatestRunView()
  const { toasts } = useInput()
  const opener = useContext(ShellContext)?.urlOpener
  const openOf = (id: string) => latest().requests.find((open) => open.id === id)
  const send = (request: { readonly id: string; readonly ticket: string }, answer: Answer) => {
    if (openOf(request.id) !== undefined) {
      command(UiCommand.Answer({ requestId: request.id, answer }))
    } else toasts.show(staleToast(request.ticket))
  }
  return (request, answer) => {
    const open = openOf(request.id)
    const url = open === undefined ? undefined : urlToOpen(open, answer)
    if (opener === undefined || url === undefined) return send(request, answer)
    const opened = (how: Opened) => {
      if (how === "failed") return toasts.show(urlFailedToast, { failure: true })
      toasts.show(how === "opened" ? openedToast : urlCopiedToast)
      send(request, answer)
    }
    opener.open(url).then(opened, () => opened("failed"))
  }
}

/** A card's answering: its focus, and what its keys and clicks do. */
export interface Answering {
  /** The focused button of the card's request: its default until you move it. */
  readonly focusOf: (card: Card) => number | null
  /** Moves the focus `step` buttons on; false, leaving it, past the last or before the first. */
  readonly step: (card: Card, step: 1 | -1) => boolean
  /** Forgets the focus moved, for the highlight leaving the card. */
  readonly reset: () => void
  /** Presses the card's button `index`, as Enter on it or a click does. */
  readonly press: (card: Card, index: number) => void
  /** Presses the focused button; false when none is focused. */
  readonly pressFocused: (card: Card) => boolean
  /** Answers the card's request as `key` does, if it answers it. */
  readonly key: (card: Card, key: AnswerKey) => void
  /** Opens the reason box to deny the card's request with a reason you type (Shift+D). */
  readonly denyWithReason: (card: Card) => void
  /**
   * Names the card the keys answer as drawn, its request the target (§ 4.5): when the target's
   * request changes, its guard starts again, so a key meant for the request before (answered, its
   * card gone) can't answer the one the target moves on to. Called as the cards are drawn; the
   * keys (Enter, `d`, `Shift+D`, `a`, `r`, `1`–`4`) name their card the target too.
   */
  readonly target: (card: Card | undefined) => void
  /** Focuses the question's option `n`, 1 to 4; false when the card has no such option. */
  readonly pick: (card: Card, n: number) => boolean
}

/**
 * The answering of the cards drawn in this render. Each card's oldest request is the one it shows;
 * the time it first showed it starts its guard, and the time it became the target (`target`) starts
 * it again. `sent` is called once a button or key has answered
 * (or the answer was dropped) or pressed Answer in view. Answer in view opens the card's worker
 * view, or does `inView` when given: the worker view's panel opens the answer form.
 */
export const useAnswering = (
  cards: ReadonlyArray<Card>,
  sent: () => void = () => {},
  inView?: (request: AttentionRequest) => void,
): Answering => {
  const command = useCommand()
  const answer = useSendAnswer()
  const clock = useClock()
  const { box } = useInput()
  // When each request shown first appeared, kept for those still shown. Updated as the cards are
  // drawn, so a key pressed after a render guards the request that render drew.
  const shown = useRef(new Map<string, number>())
  const drawn = new Map<string, number>()
  for (const card of cards) {
    const request = card.requests[0]
    if (request !== undefined) drawn.set(request.id, shown.current.get(request.id) ?? clock())
  }
  shown.current = drawn
  // The target's request, and when it became the target.
  const aimed = useRef<{ readonly request: string; readonly since: number } | null>(null)
  // The focus moved by Tab, the arrows or a pick, for the request it was moved on.
  const [, setMoved, moved] = useKeyState<{
    readonly request: string
    readonly focus: number | null
  } | null>(() => null)
  const move = (to: { readonly request: string; readonly focus: number | null } | null) =>
    setMoved(() => to)

  const requestOf = (card: Card) => card.requests[0]
  const aim = (request: AttentionRequest | undefined) => {
    if (request === undefined) aimed.current = null
    else if (aimed.current?.request !== request.id) {
      aimed.current = { request: request.id, since: clock() }
    }
  }
  // A key answers the target, which it names too: a move that came with it, before the cards were
  // drawn again, starts the new target's guard as drawing would. A click names none.
  const aimedAt = (card: Card) => {
    const request = requestOf(card)
    aim(request)
    return request
  }
  const settled = (request: AttentionRequest) => {
    const now = clock()
    const first = shown.current.get(request.id) ?? now
    const aim = aimed.current
    const since = aim?.request === request.id ? Math.max(first, aim.since) : first
    return now - since >= settle
  }
  const focusOf = (card: Card) => {
    const request = requestOf(card)
    if (request === undefined) return null
    const now = moved()
    return now?.request === request.id ? now.focus : defaultFocus(request)
  }
  const send = (request: AttentionRequest, given: Answer) => {
    answer(request, given)
    sent()
  }
  const press = (card: Card, index: number) => {
    const request = requestOf(card)
    const button = request === undefined ? undefined : buttonsOf(request)[index]
    if (request === undefined || button === undefined || !settled(request)) return
    if (button.press._tag === "Answer") send(request, button.press.answer)
    else {
      if (inView === undefined) command(UiCommand.OpenWorker({ ticket: card.ticket }))
      else inView(request)
      sent()
    }
  }
  return {
    focusOf,
    step: (card, step) => {
      const request = requestOf(card)
      if (request === undefined) return false
      const to = stepFocus(buttonsOf(request).length, focusOf(card), step, defaultFocus(request))
      if (to === "leave") return false
      move({ request: request.id, focus: to })
      return true
    },
    reset: () => move(null),
    press,
    pressFocused: (card) => {
      aimedAt(card)
      const focus = focusOf(card)
      if (focus === null) return false
      press(card, focus)
      return true
    },
    key: (card, key) => {
      const request = aimedAt(card)
      const answer = request === undefined ? null : keyAnswer(request, key)
      if (request !== undefined && answer !== null && settled(request)) send(request, answer)
    },
    denyWithReason: (card) => {
      const request = aimedAt(card)
      if (request === undefined || !settled(request)) return
      if (request.kind._tag === "Elicitation") send(request, { _tag: "Decline" })
      else
        box.set(Box.Reason({ requestId: request.id, ticket: request.ticket, label: request.label }))
    },
    target: (card) => aim(card === undefined ? undefined : requestOf(card)),
    pick: (card, n) => {
      const request = aimedAt(card)
      if (request === undefined || !picksOptions(request)) return false
      if (n > buttonsOf(request).length) return false
      if (settled(request)) move({ request: request.id, focus: n - 1 })
      return true
    },
  }
}
