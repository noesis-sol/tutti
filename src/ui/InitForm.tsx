// tutti init's form in its own renderer (§ 7.1, § 8.3): the questions of src/init/form.ts, one field
// at a time, under init's title and a stepper of its two steps, Workers and Checks (✓ done, ● now,
// ○ to come). The fields answered in the step stay above the one asked, blurred, with their answers.
// As huh's Charm theme draws them (§ 7.11's form roles):
//
//   confirm     Yes and No buttons: ← and → (h, l, Tab) move, y and n answer, Enter confirms
//   select      the options, the selected one behind `>`: ↑ and ↓ (k, j) move, Enter chooses
//   text        a line to type in: Enter submits, an error under it until it does
//   checklist   the options, ticked `✓` or not `•`: ↑ and ↓ move, Space (or x) ticks, Enter confirms
//
// A click does what a key does (D9, § 7.3): on Yes or No it answers, on a select's option it chooses
// and confirms it, on a checklist's option it ticks or unticks it, on a line to type in it focuses
// it, on the scout's Esc line it skips the scout. The stepper takes none: no key moves between
// steps. Taking the mouse, the form has the run's guards in front of its keys (InputGuards): a mouse
// report split between two reads neither cancels it nor types into it.
// Esc or Ctrl+C cancels the form, and init then changes nothing. While the scout looks for the
// project's suites a spinner turns, with the time it has taken; Esc there skips it, and the choice
// of checks starts on manual. Between questions, while init works, a spinner says so; Ctrl+C there
// (a key in the renderer's raw mode, not SIGINT) cancels init before it takes its steps, as it does
// in a field, interrupting what it reads (bd, the lock), and once it takes them stops init after the
// step under way, the spinner saying it is stopping. The form is
// unmounted when the scope it was opened in closes; the summary is printed once the renderer is
// gone (src/print/initSummary.ts). Its faint text is `formFaint`'s, as the summary's.
import type { InputRenderable } from "@opentui/core"
import { createRoot, useTerminalDimensions } from "@opentui/react"
import { Deferred, Effect, type Scope } from "effect"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { type ScoutResult, scoutSkipped } from "../init/checks.ts"
import {
  type ChecklistField,
  type ConfirmField,
  type Fields,
  initForm,
  type SelectField,
  type StepName,
  stepNames,
  type TextField,
} from "../init/form.ts"
import type { InitForm } from "../init/init.ts"
import { serverLabel } from "../init/workers.ts"
import type { Key } from "../run/runView.ts"
import { outputMode, type TtyValue } from "../services/Tty.ts"
import { clickable, Field, formHintSegments, Themed, targetLines } from "./Form.tsx"
import { type FormHeading, initHeading, initTitle, scoutClock } from "./initTitle.ts"
import { type Command, useFormCommands } from "./keyCommands.ts"
import { InputGuards } from "./keys.ts"
import { Line, Lines, type Segments, seg, styled, wrap } from "./line.tsx"
import { marks } from "./marks.ts"
import { FormCancelled } from "./questions.ts"
import type { Shell } from "./renderer.ts"
import type { Appearance, Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"
import { external, type Settable, spinnerAt, spinnerTick } from "./useRunView.ts"

/**
 * Which form init asks in on the terminal `tty`: its own renderer where stdin and stdout are TTYs
 * and the terminal draws one (as the dashboard needs, § 7.7), the line forms with TERM=dumb or
 * fewer than 256 colours; none without a TTY, when init asks nothing.
 */
export const initFormKind = (
  tty: Pick<TtyValue, "stdinIsTty" | "stdoutIsTty" | "dumb" | "colourDepth">,
): "renderer" | "lines" | null =>
  !tty.stdinIsTty || !tty.stdoutIsTty
    ? null
    : outputMode(tty, false)._tag === "Dashboard"
      ? "renderer"
      : "lines"

/** The field asked now, and how it says it is done. */
export type Asking =
  | {
      readonly _tag: "Confirm"
      readonly id: number
      readonly field: ConfirmField
      readonly answer: (yes: boolean) => void
      readonly cancel: () => void
    }
  | {
      readonly _tag: "Select"
      readonly id: number
      readonly field: SelectField
      readonly answer: (at: number) => void
      readonly cancel: () => void
    }
  | {
      readonly _tag: "Text"
      readonly id: number
      readonly field: TextField
      readonly answer: (text: string) => void
      readonly cancel: () => void
    }
  | {
      readonly _tag: "Checklist"
      readonly id: number
      readonly field: ChecklistField
      readonly answer: (ticked: ReadonlyArray<number>) => void
      readonly cancel: () => void
    }
  | {
      readonly _tag: "Scout"
      readonly id: number
      /** When the scout started, in epoch milliseconds. */
      readonly since: number
      readonly skip: () => void
      readonly cancel: () => void
    }

/** What stays above the field asked: a field answered, or a note. */
export type Done =
  | { readonly _tag: "Answered"; readonly title: string; readonly answer: string }
  | { readonly _tag: "Note"; readonly text: string }

/** The form's screen: the steps in the stepper, the one now, what was done in it, the field asked. */
export interface InitScreen {
  readonly steps: ReadonlyArray<StepName>
  /** The step now, an index of `steps`; null before the first. */
  readonly at: number | null
  readonly done: ReadonlyArray<Done>
  /** Null while init works between questions. */
  readonly asking: Asking | null
  /** What Ctrl+C does while init works between questions: stops it, once it takes its steps. */
  readonly stop?: () => void
  /** What Ctrl+C does while init works between questions before it takes its steps: cancels it. */
  readonly cancel?: () => void
}

export const emptyScreen: InitScreen = { steps: [], at: null, done: [], asking: null }

/** Esc or Ctrl+C: cancels the form. */
const cancelCommand = (cancel: () => void): Command => ({
  keys: ["escape", "ctrl+c"],
  run: cancel,
  hint: { keys: "Esc", does: "cancel" },
})

const enterKeys = ["return", "kpenter"]

/** The keys of a confirm: `toggle` moves between Yes and No, `confirm` answers the one focused. */
export const confirmCommands = (
  asking: Extract<Asking, { _tag: "Confirm" }>,
  act: { readonly toggle: () => void; readonly confirm: () => void },
): ReadonlyArray<Command> => [
  {
    keys: ["left", "right", "h", "l", "tab"],
    run: act.toggle,
    hint: { keys: "←→", does: "choose" },
  },
  { keys: ["y"], run: () => asking.answer(true), hint: { keys: "y", does: "yes" } },
  { keys: ["n"], run: () => asking.answer(false), hint: { keys: "n", does: "no" } },
  { keys: enterKeys, run: act.confirm, hint: { keys: "Enter", does: "confirm" } },
  cancelCommand(asking.cancel),
]

/** The keys of a select: `move` moves the selector by one, `confirm` chooses the one it is on. */
export const selectCommands = (
  asking: Extract<Asking, { _tag: "Select" }>,
  act: { readonly move: (by: number) => void; readonly confirm: () => void },
): ReadonlyArray<Command> => [
  { keys: ["up", "k"], run: () => act.move(-1), hint: { keys: "↑↓", does: "choose" } },
  { keys: ["down", "j"], run: () => act.move(1) },
  { keys: enterKeys, run: act.confirm, hint: { keys: "Enter", does: "confirm" } },
  cancelCommand(asking.cancel),
]

/** The keys of a line to type in: Enter is the line's own, which submits it. */
export const textCommands = (asking: Extract<Asking, { _tag: "Text" }>): ReadonlyArray<Command> => [
  { keys: [], run: () => {}, hint: { keys: "Enter", does: "confirm" } },
  cancelCommand(asking.cancel),
]

/** The keys of a checklist: `move` moves the selector, `tick` ticks its option, `confirm` answers. */
export const checklistCommands = (
  asking: Extract<Asking, { _tag: "Checklist" }>,
  act: {
    readonly move: (by: number) => void
    readonly tick: () => void
    readonly confirm: () => void
  },
): ReadonlyArray<Command> => [
  { keys: ["up", "k"], run: () => act.move(-1), hint: { keys: "↑↓", does: "move" } },
  { keys: ["down", "j"], run: () => act.move(1) },
  { keys: ["space", "x"], run: act.tick, hint: { keys: "Space", does: "tick" } },
  { keys: enterKeys, run: act.confirm, hint: { keys: "Enter", does: "confirm" } },
  cancelCommand(asking.cancel),
]

/** The keys while the scout looks: Esc skips it, Ctrl+C cancels the form. */
export const scoutCommands = (
  asking: Extract<Asking, { _tag: "Scout" }>,
): ReadonlyArray<Command> => [
  { keys: ["escape"], run: asking.skip, hint: { keys: "Esc", does: "skip" } },
  { keys: ["ctrl+c"], run: asking.cancel, hint: { keys: "Ctrl+C", does: "cancel" } },
]

/** The columns a field's text is in from the screen's edges: the form's padding, and the bar's. */
const fieldInset = 4

/** The columns the form's own lines are in from the screen's edges: its padding. */
const formInset = 2

/**
 * The lines under a field `width` columns wide: a blank one, and the keys its commands there now
 * name, as a form draws them; none where they name none.
 */
const hintLines = (
  theme: Theme,
  keys: ReadonlyArray<Key>,
  width: number,
): ReadonlyArray<Segments> =>
  keys.length === 0
    ? []
    : [[], ...wrap(formHintSegments(keys, theme), Math.max(width - formInset, 1))]

/** A field's title and description, as huh draws them, wrapped by tutti's wrap to `room` columns. */
const headingLines = (
  theme: Theme,
  title: string,
  description: string | undefined,
  room: number,
): ReadonlyArray<Segments> => [
  ...wrap([seg(title, theme.form.fieldTitle)], room),
  ...(description === undefined || description === ""
    ? []
    : wrap([seg(description, theme.form.description)], room)),
]

/**
 * Draws the form's screen around a field `used` lines tall, which `field` draws: the field whole,
 * and above it what is left room for (InitView).
 */
type Page = (used: number, field: ReactNode) => ReactNode

/** The columns a field's text has, and the lines its keys take under it. */
const useFieldRoom = () => {
  const { width } = useTerminalDimensions()
  return { width, room: Math.max(width - fieldInset, 1) }
}

const ConfirmView = ({
  theme,
  asking,
  page,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Confirm" }>
  readonly page: Page
}) => {
  const [yes, setYes, yesNow] = useKeyState(() => asking.field.initial ?? false)
  const hint = useFormCommands(
    confirmCommands(asking, {
      toggle: () => setYes((now) => !now),
      confirm: () => asking.answer(yesNow()),
    }),
  )
  const { form } = theme
  const { width, room } = useFieldRoom()
  const heading = headingLines(theme, asking.field.question, asking.field.description, room)
  const under = hintLines(theme, hint, width)
  return page(
    heading.length + 1 + under.length,
    <>
      <Field theme={theme} focused>
        <Lines lines={heading} />
        <Line
          segments={[
            seg("  Yes  ", yes ? form.focusedButton : form.button, 0),
            seg(" "),
            seg("  No  ", yes ? form.button : form.focusedButton, 1),
          ]}
          press={(target) => asking.answer(target === 0)}
        />
      </Field>
      <Lines lines={under} />
    </>,
  )
}

const SelectView = ({
  theme,
  asking,
  page,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Select" }>
  readonly page: Page
}) => {
  const { options } = asking.field
  const [at, setAt, atNow] = useKeyState(() => asking.field.initial ?? 0)
  const hint = useFormCommands(
    selectCommands(asking, {
      move: (by) => setAt((now) => Math.min(options.length - 1, Math.max(0, now + by))),
      confirm: () => asking.answer(atNow()),
    }),
  )
  const { form } = theme
  const { width, room } = useFieldRoom()
  const heading = headingLines(theme, asking.field.title, asking.field.description, room)
  const choices = targetLines(
    options.map((option, index) =>
      index === at
        ? [seg("> ", form.selector), seg(option, form.selected)]
        : [seg(`  ${option}`, form.option)],
    ),
    room,
  )
  const under = hintLines(theme, hint, width)
  return page(
    heading.length + choices.length + under.length,
    <>
      <Field theme={theme} focused>
        <Lines lines={heading} />
        <Lines
          lines={choices}
          press={(index) => {
            setAt(() => index)
            asking.answer(index)
          }}
        />
      </Field>
      <Lines lines={under} />
    </>,
  )
}

const TextView = ({
  theme,
  asking,
  page,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Text" }>
  readonly page: Page
}) => {
  const [error, setError] = useState<string | null>(null)
  const input = useRef<InputRenderable>(null)
  const hint = useFormCommands(textCommands(asking))
  const submit = () => {
    const typed = input.current?.value ?? ""
    const problem = asking.field.validate?.(typed) ?? null
    if (problem === null) asking.answer(typed.trim())
    else setError(problem)
  }
  const { form } = theme
  const { width, room } = useFieldRoom()
  const heading = headingLines(theme, asking.field.title, asking.field.description, room)
  const errorLines = error === null ? [] : wrap([seg(error, form.error)], room)
  const under = hintLines(theme, hint, width)
  return page(
    heading.length + 1 + errorLines.length + under.length,
    <>
      <Field theme={theme} focused>
        <Lines lines={heading} />
        <box
          flexDirection="row"
          height={1}
          flexShrink={0}
          {...clickable(() => input.current?.focus())}
        >
          <text {...styled(form.selector)}>{"> "}</text>
          <input
            ref={input}
            focused
            flexGrow={1}
            onSubmit={submit}
            onInput={() => setError(null)}
            {...(asking.field.initial === undefined ? {} : { value: asking.field.initial })}
            {...(form.option.fg === undefined ? {} : { textColor: form.option.fg })}
            {...(form.option.fg === undefined ? {} : { focusedTextColor: form.option.fg })}
            {...(form.placeholder.fg === undefined
              ? {}
              : { placeholderColor: form.placeholder.fg })}
            {...(form.selected.fg === undefined ? {} : { cursorColor: form.selected.fg })}
          />
        </box>
        <Lines lines={errorLines} />
      </Field>
      <Lines lines={under} />
    </>,
  )
}

const ChecklistView = ({
  theme,
  asking,
  page,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Checklist" }>
  readonly page: Page
}) => {
  const { options } = asking.field
  const [state, setState, stateNow] = useKeyState(() => ({
    at: 0,
    ticked: new Set(asking.field.ticked),
  }))
  const { at, ticked } = state
  // Ticks or unticks option `index`, the selector moving to it.
  const toggle = (index: number) =>
    setState((now) => {
      const next = new Set(now.ticked)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return { at: index, ticked: next }
    })
  const hint = useFormCommands(
    checklistCommands(asking, {
      move: (by) =>
        setState((now) => ({ ...now, at: Math.min(options.length - 1, Math.max(0, now.at + by)) })),
      tick: () => toggle(stateNow().at),
      confirm: () => asking.answer([...stateNow().ticked].sort((a, b) => a - b)),
    }),
  )
  const { form } = theme
  const { width, room } = useFieldRoom()
  const heading = headingLines(theme, asking.field.title, asking.field.description, room)
  const choices = targetLines(
    options.map((option, index) => [
      seg(index === at ? "> " : "  ", form.selector),
      ...(ticked.has(index)
        ? [seg("✓ ", form.selectedMark), seg(option, form.selected)]
        : [seg("• ", form.description), seg(option, form.option)]),
    ]),
    room,
  )
  const under = hintLines(theme, hint, width)
  return page(
    heading.length + choices.length + under.length,
    <>
      <Field theme={theme} focused>
        <Lines lines={heading} />
        <Lines lines={choices} press={toggle} />
      </Field>
      <Lines lines={under} />
    </>,
  )
}

const ScoutView = ({
  theme,
  asking,
  now,
  page,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Scout" }>
  readonly now: number
  readonly page: Page
}) => {
  const hint = useFormCommands(scoutCommands(asking))
  const { form, styles } = theme
  const { width, room } = useFieldRoom()
  const heading = [
    ...wrap(
      [
        seg(spinnerAt(now), styles.picked),
        seg(" "),
        seg("Looking for the project's suites", form.fieldTitle),
        seg(` ${scoutClock(now - asking.since)} (up to 5 minutes)`, form.faint),
      ],
      room,
    ),
    ...wrap([seg("Its tests, lints, type checks and builds.", form.description)], room),
  ]
  const skip = targetLines(
    [[seg("Esc", styles.key), seg(": skip and type a check yourself", form.description)]],
    room,
  )
  const under = hintLines(theme, hint, width)
  return page(
    heading.length + skip.length + under.length,
    <>
      <Field theme={theme} focused>
        <Lines lines={heading} />
        <Lines lines={skip} press={asking.skip} />
      </Field>
      <Lines lines={under} />
    </>,
  )
}

/** The stepper: each step ✓ done, ● now or ○ to come, joined by lines green once reached. */
export const stepperParts = (
  theme: Theme,
  steps: ReadonlyArray<StepName>,
  at: number,
): Segments => {
  const { closed, organ, done } = theme.styles
  const { faint } = theme.form
  if (steps.length === 1) return [seg(steps[0] ?? "", organ)]
  return steps.flatMap((name, index) => [
    ...(index === 0 ? [] : [seg(" ──── ", index <= at ? done : faint)]),
    index < at
      ? seg(`${marks.done} ${name}`, closed)
      : index === at
        ? seg(`${marks.current} ${name}`, organ)
        : seg(`${marks.toCome} ${name}`, faint),
  ])
}

/** What `done` says above the field asked. */
const doneSegments = (theme: Theme, done: Done): Segments =>
  done._tag === "Note"
    ? [seg(done.text, theme.form.description)]
    : [seg(done.title, theme.form.description), seg("  "), seg(done.answer, theme.form.option)]

/**
 * The lines above a field, given `left` lines: `head` (the title, init's words and the stepper),
 * a blank line, and `done`'s lines with a blank line under them. Where there isn't room for them
 * all, `done` gives up its top lines first, then `head`, and nothing is drawn where nothing fits.
 */
export const aboveField = (
  head: ReadonlyArray<Segments>,
  done: ReadonlyArray<Segments>,
  left: number,
): ReadonlyArray<Segments> => {
  const kept = Math.min(done.length, Math.max(left - head.length - 2, 0))
  const lines = [...head, [], ...(kept === 0 ? [] : [...done.slice(done.length - kept), []])]
  return lines.slice(Math.max(lines.length - Math.max(left, 0), 0))
}

/**
 * init working between questions, its spinner at `now`: Ctrl+C calls `stop` where there is one, and
 * `cancel` where there is none.
 */
const WorkingView = ({
  theme,
  now,
  stop,
  cancel,
  page,
}: {
  readonly theme: Theme
  readonly now: number
  readonly stop: (() => void) | undefined
  readonly cancel: (() => void) | undefined
  readonly page: Page
}) => {
  const [stopping, setStopping] = useState(false)
  useFormCommands([
    {
      keys: ["ctrl+c"],
      run: () => {
        if (stop === undefined) {
          cancel?.()
          return
        }
        stop()
        setStopping(true)
      },
    },
  ])
  const { room } = useFieldRoom()
  const lines = wrap(
    [
      seg(spinnerAt(now), theme.styles.picked),
      seg(stopping ? " Stopping after this step…" : " Setting the project up…", theme.form.faint),
    ],
    room,
  )
  return page(
    lines.length,
    <box paddingLeft={2} flexShrink={0}>
      <Lines lines={lines} />
    </box>,
  )
}

/**
 * The form's screen at `now` (epoch milliseconds), which turns its spinners, under init's title or
 * tutti checks' (`heading`).
 */
export const InitView = ({
  theme,
  repo,
  screen,
  now,
  heading = initHeading,
}: {
  readonly theme: Theme
  readonly repo: string
  readonly screen: InitScreen
  readonly now: number
  readonly heading?: FormHeading
}) => {
  const { asking } = screen
  // Each part as tall as its lines, wrapped by tutti's wrap: the field whole, and above it what is
  // left room for. Left to Yoga, a screen too short for the form shrank its texts, which drew their
  // lines over each other, and OpenTUI cuts nothing of what a box with no height draws (tutti-v62n).
  const { width, height } = useTerminalDimensions()
  const formRoom = Math.max(width - formInset, 1)
  const head = [
    ...wrap(initTitle(theme, repo, heading.command), formRoom),
    ...wrap([seg(heading.about, theme.form.faint)], formRoom),
    ...(screen.at === null
      ? []
      : [[], ...wrap(stepperParts(theme, screen.steps, screen.at), formRoom)]),
  ]
  const done = screen.done.flatMap((each) =>
    wrap(doneSegments(theme, each), Math.max(width - fieldInset, 1)).map((line) => [
      seg("  "),
      ...line,
    ]),
  )
  const page: Page = (used, field) => {
    const above = aboveField(head, done, height - 1 - used)
    return (
      <box flexDirection="column" paddingX={1} paddingTop={1} flexGrow={1}>
        {above.length === 0 ? null : <Lines lines={above} />}
        <box flexDirection="column" flexShrink={0}>
          {field}
        </box>
      </box>
    )
  }
  if (asking === null) {
    return (
      <WorkingView theme={theme} now={now} stop={screen.stop} cancel={screen.cancel} page={page} />
    )
  }
  switch (asking._tag) {
    case "Confirm":
      return <ConfirmView key={asking.id} theme={theme} asking={asking} page={page} />
    case "Select":
      return <SelectView key={asking.id} theme={theme} asking={asking} page={page} />
    case "Text":
      return <TextView key={asking.id} theme={theme} asking={asking} page={page} />
    case "Checklist":
      return <ChecklistView key={asking.id} theme={theme} asking={asking} page={page} />
    case "Scout":
      return <ScoutView key={asking.id} theme={theme} asking={asking} now={now} page={page} />
  }
}

/** InitView following `screen`, its spinners turning on `clock` while one is shown. */
const LiveInitView = ({
  theme,
  repo,
  screen,
  clock,
  heading,
}: {
  readonly theme: Theme
  readonly repo: string
  readonly screen: Settable<InitScreen>
  readonly clock: () => number
  readonly heading: FormHeading
}) => {
  const now = useSyncExternalStore(screen.subscribe, screen.get)
  const spinning = now.asking === null || now.asking._tag === "Scout"
  const [time, setTime] = useState(clock)
  useEffect(() => {
    if (!spinning) return
    setTime(clock())
    const timer = setInterval(() => setTime(clock()), spinnerTick)
    return () => clearInterval(timer)
  }, [clock, spinning])
  return <InitView theme={theme} repo={repo} screen={now} now={time} heading={heading} />
}

/** What the field answered leaves above the next one. */
const answered = (title: string, answer: string): Done => ({ _tag: "Answered", title, answer })

/**
 * init's fields on `screen`: each shows its field there until it is answered, with its answer, or
 * cancelled, failing with FormCancelled; interrupted, it takes its field away. The scout runs under
 * its spinner until it ends, Esc skips it, or Ctrl+C cancels the form.
 */
export const screenFields = (screen: Settable<InitScreen>, clock: () => number): Fields => {
  let ids = 0
  const update = (change: (now: InitScreen) => InitScreen) => screen.set(change(screen.get()))
  const ask = <A,>(
    make: (id: number, answer: (value: A) => void, cancel: () => void) => Asking,
    leaves: (value: A) => Done,
  ): Effect.Effect<A, FormCancelled> =>
    Effect.callback<A, FormCancelled>((resume) => {
      let open = true
      const close = (done: Done | null) => {
        if (!open) return false
        open = false
        update((now) => ({
          ...now,
          asking: null,
          done: done === null ? now.done : [...now.done, done],
        }))
        return true
      }
      const asking = make(
        ++ids,
        (value) => {
          if (close(leaves(value))) resume(Effect.succeed(value))
        },
        () => {
          if (close(null)) resume(Effect.fail(new FormCancelled()))
        },
      )
      update((now) => ({ ...now, asking }))
      return Effect.sync(() => close(null))
    })
  return {
    step: (name) =>
      Effect.sync(() =>
        update((now) => {
          // Checks comes after Workers where Workers was asked; alone, it is named alone.
          const steps =
            name === "Workers" || now.steps.includes("Workers") ? [...stepNames] : [name]
          return { ...now, steps, at: steps.indexOf(name), done: [] }
        }),
      ),
    note: (text) =>
      Effect.sync(() => update((now) => ({ ...now, done: [...now.done, { _tag: "Note", text }] }))),
    confirm: (field) =>
      ask<boolean>(
        (id, answer, cancel) => ({ _tag: "Confirm", id, field, answer, cancel }),
        (yes) => answered(field.question, yes ? "Yes" : "No"),
      ),
    select: (field) =>
      ask<number>(
        (id, answer, cancel) => ({ _tag: "Select", id, field, answer, cancel }),
        (at) => answered(field.title, field.options[at] ?? ""),
      ),
    text: (field) =>
      ask<string>(
        (id, answer, cancel) => ({ _tag: "Text", id, field, answer, cancel }),
        (typed) => answered(field.title, typed === "" ? "—" : typed),
      ),
    checklist: (field) =>
      ask<ReadonlyArray<number>>(
        (id, answer, cancel) => ({ _tag: "Checklist", id, field, answer, cancel }),
        (ticked) => answered(field.title, `${ticked.length} of ${field.options.length} ticked`),
      ),
    servers: ({ available, chosen, notes }) =>
      ask<ReadonlyArray<number>>(
        (id, answer, cancel) => ({
          _tag: "Checklist",
          id,
          field: {
            title: "MCP servers workers get",
            description: "Those defined for this project here. Each worker gets the ones ticked.",
            options: available.map((name) => serverLabel(name, notes)),
            ticked: available.flatMap((name, at) => (chosen.includes(name) ? [at] : [])),
          },
          answer,
          cancel,
        }),
        (ticked) =>
          answered(
            "MCP servers workers get",
            ticked.length === 0 ? "none" : ticked.map((at) => available[at]).join(", "),
          ),
      ).pipe(Effect.map((ticked) => ticked.flatMap((at) => available[at] ?? []))),
    scout: (search) =>
      Effect.gen(function* () {
        const pressed = yield* Deferred.make<ScoutResult, FormCancelled>()
        const asking: Asking = {
          _tag: "Scout",
          id: ++ids,
          since: clock(),
          skip: () => Deferred.doneUnsafe(pressed, Effect.succeed({ failed: scoutSkipped })),
          cancel: () => Deferred.doneUnsafe(pressed, Effect.fail(new FormCancelled())),
        }
        update((now) => ({ ...now, asking }))
        const searched = search.pipe(
          Effect.match({
            onSuccess: (found): ScoutResult => ({ found }),
            onFailure: (failed): ScoutResult => ({ failed }),
          }),
        )
        return yield* Effect.raceFirst(searched, Deferred.await(pressed)).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              update((now) => (now.asking === asking ? { ...now, asking: null } : now)),
            ),
          ),
        )
      }),
  }
}

