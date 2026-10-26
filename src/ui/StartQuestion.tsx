// The start question (§ 5 item 3, § 7.1), in the command's renderer, before the dashboard: a
// select of the current tickets (with their count), a spec or a new feature; for a spec, the field
// for its file or URL (SpecField.tsx), then whether to refine it with Claude first; for a new
// feature, a textarea for its description. As orchestra's huh form: ↑ and ↓ (or k and j) move the
// selector, Enter chooses; in the description Enter submits and Alt+Enter or Ctrl+J starts a new
// line (Ctrl+J for terminals whose legacy encoding can't tell Alt+Enter from Enter, § 7.7), and
// Shift+Tab goes back a step, keeping what was typed. Esc or Ctrl+C cancels: nothing has started
// yet. A click on an option chooses it, as Enter on it does (D9, § 7.3); one on a field focuses it,
// as the renderer focuses what is clicked.
import type { KeyBinding, TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import type { Effect } from "effect"
import { useRef, useState } from "react"
import { FileBrowser, rowsShown } from "./FileBrowser.tsx"
import { type Answers, ask, Field, formHintSegments, targetLines } from "./Form.tsx"
import { type Command, useFormCommands } from "./keyCommands.ts"
import { Lines, type Look, type Segments, seg, wrap } from "./line.tsx"
import {
  describeDescription,
  describeTitle,
  type FormCancelled,
  newLineHint,
  noDescription,
  optionAt,
  refineDescription,
  refineOptions,
  refineTitle,
  type SpecAsk,
  specDescription,
  specKeysHint,
  specTitle,
  startDescription,
  startOptions,
  startTitle,
  type TicketCount,
  Work,
} from "./questions.ts"
import type { Shell } from "./renderer.ts"
import {
  Listing,
  listedLines,
  type SpecFieldActions,
  SpecInput,
  specFieldCommands,
  useSpecField,
} from "./SpecField.tsx"
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

/** The start question's steps: the select, a feature's description, a spec's file, then refining. */
export type Step = "choose" | "describe" | "spec" | "refine"

/** What the start question's keys do, in its step `step` now. */
export interface StartActions {
  readonly step: () => Step
  /** Moves the selector by one. */
  readonly move: (by: number) => void
  /** Chooses the option the selector is on. */
  readonly choose: () => void
  /** Goes back a step, keeping what was typed. */
  readonly back: () => void
  readonly cancel: () => void
  /** The spec's field. */
  readonly field: SpecFieldActions
  /** Moves the refine step's selector by one. */
  readonly moveRefine: (by: number) => void
  /** Chooses the refine step's option the selector is on. */
  readonly chooseRefine: () => void
}

/**
 * The start question's keys: the select's while it chooses, the spec field's while it is answered
 * (specFieldCommands), the refine step's, and the description's while it is typed in, whose Enter,
 * Alt+Enter and Ctrl+J are the textarea's own (descriptionKeys).
 */
export const startCommands = (act: StartActions): ReadonlyArray<Command> => {
  const choosing = () => act.step() === "choose"
  const describing = () => act.step() === "describe"
  const refining = () => act.step() === "refine"
  const field = act.field
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
    ...specFieldCommands(field, () => act.step() === "spec", act.back),
    {
      keys: ["up", "k"],
      run: () => act.moveRefine(-1),
      when: refining,
      hint: { keys: "↑↓", does: "choose" },
    },
    { keys: ["down", "j"], run: () => act.moveRefine(1), when: refining },
    {
      keys: ["return", "kpenter"],
      run: act.chooseRefine,
      when: refining,
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
      when: () => describing() || refining(),
      hint: { keys: "Shift+Tab", does: "back" },
    },
    // Esc closes the browser, or stops a fetch, where one is open (specFieldCommands); Ctrl+C
    // cancels all the same.
    {
      keys: ["escape", "ctrl+c"],
      run: act.cancel,
      when: () => act.step() !== "spec" || (!field.browsingNow() && !field.fetchingNow()),
      hint: { keys: "Esc", does: "cancel" },
    },
    { keys: ["ctrl+c"], run: act.cancel },
  ]
}

/** How many lines the description's textarea shows, as orchestra's. */
const descriptionLines = 6

