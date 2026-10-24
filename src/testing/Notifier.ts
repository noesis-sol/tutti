// The Notifier test layer (§ 3.3): notices captured in memory, as the live layer would show them
// (noticeOf: sanitised, and none when AppConfig's `notify` is off), for a test to read through
// Captured.
import { Context, Effect, Layer, Ref } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { Notifier, noticeOf } from "../services/Notifier.ts"

/** The notices the test layer captured, for a test to look at. */
export class Captured extends Context.Service<
  Captured,
  {
    /** Every notice so far, sanitised, in order. */
    readonly notices: Effect.Effect<ReadonlyArray<string>>
  }
>()("tutti/testing/Notifier/Captured") {}

/** A Notifier that captures its notices, and Captured, to read them. */
export const layer: Layer.Layer<Notifier | Captured, never, AppConfig> = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const notices = yield* Ref.make<ReadonlyArray<string>>([])
    const notifier = Notifier.of({
      notify: (notice) => {
        const text = noticeOf(config, notice)
        return text === undefined ? Effect.void : Ref.update(notices, (all) => [...all, text])
      },
    })
    return Context.make(Notifier, notifier).pipe(
      Context.add(Captured, Captured.of({ notices: Ref.get(notices) })),
    )
  }),
)
