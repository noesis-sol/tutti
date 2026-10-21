// A worker's compactions (§ 4.2, "The callbacks also record compactions, for triage and the
// reviewer"): each one its PreCompact hook reports is counted in its ticket's tallies, which the
// report and the reviewer say ("compacted twice"), and logged as orchestra logs it, with an `info`
// record. Triage reads them from the worker's transcript instead (src/run/triage.ts).
import { Effect, Stream } from "effect"
import { AgentHost, type Compaction } from "../agent/AgentHost.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import * as log from "./log.ts"
import { Log } from "./log.ts"

/** Counts and logs `c`; a worker whose ticket the run hasn't taken up (the probe's) is left out. */
export const noteCompaction = (
  c: Compaction,
): Effect.Effect<void, never, Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    if (!(yield* ledger.current).tickets.has(c.ticket)) return
    yield* ledger.count(c.ticket, "compactions")
    const text = log.compacted(c.ticket, c.trigger)
    yield* (yield* Log).writeWith(
      [text],
      (yield* EventStream).emit({ kind: "info", ticket: c.ticket, text }),
    )
  })

/** Notes every worker's compactions from now on, for as long as it runs. */
export const noteCompactions: Effect.Effect<void, never, AgentHost | Ledger | Log | EventStream> =
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* Stream.runForEach(host.compactions, noteCompaction)
  })
