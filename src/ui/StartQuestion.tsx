// The start question (§ 5 item 3, § 7.1), in the command's renderer, before the dashboard: a
// select of the current tickets (with their count) or a new feature, and for a new feature a
// textarea for its description. As orchestra's huh form: ↑ and ↓ (or k and j) move the selector,
// Enter chooses; in the description Enter submits and Alt+Enter or Ctrl+J starts a new line
// (Ctrl+J for terminals whose legacy encoding can't tell Alt+Enter from Enter, § 7.7), and
// Shift+Tab goes back to the select, keeping what was typed. Esc or Ctrl+C cancels: nothing has
// started yet. A click on an option chooses it, as Enter on it does (D9, § 7.3); one on the
// description focuses it, as the renderer focuses what is clicked.
import type { KeyBinding, TextareaRenderable } from "@opentui/core"
import type { Effect } from "effect"
import { useRef, useState } from "react"
import { type Answers, ask, clickable, Field, Hint } from "./Form.tsx"
import { type Command, useFormCommands } from "./keyCommands.ts"
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

/** What the start question's keys do, in its step `step` now. */
export interface StartActions {
  readonly step: () => "choose" | "describe"
  /** Moves the selector by one. */
  readonly move: (by: number) => void
  /** Chooses the option the selector is on. */
  readonly choose: () => void
  /** Goes back from the description to the select, keeping what was typed. */
  readonly back: () => void
  readonly cancel: () => void
}

/**
 * The start question's keys: the select's while it chooses, the description's while it is typed
 * in, whose Enter, Alt+Enter and Ctrl+J are the textarea's own (descriptionKeys).
 */
export const startCommands = (act: StartActions): ReadonlyArray<Command> => {
  const choosing = () => act.step() === "choose"
  const describing = () => act.step() === "describe"
  return [
    {
      keys: ["up", "k"],
      run: () => act.move(-1),
      when: choosing,
      hint: { keys: "↑↓", does: "choose" },
    },
    { keys: ["down", "j"], run: () => act.move(1), when: choosing },
    // The Enter that chooses isn't the description's: it would submit it empty.
    {
      keys: ["return", "kpenter"],
      run: act.choose,
      when: choosing,
      hint: { keys: "Enter", does: "confirm" },
    },
    { keys: [], run: () => {}, when: describing, hint: { keys: "Enter", does: "submit" } },
    {
      keys: [],
      run: () => {},
      when: describing,
      hint: { keys: "Alt+Enter or Ctrl+J", does: "new line" },
    },
    {
      keys: ["shift+tab"],
      run: act.back,
      when: describing,
      hint: { keys: "Shift+Tab", does: "back" },
    },
    { keys: ["escape", "ctrl+c"], run: act.cancel, hint: { keys: "Esc", does: "cancel" } },
  ]
}

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

  const hint = useFormCommands(
    startCommands({
      step: stepNow,
      move: (by) => setHighlighted((at) => Math.min(options.length - 1, Math.max(0, at + by))),
      choose: () => choose(highlightedNow()),
      back: () => {
        setStep(() => "choose")
        // The read's keys after Shift+Tab are the select's, not the description's.
        description.current?.blur()
      },
      cancel,
    }),
  )

  // Option `at` chosen: the current tickets answer; a new feature asks for its description.
  const choose = (at: number) => {
    if (at === 0) answer(Work.Tickets())
    else if (stepNow() === "choose") {
      setError(null)
      setStep(() => "describe")
      // The read's keys after this Enter are the description's, before React draws it.
      description.current?.focus()
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
      {/* Mounted while hidden, so that the keys of the read that chose New feature reach it. */}
      <box flexDirection="column" paddingTop={1} visible={step === "describe"}>
        <Field theme={theme} focused>
          <text {...styled(form.fieldTitle)}>{describeTitle}</text>
          <text {...styled(form.description)}>{`${describeDescription} ${newLineHint}`}</text>
          <textarea
            ref={description}
            focused={step === "describe"}
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
      <box paddingTop={1}>
        <Hint theme={theme} keys={hint} />
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