/** The columns a field's text is in from the screen's edges: the form's padding, and the bar's. */
const fieldInset = 4

/** The columns the hint is in from the screen's edges: the form's padding. */
const hintInset = 2

export const StartQuestion = ({
  theme,
  count,
  spec,
  answer,
  cancel,
}: {
  readonly theme: Theme
  readonly count: TicketCount
  readonly spec: SpecAsk
} & Answers<Work>) => {
  // The keys of one read each see the ones before them: Down and Enter together choose Spec.
  const [step, setStep, stepNow] = useKeyState<Step>(() => "choose")
  const [highlighted, setHighlighted, highlightedNow] = useKeyState(() => 0)
  const [refineAt, setRefineAt, refineAtNow] = useKeyState(() => 0)
  // The spec the field took, absolute or a URL, which the refine step runs.
  const [, setGiven, givenNow] = useKeyState<string | null>(() => null)
  const [error, setError] = useState<string | null>(null)
  const description = useRef<TextareaRenderable>(null)
  // How many rows the browser shows, as last drawn.
  const browserRows = useRef(rowsShown(0))
  const options = startOptions(count)
  const { form } = theme
  const { width, height } = useTerminalDimensions()

  const field = useSpecField(
    spec,
    (taken) => {
      setGiven(() => taken)
      setRefineAt(() => 0)
      setStep(() => "refine")
      field.input.current?.blur()
    },
    () => browserRows.current,
  )

  const chooseRefine = (at: number) => {
    const taken = givenNow()
    if (taken !== null) answer(Work.Spec({ given: taken, refine: at === 1 }))
  }

  const hint = useFormCommands(
    startCommands({
      step: stepNow,
      move: (by) => setHighlighted((at) => Math.min(options.length - 1, Math.max(0, at + by))),
      choose: () => choose(highlightedNow()),
      back: () => {
        if (stepNow() === "refine") {
          setStep(() => "spec")
          field.input.current?.focus()
          return
        }
        field.act.leave()
        setStep(() => "choose")
        // The read's keys after Shift+Tab are the select's, not a field's.
        description.current?.blur()
        field.input.current?.blur()
      },
      cancel,
      field: field.act,
      moveRefine: (by) =>
        setRefineAt((at) => Math.min(refineOptions.length - 1, Math.max(0, at + by))),
      chooseRefine: () => chooseRefine(refineAtNow()),
    }),
  )

  // Option `at` chosen: the current tickets answer; a spec asks for its file, a new feature for its
  // description.
  const choose = (at: number) => {
    if (at === optionAt.tickets) answer(Work.Tickets())
    else if (stepNow() === "choose" && at === optionAt.spec) {
      setStep(() => "spec")
      // The read's keys after this Enter are the field's, before React draws it.
      field.input.current?.focus()
    } else if (stepNow() === "choose") {
      setError(null)
      setStep(() => "describe")
      description.current?.focus()
    }
  }

  const submit = () => {
    const text = description.current?.plainText.trim() ?? ""
    if (text === "") setError(noDescription("Esc"))
    else answer(Work.Feature({ description: text }))
  }

  // Each part as tall as its lines, wrapped by tutti's wrap, and the select given the lines left
  // above the field answered, cut from its top; none where none are left. Left to Yoga, a screen too
  // short for the form shrank its texts, which drew their lines over each other, and OpenTUI cuts
  // nothing of what a box with no height draws (tutti-lfii).
  const room = Math.max(width - fieldInset, 1)
  const paragraph = (text: string, look: Look) => wrap([seg(text, look)], room)
  const heading = [
    ...paragraph(startTitle, form.fieldTitle),
    ...paragraph(startDescription, form.description),
  ]
  const choices = targetLines(
    options.map((option, at) =>
      at === highlighted
        ? [seg("> ", form.selector), seg(option, form.selected)]
        : [seg(`  ${option}`, form.option)],
    ),
    room,
  )
  const describing = [
    ...paragraph(describeTitle, form.fieldTitle),
    ...paragraph(`${describeDescription} ${newLineHint}`, form.description),
  ]
  const errorLines = error === null ? [] : paragraph(error, form.error)
  const specHeading = [
    ...paragraph(specTitle, form.fieldTitle),
    ...paragraph(`${specDescription} ${specKeysHint}`, form.description),
  ]
  const specErrorLines = field.error === null ? [] : paragraph(field.error, form.error)
  const listing = listedLines(field.listed, theme)
  const refineHeading = [
    ...paragraph(refineTitle, form.fieldTitle),
    ...paragraph(refineDescription, form.description),
  ]
  const refineChoices: ReadonlyArray<Segments> = targetLines(
    refineOptions.map((option, at) =>
      at === refineAt
        ? [seg("> ", form.selector), seg(option, form.selected)]
        : [seg(`  ${option}`, form.option)],
    ),
    room,
  )
  const hintLines = wrap(formHintSegments(hint, theme), Math.max(width - hintInset, 1))
  const specLines = 1 + specHeading.length + 1 + listing.length + specErrorLines.length
  const below =
    step === "describe"
      ? 1 + describing.length + descriptionLines + errorLines.length
      : step === "spec"
        ? specLines
        : step === "refine"
          ? specLines + 1 + refineHeading.length + refineChoices.length
          : 0
  const left = height - 1 - below - 1 - hintLines.length
  // The select, while it is the field answered, keeps its options.
  const shown = Math.min(
    heading.length + choices.length,
    Math.max(left, step === "choose" ? choices.length : 0),
  )
  const specShown = step === "spec" || step === "refine"
  browserRows.current = rowsShown(height - 1 - hintLines.length)

  return (
    <box flexDirection="column" paddingX={1} paddingTop={1}>
      {shown <= 0 ? null : (
        <box
          flexDirection="column"
          height={shown}
          flexShrink={0}
          overflow="hidden"
          justifyContent="flex-end"
        >
          <box flexDirection="column" flexShrink={0}>
            <Field theme={theme} focused={step === "choose"}>
              <Lines lines={heading} />
              <Lines
                lines={choices}
                press={(at) => {
                  setHighlighted(() => at)
                  choose(at)
                }}
              />
            </Field>
          </box>
        </box>
      )}
      {/* Mounted while hidden, so that the keys of the read that chose Spec reach it. */}
      <box flexDirection="column" paddingTop={1} visible={specShown} flexShrink={0}>
        <Field theme={theme} focused={step === "spec"}>
          <Lines lines={specHeading} />
          <SpecInput
            theme={theme}
            field={field}
            focused={step === "spec" && field.browsing === null && field.fetching === null}
          />
          <Listing theme={theme} field={field} />
          <Lines lines={specErrorLines} />
        </Field>
      </box>
      {step !== "refine" ? null : (
        <box flexDirection="column" paddingTop={1} flexShrink={0}>
          <Field theme={theme} focused>
            <Lines lines={refineHeading} />
            <Lines
              lines={refineChoices}
              press={(at) => {
                setRefineAt(() => at)
                chooseRefine(at)
              }}
            />
          </Field>
        </box>
      )}
      {/* Mounted while hidden, so that the keys of the read that chose New feature reach it. */}
      <box flexDirection="column" paddingTop={1} visible={step === "describe"} flexShrink={0}>
        <Field theme={theme} focused>
          <Lines lines={describing} />
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
          <Lines lines={errorLines} />
        </Field>
      </box>
      <box flexDirection="column" paddingTop={1} flexShrink={0}>
        <Lines lines={hintLines} />
      </box>
      {step !== "spec" || field.browsing === null ? null : (
        <FileBrowser
          theme={theme}
          browsing={field.browsing}
          home={spec.where.home}
          width={width}
          height={height - 1 - hintLines.length}
          shown={browserRows.current}
          keys={hint}
          press={field.act.browser.press}
          scroll={field.act.browser.scroll}
        />
      )}
    </box>
  )
}

/**
 * Asks the start question in `shell`'s renderer: the current tickets, as `count` says of them,
 * a spec, as `spec` reads it, or a new feature and its description. Fails with FormCancelled on Esc
 * or Ctrl+C.
 */
export const askStart = (
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  count: TicketCount,
  spec: SpecAsk,
): Effect.Effect<Work, FormCancelled> =>
  ask<Work>(shell, themeOf, (theme, answers) => (
    <StartQuestion theme={theme} count={count} spec={spec} {...answers} />
  ))
