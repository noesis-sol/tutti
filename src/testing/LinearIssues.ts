// The LinearIssues test layer: Linear's API over the Beads test layer's Linear team
// (src/testing/Beads.ts), as the team is when it is asked. With a time it lists every issue the
// team has, as a pull may list more than changed and must choose among them; with none, those
// neither completed nor canceled. Each listing is kept for tests, and Listings scripts a failure.
import { Context, Effect, Layer, Ref } from "effect"
import { LinearApiFailed, linearTimedOutWhy } from "../services/LinearApi.ts"
import { LinearIssues, type ListedIssue } from "../services/LinearIssues.ts"
import { type LinearKey, linearKey } from "../services/linearSync.ts"
import { Backlog } from "./Beads.ts"

/** A listing the run asked for: the team's key, and since when (null for those not done). */
export interface Listing {
  readonly team: string
  readonly since: number | null
}

/** How the next listings fail: with a reason Linear's API gave, or past their time limit. */
export interface ListFault {
  readonly reason?: string
  readonly timedOut?: boolean
  /** How many listings it fails; 1 by default. */
  readonly times?: number
}

/** The listings asked for, and the failures to give them, for a test. */
export class Listings extends Context.Service<
  Listings,
  {
    /** The listings asked for, in order. */
    readonly asked: Effect.Effect<ReadonlyArray<Listing>>
    /** Has the next listings fail as `fault` says. */
    readonly fail: (fault: ListFault) => Effect.Effect<void>
  }
>()("tutti/testing/LinearIssues/Listings") {}

/** A LinearIssues source over the Backlog's Linear team, and Listings. */
export const layer: Layer.Layer<Listings, never, Backlog> = Layer.effectContext(
  Effect.gen(function* () {
    const backlog = yield* Backlog
    const asked = yield* Ref.make<ReadonlyArray<Listing>>([])
    const faults = yield* Ref.make<ReadonlyArray<ListFault>>([])
    const list = (team: string, since: number | null) =>
      Effect.gen(function* () {
        yield* Ref.update(asked, (all) => [...all, { team, since }])
        const [fault, ...rest] = yield* Ref.get(faults)
        if (fault !== undefined) {
          const left = (fault.times ?? 1) - 1
          yield* Ref.set(faults, left > 0 ? [{ ...fault, times: left }, ...rest] : rest)
          return yield* new LinearApiFailed({
            why: fault.timedOut
              ? linearTimedOutWhy
              : `Linear said: ${fault.reason ?? "Internal server error"}`,
          })
        }
        const issues = yield* backlog.linearIssues
        return issues.flatMap((issue): ReadonlyArray<ListedIssue> => {
          const key: LinearKey | undefined = linearKey(issue.key)
          const done = issue.state === "completed" || issue.state === "canceled"
          return key === undefined || !issue.key.startsWith(`${team}-`) || (since === null && done)
            ? []
            : [{ key, state: issue.state }]
        })
      })
    return Context.make(LinearIssues, { list }).pipe(
      Context.add(
        Listings,
        Listings.of({
          asked: Ref.get(asked),
          fail: (fault) => Ref.update(faults, (all) => [...all, fault]),
        }),
      ),
    )
  }),
)
