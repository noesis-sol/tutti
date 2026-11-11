// A spec's start in a bare `tutti`'s run (src/main.ts's runFrom): --spec's, wired into the run
// (src/run/specStart.ts), or the spec chosen at the start question, taken as --spec takes one.
import { type Context, Effect, type Option, Queue, type Scope } from "effect"
import type { GettingReady } from "../../print/gettingReady.ts"
import { bothPrinters, makePrinter, type Out } from "../../print/organLine.ts"
import type { InterviewScreen } from "../../run/interview.ts"
import { breakdownFailed, type QuitRequest } from "../../run/quit.ts"
import type { LiveFetch, SpecFetch } from "../../run/specSource.ts"
import { specStart } from "../../run/specStart.ts"
import { EventStream } from "../../services/EventStream.ts"
import type { HeldLock } from "../../services/RunLock.ts"
import { endRecord } from "../../services/Spending.ts"
import type { Work } from "../../ui/questions.ts"
import type { Shell } from "../../ui/renderer.ts"
import { takeSpec } from "../choose.ts"
import type { Choice } from "./choice.ts"
import { gitLayer } from "./layers.ts"
import type { Looks } from "./looks.ts"

/** Where a spec's start says what it says, and shows its refinement. */
export interface SpecStartIO {
  readonly out: Out
  readonly error: (text: string) => Effect.Effect<void>
  readonly refine: Option.Option<InterviewScreen>
  /**
   * The renderer, open: its appearance is the theme's, as asking the terminal for its background
   * would take stdin from the renderer, which then gets no key.
   */
  readonly shell?: Shell
  /** An Out on the renderer's screen, which draws the organ lines there as well, unstyled, while `out` holds them. */
  readonly drawn?: Out
}

/**
 * The spec's start in the run `choice` describes: --spec (src/run/specStart.ts), the spec committed
 * with the `setup`'s files and broken down where it needs to be, then the run scoped to its root
 * epic, which the `lock` then names; and the spec chosen at the start question, taken as --spec
 * takes one and wired the same. An early start's breakdown goes on in `runScope`; one that fails
 * quits the run through `quits`.
 */
export const specsOf = (options: {
  readonly setup: ReadonlyArray<string>
  readonly lock: HeldLock
  readonly runScope: Scope.Scope
  readonly quits: Queue.Queue<QuitRequest>
  readonly choice: Choice
  readonly ready: GettingReady
  readonly looks: Looks
  readonly fieldFetch: SpecFetch<LiveFetch>
  readonly fetchContext: Context.Context<LiveFetch>
}) => {
  const { setup, lock, runScope, quits, choice, ready, looks, fieldFetch, fetchContext } = options
  const wireSpec = () =>
    specStart({
      setup,
      holder: choice.holder,
      rewrite: lock.rewrite,
      runScope,
      quit: Queue.offer(quits, breakdownFailed),
    })
  let specStarting = wireSpec()
  /**
   * The spec's start, where there is one: what it says goes to `io`'s out and error; a refinement
   * is shown with its refine. The exit code when it stopped the run; else the run is scoped to the
   * root epic.
   */
  const startSpec = (io: SpecStartIO) =>
    Effect.gen(function* () {
      if (choice.spec === null) return undefined
      const events = yield* EventStream
      yield* ready.end
      const theme =
        io.shell === undefined
          ? yield* looks.printedThemeOf(io.out)
          : looks.themeOf(io.shell.appearance.get())
      // Drawn on the screen, its organ lines are held for the main screen with their final
      // lines alone, as off a terminal.
      const printer = makePrinter(
        io.drawn === undefined ? io.out : { ...io.out, tty: false },
        theme,
      )
      const begun = yield* specStarting.start(choice.spec, choice.config, {
        printer:
          io.drawn === undefined
            ? printer
            : bothPrinters(printer, makePrinter(io.drawn, looks.themeOf(theme.appearance, false))),
        error: io.error,
        refine: io.refine,
      })
      if (begun._tag === "Stopped") {
        yield* Effect.flatMap(endRecord(begun.exitCode), events.emit)
        return begun.exitCode
      }
      choice.scope = begun.root
      return undefined
    })
  /**
   * The spec chosen at the start question, `work`, taken as --spec takes one: what was chosen
   * said on `out`, then the spec read as the startup checks read it, the run, the lock and the
   * spec's start wired to it. The exit code where it can't be run, having said why on `error`.
   */
  const takeChosen = (
    work: Extract<Work, { readonly _tag: "Spec" }>,
    out: Out,
    error: (text: string) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const taken = yield* takeSpec(work, {
        repo: choice.config.repo,
        fetch: fieldFetch,
        out: (text) => out.write(text),
        error,
        rewrite: (read) => lock.rewrite({ ...choice.holder, spec: read.path }),
      }).pipe(Effect.provide(gitLayer), Effect.provideContext(fetchContext))
      if (taken._tag === "Refused") return taken.exitCode
      choice.spec = taken.spec
      choice.config = { ...choice.config, refine: work.refine }
      choice.started = { ...choice.started, spec: taken.spec, config: choice.config }
      choice.holder = { ...choice.holder, spec: taken.spec.path }
      specStarting = wireSpec()
      return undefined
    })
  return {
    startSpec,
    takeChosen,
    /** The run's options for an early start: what the breakdown has filed meanwhile. */
    runOptions: () => specStarting.runOptions(),
    /** Once the run has ended: a breakdown the run's end cut short stops with it. */
    stop: Effect.suspend(() => specStarting.stop),
    /** The run's exit code: the breakdown's where it stopped the run, else the run's own `code`. */
    exitCode: (code: number) => specStarting.exitCode(code),
  }
}

/** A spec's start as `specsOf` wired it. */
export type Specs = ReturnType<typeof specsOf>
