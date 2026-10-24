// The drain (§ 5 item 10, § 7.4, orchestra's drain.go): asked to wind down (SIGUSR1, or the
// dashboard's `s` once it exists), the run starts no new tickets, the running ones finish and merge
// as usual, and the run ends DRAINED with exit code 0. Taken back, it takes tickets again. Only the
// latest request counts, and one that changes nothing says nothing.
//
// The wind-down itself is the ledger's (it notes the tickets running as it begins, for the
// wind-down line), and the scheduler takes no new tickets while it lasts. Beginning, it gives up the
// tickets waiting to be checked once more, naming each (recheck.ts's dropRechecks): taken back, it
// doesn't promise them again.
import { Effect } from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import type { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { type Line, type Log, line } from "./log.ts"
import { dropRechecks, type Rechecks } from "./recheck.ts"
import { say } from "./say.ts"

/** A request to wind down (`on`) or to take tickets again, and who asked: `by SIGUSR1`. */
export interface DrainRequest {
  readonly on: boolean
  readonly how: string
}

/** How SIGUSR1 asks, as the DRAIN line says it. */
export const bySignal = "by SIGUSR1"

/**
 * The words the DRAIN line and the dashboard share, for the tickets running (`ids`): lead, list
 * and tail read `stopping after the 2 running tickets finish (A, B): no new tickets will start`.
 */
export const drainWords = (
  ids: ReadonlyArray<string>,
): readonly [lead: string, list: string, tail: string] => {
  switch (ids.length) {
    case 0:
      return ["stopping now, as nothing is running", "", ""]
    case 1:
      return ["stopping after ", ids[0] as string, " finishes: no new tickets will start"]
  }
  return [
    `stopping after the ${ids.length} running tickets finish (`,
    ids.join(", "),
    "): no new tickets will start",
  ]
}

/** `DRAIN: stopping after …, asked by SIGUSR1`. */
export const drainLine = (running: ReadonlyArray<string>, how: string): Line => {
  const [lead, list, tail] = drainWords([...running].sort())
  const asked = how === "" ? "" : `, asked ${how}`
  return line`DRAIN: ${lead}${list}${tail}${asked}`
}

/** `DRAIN cancelled: taking new tickets again, asked …`. */
export const undrainLine = (how: string): Line => {
  const asked = how === "" ? "" : `, asked ${how}`
  return line`DRAIN cancelled: taking new tickets again${asked}`
}

/** The done line of a run that wound down as asked. */
export const drainedLine = (n: number): Line => line`DRAINED after ${n} tickets`

/**
 * Hears `request`: begins the wind-down, saying so with a `drain` record and its line, then giving
 * up the tickets waiting in `rechecks` to be checked once more, or ends it with a `resume` record;
 * nothing when the run already does as asked. Whether it winds down now.
 */
export const hear = (
  request: DrainRequest,
  rechecks?: Pick<Rechecks, "dropAll">,
): Effect.Effect<boolean, never, AgentHost | Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const winding = (yield* ledger.current).windDown !== null
    if (request.on === winding) return winding
    if (!request.on) {
      yield* ledger.windUp
      const text = undrainLine(request.how)
      yield* say({ kind: "resume", text })
      return false
    }
    yield* ledger.windDown
    const running = (yield* ledger.current).windDown?.tickets ?? []
    const text = drainLine(running, request.how)
    yield* say({ kind: "drain", text })
    if (rechecks !== undefined) yield* dropRechecks(rechecks, "the run winds down")
    return true
  })
