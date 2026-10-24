// The scheduler's fills as the tests run them, without the run's wakes (src/run/wakes.ts): a fill,
// then another on each slot freed or each ready poll, until interrupted.
import { Effect } from "effect"
import { readyPoll, type Scheduler } from "../src/run/schedule.ts"
import type { BeadsError } from "../src/services/Beads.ts"

/** Fills, then again on each ready poll and each slot freed; a read that fails as fillTrying does. */
export const filling = (schedule: Scheduler): Effect.Effect<never, BeadsError> =>
  Effect.forever(
    Effect.andThen(
      schedule.fillTrying,
      Effect.race(schedule.freed, Effect.asVoid(Effect.sleep(readyPoll))),
    ),
  )
