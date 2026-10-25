// The SleepCauses test layer (§ 5 item 15): why the machine slept, read from the pmset log a test
// gives (a fixture's text), as the live source reads `pmset -g log`'s.
import { Effect, Layer } from "effect"
import { causeFromPmsetLog, SleepCauses } from "../run/sleepCause.ts"

/** A SleepCauses source that reads each sleep's cause from `log`, pmset's log as text. */
export const layer = (log: string): Layer.Layer<never> =>
  Layer.succeed(SleepCauses, { read: (from) => Effect.succeed(causeFromPmsetLog(log, from)) })
