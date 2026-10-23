// The Store's test layer (§ 3.3): the state in memory, with the live layer's operations and its
// commit, stamp and encoding included; only the file is a Ref. A change commits at once, in the
// order changes come, and readers get the last committed state.
import { Effect, Exit, Layer, Ref, Result } from "effect"
import {
  commit,
  emptyState,
  makeStore,
  type RunStamp,
  type State,
  Store,
  StoreWriteFailed,
  stateFile,
} from "../services/Store.ts"

/** The run the test layer stamps on what it commits, unless it is given one. */
export const testRun: RunStamp = { pid: 1, started: "2026-01-01T00:00:00Z", version: "0.0.0-test" }

/**
 * The test layer, starting from `initial` as if read from state.json, and committing as the run
 * `run`.
 */
export const layer = (initial: State = emptyState, run: RunStamp = testRun) =>
  Layer.effect(
    Store,
    Effect.map(Ref.make(initial), (state) =>
      makeStore(
        Ref.get(state),
        (change) =>
          Effect.flatten(
            Ref.modify(state, (current): [Exit.Exit<State, StoreWriteFailed>, State] => {
              const batch = commit(current, [change], run)
              const outcome = batch.changes[0] ?? Exit.void
              if (Exit.isFailure(outcome)) return [Exit.failCause(outcome.cause), current]
              if (batch.result === undefined) return [Exit.succeed(current), current]
              if (Result.isFailure(batch.result))
                return [
                  Exit.fail(
                    new StoreWriteFailed({ file: stateFile, reason: batch.result.failure }),
                  ),
                  current,
                ]
              return [Exit.succeed(batch.result.success.state), batch.result.success.state]
            }),
          ),
        initial.run,
      ),
    ),
  )
