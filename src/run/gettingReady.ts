// The line a run draws on the main screen while it gets ready (§ 7.1): from the moment tutti knows
// it is starting a run, its flags parsed, until the first thing it writes or draws (the start
// question, the dashboard, the Nothing to run box, or why it can't start). It is an organ line
// (src/print/organLine.ts), `Getting ready` and the step under way, ended with no final line, so
// what follows looks as it would without it; its first frame comes after frameInterval, so a fast
// start shows nothing. Only a terminal that isn't dumb gets it. The appearance is read later, so
// the line is drawn in styles that don't depend on it: the terminal's own colour, the time faint.
import { Effect } from "effect"
import { makePrinter, type Out } from "../print/organLine.ts"
import { frameInterval } from "../ui/spinner.ts"
import { makeTheme, orchestra } from "../ui/theme.ts"

/** The steps the line names, in plain words, as the dashboard's are. */
export const readySteps = {
  /** The embedded Claude Code copied out to a file it can run. */
  unpacking: "unpacking Claude Code",
  /** startup.ts's check, the login probe the slowest of it. */
  checking: "checking the setup and your Claude login",
  /** The tickets left unmerged, the carried ones and the ticket count, or the nothing check. */
  backlog: "reading the backlog",
  /** What is left before the first screen: the run lock, the run's services, the renderer. */
  starting: "starting the run",
} as const

/** The line as a run draws it until its first screen; `end` must end it. */
export interface GettingReady {
  /** Says the step under way. */
  readonly step: (detail: string) => Effect.Effect<void>
  /**
   * Runs `extracting`, the embedded Claude Code's copy, as the step unpacking, then the check's
   * again. The copy holds the thread, so no frame is drawn while it goes: one is given first.
   */
  readonly unpacking: <A, E, R>(extracting: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Ends the line with nothing left of it; once it has ended, nothing. */
  readonly end: Effect.Effect<void>
}

/** Where nothing is drawn: stdout isn't a terminal, or the terminal is dumb. */
const quiet: GettingReady = {
  step: () => Effect.void,
  unpacking: (extracting) => extracting,
  end: Effect.void,
}

/** The line's styles: every colour the terminal's own, the spinner bold and the time faint. */
const readyTheme = makeTheme(orchestra, { appearance: "dark", depth: "256", noColor: true })

/**
 * Starts the line on `out`, at the step checking. Its spinner is a fiber of the caller's, so an
 * interrupt or a failure that ends the caller erases it.
 */
export const gettingReady = (
  out: Out,
  terminal: { readonly dumb: boolean },
): Effect.Effect<GettingReady> =>
  Effect.gen(function* () {
    if (!out.tty || terminal.dumb) return quiet
    // The organ line puts one space before its detail; this one has two, as a heading has.
    const line = yield* makePrinter(out, readyTheme).organ("Getting ready ")
    yield* line.detail(readySteps.checking)
    let ended = false
    return {
      step: line.detail,
      unpacking: (extracting) =>
        ended
          ? extracting
          : Effect.gen(function* () {
              yield* line.detail(readySteps.unpacking)
              yield* Effect.sleep(frameInterval)
              const extracted = yield* extracting
              yield* line.detail(readySteps.checking)
              return extracted
            }),
      end: Effect.suspend(() => {
        ended = true
        return line.drop
      }),
    }
  })
