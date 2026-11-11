// A bare `tutti`'s run (src/main.ts's runFrom) presented plain (§ 7.6): the open questions and
// the start question as lines, a spec broken down on the main screen (a refinement needs the
// renderer, which plain output doesn't open), then the run, its log lines on stdout.
import { Console, Effect, Option } from "effect"
import { stdout } from "../../print/organLine.ts"
import { exitCodes } from "../../run/holds.ts"
import { EventStream } from "../../services/EventStream.ts"
import { endRecord } from "../../services/Spending.ts"
import { Work } from "../../ui/questions.ts"
import { askLines, askThenBegin, interviewUnavailable } from "../choose.ts"
import { exitNow } from "./running.ts"
import type { Presented, Starting } from "./starting.ts"

/**
 * The run presented plain, from what it starts from, `on`: the open questions put as lines, the
 * spec started, the start question asked as lines where the terminal allows, the spec chosen run
 * as it is, then the run, unless there is nothing to run. A new feature chosen as lines can't be
 * interviewed: the interview needs the renderer.
 */
export const presentPlain = (on: Starting) =>
  Effect.gen(function* () {
    const { ready, asks, error, looks, backlog, specs, beginning, questions, runner } = on
    const events = yield* EventStream
    const stoppedAt = yield* questions.putOnMainScreen
    if (stoppedAt !== null) return { _tag: "Stopped", exitCode: stoppedAt } as const
    // A refinement needs the renderer, which plain output doesn't open.
    const specStopped = yield* specs.startSpec({ out: stdout, error, refine: Option.none() })
    if (specStopped !== undefined) return { _tag: "Stopped", exitCode: specStopped } as const
    const work = yield* askThenBegin(
      asks === "lines" && looks.mainTheme !== undefined
        ? Effect.andThen(
            ready.end,
            askLines(
              process.stdin,
              (text) => process.stdout.write(text),
              looks.mainTheme,
              backlog.count,
              on.specAsking,
            ),
          )
        : Effect.succeed(Work.Tickets()),
      beginning.beginUnlessSpec,
    )
    if (work === null) return { _tag: "Cancelled" } as const
    if (work._tag === "Feature") {
      yield* ready.end
      yield* Console.error(interviewUnavailable)
      yield* Effect.flatMap(endRecord(exitCodes.ok), events.emit)
      return { _tag: "Stopped", exitCode: exitCodes.ok } as const
    }
    if (work._tag === "Spec") {
      // A spec chosen as lines, run as it is: refining it needs the renderer.
      const failed = yield* specs.takeChosen(work, stdout, error)
      if (failed !== undefined) return { _tag: "Stopped", exitCode: failed } as const
      const chosenStopped = yield* specs.startSpec({ out: stdout, error, refine: Option.none() })
      if (chosenStopped !== undefined) return { _tag: "Stopped", exitCode: chosenStopped } as const
      yield* beginning.begin(Work.Tickets())
    }
    const nothing = yield* backlog.nothingYet
    if (nothing !== null) return nothing
    yield* ready.end
    const outcome = yield* runner.go({ exitNow: exitNow() })
    // The report's theme, made only when the report prints: off the main screen's theme, it
    // asks the terminal for its background.
    const theme =
      looks.mainTheme === undefined ? looks.printedThemeOf(stdout) : Effect.succeed(looks.mainTheme)
    const ran: Presented = {
      _tag: "Ran",
      outcome,
      report: Effect.flatMap(theme, looks.reportOut),
      styled: false,
    }
    return ran
  })
