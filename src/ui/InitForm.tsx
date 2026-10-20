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
// Esc or Ctrl+C cancels the form, and init then changes nothing. While the scout looks for the
// project's suites a spinner turns, with the time it has taken; Esc there skips it, and the choice
// of checks starts on manual. Between questions, while init works, a spinner says so. The form is
// unmounted when the scope it was opened in closes; the summary is printed once the renderer is
// gone (src/print/initSummary.ts).
import { type InputRenderable, TextAttributes } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
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
import { initAbout, initTitle, scoutClock } from "../print/initSummary.ts"
import { outputMode, type TtyValue } from "../services/Tty.ts"
import { Field, Hint, Themed } from "./Form.tsx"
import { styled } from "./line.tsx"
import { FormCancelled } from "./questions.ts"
import type { Shell } from "./renderer.ts"
import type { Appearance, Style, Theme } from "./theme.ts"
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
}

export const emptyScreen: InitScreen = { steps: [], at: null, done: [], asking: null }

const cancelKeys = (key: { readonly name: string; readonly ctrl: boolean }) =>
  key.name === "escape" || (key.ctrl && key.name === "c")

const isEnter = (name: string) => name === "return" || name === "kpenter"

/**
 * A field's state, drawn as it changes, which its key handler reads as it is now: a key pressed
 * before the last change was drawn still sees it.
 */
const useKeyState = <A,>(initial: () => A) => {
  const latest = useRef<{ readonly value: A } | null>(null)
  if (latest.current === null) latest.current = { value: initial() }
  const [shown, setShown] = useState(latest.current.value)
  const now = () => (latest.current as { readonly value: A }).value
  const change = (next: (value: A) => A) => {
    const value = next(now())
    latest.current = { value }
    setShown(value)
  }
  return [shown, change, now] as const
}

/** The text of a field's title and description, as huh draws them. */
const Heading = ({
  theme,
  title,
  description,
}: {
  readonly theme: Theme
  readonly title: string
  readonly description: string | undefined
}) => (
  <>
    <text {...styled(theme.form.fieldTitle)}>{title}</text>
    {description === undefined || description === "" ? null : (
      <text wrapMode="word" {...styled(theme.form.description)}>
        {description}
      </text>
    )}
  </>
)

const ConfirmView = ({
  theme,
  asking,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Confirm" }>
}) => {
  const [yes, setYes, yesNow] = useKeyState(() => asking.field.initial ?? false)
  useKeyboard((key) => {
    if (cancelKeys(key)) asking.cancel()
    else if (key.ctrl || key.meta) return
    else if (["left", "right", "h", "l", "tab"].includes(key.name)) setYes((now) => !now)
    else if (key.name === "y") asking.answer(true)
    else if (key.name === "n") asking.answer(false)
    else if (isEnter(key.name)) asking.answer(yesNow())
  })
  const { form } = theme
  return (
    <Field theme={theme} focused>
      <Heading theme={theme} title={asking.field.question} description={asking.field.description} />
      <text>
        <span {...styled(yes ? form.focusedButton : form.button)}>{"  Yes  "}</span>
        <span> </span>
        <span {...styled(yes ? form.button : form.focusedButton)}>{"  No  "}</span>
      </text>
    </Field>
  )
}

