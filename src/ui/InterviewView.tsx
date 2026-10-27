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
// A spec's refinement and a question's talk (run/answerTalk.ts) are shown the same way, with their
// own name in the head and their own leaving question.
//
// The keys, in the view's layer: `Tab`, `Shift+Tab` and the arrows move between the items and the
// panel's requests, and between a request's buttons; `Enter` expands or collapses the selected item
// or presses the focused button; `1`–`4` pick a question's option; `d` and `Shift+D` decline it;
// PgUp/PgDn and `g`/`G` scroll; `i` or a click focuses the composer; `?` shows the keys.
// The transcript, the panel, the selection, the composer and these keys are the worker view's
// (transcriptView.ts); the hint wraps as its does.
import { useTerminalDimensions } from "@opentui/react"
import { createContext, useContext, useEffect, useState } from "react"
import { MessageUuid } from "../agent/AgentHost.ts"
import { interviewWorker } from "../agent/interview.ts"
import { type Filing, filedSomething } from "../agent/interviewTools.ts"
import { settled as hasSettled } from "../agent/WorkerState.ts"
import { UiCommand } from "../run/commands.ts"
import { cardMark, elapsed, statusLook } from "./Card.tsx"
import { Composer, QueuedLines, queuedLines } from "./Composer.tsx"
import { hintLines } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { type Command, type HelpRow, hintOf, useCommands } from "./keyCommands.ts"
import { Box, useInput } from "./keys.ts"
import { Line, Section, type Segments, seg } from "./line.tsx"
import { Modal } from "./Modal.tsx"
import { sanitizeLine } from "./sanitize.ts"
import {
  inertTranscript,
  type TranscriptActions,
  transcriptCommands,
  useComposer,
  usePanel,
  useSelection,
  useTranscriptKeys,
  useTranscriptWindow,
} from "./transcriptView.ts"
import { type External, useCommand, useRunViewPart, useTheme } from "./useRunView.ts"
import { panelBudget, underToasts, type ViewChrome, ViewHint, viewLayout } from "./WorkerView.tsx"
import { aboveLines, ViewHead } from "./worker/Head.tsx"
import { LooksContext, useSyntaxStyles } from "./worker/Looks.tsx"
import { RequestPanel, usePanelRooms } from "./worker/Panel.tsx"
import { TranscriptPane, TranscriptSection } from "./worker/Story.tsx"

