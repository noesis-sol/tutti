// Spending's test layer (§ 3.3): the live layer, which keeps its sums in memory, over the
// EventStream in context, the captured one in a scenario. The scripted AgentHost hands it the
// results its scripts emit, as the live host does.
import type { Layer } from "effect"
import type { EventStream } from "../services/EventStream.ts"
import { Spending } from "../services/Spending.ts"

/** Spending over the EventStream in context. */
export const layer = (): Layer.Layer<Spending, never, EventStream> => Spending.layer
