// The React tree in the command's renderer (§ 7.1): one screen at a time, routed by the run's
// Screen (the dashboard, a worker's view, the interview). Each screen is a placeholder here, which
// the dashboard's, the worker view's and the interview's own code replace.
//
// dashboard() is the Dashboard a run shows (src/run/screen.ts): it bridges the run's RunView and
// Screen into React (useRunView.ts) and mounts the tree into the renderer until the run's scope
// closes.
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import type { ReactNode } from "react"
import type { Dashboard } from "../run/screen.ts"
import type { Shell } from "./renderer.ts"
import type { Appearance, Style, Theme } from "./theme.ts"
import {
  bridge,
  ShellContext,
  type ShellValue,
  useRunView,
  useScreen,
  useTheme,
} from "./useRunView.ts"

/** The props that draw a <text> in `style`. */
export const styled = (style: Style) => ({
  ...(style.fg === undefined ? {} : { fg: style.fg }),
  ...(style.bg === undefined ? {} : { bg: style.bg }),
  attributes: style.attributes,
})

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

const DashboardScreen = () => {
  const { totals } = useRunView()
  return (
    <Placeholder
      name="Dashboard"
      detail={`Completed ${totals.completed} · Needs you ${totals.needsYou} · Workers ${totals.workers} of ${totals.slots} · In queue ${totals.queued}`}
    />
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
      return <DashboardScreen />
    case "Worker":
      return <WorkerScreen worker={screen.worker} />
    case "Interview":
      return <Placeholder name="Interview" detail="a new feature" />
  }
}

/** The App, or `children` in its place, over `value`. */
export const Root = ({
  value,
  children,
}: {
  readonly value: ShellValue
  readonly children?: ReactNode
}) => <ShellContext.Provider value={value}>{children ?? <App />}</ShellContext.Provider>

/** The dashboard a run shows in `shell`'s renderer, drawn in the theme `themeOf` makes. */
export const dashboard =
  (shell: Shell, themeOf: (appearance: Appearance) => Theme): Dashboard =>
  (inputs) =>
    Effect.gen(function* () {
      const value: ShellValue = {
        view: yield* bridge(inputs.view),
        screen: yield* bridge(inputs.screen),
        commands: inputs.commands,
        appearance: shell.appearance,
        themeOf,
      }
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => createRoot(shell.renderer)),
        (made) => Effect.sync(() => made.unmount()),
      )
      root.render(<Root value={value} />)
    })
