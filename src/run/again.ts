// How a failed read, or a write git was kept from, is made again: a few times in all, a few
// seconds apart, as a Schedule for Effect.retry. Each policy is named once, where its reads are:
// branch.ts's gitAgain for the git reads that steer a merge, schedule.ts's readAgain for bd's.
import { type Duration, Effect, Schedule } from "effect"

/** How a failing effect is made again: up to `tries` times in all, `after` apart. */
export interface Again {
  readonly tries: number
  readonly after: Duration.Duration
}

/** What else a retry by `again` takes: which failures are tried again, and who is told of each. */
export interface AgainOptions<E, R> {
  /** Whether `error` is worth another try; every failure is without it. */
  readonly while?: (error: E) => boolean
  /** Told of each failed try that is made again, `tried` its number (1 for the first). */
  readonly tried?: (error: E, tried: number) => Effect.Effect<void, never, R>
}

/**
 * The schedule Effect.retry takes for `policy`. Its limits sit under `tried`, so that the try that
 * gives up isn't said to be made again: Effect.retry's own `times` and `while` are checked after a
 * schedule's tap has run.
 */
export const again = <E, R = never>(
  policy: Again,
  options: AgainOptions<E, R> = {},
): Schedule.Schedule<number, E, never, R> => {
  const { while: retries, tried } = options
  return Schedule.spaced(policy.after).pipe(
    Schedule.setInputType<E>(),
    Schedule.upTo({ times: policy.tries - 1 }),
    Schedule.while(({ input }) => retries === undefined || retries(input)),
    Schedule.tap(({ input, attempt }) =>
      tried === undefined ? Effect.void : tried(input, attempt),
    ),
  )
}

/** `effect`, made again as `policy` says while it fails: then it fails with its last error. */
export const retrying = <A, E, R, R2 = never>(
  effect: Effect.Effect<A, E, R>,
  policy: Again,
  options: AgainOptions<E, R2> = {},
): Effect.Effect<A, E, R | R2> => Effect.retry(effect, again(policy, options))
