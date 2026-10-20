// The Interview view (§ 4.10, § 7.1, § 7.3): the chat with the feature interview's session, in
// the command's one renderer, built from the worker view's components. Its chrome: `← Back`, then
// the interview's mark, status and elapsed time, and the description's first line, over a rule.
// Under it, the session's transcript as the worker view draws it (Claude's text as Markdown, each
// tool call one line that Enter or a click expands), the attention panel with its AskUserQuestion
// requests (the card's buttons and rules; Answer in view opens the answer form), and the composer,
// where you type your answers: Enter sends, Alt+Enter or Ctrl+J starts a new line.
//
// Leaving (`Esc` outside the composer, or a click on `← Back`) asks `End the interview? Nothing has
// been filed.`: `y` ends it, `n` or `Esc` stays. Once file_feature has filed something, leaving
// asks nothing. Leaving sends CloseWorker, which run/interview.ts takes as the interview's end.
//
// The keys, in the view's layer: `Tab`, `Shift+Tab` and the arrows move between the items and the
// panel's requests, and between a request's buttons; `Enter` expands or collapses the selected item
// or presses the focused button; `1`–`4` pick a question's option; `d` and `Shift+D` decline it;
// PgUp/PgDn and `g`/`G` scroll; `i` or a click focuses the composer; `?` shows the keys.
import type { MouseEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/react"
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { interviewWorker } from "../agent/interview.ts"
import { type Filing, filedSomething } from "../agent/interviewTools.ts"
import { settled as hasSettled } from "../agent/WorkerState.ts"
import { UiCommand } from "../run/commands.ts"
import type { Card } from "../run/runView.ts"
import { answerBindings } from "./AttentionCard.tsx"
import { optionKeys, useAnswering } from "./attentionKeys.ts"
import { elapsed, statusLook } from "./Card.tsx"
import { Composer, QueuedLines, queuedLines, useSends } from "./Composer.tsx"
import { Hint, hintSegments } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { Box, type KeyBinding, useInput, useLayer } from "./keys.ts"
import { cut, Line, roleLook, type Segments, seg, styled } from "./line.tsx"
import { Modal } from "./Modal.tsx"
import { sanitizeLine } from "./sanitize.ts"
import {
  bounded,
  emptyTranscript,
  entriesOf,
  mounted,
  type OpenTranscript,
  type TranscriptState,
} from "./transcriptItems.ts"
import {
  type External,
  external,
  useCommand,
  useNow,
  useRunView,
  useSpinner,
  useTheme,
  useTranscripts,
} from "./useRunView.ts"
import {
  EntryList,
  entryId,
  inputLines,
  LooksContext,
  PanelBox,
  panelParts,
  panelRequests,
  requestKey,
  selectable,
  useSyntaxStyles,
} from "./WorkerView.tsx"

/** What the Interview view reads besides the shell: the description, and what has been filed. */
export interface InterviewValue {
  readonly description: string
  readonly filing: External<Filing>
}

export const InterviewContext = createContext<InterviewValue | null>(null)

/** The link back, at the head of the view: leaving the interview. */
export const backLink = " ← Back"

/** What leaving asks while nothing has been filed (§ 4.10). */
export const leaveQuestion = "End the interview?"
export const leaveAbout = "Nothing has been filed."

/** The composer's placeholder in the interview, unfocused and focused. */
export const answerPlaceholder = (focused: boolean): string =>
  focused ? "your answer" : "i to answer"

/** The interview's hint: the keys there are; the composer's while you write in it. */
const hintKeys = (question: boolean, composing: boolean) =>
  composing
    ? [
        { keys: "Enter", does: "send" },
        { keys: "Alt+Enter/Ctrl+J", does: "new line" },
        { keys: "Esc", does: "leave the composer" },
      ]
    : [
        { keys: "Esc", does: "back" },
        { keys: "i", does: "answer" },
        ...(question ? [{ keys: "1–4", does: "pick" }] : []),
        { keys: "↑↓", does: "select" },
        { keys: "Enter", does: "expand" },
        { keys: "PgUp/PgDn", does: "scroll" },
        { keys: "?", does: "keys" },
      ]

/** The Interview view's keys, for its key help (§ 7.3's table). */
export const interviewViewKeys: ReadonlyArray<readonly [string, string]> = [
  ["Tab, Shift+Tab, arrows", "move between items; between a question's options"],
  ["Enter, a click", "expand or collapse the item; press the focused button"],
  ["i, a click on the composer", "write your answer; Enter sends, Alt+Enter or Ctrl+J a new line"],
  ["Esc, ← Back", "leave the composer; end the interview (asks first)"],
  ["1–4 in a question", "pick an option"],
  ["d, Shift+D", "decline the question; decline with a reason"],
  ["Answer in view", "the answer form: ↑↓ move, Space picks, Enter presses"],
  ["the wheel, PgUp/PgDn", "scroll; past the top loads earlier items"],
  ["g, G", "jump to the top or the end"],
  ["Ctrl+C", "quit"],
  ["a drag", "select text and copy it"],
  ["?", "these keys"],
]

/** Leaving's question, over the view: `y` ends the interview, `n` or `Esc` stays. */
export const LeaveQuestion = ({
  yes,
  no,
}: {
  readonly yes: () => void
  readonly no: () => void
}) => {
  const theme = useTheme()
  const notice = theme.rgba("notice")
  return (
    <Modal
      frame={{ fg: notice, bg: undefined, attributes: 0 }}
      paragraphs={[
        seg(leaveQuestion, { fg: notice, bg: undefined, attributes: TextAttributes.BOLD }),
        seg(""),
        seg(leaveAbout),
      ]}
      choices={[
        { name: "y", does: "end it", run: yes },
        { name: "n", does: "keep talking", run: no },
      ]}
    />
  )
}

/** The store a view without a transcript reads. */
const noTranscript = external<TranscriptState>(emptyTranscript)

/** The interview's view, while the run shows it. */
export const InterviewView = () => {
  const interview = useContext(InterviewContext)
  if (interview === null) throw new Error("the Interview view is drawn outside its interview")
  const view = useRunView()
  const theme = useTheme()
  const looks = useSyntaxStyles(theme)
  const renderer = useRenderer()
  const now = useNow()
  const command = useCommand()
  const feed = useTranscripts()
  const { width, height } = useTerminalDimensions()
  const card = view.cards.find((each) => each.ticket === interviewWorker)
  const spin = useSpinner(card?.motion === "spinner")

  // The transcript, open while the view is.
  const [transcript, setTranscript] = useState<OpenTranscript | null>(null)
  useEffect(() => {
    if (feed === undefined) return
    const opened = feed.open(interviewWorker)
    setTranscript(opened)
    return () => {
      opened.close()
      setTranscript(null)
    }
  }, [feed])
  const store = transcript?.state ?? noTranscript
  const state = useSyncExternalStore(store.subscribe, store.get)
  const window = state.window
  // Your messages sent while a turn is under way are queued until the transcript says they were
  // taken; the composer shows them till then, the transcript after.
  const underWay = card?.state != null && !hasSettled(card.state)
  const sends = useSends(interviewWorker, window.latest, underWay)
  const queuedKey = sends.queued.map((send) => send.uuid).join(" ")
  const queued = useMemo(() => new Set(queuedKey === "" ? [] : queuedKey.split(" ")), [queuedKey])
  const entries = useMemo(
    () => entriesOf(window.items, state.live, queued),
    [window.items, state.live, queued],
  )
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const shown = bounded(entries, expanded, window.following)
  const flat = mounted(shown, expanded)

  // The panel: the session's oldest open requests, each as a card of its own for the card's
  // answering; the rest are counted under them.
  const waiting = card === undefined ? [] : view.requests.filter((r) => r.ticket === card.ticket)
  const requests = waiting.slice(0, panelRequests)
  const more = waiting.length - requests.length
  const requestCards: ReadonlyArray<Card> =
    card === undefined ? [] : requests.map((request) => ({ ...card, requests: [request] }))
  const input = useInput()
  const answering = useAnswering(requestCards, undefined, (request) =>
    input.box.set(Box.Form({ requestId: request.id, ticket: request.ticket })),
  )

  // The composer, as the worker view's: it takes the focus, or gives it up, as the key is pressed.
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
  const send = (text: string) => {
    const uuid = crypto.randomUUID()
    sends.sent({ uuid, ticket: interviewWorker, text })
    command(UiCommand.SendMessage({ ticket: interviewWorker, text, uuid }))
  }

  // Leaving asks first while nothing has been filed.
  const leave = () => {
    if (filedSomething(interview.filing.get())) {
      command(UiCommand.CloseWorker())
      return
    }
    field.current?.blur()
    input.box.set(Box.Leave())
  }
  const answerLeave = (yes: boolean) => {
    if (input.box.get()?._tag !== "Leave") return
    input.box.set(null)
    if (yes) command(UiCommand.CloseWorker())
    else if (composingNow.current) field.current?.focus()
  }
  useLayer(
    "box",
    [
      { key: "y", run: () => answerLeave(true) },
      { key: "n", run: () => answerLeave(false) },
      { key: "escape", run: () => answerLeave(false) },
    ],
    "Leave",
  )

  // The selection names an entry or a request; with none chosen, the oldest request is the target.
  const chosen = useRef<string | null>(null)
  const [, redraw] = useState(0)
  const selectables = [
    ...flat.filter(selectable).map((entry) => entry.key),
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
    if (key !== null && !key.startsWith("request:")) {
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

  // Scrolling: past the top loads older items, keeping your place; the bottom follows the session.
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
  const enter = () => {
    const key = current()
    if (key === null) return
    const target = selectedCard()
    if (target !== undefined) {
      answering.pressFocused(target)
      return
    }
    toggle(key)
  }
  const pick = (n: number) => () => {
    const target = selectedCard() ?? requestCards[0]
    if (target !== undefined) answering.pick(target, n)
  }
  const targetCard = () => selectedCard() ?? requestCards[0]
  const [help, setHelp] = useState(false)
  const helpOpen = useRef(false)
  const showHelp = (on: boolean) => {
    helpOpen.current = on
    setHelp(on)
  }
  const keys: ReadonlyArray<KeyBinding> = [
    { key: "pageup", run: () => page(-1) },
    { key: "pagedown", run: () => page(1) },
    { key: "i", run: () => setComposing(true) },
    { key: "down", run: () => move(1) },
    { key: "up", run: () => move(-1) },
    ...["tab", "right"].map((key) => ({ key, run: () => stepOrMove(1) })),
    ...["shift+tab", "left"].map((key) => ({ key, run: () => stepOrMove(-1) })),
    ...["return", "enter"].map((key) => ({ key, run: enter })),
    ...answerBindings(answering, targetCard),
    ...Array.from({ length: optionKeys }, (_, i) => ({ key: String(i + 1), run: pick(i + 1) })),
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
        helpOpen.current ? showHelp(false) : composingNow.current ? setComposing(false) : leave(),
    },
    ...keys.map((binding) => ({
      key: binding.key,
      run: () => (helpOpen.current ? undefined : binding.run()),
    })),
  ])

  const inner = Math.max(width, 1)
  const rule: Segments = [seg("─".repeat(inner), roleLook(theme, "frame"))]
  const { styles } = theme
  const head: Segments =
    card === undefined
      ? [seg("Interview", styles.picked)]
      : [
          card.motion === "spinner" ? seg(spin, styles.picked) : seg("•", styles.done),
          seg("  "),
          seg("Interview", styles.picked),
          seg("  "),
          seg(card.status, statusLook(card, theme)),
          seg("  "),
          seg(elapsed(now - card.since), styles.dim),
          seg("   "),
          seg(sanitizeLine(card.title)),
        ]
  const panelWidth = Math.max(inner - 2, 8)
  const inputRoom = Math.max(inputLines, Math.floor(height / 4))
  const question = requests.some((request) => request.kind._tag === "Question")
  return (
    <LooksContext.Provider value={looks}>
      <box flexDirection="column" width={width} height={height}>
        <box flexDirection="row" height={1} flexShrink={0}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a terminal's text, not the DOM's; Esc is its key */}
          <text
            wrapMode="none"
            height={1}
            {...styled(styles.key)}
            onMouseDown={(event: MouseEvent) => {
              if (event.button !== 0) return
              event.stopPropagation()
              leave()
            }}
          >
            {backLink}
          </text>
          <Line segments={cut([seg("   "), ...head], Math.max(inner - backLink.length, 0))} />
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
              <Line segments={[seg("  loading earlier items…", styles.dim)]} />
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
        {more > 0 ? <Line segments={[seg(`  +${more} more requests`, styles.dim)]} /> : null}
        <Line segments={rule} />
        {sends.queued.length > 0 ? (
          <QueuedLines lines={queuedLines(sends.queued, theme, inner)} />
        ) : null}
        <Composer
          theme={theme}
          field={field}
          focused={typing}
          focus={() => setComposing(true)}
          send={send}
          placeholder={answerPlaceholder}
        />
        <Hint segments={hintSegments(hintKeys(question, typing), theme, inner)} />
        {help ? (
          <KeyHelp theme={theme} width={width} height={height} keys={interviewViewKeys} />
        ) : null}
        {box?._tag === "Leave" ? (
          <LeaveQuestion yes={() => answerLeave(true)} no={() => answerLeave(false)} />
        ) : null}
      </box>
    </LooksContext.Provider>
  )
}
