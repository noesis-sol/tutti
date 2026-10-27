// The questions box (Box.Questions, § 7.2, tutti-kkb.35): Shift+A on the dashboard puts the open
// questions in the run's scope to you while the run goes on, one by one, in the answer form the
// overnight pre-flight puts them in (OpenQuestion.tsx): the question's title and description, its
// options from the metadata, the recommended one first and marked, Other to type your own, and
// Leave open. The box offers ReadQuestions as it opens, and says it is reading them until the run
// has (questionNews.ts); with none open, or bd unable to say, a toast says so and the box closes.
// Each answer is offered as AnswerQuestion, and the next question shown at once: the run records
// it with bd (answerQuestion.ts: the decision in each blocked ticket's design, then bd human
// respond), and a toast says how it went, the box open or not (QuestionToasts). Esc closes the box,
// leaving the rest open; the keys are bound in the box layer, Esc from before the box opens.
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { QuestionNews } from "../run/questionNews.ts"
import { type Command, useCommands } from "./keyCommands.ts"
import { useInput } from "./keys.ts"
import { seg } from "./line.tsx"
import { Modal } from "./Modal.tsx"
import { type Closing, OpenQuestionForm } from "./OpenQuestion.tsx"
import type { Reply } from "./questions.ts"
import { sanitizeLine } from "./sanitize.ts"
import type { ToastStore } from "./Toasts.tsx"
import { useCommand, useQuestionNews, useTheme } from "./useRunView.ts"

/** On the dashboard, Esc closes the box, the questions not yet answered left open. */
export const dashboardClosing: Closing = {
  does: "close",
  noAnswer: "type your answer first, or press Esc to close",
}

/** What the box says until the run has read the questions. */
export const readingText = "Reading the open questions…"

/** The toast when no question is open in the run's scope. */
export const noneOpenText = "No open questions to answer"

/** The toast of a news item, or null for one that has none (the questions read). */
export const newsToast = (
  news: QuestionNews,
): { readonly text: string; readonly failure: boolean } | null => {
  switch (news._tag) {
    case "Read":
      return news.questions.length === 0 ? { text: noneOpenText, failure: false } : null
    case "NotRead":
      return { text: sanitizeLine(`couldn't read the questions: ${news.why}`), failure: true }
    case "Answered":
      return { text: sanitizeLine(`Answered ${news.question} (${news.title})`), failure: false }
    case "NotAnswered":
      return {
        text: sanitizeLine(`couldn't record the answer to ${news.question}: ${news.why}`),
        failure: true,
      }
  }
}

/**
 * The form's keys in the box layer while the questions box is open, Esc and Ctrl+C left out: Esc
 * is QuestionsKeys', and Ctrl+C the global quit's.
 */
const useBoxCommands = (commands: ReadonlyArray<Command>) =>
  useCommands(
    "box",
    commands.map((command) => ({
      ...command,
      keys: command.keys.filter((key) => key !== "escape" && key !== "ctrl+c"),
    })),
    "Questions",
  ).hint

/** Esc, which closes the questions box: bound before it opens, so it closes it while it reads. */
export const QuestionsKeys = () => {
  const { box } = useInput()
  useCommands("box", [{ keys: ["escape"], run: () => box.set(null) }], "Questions")
  return null
}

/** Shows each news item's toast once, as it comes: whether the box is still open or not. */
export const QuestionToasts = ({ toasts }: { readonly toasts: ToastStore }) => {
  const news = useQuestionNews()
  const seen = useRef(new Set<QuestionNews>())
  useEffect(() => {
    for (const item of news) {
      if (seen.current.has(item)) continue
      seen.current.add(item)
      const toast = newsToast(item)
      if (toast !== null) toasts.show(toast.text, { failure: toast.failure })
    }
  }, [news, toasts])
  return null
}

export const QuestionsBox = () => {
  const theme = useTheme()
  const command = useCommand()
  const { box } = useInput()
  const { width, height } = useTerminalDimensions()
  const [uuid] = useState(() => crypto.randomUUID())
  const [at, setAt] = useState(0)
  useEffect(() => command(UiCommand.ReadQuestions({ uuid })), [command, uuid])
  const read = useQuestionNews().find(
    (news) => news.uuid === uuid && (news._tag === "Read" || news._tag === "NotRead"),
  )
  const close = () => box.set(null)
  const questions = read?._tag === "Read" ? read.questions : undefined
  // None to put, or bd couldn't say: QuestionToasts says so, and the box closes.
  const done = read !== undefined && (questions === undefined || at >= questions.length)
  useEffect(() => {
    if (done) box.set(null)
  }, [done, box])

  if (read === undefined) {
    return (
      <Modal
        frame={theme.look("notice")}
        paragraphs={[seg(readingText)]}
        choices={[{ keys: [], run: close, hint: { keys: "Esc", does: "close" } }]}
      />
    )
  }
  const question = questions?.[at]
  if (questions === undefined || question === undefined) return null
  const reply = (given: Reply) => {
    if (given._tag === "Answer") {
      command(
        UiCommand.AnswerQuestion({
          question: question.id,
          answer: given.answer,
          uuid: crypto.randomUUID(),
        }),
      )
    }
    setAt((now) => now + 1)
  }
  return (
    <box
      position="absolute"
      zIndex={10}
      left={0}
      top={0}
      width={width}
      height={height}
      // Opaque, in the terminal's own background: the dashboard doesn't show through its spaces.
      backgroundColor={RGBA.defaultBackground()}
      flexDirection="column"
    >
      <OpenQuestionForm
        key={question.id}
        theme={theme}
        question={question}
        at={{ index: at, of: questions.length }}
        answer={reply}
        cancel={close}
        bind={useBoxCommands}
        closing={dashboardClosing}
      />
    </box>
  )
}
