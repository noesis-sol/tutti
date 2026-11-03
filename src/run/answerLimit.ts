// The time limit of what an overnight run asks before it starts (tutti-epza.17): the pre-flight's
// fixes and its start-anyway question (overnight.ts), and the open questions (overnightQuestions.ts).
// A maintainer who starts tutti --overnight and walks away meets the first of them only after the
// slow merge check on the base, so each waits `answerLimit`, a countdown on screen saying what no
// answer takes, then takes its default: a fix as offered (yes), start anyway no, a question left
// open. Once one has gone unanswered, nobody is there: the rest take theirs without being asked.
import { Duration, Effect, type Option } from "effect"

/** How long a question asked before an overnight run waits for its answer. */
export const answerLimit: Duration.Duration = Duration.minutes(5)

/** What no answer takes, as the countdown says it: `takes yes`, `leaves it open`. */
export type Taken = string

/** What no answer to a yes-or-no question whose default is `initial` takes. */
export const takesAnswer = (initial: boolean): Taken => `takes ${initial ? "yes" : "no"}`

/** What no answer to an open question takes. */
export const leavesOpen: Taken = "leaves it open"

/** `millis` as the countdown gives it, rounded up to the second: `4:59`, `0:00`. */
export const clockOf = (millis: number): string => {
  const seconds = Math.max(0, Math.ceil(millis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** The countdown's line, `left` milliseconds to go: `No answer in 4:59 takes yes.` */
export const countdownText = (left: number, taken: Taken): string =>
  `No answer in ${clockOf(left)} ${taken}.`

/** How often the countdown is drawn again. */
export const countdownTick: Duration.Duration = Duration.seconds(1)

/** The answer `asking` gives within `limit`, or none once it runs out, `asking` then stopped. */
export const within = <A, E, R>(
  asking: Effect.Effect<A, E, R>,
  limit: Duration.Duration,
): Effect.Effect<Option.Option<A>, E, R> => Effect.timeoutOption(asking, limit)

/**
 * What is said and logged of `asked`, a question no answer came to within `limit`, and what it
 * took: `overnight pre-flight: no answer in 5m to "Run without a limit?": yes`.
 */
export const unansweredText = (limit: Duration.Duration, asked: string, took: string): string =>
  `overnight pre-flight: no answer in ${Duration.format(limit)} to ${asked}: ${took}`

/** What is said and logged of `asked`, not asked as nobody answered one before it, and what it took. */
export const notAskedText = (asked: string, took: string): string =>
  `overnight pre-flight: not asked, as nobody answered: ${asked}: ${took}`
