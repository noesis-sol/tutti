// The plan confirmation (§ 7.1), in the command's renderer: the epic and its tickets (type,
// priority, files, after:), then the question and `[y/N]`, after --feature's plan or at the end
// of an interview. The plan scrolls (↑, ↓, PgUp, PgDn) when it is taller than the screen; the
// question stays under it. y says yes; n or Enter no; Esc or Ctrl+C cancels. A click on `y` in
// `[y/N]` says yes, one on `N` no (D9, § 7.3).
import type { Effect } from "effect"
import { type Answers, ask, Field, Hint } from "./Form.tsx"
import { type Command, useFormCommands } from "./keyCommands.ts"
import { Line, plainFg, type Segments, seg, styled } from "./line.tsx"
import { type FormCancelled, type Plan, planLines } from "./questions.ts"
import type { Shell } from "./renderer.ts"
import type { Appearance, Theme } from "./theme.ts"

/** ` [y/N]` after the question: a click on `y` says yes (its target 0), one on `N` no (1). */
const confirmSegments = (theme: Theme): Segments => {
  const look = theme.form.description
  return [seg(" [", look), seg("y", look, 0), seg("/", look), seg("N", look, 1), seg("]", look)]
}

/** The plan confirmation's keys: ↑ and ↓ are the plan's scrollbox's own. */
export const planCommands = ({ answer, cancel }: Answers<boolean>): ReadonlyArray<Command> => [
  { keys: ["y"], run: () => answer(true), hint: { keys: "y", does: "yes" } },
  {
    keys: ["n", "return", "kpenter"],
    run: () => answer(false),
    hint: { keys: "n or Enter", does: "no" },
  },
  { keys: [], run: () => {}, hint: { keys: "↑↓", does: "scroll" } },
  { keys: ["escape", "ctrl+c"], run: cancel, hint: { keys: "Esc", does: "cancel" } },
]

export const PlanConfirmation = ({
  theme,
  plan,
  question,
  answer,
  cancel,
}: {
  readonly theme: Theme
  readonly plan: Plan
  readonly question: string
} & Answers<boolean>) => {
  const { form } = theme

  const hint = useFormCommands(planCommands({ answer, cancel }))

  return (
    <box flexDirection="column" paddingX={1} paddingTop={1} flexGrow={1}>
      <scrollbox focused flexGrow={1} flexShrink={1}>
        {planLines(plan, theme).map((line, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed for the form's life
          <text key={at} fg={plainFg}>
            {line.length === 0
              ? " "
              : line.map((segment, part) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: as the lines
                  <span key={part} {...(segment.look === null ? {} : styled(segment.look))}>
                    {segment.text}
                  </span>
                ))}
          </text>
        ))}
      </scrollbox>
      <box flexDirection="column" paddingTop={1} flexShrink={0}>
        <Field theme={theme} focused>
          <box flexDirection="row" alignItems="flex-end">
            <text flexShrink={1} {...styled(form.fieldTitle)}>
              {question}
            </text>
            <Line segments={confirmSegments(theme)} press={(target) => answer(target === 0)} />
          </box>
        </Field>
        <Hint theme={theme} keys={hint} />
      </box>
    </box>
  )
}

/**
 * Shows `plan` in `shell`'s renderer and asks `question`: true for y, false for n or Enter. Fails
 * with FormCancelled on Esc or Ctrl+C.
 */
export const askPlan = (
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  plan: Plan,
  question: string,
): Effect.Effect<boolean, FormCancelled> =>
  ask<boolean>(shell, themeOf, (theme, answers) => (
    <PlanConfirmation theme={theme} plan={plan} question={question} {...answers} />
  ))