/**
 * init's form in `shell`'s renderer, for the repository `repo`, for the rest of the scope: shown
 * at once, init working until its first question, and unmounted when the scope closes. `clock`
 * turns the spinners and times the scout; `heading` titles it init's, or tutti checks'. Ctrl+C
 * while init works fails `cancels` until init catches stops, and stops init from then on.
 */
export const openInitForm = (
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  repo: string,
  clock: () => number = Date.now,
  heading: FormHeading = initHeading,
): Effect.Effect<InitForm, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const cancelled = Deferred.makeUnsafe<never, FormCancelled>()
      // Set once init catches stops, for good: from then on Ctrl+C stops it, even in a key handler
      // drawn before it did.
      let caught = false
      const cancel = () => {
        if (caught) screen.get().stop?.()
        else Deferred.doneUnsafe(cancelled, Effect.fail(new FormCancelled()))
      }
      const screen = external<InitScreen>({ ...emptyScreen, cancel })
      const root = createRoot(shell.renderer)
      root.render(
        <Themed appearance={shell.appearance} themeOf={themeOf}>
          {(theme) => (
            <>
              <InputGuards />
              <LiveInitView
                theme={theme}
                repo={repo}
                screen={screen}
                clock={clock}
                heading={heading}
              />
            </>
          )}
        </Themed>,
      )
      const form: InitForm = {
        ...initForm(screenFields(screen, clock)),
        cancels: Deferred.await(cancelled),
        catchStops: (stop) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              caught = true
              const { cancel: _, ...rest } = screen.get()
              screen.set({ ...rest, stop })
            }),
            () =>
              Effect.sync(() => {
                const { stop: _, ...rest } = screen.get()
                screen.set(rest)
              }),
          ),
      }
      return { root, form }
    }),
    ({ root }) => Effect.sync(() => root.unmount()),
  ).pipe(Effect.map(({ form }) => form))
