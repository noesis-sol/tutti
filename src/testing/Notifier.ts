// The Notifier test layer (§ 3.3): notices captured in memory, sanitised as the live layer shows
// them, for a test to read through Captured. It captures whatever AppConfig's `notify` says: the
// live layer's tests cover turning notifications off.
import { Context, Effect, Layer, Ref } from "effect"
import { Notifier } from "../services/Notifier.ts"
import { sanitizeLine } from "../ui/sanitize.ts"

/** The notices the test layer captured, for a test to look at. */
export class Captured extends Context.Service<
  Captured,
  {
    /** Every notice so far, sanitised, in order. */
    readonly notices: Effect.Effect<ReadonlyArray<string>>
  }
>()("tutti/testing/Notifier/Captured") {}

/** A Notifier that captures its notices, and Captured, to read them. */
export const layer: Layer.Layer<Notifier | Captured> = Layer.effectContext(
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<string>>([])
    const notifier = Notifier.of({
      notify: (notice) => {
        const text = sanitizeLine(notice).trim()
        return text === "" ? Effect.void : Ref.update(notices, (all) => [...all, text])
      },
    })
    return Context.make(Notifier, notifier).pipe(
      Context.add(Captured, Captured.of({ notices: Ref.get(notices) })),
    )
  }),
)
