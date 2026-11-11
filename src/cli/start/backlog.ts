// The backlog as a bare `tutti`'s run (src/main.ts's runFrom) reads it before it begins: whether
// there is nothing to run (src/run/nothing.ts), and what the start question says of the tickets.
import { Effect, Result } from "effect"
import type { AppConfigValue } from "../../core/AppConfig.ts"
import { type GettingReady, readySteps } from "../../print/gettingReady.ts"
import { carriedTickets } from "../../run/carry.ts"
import { startBranches } from "../../run/closedBranches.ts"
import {
  check as checkNothing,
  heldAtStart,
  type Options as NothingOptions,
} from "../../run/nothing.ts"
import { fixedLeft } from "../../run/takenBack.ts"
import { stillUnmerged } from "../../run/unmerged.ts"
import { Beads, type TicketId } from "../../services/Beads.ts"
import { TicketCount } from "../../ui/questions.ts"
import { type Asking, ticketCount } from "../choose.ts"
import type { Choice } from "./choice.ts"

/**
 * The backlog of the run `choice` describes, on `base`, read as the start question opens or when
 * the nothing check first asks, the getting-ready line `ready` saying so: the tickets left
 * unmerged, read once (bd failing to list them is something to run: the run lists them again, and
 * stops on it), and a conflict an earlier run left, fixed by hand since, which is something to run
 * too (takenBack.ts). With the start question `asks`, the count it says, and the unmerged tickets
 * read while it is asked.
 */
export const backlogOf = (
  config: Pick<AppConfigValue, "repo" | "settings">,
  base: string,
  choice: Choice,
  ready: GettingReady,
  asks: Asking,
) =>
  Effect.gen(function* () {
    yield* ready.step(readySteps.backlog)
    const unmergedNow = yield* Effect.cached(
      Effect.result(stillUnmerged({ repo: config.repo, base })),
    )
    const beads = yield* Beads
    const carried = new Set([
      ...(yield* carriedTickets),
      ...(yield* fixedLeft({ repo: config.repo, base })),
    ])
    const filter = { excludeTypes: config.settings.queue.exclude_types }
    const nothingOptions = (left: ReadonlySet<TicketId>): NothingOptions => {
      // A blocker closed by hand while its branch has commits the base lacks holds, as in the run.
      const branches = startBranches({ repo: config.repo, base })
      return {
        scope: choice.scope,
        filter,
        repo: config.repo,
        base,
        carried,
        unmerged: left,
        branches,
        held: heldAtStart(beads, left, branches),
      }
    }
    /** Nothing to run, to report once the renderer has gone; null when there is something. */
    const nothingYet = Effect.gen(function* () {
      yield* ready.step(readySteps.backlog)
      const unmerged = yield* unmergedNow
      const nothing = Result.isSuccess(unmerged)
        ? yield* Effect.result(checkNothing(nothingOptions(unmerged.success)))
        : Result.succeed(null)
      yield* ready.step(readySteps.starting)
      return Result.isSuccess(nothing) && nothing.success !== null
        ? ({ _tag: "Nothing", nothing: nothing.success } as const)
        : null
    })
    const count =
      asks === "no"
        ? TicketCount.Unknown()
        : yield* ticketCount(
            { scope: choice.scope, filter },
            Effect.map(unmergedNow, (unmerged) =>
              nothingOptions(Result.isSuccess(unmerged) ? unmerged.success : new Set()),
            ),
          )
    // The question opens: the tickets left unmerged are read while it is asked.
    if (asks !== "no") yield* Effect.forkChild(unmergedNow)
    yield* ready.step(readySteps.starting)
    return { nothingYet, count }
  })

/** The backlog as `backlogOf` read it. */
export type Backlog = Effect.Success<ReturnType<typeof backlogOf>>
