// The start question's side of the run (§ 5 item 3, § 7.1): whether a run asks it, what it says
// of the current tickets, how a run asks it, and how it reads a spec chosen there. A run asks once the startup checks have passed
// and it holds the run lock, when stdin and stdout are TTYs and no flag decides: --tickets,
// --ticket (or TUTTI_TICKET), --feature, --spec and --plain each do, and so does a --limit the run has
// already reached, as orchestra's. It asks in the command's one renderer, before the dashboard,
// or as lines (plain/forms.ts) when the terminal can't show one: TERM=dumb, or fewer than 256
// colours. A cancelled question ends the run before it started, exit 130.
import { Console, type Context, Effect, type FileSystem, Result } from "effect"
import type { AppConfigValue } from "../cli/AppConfig.ts"
import { Beads } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import type { OutputMode, TtyValue } from "../services/Tty.ts"
import { startQuestion, streamInput } from "../ui/plain/forms.ts"
import {
  type FormCancelled,
  type SpecAsk,
  specChosenFrom,
  specLine,
  TicketCount,
  type Work,
} from "../ui/questions.ts"
import type { Theme } from "../ui/theme.ts"
import { exitCodes } from "./holds.ts"
import * as nothing from "./nothing.ts"
import * as scope from "./scope.ts"
import { fetchUrlSpec, readSpec, type Spec } from "./spec.ts"
import type { LiveFetch, SpecFetch } from "./specSource.ts"

/** How the run asks the start question: in the renderer, as lines, or not at all. */
export type Asking = "renderer" | "lines" | "no"

/** The flags that decide what the run works on, so that it doesn't ask. */
export type Deciding = Pick<
  AppConfigValue,
  "tickets" | "ticket" | "feature" | "spec" | "plain" | "limit"
>

/** Whether a flag decides what the run works on: the start question isn't asked then. */
export const decided = (config: Deciding): boolean =>
  config.tickets ||
  config.ticket !== null ||
  config.feature !== null ||
  config.spec !== null ||
  config.plain ||
  (config.limit !== null && config.limit <= 0)

/**
 * How the run asks the start question on the terminal `tty`, its output in `mode`: not at all
 * unless stdin and stdout are TTYs and no flag decides; in the renderer with the dashboard, and as
 * lines when the terminal can't draw one.
 */
export const asking = (
  tty: Pick<TtyValue, "stdinIsTty" | "stdoutIsTty">,
  config: Deciding,
  mode: OutputMode,
): Asking => {
  if (!tty.stdinIsTty || !tty.stdoutIsTty || decided(config)) return "no"
  return mode._tag === "Dashboard" ? "renderer" : "lines"
}

/**
 * What the start question says of the current tickets the run `options` describes: how many bd
 * ready lists in `where`, its scope, or, with none, whether all is done or how many are open but
 * held or waiting, as nothing to run would say, without the deferred tickets it would list. Unknown
 * when bd can't say. `options` is only read with none ready.
 */
export const ticketCount = <R>(
  where: Pick<nothing.Options, "scope" | "filter">,
  options: Effect.Effect<nothing.Options, never, R>,
): Effect.Effect<TicketCount, never, Beads | Git | R> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ready = yield* Effect.result(scope.ready(beads, where.scope, where.filter))
    if (Result.isFailure(ready)) return TicketCount.Unknown()
    if (ready.success.length > 0) return TicketCount.Ready({ n: ready.success.length })
    const n = yield* Effect.result(
      nothing.check(yield* options, { deferred: false, ready: ready.success }),
    )
    if (Result.isFailure(n)) return TicketCount.Unknown()
    if (n.success === null) return TicketCount.Ready({ n: 0 })
    if (n.success.allDone) return TicketCount.AllDone()
    const open = n.success.scope === null ? nothing.open(n.success) : n.success.notDone.length
    return TicketCount.NoneReady({ open })
  })

/** The start question as lines: read from `stdin`, written with `write`, in `theme`. */
export const askLines = (
  stdin: NodeJS.ReadableStream,
  write: (text: string) => void,
  theme: Theme,
  count: TicketCount,
  spec: SpecAsk,
): Effect.Effect<Work, FormCancelled> =>
  Effect.scoped(
    Effect.flatMap(streamInput(stdin), (input) =>
      startQuestion({ input, write, theme }, count, spec),
    ),
  )

