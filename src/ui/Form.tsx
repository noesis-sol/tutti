// The forms drawn in the command's renderer (§ 7.1, § 7.11): the start question and the plan
// confirmation, in the form roles, as `huh`'s Charm theme draws its fields. The focused field has
// a bar on its left (`┃`, formFrame); the others keep its width, blank.
//
// ask() shows a form in the renderer until it is answered or cancelled, then unmounts it, leaving
// the renderer to the screen after it: the dashboard, or the interview.
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import { type ReactNode, useMemo, useSyncExternalStore } from "react"
import { styled } from "./line.tsx"
import { FormCancelled } from "./questions.ts"
import type { Shell } from "./renderer.ts"
import type { Appearance, Theme } from "./theme.ts"
import type { External } from "./useRunView.ts"

/** A field: `children` behind the focused bar, or behind blank space of its width. */
export const Field = ({
  theme,
  focused,
  children,
}: {
  readonly theme: Theme
  readonly focused: boolean
  readonly children: ReactNode
}) =>
  focused ? (
    <box
      flexDirection="column"
      border={["left"]}
      borderStyle="heavy"
      {...(theme.form.bar.fg === undefined ? {} : { borderColor: theme.form.bar.fg })}
      paddingLeft={1}
    >
      {children}
    </box>
  ) : (
    <box flexDirection="column" paddingLeft={2}>
      {children}
    </box>
  )

/** The keys there are, under a form: each key and its words in the description style. */
export const Hint = ({ theme, keys }: { readonly theme: Theme; readonly keys: string }) => (
  <text {...styled(theme.form.description)}>{keys}</text>
)

/** `children` in the theme the appearance now gives, re-rendered when it changes. */
const Themed = ({
  appearance,
  themeOf,
  children,
}: {
  readonly appearance: External<Appearance>
  readonly themeOf: (appearance: Appearance) => Theme
  readonly children: (theme: Theme) => ReactNode
}) => {
  const now = useSyncExternalStore(appearance.subscribe, appearance.get)
  const theme = useMemo(() => themeOf(now), [themeOf, now])
  return children(theme)
}

/** How a form says it is done: its answer, or cancelled. */
export interface Answers<A> {
  readonly answer: (value: A) => void
  readonly cancel: () => void
}

/**
 * Shows the form `draw` makes in `shell`'s renderer until it answers, with its answer, or cancels,
 * failing with FormCancelled; then unmounts it. Interrupted, it unmounts it too.
 */
export const ask = <A,>(
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  draw: (theme: Theme, answers: Answers<A>) => ReactNode,
): Effect.Effect<A, FormCancelled> =>
  Effect.callback<A, FormCancelled>((resume) => {
    const root = createRoot(shell.renderer)
    let open = true
    const close = () => {
      if (!open) return false
      open = false
      root.unmount()
      return true
    }
    const answers: Answers<A> = {
      answer: (value) => {
        if (close()) resume(Effect.succeed(value))
      },
      cancel: () => {
        if (close()) resume(Effect.fail(new FormCancelled()))
      },
    }
    root.render(
      <Themed appearance={shell.appearance} themeOf={themeOf}>
        {(theme) => draw(theme, answers)}
      </Themed>,
    )
    return Effect.sync(close)
  })
