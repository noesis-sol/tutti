// The React tree in the command's renderer (§ 7.1): one screen at a time, routed by the run's
// Screen (the dashboard, a worker's view, the interview).
//
// dashboard() is the Dashboard a run shows (src/run/screen.ts): it bridges the run's RunView and
// Screen into React (useRunView.ts), the workers' transcripts for their views (transcriptItems.ts)
// and the hand-backs waiting for their notices, and mounts the tree into the renderer until the
// run's scope closes.
// interviewScreen() is the Interview view's (src/run/interview.ts), mounted the same way, with the
// description and what file_feature has filed beside it.
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import type { ReactNode } from "react"
import type { InterviewScreen } from "../run/interview.ts"
import type { Dashboard as RunDashboard, ScreenInputs } from "../run/screen.ts"
import type { Clipboard } from "./clipboard.ts"
import { Dashboard } from "./Dashboard.tsx"
import { FilingDeskProvider } from "./filingDesk.tsx"
import { Input } from "./Input.tsx"
import { InterviewContext, type InterviewValue, InterviewView } from "./InterviewView.tsx"
import type { UrlOpener } from "./openUrl.ts"
import type { Shell } from "./renderer.ts"
import type { Timer } from "./Toasts.tsx"
import type { Appearance, Theme } from "./theme.ts"
import { transcriptFeed } from "./transcriptItems.ts"
import { bridge, ShellContext, type ShellValue, useScreen } from "./useRunView.ts"
import { WorkerView } from "./WorkerView.tsx"

/** The screen the run shows now. */
export const App = () => {
  const screen = useScreen()
  switch (screen._tag) {
    case "Dashboard":
      return <Dashboard />
    case "Worker":
      // Keyed by the ticket, so that switching workers opens the other's transcript afresh.
      return <WorkerView key={screen.ticket} ticket={screen.ticket} />
    case "Interview":
      return <InterviewView />
  }
}

/**
 * The App, or `children` in its place, over `value`, with the input layers (`input`: the tests'
 * paste limit and toast timer).
 */
export const Root = ({
  value,
  children,
  input = {},
}: {
  readonly value: ShellValue
  readonly children?: ReactNode
  readonly input?: { readonly pasteLimit?: number; readonly toastTimer?: Timer }
}) => (
  <ShellContext.Provider value={value}>
    <Input {...input}>
      <FilingDeskProvider>{children ?? <App />}</FilingDeskProvider>
    </Input>
  </ShellContext.Provider>
)

/** What the screen hands the desktop: a drag's selection, and Open URL's URL. */
export interface Desktop {
  readonly clipboard?: Clipboard
  readonly urlOpener?: UrlOpener
}

/** The ShellValue over a screen's `inputs`, in `shell`, bridged for the scope's life. */
const shellValue = (
  inputs: ScreenInputs,
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  desktop: Desktop,
) =>
  Effect.gen(function* () {
    return {
      view: yield* bridge(inputs.view),
      screen: yield* bridge(inputs.screen),
      commands: inputs.commands,
      appearance: shell.appearance,
      themeOf,
      transcripts: yield* transcriptFeed(inputs.transcripts),
      handBacks: yield* bridge(inputs.handBacks),
      filings: yield* bridge(inputs.filings),
      ...(desktop.clipboard === undefined ? {} : { clipboard: desktop.clipboard }),
      ...(desktop.urlOpener === undefined ? {} : { urlOpener: desktop.urlOpener }),
    } satisfies ShellValue
  })

/** `node` mounted in `shell`'s renderer until the scope closes. */
const mount = (shell: Shell, node: ReactNode) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => createRoot(shell.renderer)),
      (made) => Effect.sync(() => made.unmount()),
    )
    root.render(node)
  })

/**
 * The dashboard a run shows in `shell`'s renderer, drawn in the theme `themeOf` makes, copying a
 * drag's selection and opening Open URL's URL with `desktop`.
 */
export const dashboard =
  (shell: Shell, themeOf: (appearance: Appearance) => Theme, desktop: Desktop = {}): RunDashboard =>
  (inputs) =>
    Effect.gen(function* () {
      const value = yield* shellValue(inputs, shell, themeOf, desktop)
      yield* mount(shell, <Root value={value} />)
    })

/** The Interview view in `shell`'s renderer, as dashboard() shows the dashboard. */
export const interviewScreen =
  (
    shell: Shell,
    themeOf: (appearance: Appearance) => Theme,
    desktop: Desktop = {},
  ): InterviewScreen =>
  (inputs) =>
    Effect.gen(function* () {
      const value = yield* shellValue(inputs, shell, themeOf, desktop)
      const interview: InterviewValue = {
        description: inputs.description,
        filing: yield* bridge(inputs.filing),
      }
      yield* mount(
        shell,
        <InterviewContext.Provider value={interview}>
          <Root value={value} />
        </InterviewContext.Provider>,
      )
    })
