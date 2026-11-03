// bd failing to read the queue (run.ts's fill, § 5 item 10). A fill whose bd read still fails after
// schedule.ts's readAgain skips that look's dispatch, and a later look reads the queue again: the
// next one at first, then a poll later, doubling up to readBackoffMax. The run stops with
// BEADS_FAILED only once every read has failed for beadsOutage: a Dolt lock, a bd sync or a Dolt
// server restarting after a wake delays the fill by a few minutes rather than end the run hours
// early. Its time is counted awake, as tutti's limits are (§ 3.3). Until the queue is read again,
// the run doesn't end on the tickets it couldn't see.
import { Duration } from "effect"
import { formatDuration } from "../project/configFile.ts"
import { beadsOutage, readyPoll } from "./schedule.ts"

/** The longest a look waits, after a failed fill, before it reads the queue again. */
export const readBackoffMax: Duration.Duration = Duration.minutes(2)

/** An outage of bd's queue reads: every fill since `since` failed. */
export interface Outage {
  /** When the first failed fill of the outage ended, in the clock's milliseconds. */
  readonly since: number
  /** How many fills have failed in it. */
  readonly failed: number
  /** When a look may read the queue again. */
  readonly next: number
}

/**
 * How long a look waits to read the queue again after the `failed`th failed fill of an outage:
 * not at all after the first, the next look reading it, then a poll, doubling to readBackoffMax.
 */
export const backoff = (failed: number): Duration.Duration =>
  failed <= 1
    ? Duration.zero
    : Duration.min(Duration.times(readyPoll, 2 ** (failed - 2)), readBackoffMax)

/** The outage once a fill has failed at `now`: begun with it, or one more failure in it. */
export const failedRead = (outage: Outage | null, now: number): Outage => {
  const failed = (outage?.failed ?? 0) + 1
  return { since: outage?.since ?? now, failed, next: now + Duration.toMillis(backoff(failed)) }
}

/** Whether a look at `now` reads the queue: always but during an outage's backoff. */
export const readDue = (outage: Outage | null, now: number): boolean =>
  outage === null || now >= outage.next

/**
 * Whether an outage the machine has been awake for `awake` ms of, since it began, has lasted
 * beadsOutage, which stops the run: a sleep meanwhile isn't counted (Wake.ts's awakeSince), so a
 * fill failing as the machine wakes, Dolt restarting, doesn't stop it at once.
 */
export const sustained = (awake: number): boolean => awake >= Duration.toMillis(beadsOutage)

/** How long an outage has lasted, `awake` ms of the machine awake, to the second ("1m30s"). */
export const lasted = (awake: number): string =>
  formatDuration(Duration.seconds(Math.round(awake / 1000)))
