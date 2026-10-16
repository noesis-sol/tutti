// The Store's test layer (§ 3.3): the state in memory, with the live layer's operations. A change
// commits at once, in the order changes come, and readers get the last committed state.
import { Effect, Layer, Ref } from "effect"
import { emptyState, makeStore, type State, Store } from "../services/Store.ts"

/** The test layer, starting from `initial` as if read from state.json. */
export const layer = (initial: State = emptyState) =>
  Layer.effect(
    Store,
    Effect.map(Ref.make(initial), (state) =>
      makeStore(Ref.get(state), (change) => Ref.updateAndGet(state, change)),
    ),
  )
