// A run scoped to the epic a feature's or a spec's breakdown filed (§ 4.10, § 4.14), as --ticket
// <epic> scopes one: AppConfig's ticket the epic, and a spec run's spec path or a feature run's
// request beside it.
import { Effect } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import type { TicketId } from "../services/Beads.ts"
import { oneLine } from "../ui/oneLine.ts"

/**
 * `effect` with AppConfig scoped to `epic`, as --ticket <epic> scopes a run; a spec run's with its
 * spec's path, `specPath`; a feature run's with the request it was talked through from, `feature`
 * (New feature's, which AppConfig doesn't have; null keeps --feature's).
 */
export const scopedTo =
  (epic: TicketId, specPath: string | null = null, feature: string | null = null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | AppConfig> =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      return yield* Effect.provideService(effect, AppConfig, {
        ...config,
        ticket: epic,
        specPath,
        ...(feature === null ? {} : { feature }),
      })
    })

/**
 * A feature request on one line, its white space collapsed and cut after 200 characters, for the
 * START block, as orchestra's FeatureLine.
 */
export const featureLine = (request: string): string => oneLine(request, 201)

/** The heading of the report's section with the request a feature run's `epic` was talked through from. */
export const featureRequestHeading = (epic: TicketId | null): string =>
  epic === null ? "The feature request" : `The feature request epic ${epic} was talked through from`
