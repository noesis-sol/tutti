// The start question's side of the run (§ 5 item 3, § 7.1): whether a run asks it, what it says
// of the current tickets, and how a run asks it. A run asks once the startup checks have passed
// and it holds the run lock, when stdin and stdout are TTYs and no flag decides: --tickets,
// --ticket (or TUTTI_TICKET), --feature and --plain each do, and so does a --limit the run has
// already reached, as orchestra's. It asks in the command's one renderer, before the dashboard,
// or as lines (plain/forms.ts) when the terminal can't show one: TERM=dumb, or fewer than 256
// colours. A cancelled question ends the run before it started, exit 130.
import { Console, Effect, Result } from "effect"
import type { AppConfigValue } from "../cli/AppConfig.ts"
import { Beads } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import type { OutputMode, TtyValue } from "../services/Tty.ts"
import { startQuestion, streamInput } from "../ui/plain/forms.ts"
import { type FormCancelled, TicketCount, type Work } from "../ui/questions.ts"
import type { Theme } from "../ui/theme.ts"
import { exitCodes } from "./holds.ts"
import * as nothing from "./nothing.ts"
import * as scope from "./scope.ts"

/** How the run asks the start question: in the renderer, as lines, or not at all. */
export type Asking = "renderer" | "lines" | "no"

/** The flags that decide what the run works on, so that it doesn't ask. */
export type Deciding = Pick<AppConfigValue, "tickets" | "ticket" | "feature" | "plain" | "limit">

/** Whether a flag decides what the run works on: the start question isn't asked then. */
export const decided = (config: Deciding): boolean =>
  config.tickets ||
  config.ticket !== null ||
  config.feature !== null ||
  config.plain ||
  config.limit <= 0

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
 * ready lists in its scope, or, with none, whether all is done or how many are open but held or
 * waiting, as nothing to run would say. Unknown when bd can't say.
 */
export const ticketCount = (
  options: nothing.Options,
): Effect.Effect<TicketCount, never, Beads | Git> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ready = yield* Effect.result(scope.ready(beads, options.scope, options.filter))
    if (Result.isFailure(ready)) return TicketCount.Unknown()
    if (ready.success.length > 0) return TicketCount.Ready({ n: ready.success.length })
    const n = yield* Effect.result(nothing.check(options))
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
): Effect.Effect<Work, FormCancelled> =>
  Effect.scoped(
    Effect.flatMap(streamInput(stdin), (input) => startQuestion({ input, write, theme }, count)),
  )

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
