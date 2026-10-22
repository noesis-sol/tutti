// The Interview view (§ 4.10, § 7.1, § 7.3): the chat with the feature interview's session, in
// the command's one renderer, built from the worker view's components. Its chrome: `← Back`, then
// the interview's mark, status and elapsed time, and the description's first line, wrapped in a
// narrow pane as the worker view's header is, over a rule.
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
// The transcript, the panel, the selection, the composer and these keys are the worker view's
// (transcriptView.ts); the hint wraps as its does.
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { createContext, useContext, useEffect } from "react"
import { interviewWorker } from "../agent/interview.ts"
import { type Filing, filedSomething } from "../agent/interviewTools.ts"
import { settled as hasSettled } from "../agent/WorkerState.ts"
import { UiCommand } from "../run/commands.ts"
import { elapsed, statusLook } from "./Card.tsx"
import { Composer, QueuedLines, queuedLines } from "./Composer.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { Box, useInput, useLayer } from "./keys.ts"
import { Line, roleLook, type Segments, seg } from "./line.tsx"
import { Modal } from "./Modal.tsx"
import { sanitizeLine } from "./sanitize.ts"
import {
  useComposer,
  usePanel,
  useSelection,
  useTranscriptKeys,
  useTranscriptWindow,
} from "./transcriptView.ts"
import {
  type External,
  useCommand,
  useNow,
  useRunView,
  useSpinner,
  useTheme,
} from "./useRunView.ts"
import {
  LooksContext,
  RequestPanel,
  TranscriptPane,
  useSyntaxStyles,
  ViewHead,
  ViewHint,
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

/** The interview's view, while the run shows it. */
export const InterviewView = () => {
  const interview = useContext(InterviewContext)
  if (interview === null) throw new Error("the Interview view is drawn outside its interview")
  const view = useRunView()
  const theme = useTheme()
  const looks = useSyntaxStyles(theme)
  const now = useNow()
  const command = useCommand()
  const { width, height } = useTerminalDimensions()
  const card = view.cards.find((each) => each.ticket === interviewWorker)
  const spin = useSpinner(card?.motion === "spinner")

  // The transcript, open while the view is; the panel: the session's oldest open requests.
  const transcript = useTranscriptWindow(
    interviewWorker,
    card?.state != null && !hasSettled(card.state),
  )
  const { sends } = transcript
  const panel = usePanel(card)
  const selection = useSelection(transcript, panel)
  const composer = useComposer()
  const input = useInput()
  const send = (text: string) => {
    const uuid = crypto.randomUUID()
    sends.sent({ uuid, ticket: interviewWorker, text })
    command(UiCommand.SendMessage({ ticket: interviewWorker, text, uuid }))
    return true
  }

  // Leaving asks first while nothing has been filed.
  const leave = () => {
    if (filedSomething(interview.filing.get())) {
      command(UiCommand.CloseWorker())
      return
    }
    composer.blur()
    input.box.set(Box.Leave())
  }
  const answerLeave = (yes: boolean) => {
    if (input.box.get()?._tag !== "Leave") return
    input.box.set(null)
    if (yes) command(UiCommand.CloseWorker())
    else composer.refocus()
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
  // The view draws its Leave box and binds its keys: unmounted with it open, nothing would, and the
  // box would hold the keys of the view after it (tutti-por).
  useEffect(
    () => () => {
      if (input.box.get()?._tag === "Leave") input.box.set(null)
    },
    [input],
  )
  const help = useTranscriptKeys({ transcript, panel, selection, composer, back: leave })

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
  const question = panel.requests.some((request) => request.kind._tag === "Question")
  const { box } = composer
  return (
    <LooksContext.Provider value={looks}>
      <box flexDirection="column" width={width} height={height}>
        <ViewHead link={backLink} leave={leave} head={head} width={inner} />
        <Line segments={rule} />
        <TranscriptPane transcript={transcript} selection={selection} width={inner} />
        <RequestPanel
          panel={panel}
          selection={selection}
          width={Math.max(inner - 2, 8)}
          height={height}
        />
        <Line segments={rule} />
        {sends.queued.length > 0 ? (
          <QueuedLines lines={queuedLines(sends.queued, theme, inner)} />
        ) : null}
        <Composer
          theme={theme}
          field={composer.field}
          focused={composer.typing}
          focus={() => composer.setComposing(true)}
          send={send}
          placeholder={answerPlaceholder}
        />
        <ViewHint keys={hintKeys(question, composer.typing)} width={inner} />
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
