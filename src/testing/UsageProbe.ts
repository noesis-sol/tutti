// UsageProbe's test layer: scripted answers, in order, and Probed, to read back the limits each
// probe was asked about. Once the script runs out, the account is under the limit (Allowed), as
// the hold's lifts on the clock assumed before the probe.
import { Context, Effect, Layer, Ref } from "effect"
import { ProbeAnswer, UsageProbe } from "../agent/UsageProbe.ts"

/** The probes asked of the test layer, for a test to look at. */
export class Probed extends Context.Service<
  Probed,
  {
    /** The held limit each probe was asked about, in order. */
    readonly limits: Effect.Effect<ReadonlyArray<string | null>>
  }
>()("tutti/testing/UsageProbe/Probed") {}

/** A probe's answer in a script: the answer, or an Effect that gives it, as a probe that takes time. */
export type Scripted = ProbeAnswer | Effect.Effect<ProbeAnswer>

/** A UsageProbe that answers `answers` in order, then Allowed, and Probed, to read what it was asked. */
export const layer = (answers: ReadonlyArray<Scripted> = []): Layer.Layer<UsageProbe | Probed> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<string | null>>([])
      const left = yield* Ref.make<ReadonlyArray<Scripted>>(answers)
      const probe = (limit: string | null) =>
        Effect.gen(function* () {
          yield* Ref.update(asked, (all) => [...all, limit])
          const next = yield* Ref.modify(left, (all) => [all[0], all.slice(1)] as const)
          if (next === undefined) return ProbeAnswer.Allowed()
          return Effect.isEffect(next) ? yield* next : next
        })
      return Context.make(UsageProbe, UsageProbe.of({ probe })).pipe(
        Context.add(Probed, Probed.of({ limits: Ref.get(asked) })),
      )
    }),
  )
