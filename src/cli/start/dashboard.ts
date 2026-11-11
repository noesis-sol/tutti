// A bare `tutti`'s run (src/main.ts's runFrom) presented in the command's one OpenTUI renderer
// (src/ui/renderer.ts): the start question or --feature's interview, the open questions, a spec's
// refinement or its breakdown drawn there, then the dashboard; what is said while it is open is
// held for the main screen until it is gone.
import { Deferred, Effect, Option, Result, Scope } from "effect"
import { makePrinter, stdout } from "../../print/organLine.ts"
import { screenOut } from "../../print/screenOut.ts"
import { talkQuestion } from "../../run/answerTalk.ts"
import { exitCodes } from "../../run/holds.ts"
import { type InRenderer, inRenderer } from "../../run/inRenderer.ts"
import { interview, interviewEnding } from "../../run/interview.ts"
import { putQuestions } from "../../run/overnightQuestions.ts"
import { EventStream } from "../../services/EventStream.ts"
import { endRecord } from "../../services/Spending.ts"
import { type Desktop, dashboard, interviewScreen } from "../../ui/App.tsx"
import { liveClipboard } from "../../ui/clipboard.ts"
import { askOpenQuestion } from "../../ui/OpenQuestion.tsx"
import { showOrgans } from "../../ui/OrganScreen.tsx"
import { liveUrlOpener } from "../../ui/openUrl.ts"
import { chosenLines, Work } from "../../ui/questions.ts"
import {
  closeLimit,
  open as openRenderer,
  type RendererFailed,
  type Shell,
} from "../../ui/renderer.ts"
import { askStart } from "../../ui/StartQuestion.tsx"
import { askThenBegin } from "../choose.ts"
import { cannotStart } from "./preflight.ts"
import { exitNow } from "./running.ts"
import type { Presented, Starting } from "./starting.ts"

/** What is on the renderer's screen once it is open. */
interface OnScreen {
  readonly screen: InRenderer<Shell, RendererFailed>
  readonly shell: Shell
  readonly desktop: Desktop
}

/**
 * The breakdown of a spec chosen at the start question and run as it is, as --spec breaks one
 * down, with the renderer open: its organ lines drawn there meanwhile, unstyled, and held for the
 * main screen; Ctrl+C stops it, as on the main screen, with exit 130. The exit code where it
 * stopped the run.
 */
const breakdownOnScreen = (on: Starting, { screen, shell }: OnScreen) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* EventStream
      const drawn = screenOut(() => shell.renderer.width)
      const stop = yield* Deferred.make<void>()
      yield* showOrgans(shell, on.looks.themeOf, drawn.text, () => {
        Effect.runFork(Deferred.succeed(stop, undefined))
      })
      const ended = yield* Effect.raceFirst(
        on.specs.startSpec({
          out: screen.out,
          error: screen.error,
          refine: Option.none(),
          shell,
          drawn: drawn.out,
        }),
        Effect.as(Deferred.await(stop), "stopped" as const),
      )
      if (ended !== "stopped") return ended
      yield* Effect.flatMap(endRecord(exitCodes.interrupted), events.emit)
      return exitCodes.interrupted
    }),
  )

/**
 * The interview of the feature `description` describes, in this renderer, `chosen` the lines
 * saying what was chosen at the start question; once its epic is filed and checked, the run scoped
 * to it, with nothing asked (undefined). What it says is held for the main screen until the
 * renderer is gone.
 */
const interviewed = (
  on: Starting,
  { screen, shell, desktop }: OnScreen,
  description: string,
  chosen: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const { themeOf } = on.looks
    const printer = makePrinter(screen.out, themeOf(shell.appearance.get()))
    const outcome = yield* interview(description, {
      screen: interviewScreen(shell, themeOf, desktop),
      say: printer.print,
      error: screen.error,
    })
    if (outcome._tag !== "Run") {
      return { _tag: "Interviewed", chosen, ending: interviewEnding(outcome) } as const
    }
    on.choice.scope = outcome.epic
    on.choice.feature = description
    return undefined
  })

/**
 * What comes before the run on the renderer's screen, in this order: --feature's interview; the
 * refinement of a spec in the Interview view; the open questions put in the renderer, Talk it
 * through showing the talk in the Interview view (§ 4.11); the start question, the spec chosen
 * then refined or broken down with its organ lines drawn there, or the feature chosen interviewed.
 * How the run ended where it doesn't begin, else undefined.
 */
