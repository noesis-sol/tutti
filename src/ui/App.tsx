// The React tree in the command's renderer (§ 7.1): one screen at a time, routed by the run's
// Screen (the dashboard, a worker's view, the interview). The worker view and the interview are
// placeholders here, which their own code replaces.
//
// dashboard() is the Dashboard a run shows (src/run/screen.ts): it bridges the run's RunView and
// Screen into React (useRunView.ts) and mounts the tree into the renderer until the run's scope
// closes.
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import type { ReactNode } from "react"
import type { Dashboard as RunDashboard } from "../run/screen.ts"
import type { Clipboard } from "./clipboard.ts"
import { Dashboard } from "./Dashboard.tsx"
import { Input } from "./Input.tsx"
import { styled } from "./line.tsx"
import type { Shell } from "./renderer.ts"
import type { Appearance, Theme } from "./theme.ts"
import {
  bridge,
  ShellContext,
  type ShellValue,
  useRunView,
  useScreen,
  useTheme,
} from "./useRunView.ts"

/** A screen still to be drawn: its name, and a line under it. */
const Placeholder = ({ name, detail }: { readonly name: string; readonly detail: string }) => {
  const theme = useTheme()
  return (
    <box flexDirection="column" paddingX={1}>
      <text {...styled(theme.styles.title)}>{" tutti "}</text>
      <text {...styled(theme.styles.tickets)}>{name}</text>
      <text {...styled(theme.styles.dim)}>{detail}</text>
    </box>
  )
}

const WorkerScreen = ({ worker }: { readonly worker: number }) => {
  const card = useRunView().cards.find((each) => each.worker === worker)
  return (
    <Placeholder
      name={`Worker ${worker}`}
      detail={card === undefined ? "no worker" : `${card.ticket} ${card.status}`}
    />
  )
}

/** The screen the run shows now. */
export const App = () => {
  const screen = useScreen()
  switch (screen._tag) {
    case "Dashboard":
      return <Dashboard />
    case "Worker":
      return <WorkerScreen worker={screen.worker} />
    case "Interview":
      return <Placeholder name="Interview" detail="a new feature" />
  }
}

/**
 * The App, or `children` in its place, over `value`, with the input layers (`input`: the tests'
 * paste limit and toast life).
 */
export const Root = ({
  value,
  children,
  input = {},
}: {
  readonly value: ShellValue
  readonly children?: ReactNode
  readonly input?: { readonly pasteLimit?: number; readonly toastLife?: number }
}) => (
  <ShellContext.Provider value={value}>
    <Input {...input}>{children ?? <App />}</Input>
  </ShellContext.Provider>
)

/**
 * The dashboard a run shows in `shell`'s renderer, drawn in the theme `themeOf` makes, copying a
 * drag's selection with `clipboard`.
 */
export const dashboard =
  (shell: Shell, themeOf: (appearance: Appearance) => Theme, clipboard?: Clipboard): RunDashboard =>
  (inputs) =>
    Effect.gen(function* () {
      const value: ShellValue = {
        view: yield* bridge(inputs.view),
        screen: yield* bridge(inputs.screen),
        commands: inputs.commands,
        appearance: shell.appearance,
        themeOf,
        ...(clipboard === undefined ? {} : { clipboard }),
      }
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => createRoot(shell.renderer)),
        (made) => Effect.sync(() => made.unmount()),
      )
      root.render(<Root value={value} />)
    })