/**
 * What the start question needs to ask for a spec in the repository `repo`, `home` the home folder:
 * a URL is fetched with `fetch`, a fetchOnce keeping only what was fetched, so that reading the spec
 * once chosen doesn't fetch it again and a URL that failed is fetched again; run in `context`.
 */
export const specAsk = <R>(
  repo: string,
  home: string,
  fetch: SpecFetch<R>,
  context: Context.Context<R>,
): SpecAsk => ({
  where: { repo, home },
  checkUrl: (url) =>
    fetchUrlSpec(url, specChosenFrom, fetch).pipe(
      Effect.map((fetched) => (Result.isFailure(fetched) ? fetched.failure : null)),
      Effect.provideContext(context),
    ),
})

/** What a run says on stderr when the spec chosen at the start question can't be run, before exit 2. */
export const cannotRunSpec = (problem: string): string => `tutti cannot run that spec: ${problem}`

/** How a spec chosen at the start question was taken: the spec, or the exit code that ends the run. */
export type TakenSpec =
  | { readonly _tag: "Taken"; readonly spec: Spec }
  | { readonly _tag: "Refused"; readonly exitCode: number }

/**
 * The spec chosen at the start question, `work`, taken as --spec takes one: what was chosen said on
 * `out` (specLine), then the spec read with readChosenSpec, from the main checkout `repo`, and the
 * run lock's holder rewritten with it by `rewrite` (held all the same if it can't be). Refused with
 * exit 2 where it can't be run, having said why on `error`.
 */
export const takeSpec = <E>(
  work: Extract<Work, { readonly _tag: "Spec" }>,
  io: {
    readonly repo: string
    readonly fetch: SpecFetch<LiveFetch>
    readonly out: (text: string) => void
    readonly error: (text: string) => Effect.Effect<void>
    readonly rewrite: (spec: Spec) => Effect.Effect<void, E>
  },
): Effect.Effect<TakenSpec, never, FileSystem.FileSystem | Git | LiveFetch> =>
  Effect.gen(function* () {
    io.out(`${specLine(work.given, work.refine)}\n`)
    const read = yield* readChosenSpec(work.given, io.repo, io.fetch)
    if (Result.isFailure(read)) {
      yield* io.error(read.failure)
      return { _tag: "Refused", exitCode: exitCodes.setup } as const
    }
    yield* Effect.ignore(io.rewrite(read.success))
    return { _tag: "Taken", spec: read.success } as const
  })

/**
 * The spec chosen at the start question, `given` (its path, absolute, or its URL), read as the
 * startup checks read --spec's, in the main checkout `repo`, a URL fetched with `fetch`: the spec,
 * or what the run says before it exits 2 (cannotRunSpec), such as a spec git ignores.
 */
export const readChosenSpec = (
  given: string,
  repo: string,
  fetch: SpecFetch<LiveFetch>,
): Effect.Effect<Result.Result<Spec, string>, never, FileSystem.FileSystem | Git | LiveFetch> =>
  Effect.map(readSpec(given, specChosenFrom, repo, repo, fetch), Result.mapError(cannotRunSpec))

/**
 * Asks the start question with `ask`, then begins the run on the work chosen with `begin`: the
 * work, or null when the question was cancelled, which begins nothing, so the run has no start
 * record.
 */
export const askThenBegin = <E, R, R2>(
  ask: Effect.Effect<Work, E, R>,
  begin: (work: Work) => Effect.Effect<void, never, R2>,
): Effect.Effect<Work | null, never, R | R2> =>
  Effect.flatMap(Effect.result(ask), (asked) =>
    Result.isFailure(asked) ? Effect.succeed(null) : Effect.as(begin(asked.success), asked.success),
  )

/** What a run whose start question was cancelled says on stderr, before it exits 130. */
export const cancelledMessage = "tutti: stopped before the run started; nothing was changed."

/** Ends a run whose start question was cancelled: cancelledMessage on stderr, and exit 130. */
export const cancelled: Effect.Effect<number> = Effect.as(
  Console.error(cancelledMessage),
  exitCodes.interrupted,
)

/**
 * What a run says on stderr when its start question, asked as lines, chose a new feature: the
 * interview is a view in the renderer, which the terminal can't show.
 */
export const interviewUnavailable =
  "tutti: the feature interview needs tutti's full screen, which this terminal can't show; nothing was filed or changed. tutti --feature \"<request>\" plans the feature without it."
