// The Ledger's test layer (§ 3.3): the live ledger, which keeps its state in memory, over the
// captured Log and EventStream, so a test can read the PHASE_BUG lines and the phase records.
import { Layer } from "effect"
import type { EventStream } from "../run/eventstream.ts"
import { Ledger } from "../run/ledger.ts"
import type { Log } from "../run/log.ts"
import { type Captured, layer as eventsLayer } from "./EventStream.ts"
import { layer as logLayer } from "./Log.ts"

/** The ledger, with the captured Log and EventStream it writes to. */
export const layer = (): Layer.Layer<Ledger | Log | EventStream | Captured> =>
  Ledger.layer.pipe(Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())))