const beforeRun = (on: Starting, view: OnScreen, refining: boolean) =>
  Effect.gen(function* () {
    const { asks, choice, looks, backlog, specs, beginning, questions } = on
    const { screen, shell, desktop } = view
    const { themeOf } = looks
    if (choice.config.feature !== null) {
      // --feature: the interview, as New feature's, the request its first message.
      const ended = yield* interviewed(on, view, choice.config.feature, [])
      if (ended !== undefined) return ended
      const nothing = yield* backlog.nothingYet
      if (nothing !== null) return nothing
    }
    if (refining) {
      // The refinement in the Interview view, in this renderer; then the run.
      const specStopped = yield* specs.startSpec({
        out: screen.out,
        error: screen.error,
        refine: Option.some(interviewScreen(shell, themeOf, desktop)),
        shell,
      })
      if (specStopped !== undefined) return { _tag: "Stopped", exitCode: specStopped } as const
      yield* beginning.begin(Work.Tickets())
      const nothing = yield* backlog.nothingYet
      if (nothing !== null) return nothing
    }
    if (questions.putInRenderer) {
      // What it says is held for the main screen until the renderer is gone, in its theme now.
      const theme = themeOf(shell.appearance.get())
      // Talk it through shows the talk in the Interview view, in this renderer (§ 4.11).
      const putting = yield* putQuestions({
        questions: questions.questions,
        put: Option.some((question, at, limit) =>
          askOpenQuestion(shell, themeOf, question, at, true, limit),
        ),
        talk: (question) => talkQuestion(question, interviewScreen(shell, themeOf, desktop)),
        say: { ...makePrinter(screen.out, theme), theme },
      })
      if (putting._tag === "Cancelled") {
        return { _tag: "AtQuestions", answered: putting.answered } as const
      }
      yield* beginning.begin(Work.Tickets())
      const nothing = yield* backlog.nothingYet
      if (nothing !== null) return nothing
    }
    if (asks !== "no") {
      const work = yield* askThenBegin(
        askStart(shell, themeOf, backlog.count, on.specAsking),
        beginning.beginUnlessSpec,
      )
      if (work === null) return { _tag: "Cancelled" } as const
      if (work._tag === "Spec") {
        // The spec chosen, then refined in the Interview view, or broken down with its organ
        // lines drawn in this renderer (Ctrl+C stops it); then the run, once it has begun.
        const failed = yield* specs.takeChosen(work, screen.out, screen.error)
        if (failed !== undefined) return { _tag: "Stopped", exitCode: failed } as const
        const specStopped = work.refine
          ? yield* specs.startSpec({
              out: screen.out,
              error: screen.error,
              refine: Option.some(interviewScreen(shell, themeOf, desktop)),
              shell,
            })
          : yield* breakdownOnScreen(on, view)
        if (specStopped !== undefined) return { _tag: "Stopped", exitCode: specStopped } as const
        yield* beginning.begin(Work.Tickets())
      }
      if (work._tag === "Feature") {
        const ended = yield* interviewed(on, view, work.description, chosenLines(work))
        if (ended !== undefined) return ended
      }
      const nothing = yield* backlog.nothingYet
      if (nothing !== null) return nothing
    }
    return undefined
  })

/**
 * The run presented in the renderer, from what it starts from, `on`: the open questions put on
 * the main screen first where they aren't put in the renderer; the run begun at once where
 * nothing is asked or put and there is no spec; then the renderer, from the start question or
 * --feature's interview through the dashboard, destroyed once the run's scope and then its own
 * have closed. What follows it goes to the main screen, after what was said while it was open.
 * A renderer that can't open stops the run, saying so.
 */
export const presentDashboard = (on: Starting) =>
  Effect.gen(function* () {
    const { ready, asks, error, choice, looks, backlog, specs, beginning, questions, runner } = on
    if (!questions.putInRenderer) {
      const stoppedAt = yield* questions.putOnMainScreen
      if (stoppedAt !== null) return { _tag: "Stopped", exitCode: stoppedAt } as const
    }
    // The questions put in the renderer come first, and a spec's breakdown: the run begins below,
    // once they are.
    if (asks === "no" && !questions.putInRenderer && choice.spec === null) {
      yield* beginning.begin(Work.Tickets())
      if (choice.config.feature === null) {
        const nothing = yield* backlog.nothingYet
        if (nothing !== null) return nothing
      }
    }
    const shown = yield* Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* Effect.scope
        // The getting-ready line gone before the renderer takes the screen.
        const open = openRenderer({
          chosen: choice.config.appearance,
          mouse: choice.config.mouse,
        }).pipe(Scope.provide(opened))
        const screen = inRenderer({
          out: stdout,
          error,
          open: ready.end.pipe(Effect.andThen(open)),
        })
        // Added before the renderer opens, so it runs once the renderer has closed.
        yield* Effect.addFinalizer(() => screen.release)
        const refining = choice.spec !== null && choice.config.refine
        if (choice.spec !== null && !refining) {
          // A headless breakdown on the main screen, its spinner there, before the dashboard
          // opens; what it says once that is open is held for after it.
          const specStopped = yield* specs.startSpec({
            out: screen.out,
            error: screen.error,
            refine: Option.none(),
          })
          if (specStopped !== undefined) {
            return { _tag: "Stopped", exitCode: specStopped } as const
          }
          yield* beginning.begin(Work.Tickets())
          const nothing = yield* backlog.nothingYet
          if (nothing !== null) return nothing
        }
        const shell = yield* screen.shell
        const clipboard = yield* liveClipboard(shell.renderer, on.tty.overSsh)
        const desktop = { clipboard, urlOpener: yield* liveUrlOpener(clipboard, on.tty.overSsh) }
        const ended = yield* beforeRun(on, { screen, shell, desktop }, refining)
        if (ended !== undefined) return ended
        // Exiting at once, the renderer is destroyed first, waited for up to closeLimit.
        const destroy = () => {
          shell.renderer.destroy()
          return Promise.race([
            shell.renderer.closed.catch(() => undefined),
            Bun.sleep(closeLimit),
          ]).then(() => undefined)
        }
        const outcome = yield* runner.go({
          exitNow: exitNow(destroy),
          dashboard: dashboard(shell, looks.themeOf, desktop),
        })
        const ran: Presented = {
          _tag: "Ran",
          outcome,
          report: looks.reportOut(looks.themeOf(shell.appearance.get())),
          styled: true,
        }
        return ran
      }),
    ).pipe(Effect.result)
    if (Result.isFailure(shown)) {
      const code = yield* cannotStart(ready)(
        `tutti cannot open its screen: ${shown.failure.message}`,
      )
      return { _tag: "Stopped", exitCode: code } as const
    }
    return shown.success
  })
