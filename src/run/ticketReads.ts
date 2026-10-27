// The run's tickets read at its end with one bd list, not a bd show each: bd serialises its calls,
// so a show each cost the run's end most of a second a ticket, twice over (labelAtEnd's, the
// report's), while it held its lock. The list gives the fields both read (title, status, labels,
// notes, close reason) as a show does.
import { Effect, Result } from "effect"
import { Beads, type BeadsError, type Issue, type TicketId } from "../services/Beads.ts"

/** Gives a ticket as bd has it, or how bd failed to give it. */
export type Read = (id: TicketId) => Effect.Effect<Issue, BeadsError>

/**
 * Reads the tickets with one bd list, closed ones too, and gives each from it. One the list didn't
 * give (a tombstone, an issue deleted meanwhile), or every one where the list failed, is shown on
 * its own, so it fails as its bd show did before.
 */
export const listedOrShown = (ids: ReadonlyArray<TicketId>): Effect.Effect<Read, never, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const listed = yield* Effect.result(beads.list({ ids, all: true }))
    const byId = new Map<string, Issue>(
      Result.isSuccess(listed) ? listed.success.map((issue) => [issue.id, issue]) : [],
    )
    return (id) => {
      const known = byId.get(id)
      return known === undefined ? beads.show(id) : Effect.succeed(known)
    }
  })