const SelectView = ({
  theme,
  asking,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Select" }>
}) => {
  const { options } = asking.field
  const [at, setAt, atNow] = useKeyState(() => asking.field.initial ?? 0)
  useKeyboard((key) => {
    if (cancelKeys(key)) asking.cancel()
    else if (key.name === "up" || key.name === "k") setAt((now) => Math.max(0, now - 1))
    else if (key.name === "down" || key.name === "j") {
      setAt((now) => Math.min(options.length - 1, now + 1))
    } else if (isEnter(key.name)) asking.answer(atNow())
  })
  const { form } = theme
  return (
    <Field theme={theme} focused>
      <Heading theme={theme} title={asking.field.title} description={asking.field.description} />
      {options.map((option, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the options are fixed for the field's life
        <text key={index}>
          {index === at ? (
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
  )
}

const TextView = ({
  theme,
  asking,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Text" }>
}) => {
  const [error, setError] = useState<string | null>(null)
  const input = useRef<InputRenderable>(null)
  useKeyboard((key) => {
    if (cancelKeys(key)) asking.cancel()
  })
  const submit = () => {
    const typed = input.current?.value ?? ""
    const problem = asking.field.validate?.(typed) ?? null
    if (problem === null) asking.answer(typed.trim())
    else setError(problem)
  }
  const { form } = theme
  return (
    <Field theme={theme} focused>
      <Heading theme={theme} title={asking.field.title} description={asking.field.description} />
      <box flexDirection="row">
        <text {...styled(form.selector)}>{"> "}</text>
        <input
          ref={input}
          focused
          flexGrow={1}
          onSubmit={submit}
          onInput={() => setError(null)}
          {...(form.option.fg === undefined ? {} : { textColor: form.option.fg })}
          {...(form.option.fg === undefined ? {} : { focusedTextColor: form.option.fg })}
          {...(form.placeholder.fg === undefined ? {} : { placeholderColor: form.placeholder.fg })}
          {...(form.selected.fg === undefined ? {} : { cursorColor: form.selected.fg })}
        />
      </box>
      {error === null ? null : <text {...styled(form.error)}>{error}</text>}
    </Field>
  )
}

const ChecklistView = ({
  theme,
  asking,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Checklist" }>
}) => {
  const { options } = asking.field
  const [state, setState, stateNow] = useKeyState(() => ({
    at: 0,
    ticked: new Set(asking.field.ticked),
  }))
  const { at, ticked } = state
  useKeyboard((key) => {
    if (cancelKeys(key)) asking.cancel()
    else if (key.name === "up" || key.name === "k") {
      setState((now) => ({ ...now, at: Math.max(0, now.at - 1) }))
    } else if (key.name === "down" || key.name === "j") {
      setState((now) => ({ ...now, at: Math.min(options.length - 1, now.at + 1) }))
    } else if (key.name === "space" || key.name === "x") {
      setState((now) => {
        const next = new Set(now.ticked)
        if (next.has(now.at)) next.delete(now.at)
        else next.add(now.at)
        return { ...now, ticked: next }
      })
    } else if (isEnter(key.name)) asking.answer([...stateNow().ticked].sort((a, b) => a - b))
  })
  const { form } = theme
  return (
    <Field theme={theme} focused>
      <Heading theme={theme} title={asking.field.title} description={asking.field.description} />
      {options.map((option, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the options are fixed for the field's life
        <text key={index}>
          <span {...styled(form.selector)}>{index === at ? "> " : "  "}</span>
          {ticked.has(index) ? (
            <>
              <span {...styled(form.selectedMark)}>{"✓ "}</span>
              <span {...styled(form.selected)}>{option}</span>
            </>
          ) : (
            <>
              <span {...styled(form.description)}>{"• "}</span>
              <span {...styled(form.option)}>{option}</span>
            </>
          )}
        </text>
      ))}
    </Field>
  )
}

const ScoutView = ({
  theme,
  asking,
  now,
}: {
  readonly theme: Theme
  readonly asking: Extract<Asking, { _tag: "Scout" }>
  readonly now: number
}) => {
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") asking.cancel()
    else if (key.name === "escape") asking.skip()
  })
  const { form, styles } = theme
  return (
    <Field theme={theme} focused>
      <text>
        <span {...styled(styles.picked)}>{spinnerAt(now)}</span>
        <span> </span>
        <span {...styled(form.fieldTitle)}>Looking for the project's suites</span>
        <span
          {...styled(styles.dim)}
        >{` ${scoutClock(now - asking.since)} (up to 5 minutes)`}</span>
      </text>
      <text {...styled(form.description)}>Its tests, lints, type checks and builds.</text>
      <text>
        <span {...styled(styles.key)}>Esc</span>
        <span {...styled(form.description)}>: skip and type a check yourself</span>
      </text>
    </Field>
  )
}

/** The keys there are under each field. */
export const hintOf = (asking: Asking | null): string | null => {
  if (asking === null) return null
  switch (asking._tag) {
    case "Confirm":
      return "←→ choose · y yes · n no · Enter confirm · Esc cancel"
    case "Select":
      return "↑↓ choose · Enter confirm · Esc cancel"
    case "Text":
      return "Enter confirm · Esc cancel"
    case "Checklist":
      return "↑↓ move · Space tick · Enter confirm · Esc cancel"
    case "Scout":
      return "Esc skip · Ctrl+C cancel"
  }
}

/** init's title: the pill, `init` and the repository. */
const Title = ({ theme, repo }: { readonly theme: Theme; readonly repo: string }) => (
  <text>
    {initTitle(theme, repo).map((part, at) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts are fixed
      <span key={at} {...(part.style === null ? {} : styled(part.style))}>
        {part.text}
      </span>
    ))}
  </text>
)

/** The stepper: each step ✓ done, ● now or ○ to come, joined by lines green once reached. */
export const stepperParts = (
  theme: Theme,
  steps: ReadonlyArray<StepName>,
  at: number,
): ReadonlyArray<{ readonly text: string; readonly style: Style }> => {
  const { closed, organ, dim, done } = theme.styles
  if (steps.length === 1) return [{ text: steps[0] ?? "", style: organ }]
  return steps.flatMap((name, index) => [
    ...(index === 0 ? [] : [{ text: " ──── ", style: index <= at ? done : dim }]),
    index < at
      ? { text: `✓ ${name}`, style: closed }
      : index === at
        ? { text: `● ${name}`, style: organ }
        : { text: `○ ${name}`, style: dim },
  ])
}

const DoneLine = ({ theme, done }: { readonly theme: Theme; readonly done: Done }) =>
  done._tag === "Note" ? (
    <text wrapMode="word" {...styled(theme.form.description)}>
      {done.text}
    </text>
  ) : (
    <text>
      <span {...styled(theme.form.description)}>{done.title}</span>
      <span>{"  "}</span>
      <span {...styled(theme.form.option)}>{done.answer}</span>
    </text>
  )

/** The form's screen at `now` (epoch milliseconds), which turns its spinners. */
export const InitView = ({
  theme,
  repo,
  screen,
  now,
}: {
  readonly theme: Theme
  readonly repo: string
  readonly screen: InitScreen
  readonly now: number
}) => {
  const { asking } = screen
  const hint = hintOf(asking)
  let field: ReactNode
  if (asking === null) {
    field = (
      <box paddingLeft={2}>
        <text>
          <span {...styled(theme.styles.picked)}>{spinnerAt(now)}</span>
          <span attributes={TextAttributes.DIM}> Setting the project up…</span>
        </text>
      </box>
    )
  } else {
    switch (asking._tag) {
      case "Confirm":
        field = <ConfirmView key={asking.id} theme={theme} asking={asking} />
        break
      case "Select":
        field = <SelectView key={asking.id} theme={theme} asking={asking} />
        break
      case "Text":
        field = <TextView key={asking.id} theme={theme} asking={asking} />
        break
      case "Checklist":
        field = <ChecklistView key={asking.id} theme={theme} asking={asking} />
        break
      case "Scout":
        field = <ScoutView key={asking.id} theme={theme} asking={asking} now={now} />
        break
    }
  }
  return (
    <box flexDirection="column" paddingX={1} paddingTop={1} flexGrow={1}>
      <Title theme={theme} repo={repo} />
      <text {...styled(theme.styles.dim)}>{initAbout}</text>
      {screen.at === null ? null : (
        <box paddingTop={1}>
          <text>
            {stepperParts(theme, screen.steps, screen.at).map((part, at) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts are fixed for the step
              <span key={at} {...styled(part.style)}>
                {part.text}
              </span>
            ))}
          </text>
        </box>
      )}
      <box
        flexDirection="column"
        paddingTop={1}
        flexShrink={1}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {screen.done.map((done, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: what is done is only added to
          <box key={at} paddingLeft={2}>
            <DoneLine theme={theme} done={done} />
          </box>
        ))}
      </box>
      <box flexDirection="column" paddingTop={screen.done.length === 0 ? 0 : 1} flexShrink={0}>
        {field}
        {hint === null ? null : (
          <box paddingTop={1}>
            <Hint theme={theme} keys={hint} />
          </box>
        )}
      </box>
    </box>
  )
}

/** InitView following `screen`, its spinners turning on `clock` while one is shown. */
const LiveInitView = ({
  theme,
  repo,
  screen,
  clock,
}: {
  readonly theme: Theme
  readonly repo: string
  readonly screen: Settable<InitScreen>
  readonly clock: () => number
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
  return <InitView theme={theme} repo={repo} screen={now} now={time} />
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
    servers: ({ available, chosen }) =>
      ask<ReadonlyArray<number>>(
        (id, answer, cancel) => ({
          _tag: "Checklist",
          id,
          field: {
            title: "MCP servers workers get",
            description: "Those defined for this project here. Each worker gets the ones ticked.",
            options: available,
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
 * turns the spinners and times the scout.
 */
export const openInitForm = (
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  repo: string,
  clock: () => number = Date.now,
): Effect.Effect<InitForm, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const screen = external(emptyScreen)
      const root = createRoot(shell.renderer)
      root.render(
        <Themed appearance={shell.appearance} themeOf={themeOf}>
          {(theme) => <LiveInitView theme={theme} repo={repo} screen={screen} clock={clock} />}
        </Themed>,
      )
      return { root, form: initForm(screenFields(screen, clock)) }
    }),
    ({ root }) => Effect.sync(() => root.unmount()),
  ).pipe(Effect.map(({ form }) => form))