/** What the Interview view reads besides the shell: the description, and what has been filed. */
export interface InterviewValue {
  readonly description: string
  readonly filing: External<Filing>
  /** Whether something is filed, where `filing` doesn't say: a spec's refinement (§ 4.14). */
  readonly filed?: External<boolean>
  /** What leaving asks while nothing is filed, in place of the interview's (leaveQuestion). */
  readonly leaveQuestion?: string
  /** What leaving says under its question, in place of the interview's (leaveAbout). */
  readonly leaveAbout?: string
  /** What the head names the session by, in place of `Interview`: a question's talk (§ 4.11). */
  readonly name?: string
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

const nothing = () => {}

const writeRow: HelpRow = [
  "i, a click on the composer",
  "write your answer; Enter sends, Alt+Enter or Ctrl+J a new line",
]
const moveRow: HelpRow = [
  "Tab, Shift+Tab, arrows",
  "move between items; between a question's options",
]
const pickRow: HelpRow = ["1–4 in a question", "pick an option"]
const declineRow: HelpRow = ["d, Shift+D", "decline the question; decline with a reason"]
const scrollRow: HelpRow = ["the wheel, PgUp/PgDn", "scroll; past the top loads earlier items"]
const jumpRow: HelpRow = ["g, G", "jump to the top or the end"]

/**
 * The Interview view's keys (§ 7.3), its hint's and its key help's: the keys there are; the
 * composer's while you write in it. `question`: the panel has a question open, which 1–4 pick from.
 */
export const interviewCommands = (
  at: { readonly question: boolean; readonly composing: boolean },
  act: TranscriptActions = inertTranscript,
): ReadonlyArray<Command> => {
  const keys = transcriptCommands(act)
  const viewing = !at.composing
  const named = (shown: boolean, keys: string, does: string) => (shown ? { keys, does } : undefined)
  return [
    // The composer's own keys, which its field binds.
    { keys: [], run: nothing, hint: named(at.composing, "Enter", "send"), help: writeRow },
    {
      keys: [],
      run: nothing,
      hint: named(at.composing, "Alt+Enter/Ctrl+J", "new line"),
      help: writeRow,
    },
    {
      ...keys.escape,
      hint: { keys: "Esc", does: at.composing ? "leave the composer" : "back" },
      help: ["Esc, ← Back", "leave the composer; end the interview (asks first)"],
    },
    { ...keys.write, hint: named(viewing, "i", "answer"), help: writeRow },
    ...keys.picks.map((pick, i) => ({
      ...pick,
      hint: named(i === 0 && viewing && at.question, "1–4", "pick"),
      help: pickRow,
    })),
    { ...keys.down, hint: named(viewing, "↑↓", "select"), help: moveRow },
    { ...keys.up, help: moveRow },
    { ...keys.next, help: moveRow },
    { ...keys.previous, help: moveRow },
    {
      ...keys.enter,
      hint: named(viewing, "Enter", "expand"),
      help: ["Enter, a click", "expand or collapse the item; press the focused button"],
    },
    { ...keys.pageUp, hint: named(viewing, "PgUp/PgDn", "scroll"), help: scrollRow },
    { ...keys.pageDown, help: scrollRow },
    { ...keys.help, hint: named(viewing, "?", "keys"), help: ["?", "these keys"] },
    { ...keys.deny, help: declineRow },
    { ...keys.denyWithReason, help: declineRow },
    { ...keys.allow, help: ["a", "allow the request, unless it opens on Deny"] },
    { ...keys.forRun, help: ["r", "allow for this run"] },
    {
      keys: [],
      run: nothing,
      help: ["Answer in view", "the answer form: ↑↓ move, Space picks, Enter presses"],
    },
    { ...keys.top, help: jumpRow },
    { ...keys.end, help: jumpRow },
  ]
}

/** Leaving's question's keys: `y` ends the interview, `n` or `Esc` stays. */
const leaveCommands = (yes: () => void, no: () => void): ReadonlyArray<Command> => [
  { keys: ["y"], run: yes, hint: { keys: "y", does: "end it" } },
  { keys: ["n", "escape"], run: no, hint: { keys: "n", does: "keep talking" } },
]

/** Leaving's question, over the view, its keys leaveCommands. */
export const LeaveQuestion = ({
  yes,
  no,
  question = leaveQuestion,
  about = leaveAbout,
}: {
  readonly yes: () => void
  readonly no: () => void
  readonly question?: string
  readonly about?: string
}) => {
  const theme = useTheme()
  return (
    <Modal
      frame={theme.look("notice")}
      paragraphs={[seg(question, theme.look("notice", "bold")), seg(""), seg(about)]}
      choices={leaveCommands(yes, no)}
    />
  )
}

/** The interview's view, while the run shows it. */
export const InterviewView = () => {
  const interview = useContext(InterviewContext)
  if (interview === null) throw new Error("the Interview view is drawn outside its interview")
  const card = useRunViewPart((view) => view.cards.find((each) => each.ticket === interviewWorker))
  const theme = useTheme()
  const looks = useSyntaxStyles(theme)
  const command = useCommand()
  const { width, height } = useTerminalDimensions()

  // The transcript, open while the view is; the panel: the session's oldest open requests.
  const transcript = useTranscriptWindow(
    interviewWorker,
    card?.state != null && !hasSettled(card.state),
  )
  const { sends } = transcript
  const composer = useComposer()
  const input = useInput()
  const inner = Math.max(width, 1)
  const queued = queuedLines(sends.queued, theme, inner)
  // The panel has the height the view's other parts leave it, and a few of the transcript's
  // (tutti-7nzv), the hint as it is with a question.
  const [headLines, setHeadLines] = useState(1)
  // The hint's lines with a question, for the panel's room, and as they are: each worked out once.
  const hintWith = (question: boolean) =>
    hintLines(hintOf(interviewCommands({ question, composing: composer.typing })), theme, inner)
  const askedHint = hintWith(true)
  const chrome = (hint: ReadonlyArray<Segments>): ViewChrome => ({
    above: aboveLines(width, height),
    head: headLines,
    headGap: 0,
    title: 0,
    ticketGap: 0,
    ticket: 0,
    ticketMore: 0,
    handBack: 0,
    held: 0,
    line: 0,
    queued: queued.length,
    composer: composer.lines,
    hint: hint.length,
  })
  const fit = usePanelRooms(
    theme,
    Math.max(inner - 2, 8),
    panelBudget(height, chrome(askedHint)),
    height,
  )
  const panel = usePanel(
    card,
    (requests, waiting) => fit.rooms(requests, waiting - requests.length).length,
  )
  const selection = useSelection(transcript, panel)
  const send = (text: string) => {
    const uuid = MessageUuid.draw()
    sends.sent({ uuid, ticket: interviewWorker, text })
    command(UiCommand.SendMessage({ ticket: interviewWorker, text, uuid }))
    return true
  }

  // Leaving asks first while nothing has been filed.
  const leave = () => {
    if (interview.filed?.get() ?? filedSomething(interview.filing.get())) {
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
  useCommands(
    "box",
    leaveCommands(
      () => answerLeave(true),
      () => answerLeave(false),
    ),
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
  const { help, actions } = useTranscriptKeys({
    transcript,
    panel,
    selection,
    composer,
    back: leave,
  })

  const rule: Segments = [seg("─".repeat(inner), theme.look("frame"))]
  const { styles } = theme
  const name = interview.name ?? "Interview"
  const head = (now: number, spin: string): Segments =>
    card === undefined
      ? [seg(name, styles.picked)]
      : [
          cardMark(card, theme, spin),
          seg("  "),
          seg(name, styles.picked),
          seg("  "),
          seg(card.status, statusLook(card, theme)),
          seg("  "),
          seg(elapsed(now - card.since), styles.dim),
          seg("   "),
          seg(sanitizeLine(card.title)),
        ]
  const question = panel.requests.some((request) => request.kind._tag === "Question")
  const keys = useCommands(
    "view",
    interviewCommands({ question, composing: composer.typing }, actions),
  )
  const hint = question ? askedHint : hintWith(false)
  const laid = viewLayout(height, chrome(hint), fit.lines(panel.requests, panel.more))
  const { box } = composer
  return (
    <LooksContext.Provider value={looks}>
      <box flexDirection="column" width={width} height={height}>
        <Section lines={laid.above} />
        <Section lines={laid.head}>
          <ViewHead
            link={backLink}
            leave={leave}
            head={head}
            spinning={card?.motion === "spinner"}
            width={inner}
            counted={setHeadLines}
          />
        </Section>
        <Section lines={laid.rules[0]}>
          <Line segments={rule} />
        </Section>
        <TranscriptSection lines={laid.transcript}>
          <TranscriptPane transcript={transcript} selection={selection} width={inner} />
        </TranscriptSection>
        <Section lines={laid.panel}>
          <RequestPanel
            panel={panel}
            selection={selection}
            width={Math.max(inner - 2, 8)}
            rooms={fit.rooms(panel.requests, panel.more)}
          />
        </Section>
        <Section lines={laid.rules[1]}>
          <Line segments={rule} />
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
            placeholder={answerPlaceholder}
          />
        </Section>
        <Section lines={laid.hint}>
          <ViewHint lines={hint} under={underToasts(laid)} />
        </Section>
        {help ? <KeyHelp theme={theme} width={width} height={height} keys={keys.help} /> : null}
        {box?._tag === "Leave" ? (
          <LeaveQuestion
            yes={() => answerLeave(true)}
            no={() => answerLeave(false)}
            {...(interview.leaveQuestion === undefined
              ? {}
              : { question: interview.leaveQuestion })}
            {...(interview.leaveAbout === undefined ? {} : { about: interview.leaveAbout })}
          />
        ) : null}
      </box>
    </LooksContext.Provider>
  )
}
