// The plan confirmation (§ 7.1), in the command's renderer: the epic and its tickets (type,
// priority, files, after:), then the question and `[y/N]`, after --feature's plan or at the end
// of an interview. The plan scrolls (↑, ↓, PgUp, PgDn) when it is taller than the screen; the
// question stays under it. y says yes; n or Enter no; Esc or Ctrl+C cancels.
import { useKeyboard } from "@opentui/react"
import type { Effect } from "effect"
import { styled } from "./App.tsx"
import { type Answers, ask, Field, Hint } from "./Form.tsx"
import { confirmHint, type FormCancelled, type Plan, planLines } from "./questions.ts"
import type { Shell } from "./renderer.ts"
import type { Appearance, Theme } from "./theme.ts"

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

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) cancel()
    else if (key.ctrl || key.meta) return
    else if (key.name === "y") answer(true)
    else if (key.name === "n" || key.name === "return" || key.name === "kpenter") answer(false)
  })

  return (
    <box flexDirection="column" paddingX={1} paddingTop={1} flexGrow={1}>
      <scrollbox focused flexGrow={1} flexShrink={1}>
        {planLines(plan, theme).map((line, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed for the form's life
          <text key={at}>
            {line.length === 0
              ? " "
              : line.map((segment, part) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: as the lines
                  <span key={part} {...(segment.style === null ? {} : styled(segment.style))}>
                    {segment.text}
                  </span>
                ))}
          </text>
        ))}
      </scrollbox>
      <box flexDirection="column" paddingTop={1} flexShrink={0}>
        <Field theme={theme} focused>
          <text>
            <span {...styled(form.fieldTitle)}>{question}</span>
            <span {...styled(form.description)}>{` ${confirmHint}`}</span>
          </text>
        </Field>
        <Hint theme={theme} keys="y yes · n or Enter no · ↑↓ scroll · Esc cancel" />
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
