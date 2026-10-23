// The start question (§ 5 item 3, § 7.1), in the command's renderer, before the dashboard: a
// select of the current tickets (with their count) or a new feature, and for a new feature a
// textarea for its description. As orchestra's huh form: ↑ and ↓ (or k and j) move the selector,
// Enter chooses; in the description Enter submits and Alt+Enter or Ctrl+J starts a new line
// (Ctrl+J for terminals whose legacy encoding can't tell Alt+Enter from Enter, § 7.7), and
// Shift+Tab goes back to the select. Esc or Ctrl+C cancels: nothing has started yet. A click on an
// option chooses it, as Enter on it does (D9, § 7.3); one on the description focuses it, as the
// renderer focuses what is clicked.
import type { KeyBinding, TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import type { Effect } from "effect"
import { useRef, useState } from "react"
import { type Answers, ask, clickable, Field, Hint } from "./Form.tsx"
import { plainFg, styled } from "./line.tsx"
import {
  describeDescription,
  describeTitle,
  type FormCancelled,
  newLineHint,
  noDescription,
  startDescription,
  startOptions,
  startTitle,
  type TicketCount,
  Work,
} from "./questions.ts"
import type { Shell } from "./renderer.ts"
import type { Appearance, Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"

/** The description's keys: Enter submits; Alt+Enter, Ctrl+J (legacy and Kitty) a new line. */
export const descriptionKeys: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", meta: true, action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
]

/** How many lines the description's textarea shows, as orchestra's. */
const descriptionLines = 6

export const StartQuestion = ({
  theme,
  count,
  answer,
  cancel,
}: { readonly theme: Theme; readonly count: TicketCount } & Answers<Work>) => {
  // The keys of one read each see the ones before them: Down and Enter together choose New feature.
  const [step, setStep, stepNow] = useKeyState<"choose" | "describe">(() => "choose")
  const [highlighted, setHighlighted, highlightedNow] = useKeyState(() => 0)
  const [error, setError] = useState<string | null>(null)
  const description = useRef<TextareaRenderable>(null)
  const options = startOptions(count)
  const { form } = theme

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      cancel()
      return
    }
    if (stepNow() === "describe") {
      if (key.name === "tab" && key.shift) setStep(() => "choose")
      return
    }
    if (key.name === "up" || key.name === "k") setHighlighted((at) => Math.max(0, at - 1))
    else if (key.name === "down" || key.name === "j") {
      setHighlighted((at) => Math.min(options.length - 1, at + 1))
    } else if (key.name === "return" || key.name === "kpenter") choose(highlightedNow())
  })

  // Option `at` chosen: the current tickets answer; a new feature asks for its description.
  const choose = (at: number) => {
    if (at === 0) answer(Work.Tickets())
    else if (stepNow() === "choose") {
      setError(null)
      setStep(() => "describe")
    }
  }

  const submit = () => {
    const text = description.current?.plainText.trim() ?? ""
    if (text === "") setError(noDescription("Esc"))
    else answer(Work.Feature({ description: text }))
  }

  return (
    <box flexDirection="column" paddingX={1} paddingTop={1}>
      <Field theme={theme} focused={step === "choose"}>
        <text {...styled(form.fieldTitle)}>{startTitle}</text>
        <text {...styled(form.description)}>{startDescription}</text>
        {options.map((option, at) => (
          <text
            key={option}
            fg={plainFg}
            {...clickable(() => {
              setHighlighted(() => at)
              choose(at)
            })}
          >
            {at === highlighted ? (
              <>
                <span {...styled(form.selector)}>{"> "}</span>
                <span {...styled(form.selected)}>{option}</span>
              </>
            ) : (
              <span {...styled(form.option)}>{`  ${option}`}</span>
            )}
          </text>
        ))}
      </Field>
      {step === "describe" ? (
        <box flexDirection="column" paddingTop={1}>
          <Field theme={theme} focused>
            <text {...styled(form.fieldTitle)}>{describeTitle}</text>
            <text {...styled(form.description)}>{`${describeDescription} ${newLineHint}`}</text>
            <textarea
              ref={description}
              focused
              height={descriptionLines}
              keyBindings={descriptionKeys}
              onSubmit={submit}
              onContentChange={() => setError(null)}
              placeholder="What should it do, and why?"
              {...(form.option.fg === undefined ? {} : { textColor: form.option.fg })}
              {...(form.option.fg === undefined ? {} : { focusedTextColor: form.option.fg })}
              {...(form.placeholder.fg === undefined
                ? {}
                : { placeholderColor: form.placeholder.fg })}
              {...(form.selected.fg === undefined ? {} : { cursorColor: form.selected.fg })}
            />
            {error === null ? null : <text {...styled(form.error)}>{error}</text>}
          </Field>
        </box>
      ) : null}
      <box paddingTop={1}>
        <Hint
          theme={theme}
          keys={
            step === "choose"
              ? [
                  { keys: "↑↓", does: "choose" },
                  { keys: "Enter", does: "confirm" },
                  { keys: "Esc", does: "cancel" },
                ]
              : [
                  { keys: "Enter", does: "submit" },
                  { keys: "Alt+Enter or Ctrl+J", does: "new line" },
                  { keys: "Shift+Tab", does: "back" },
                  { keys: "Esc", does: "cancel" },
                ]
          }
        />
      </box>
    </box>
  )
}

/**
 * Asks the start question in `shell`'s renderer: the current tickets, as `count` says of them,
 * or a new feature and its description. Fails with FormCancelled on Esc or Ctrl+C.
 */
export const askStart = (
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  count: TicketCount,
): Effect.Effect<Work, FormCancelled> =>
  ask<Work>(shell, themeOf, (theme, answers) => (
    <StartQuestion theme={theme} count={count} {...answers} />
  ))
