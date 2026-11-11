// --overnight's open questions in a bare `tutti`'s run (src/main.ts's runFrom), put to you before
// the first ticket (src/run/overnightQuestions.ts): in the renderer with a dashboard, as lines in
// plain output, and listed, nothing asked, without a terminal.
import { Console, Effect, Option } from "effect"
import type { AppConfigValue } from "../../core/AppConfig.ts"
import type { GettingReady } from "../../print/gettingReady.ts"
import { makePrinter, stdout } from "../../print/organLine.ts"
import {
  openQuestions,
  type Put,
  putQuestions,
  stoppedAtQuestions,
} from "../../run/overnightQuestions.ts"
import { beadsWhy } from "../../services/Beads.ts"
import type { OutputMode, TtyValue } from "../../services/Tty.ts"
import { openQuestion, streamInput } from "../../ui/plain/forms.ts"
import type { Choice } from "./choice.ts"
import type { Looks } from "./looks.ts"
import { liveLines } from "./preflight.ts"

/**
 * The open questions of the run `choice` describes, read when it is overnight (bd failing to list
 * them leaves them to you, saying so, once the getting-ready line `ready` has gone), and how they
 * are put: as lines on the main screen in a terminal that `canAsk`, in the renderer with a
 * dashboard. A question of the pre-flight nobody answered (`unanswered`) leaves them open, as
 * without a terminal.
 */
export const questionsOf = (options: {
  readonly config: Pick<AppConfigValue, "overnight">
  readonly choice: Choice
  readonly ready: GettingReady
  readonly canAsk: boolean
  readonly unanswered: boolean
  readonly mode: OutputMode
  readonly tty: TtyValue
  readonly looks: Looks
}) =>
  Effect.gen(function* () {
    const { config, choice, ready, canAsk, unanswered, mode, tty, looks } = options
    const questions = config.overnight
      ? yield* openQuestions(choice.scope).pipe(
          Effect.catch((failure) =>
            Effect.as(
              Effect.andThen(
                ready.end,
                Console.error(
                  `tutti --overnight couldn't read the open questions to put to you first: ${beadsWhy(failure)}`,
                ),
              ),
              [],
            ),
          ),
        )
      : []
    const putsThem = canAsk && !unanswered
    const putInRenderer = questions.length > 0 && putsThem && mode._tag === "Dashboard"
    /**
     * The questions put as lines in a terminal, or listed without one, on the main screen: the
     * exit code where that was cancelled, else null.
     */
    const putOnMainScreen = Effect.gen(function* () {
      if (questions.length === 0) return null
      yield* ready.end
      const theme = looks.mainTheme ?? (yield* looks.printedThemeOf(stdout))
      const write = (text: string) => process.stdout.write(text)
      const live = liveLines(tty)
      const put: Put = (question, at, limit) =>
        Effect.scoped(
          Effect.flatMap(streamInput(process.stdin), (input) =>
            openQuestion({ input, write, theme, ...live }, question, at, limit),
          ),
        )
      const putting = yield* putQuestions({
        questions,
        put: putsThem ? Option.some(put) : Option.none(),
        say: { ...makePrinter(stdout, theme), theme },
      })
      return putting._tag === "Cancelled" ? yield* stoppedAtQuestions(putting.answered) : null
    })
    return { questions, putInRenderer, putOnMainScreen }
  })

/** The open questions as `questionsOf` read them. */
export type Questions = Effect.Success<ReturnType<typeof questionsOf>>
