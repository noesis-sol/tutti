// A run scoped to the epic a feature's or a spec's breakdown filed (§ 4.10, § 4.14), as --ticket
// <epic> scopes one: AppConfig's ticket the epic, and a spec run's spec path beside it.
import { Effect } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import type { TicketId } from "../services/Beads.ts"

/**
 * `effect` with AppConfig scoped to `epic`, as --ticket <epic> scopes a run; a spec run's with its
 * spec's path, `specPath`.
 */
export const scopedTo =
  (epic: TicketId, specPath: string | null = null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | AppConfig> =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      return yield* Effect.provideService(effect, AppConfig, { ...config, ticket: epic, specPath })
    })
