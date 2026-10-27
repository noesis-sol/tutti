// An open question put before an overnight run (§ 5 item 2; src/run/overnightQuestions.ts), in the
// command's renderer, as the start question is asked there (Form.tsx's ask): the answer form's
// choices for a question ticket, its heading, title and description, then its options from the
// metadata, the recommended one first and marked, Other with a line to type your own, Talk it
// through where the caller offers it (§ 4.11: the question talked through in a session, whose
// answer comes back as the form's), and Leave open. ↑ and ↓ move the selector, Enter chooses (on Other it sends what is typed), PgUp and PgDn
// scroll a description taller than its room; Esc or Ctrl+C stops the run before it starts. A click
// on a choice chooses it, as Enter on it does (D9, § 7.3); one on Other's line focuses it.
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import type { Effect } from "effect"
import { useRef, useState } from "react"
import type { Key } from "../run/runView.ts"
import { type Answers, ask, Field, formHintSegments, targetLines } from "./Form.tsx"
import { type Command, useFormCommands } from "./keyCommands.ts"
import { Line, Lines, type Look, type Segments, seg, wrap } from "./line.tsx"
import {
  type Choice,
  choicesOf,
  type FormCancelled,
  leaveOpen,
  noAnswerTyped,
  type OpenQuestion,
  otherChoice,
  type QuestionAt,
  questionHeading,
  type Reply,
  talkChoice,
} from "./questions.ts"
import type { Shell } from "./renderer.ts"
import type { Appearance, Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"

/** What the open question's keys do. */
export interface OpenQuestionActions {
  /** Moves the selector by one. */
  readonly move: (by: number) => void
  /** Chooses the choice the selector is on. */
  readonly choose: () => void
  /** Scrolls the description by a page, up (-1) or down (1). */
  readonly scroll: (by: number) => void
  readonly cancel: () => void
}

/** What Esc does where the questions are put: its hint, and what Other with nothing typed says. */
export interface Closing {
  readonly does: string
  readonly noAnswer: string
}

/** Before an overnight run, Esc stops the run before it starts. */
export const beforeRun: Closing = {
  does: "stop before the run",
  noAnswer: noAnswerTyped("Esc"),
}

/**
 * The open question's keys: Other's line takes every other key, as it is typed in. `does` names
 * Esc's in the hint.
 */
export const openQuestionCommands = (
  act: OpenQuestionActions,
  does: string = beforeRun.does,
): ReadonlyArray<Command> => [
  { keys: ["up"], run: () => act.move(-1), hint: { keys: "↑↓", does: "choose" } },
  { keys: ["down"], run: () => act.move(1) },
  { keys: ["return", "kpenter"], run: act.choose, hint: { keys: "Enter", does: "confirm" } },
  { keys: ["pageup"], run: () => act.scroll(-1), hint: { keys: "PgUp/PgDn", does: "scroll" } },
  { keys: ["pagedown"], run: () => act.scroll(1) },
  {
    keys: ["escape", "ctrl+c"],
    run: act.cancel,
    hint: { keys: "Esc", does },
  },
]

/** The columns a field's text is in from the screen's edges: the form's padding, and the bar's. */
const fieldInset = 4

/** The columns the hint is in from the screen's edges: the form's padding. */
const hintInset = 2

/** The fewest lines of the description shown, however short the screen. */
const leastDescription = 1

/** A choice's text: an option with its trade-off, Other, Talk it through, Leave open. */
const choiceSegments = (choice: Choice, look: Look, theme: Theme): Segments => {
  switch (choice._tag) {
    case "Option":
      return [
        seg(choice.label, look),
        ...(choice.description === ""
          ? []
          : [seg(` — ${choice.description}`, theme.form.description)]),
      ]
    case "Other":
      return [seg(`${otherChoice}: `, look)]
    case "Talk":
      return [
        seg(talkChoice, look),
        seg(" — in a session that reads the code, before answering", theme.form.description),
      ]
    case "LeaveOpen":
      return [seg(leaveOpen, look)]
  }
}

export const OpenQuestionForm = ({
  theme,
  question,
  at,
  answer,
  cancel,
  bind = useFormCommands,
  closing = beforeRun,
  talk = false,
}: {
  readonly theme: Theme
  readonly question: OpenQuestion
  readonly at: QuestionAt
  /**
   * Binds the form's keys and gives the hint's: on the form keymap of ask()'s renderer when left
   * out; the dashboard's box binds them in its box layer (QuestionsBox.tsx). The same for every
   * render.
   */
  readonly bind?: (commands: ReadonlyArray<Command>) => ReadonlyArray<Key>
  readonly closing?: Closing
  /** Whether Talk it through is offered: where a talk can be shown, in the renderer before a run. */
  readonly talk?: boolean
} & Answers<Reply>) => {
  const choices = choicesOf(question, talk)
  const other = choices.findIndex((choice) => choice._tag === "Other")
  // The keys of one read each see the ones before them: Down and Enter together choose the second.
  const [highlighted, setHighlighted, highlightedNow] = useKeyState(() => 0)
  const [typed, setTyped, typedNow] = useKeyState(() => "")
  const [error, setError] = useState<string | null>(null)
  const input = useRef<InputRenderable>(null)
  const scrollbox = useRef<ScrollBoxRenderable>(null)
  const { form } = theme

  /** The selector on choice `to`: Other's line focused, so that the keys after it type in it. */
  const highlight = (to: number) => {
    const next = Math.min(choices.length - 1, Math.max(0, to))
    setHighlighted(() => next)
    setError(null)
    if (next === other) input.current?.focus()
    else input.current?.blur()
  }

  const choose = (index: number) => {
    const choice = choices[index]
    if (choice === undefined) return
    switch (choice._tag) {
      case "Option":
        return answer({ _tag: "Answer", answer: choice.answer })
      case "LeaveOpen":
        return answer({ _tag: "LeaveOpen" })
      case "Talk":
        return answer({ _tag: "Talk" })
      case "Other": {
        const text = typedNow().trim()
        if (text === "") setError(closing.noAnswer)
        else answer({ _tag: "Answer", answer: text })
      }
    }
  }

  const { width, height } = useTerminalDimensions()
  const room = Math.max(width - fieldInset, 1)
  const page = Math.max(height - 4, 1)
  const hint = bind(
    openQuestionCommands(
      {
        move: (by) => highlight(highlightedNow() + by),
        choose: () => choose(highlightedNow()),
        scroll: (by) => scrollbox.current?.scrollBy(by * page),
        cancel,
      },
      closing.does,
    ),
  )

  const paragraph = (text: string, look: Look) => wrap([seg(text, look)], room)
  const heading = [
    ...paragraph(questionHeading(question, at), form.description),
    ...paragraph(question.title, form.fieldTitle),
  ]
  const described =
    question.description === ""
      ? []
      : question.description
          .split("\n")
          .flatMap((each) => (each.trim() === "" ? [[]] : paragraph(each, form.description)))
  /** Choice `index`'s lines, the selector on the highlighted one. */
  const choiceLines = (index: number) => {
    const choice = choices[index]
    if (choice === undefined) return []
    const on = index === highlighted
    const look = on ? form.selected : form.option
    return [
      [
        seg(on ? "> " : "  ", on ? form.selector : form.option),
        ...choiceSegments(choice, look, theme),
      ],
    ]
  }
  const options = targetLines(
    choices.slice(0, other).flatMap((_, index) => choiceLines(index)),
    room,
  )
  // The choices after Other: Talk it through where offered, and Leave open.
  const after = choices.slice(other + 1).map((_, at) => other + 1 + at)
  const leave = targetLines(
    after.flatMap((index) => choiceLines(index)),
    room,
  )
  const errorLines = error === null ? [] : paragraph(error, form.error)
  const hintLines = wrap(formHintSegments(hint, theme), Math.max(width - hintInset, 1))
  // The description gets the lines the rest leaves, at least one, and scrolls within them.
  const rest = 1 + heading.length + 1 + options.length + 1 + leave.length + errorLines.length + 1
  const descriptionRoom = Math.max(height - rest - hintLines.length, leastDescription)
  const descriptionHeight = Math.min(described.length, descriptionRoom)
  const otherOn = highlighted === other

  return (
    <box flexDirection="column" paddingX={1} paddingTop={1}>
      <Field theme={theme} focused>
        <Lines lines={heading} />
        {descriptionHeight === 0 ? null : (
          <scrollbox
            ref={scrollbox}
            height={descriptionHeight}
            flexShrink={0}
            focusable={false}
            scrollbarOptions={{ visible: described.length > descriptionHeight }}
          >
            <Lines lines={described} />
          </scrollbox>
        )}
        <box flexDirection="column" paddingTop={1} flexShrink={0}>
          <Lines
            lines={options}
            press={(index) => {
              highlight(index)
              choose(index)
            }}
          />
          <box flexDirection="row" height={1} flexShrink={0}>
            <Line segments={choiceLines(other)[0] ?? []} press={() => highlight(other)} />
            <input
              ref={input}
              focused={otherOn}
              flexGrow={1}
              value={typed}
              onInput={(text: string) => {
                setTyped(() => text)
                setError(null)
                if (highlightedNow() !== other) highlight(other)
              }}
              placeholder="type your own answer"
              {...(form.option.fg === undefined ? {} : { textColor: form.option.fg })}
              {...(form.option.fg === undefined ? {} : { focusedTextColor: form.option.fg })}
              {...(form.placeholder.fg === undefined
                ? {}
                : { placeholderColor: form.placeholder.fg })}
              {...(form.selected.fg === undefined ? {} : { cursorColor: form.selected.fg })}
            />
          </box>
          <Lines
            lines={leave}
            press={(at) => {
              const index = after[at]
              if (index === undefined) return
              highlight(index)
              choose(index)
            }}
          />
          <Lines lines={errorLines} />
        </box>
      </Field>
      <box flexDirection="column" paddingTop={1} flexShrink={0}>
        <Lines lines={hintLines} />
      </box>
    </box>
  )
}

/**
 * Puts the open question `question`, `at` of those put, in `shell`'s renderer: an option's label,
 * your own text, Talk it through where `talk` offers it, or Leave open. Fails with FormCancelled on
 * Esc or Ctrl+C.
 */
export const askOpenQuestion = (
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  question: OpenQuestion,
  at: QuestionAt,
  talk = false,
): Effect.Effect<Reply, FormCancelled> =>
  ask<Reply>(shell, themeOf, (theme, answers) => (
    <OpenQuestionForm
      key={question.id}
      theme={theme}
      question={question}
      at={at}
      talk={talk}
      {...answers}
    />
  ))
