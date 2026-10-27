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
//
// Talk it through (tutti-i0sz, § 4.11) closes the box and offers TalkQuestion: the run shows the
// talk in place of the screen (App.tsx) and records the answer it gives as any other. Once the run
// says the talk is over (Talked), TalkReturn opens the box again: at the next question once it was
// answered, at the same one otherwise; a toast says why a talk that wasn't left gave no answer.
//
// Opened from the Needs you list (NeedsList.tsx, tutti-fdv1), the box puts that question alone, and
// once it is answered, left open or closed with Esc opens the list again at the next item.
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { talkLeftWhy } from "../agent/answerTalk.ts"
import { UiCommand } from "../run/commands.ts"
import type { QuestionNews } from "../run/questionNews.ts"
import type { TicketId } from "../services/Beads.ts"
import { type Command, useCommands } from "./keyCommands.ts"
import { Box, type NeedsAt, useInput } from "./keys.ts"
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

/** What a read's uuid starts with where none open needs no toast: the Needs you list's. */
const quietPrefix = "quiet-"

/** A uuid for a read whose having no question open needs no toast (the Needs you list's). */
export const quietUuid = (): string => `${quietPrefix}${crypto.randomUUID()}`

/** The toast of a news item, or null for one that has none (the questions read). */
export const newsToast = (
  news: QuestionNews,
): { readonly text: string; readonly failure: boolean } | null => {
  switch (news._tag) {
    case "Read":
      return news.questions.length === 0 && !news.uuid.startsWith(quietPrefix)
        ? { text: noneOpenText, failure: false }
        : null
    case "NotRead":
      return { text: sanitizeLine(`couldn't read the questions: ${news.why}`), failure: true }
    case "Answered":
      return { text: sanitizeLine(`Answered ${news.question} (${news.title})`), failure: false }
    case "NotAnswered":
      return {
        text: sanitizeLine(`couldn't record the answer to ${news.question}: ${news.why}`),
        failure: true,
      }
    case "Talked":
      // An answer has its own toast; a talk you left, none.
      return news.answered || news.why === null || news.why === talkLeftWhy
        ? null
        : {
            text: sanitizeLine(
              `the talk about ${news.question} ended without an answer: ${news.why}`,
            ),
            failure: true,
          }
  }
}

/**
 * Where the box opens again once the talk `news` says is over: the question after it once it was
 * answered (none: the box stays closed), the same one otherwise; null for other news.
 */
export const returnTo = (news: QuestionNews): { readonly first: TicketId } | null => {
  if (news._tag !== "Talked") return null
  if (!news.answered) return { first: news.question }
  return news.next === null ? null : { first: news.next }
}

/** Opens the box again as each talk from it is over (returnTo), unless another box is open. */
export const TalkReturn = () => {
  const news = useQuestionNews()
  const { box } = useInput()
  const seen = useRef(new Set<QuestionNews>())
  useEffect(() => {
    for (const item of news) {
      if (seen.current.has(item)) continue
      seen.current.add(item)
      const to = returnTo(item)
      if (to !== null && box.get() === null) box.set(Box.Questions(to))
    }
  }, [news, box])
  return null
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

/** The Needs you list `back` came from, at the item after the one opened. */
const nextIn = (back: NeedsAt): Box => Box.Needs({ ...back, at: back.at + 1 })

/** Where Esc goes from the questions box `open`: the Needs you list it came from, or none. */
const closedTo = (open: Box | null): Box | null =>
  open?._tag === "Questions" && open.back !== undefined ? nextIn(open.back) : null

/**
 * Esc, which closes the questions box, or goes back to the Needs you list it came from: bound
 * before it opens, so it closes it while it reads.
 */
export const QuestionsKeys = () => {
  const { box } = useInput()
  useCommands("box", [{ keys: ["escape"], run: () => box.set(closedTo(box.get())) }], "Questions")
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

/**
 * The box, its questions put from `first`'s where it is among them (the panel's Enter), else from
 * the first; with `back`, `first`'s alone, then the Needs you list again.
 */
export const QuestionsBox = ({
  first,
  back,
}: {
  readonly first?: TicketId | undefined
  readonly back?: NeedsAt | undefined
}) => {
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
  const close = () => box.set(back === undefined ? null : nextIn(back))
  const all = read?._tag === "Read" ? read.questions : undefined
  // From the Needs you list, its question alone.
  const questions = back === undefined ? all : all?.filter((question) => question.id === first)
  // Opened on a question from the panel beside the tickets table, the box starts at it.
  const startAt = questions?.findIndex((question) => question.id === first) ?? -1
  useEffect(() => {
    if (startAt > 0) setAt(startAt)
  }, [startAt])
  // None to put, or bd couldn't say: QuestionToasts says so, and the box closes.
  const done = read !== undefined && (questions === undefined || at >= questions.length)
  // biome-ignore lint/correctness/useExhaustiveDependencies: close is the latest render's
  useEffect(() => {
    if (done) close()
  }, [done])

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
    if (given._tag === "Talk") {
      // The talk takes the screen; TalkReturn opens the box again once it is over.
      command(
        UiCommand.TalkQuestion({
          question: question.id,
          title: question.title,
          next: questions[at + 1]?.id ?? null,
          uuid: crypto.randomUUID(),
        }),
      )
      return box.set(null)
    }
    if (given._tag === "Answer") {
      command(
        UiCommand.AnswerQuestion({
          question: question.id,
          answer: given.answer,
          uuid: crypto.randomUUID(),
        }),
      )
    }
    // Back to the list it came from: an answered question leaves it, so the next is at its place.
    if (back !== undefined) {
      const answered = given._tag === "Answer"
      return box.set(
        answered
          ? Box.Needs({ at: back.at, answered: [...back.answered, question.id] })
          : nextIn(back),
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
        talk
      />
    </box>
  )
}
