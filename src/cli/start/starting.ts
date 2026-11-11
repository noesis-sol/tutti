// What a bare `tutti`'s run (src/main.ts's runFrom) starts from, on the run's services: its looks,
// its backlog, its spec's start, its beginning, its open questions and its run, each made in the
// order the run reads them, for the mode's presentation (plain.ts, dashboard.ts) to use; and how
// a presentation ends, for exit.ts.
import { homedir } from "node:os"
import type { Context } from "effect"
import { Console, Effect, Queue, type Scope } from "effect"
import type { GettingReady } from "../../print/gettingReady.ts"
import type { DrainRequest } from "../../run/drain.ts"
import type { InterviewEnding } from "../../run/interview.ts"
import type { NothingToRun } from "../../run/nothing.ts"
import { logSuspends, type QuitRequest } from "../../run/quit.ts"
import type { ReportOut } from "../../run/report.ts"
import type { Outcome } from "../../run/run/shared.ts"
import type { LiveFetch, SpecFetch } from "../../run/specSource.ts"
import type { Started } from "../../run/startup.ts"
import type { HeldLock, Holder } from "../../services/RunLock.ts"
import { type OutputMode, Tty } from "../../services/Tty.ts"
import { type Asking, specAsk } from "../choose.ts"
import { type Backlog, backlogOf } from "./backlog.ts"
import { type Beginning, beginningOf } from "./beginning.ts"
import type { Choice } from "./choice.ts"
import { type Looks, looksOf } from "./looks.ts"
import type { Power } from "./power.ts"
import { type Questions, questionsOf } from "./questions.ts"
import { type Runner, runnerOf } from "./running.ts"
import { type Specs, specsOf } from "./specs.ts"

/** How a mode's presentation of the run ended, for exit.ts to end the run with. */
export type Presented =
  /** The start question was cancelled. */
  | { readonly _tag: "Cancelled" }
  /** The open questions were cancelled, `answered` of them answered. */
  | { readonly _tag: "AtQuestions"; readonly answered: number }
  /** The run stopped before it began, having said why: its exit code. */
  | { readonly _tag: "Stopped"; readonly exitCode: number }
  /** The interview ended with no run: the lines saying what was chosen, then its ending. */
  | {
      readonly _tag: "Interviewed"
      readonly chosen: ReadonlyArray<string>
      readonly ending: InterviewEnding
    }
  /** Nothing to run, reported on the main screen. */
  | { readonly _tag: "Nothing"; readonly nothing: NothingToRun }
  /** The run went: its outcome, and where its report goes, `styled` after a dashboard. */
  | {
      readonly _tag: "Ran"
      readonly outcome: Outcome
      readonly report: Effect.Effect<ReportOut>
      readonly styled: boolean
    }

/** What the run starts from, as `starting` made it. */
export interface Starting {
  readonly ready: GettingReady
  readonly tty: Tty["Service"]
  readonly mode: OutputMode
  /** How the start question is asked: in the renderer, as lines, or not at all. */
  readonly asks: Asking
  /** Whether stdin and stdout are both terminals. */
  readonly canAsk: boolean
  /** Says `text` on stderr. */
  readonly error: (text: string) => Effect.Effect<void>
  readonly choice: Choice
  readonly looks: Looks
  readonly backlog: Backlog
  /** What the start question needs to ask for a spec. */
  readonly specAsking: ReturnType<typeof specAsk>
  readonly specs: Specs
  readonly beginning: Beginning
  readonly questions: Questions
  readonly runner: Runner
}

/**
 * What the run `started` describes starts from, made on the run's services in the order the run
 * reads them: the suspends logged, the looks (the main theme asking the terminal for its
 * background), the backlog, the spec's start, the beginning, the open questions, then the run's
 * START block from a reading of the machine.
 */
export const starting = (options: {
  readonly started: Started
  readonly holder: Holder
  readonly base: string
  readonly subscription: boolean
  readonly setup: ReadonlyArray<string>
  readonly ready: GettingReady
  readonly mode: OutputMode
  readonly asks: Asking
  readonly lock: HeldLock
  readonly runScope: Scope.Scope
  readonly machine: Power
  readonly unanswered: boolean
  readonly drains: Queue.Queue<DrainRequest>
  readonly suspends: Queue.Queue<void>
  readonly fieldFetch: SpecFetch<LiveFetch>
  readonly fetchContext: Context.Context<LiveFetch>
}) =>
  Effect.gen(function* () {
    const { started, base, ready, mode, asks, lock, runScope, machine } = options
    const { config } = started
    const tty = yield* Tty
    yield* logSuspends(options.suspends)
    const looks = yield* looksOf(config, tty, mode, asks)
    const choice: Choice = {
      scope: config.ticket,
      feature: config.feature,
      spec: started.spec ?? null,
      config,
      started,
      holder: options.holder,
    }
    const backlog = yield* backlogOf(config, base, choice, ready, asks)
    const specAsking = specAsk(config.repo, homedir(), options.fieldFetch, options.fetchContext)
    const beginning = beginningOf({ machine, runScope, mode, ready, lock, base, choice })
    // The run's quits: SIGINT, SIGTERM and SIGHUP while it goes (§ 4.8), and a spec's breakdown
    // failing after the early start.
    const quits = yield* Queue.unbounded<QuitRequest>()
    const specs = specsOf({
      setup: options.setup,
      lock,
      runScope,
      quits,
      choice,
      ready,
      looks,
      fieldFetch: options.fieldFetch,
      fetchContext: options.fetchContext,
    })
    const canAsk = tty.stdinIsTty && tty.stdoutIsTty
    const error = (text: string) => Console.error(text)
    const questions = yield* questionsOf({
      config,
      choice,
      ready,
      canAsk,
      unanswered: options.unanswered,
      mode,
      tty,
      looks,
    })
    const runner = yield* runnerOf({
      config,
      base,
      subscription: options.subscription,
      mode,
      tty,
      drains: options.drains,
      quits,
      machine,
      specs,
      choice,
    })
    const made: Starting = {
      ready,
      tty,
      mode,
      asks,
      canAsk,
      error,
      choice,
      looks,
      backlog,
      specAsking,
      specs,
      beginning,
      questions,
      runner,
    }
    return made
  })
