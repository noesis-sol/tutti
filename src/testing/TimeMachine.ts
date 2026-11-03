// The TimeMachine test layer: exclusions kept in memory, a path excluded when it or a folder above it
// was, and every tmutil call recorded, for a test to read through TimeMachineCalls. `absent` fails
// every call as a machine without tmutil does; `failing` fails each addexclusion as tmutil does
// when it can't change the setting.
import { Context, Effect, Layer, Ref } from "effect"
import { TimeMachine, TimeMachineFailed } from "../services/TimeMachine.ts"

/** The calls the test layer took and what it holds excluded, for a test to look at. */
export class TimeMachineCalls extends Context.Service<
  TimeMachineCalls,
  {
    /** Every call so far, as `isexcluded <path>` or `addexclusion <path>`, in order. */
    readonly calls: Effect.Effect<ReadonlyArray<string>>
    /** Removes the exclusion of `path`, as tmutil removeexclusion would. */
    unexclude(path: string): Effect.Effect<void>
  }
>()("tutti/testing/TimeMachine/TimeMachineCalls") {}

export interface Options {
  /** The paths excluded already. */
  readonly excluded?: ReadonlyArray<string>
  /** tmutil isn't there: every call fails. */
  readonly absent?: boolean
  /** addexclusion fails. */
  readonly failing?: boolean
}

/** A TimeMachine in memory, and TimeMachineCalls, to read what it was asked. */
export const layer = (options: Options = {}): Layer.Layer<TimeMachine | TimeMachineCalls> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const excluded = yield* Ref.make<ReadonlySet<string>>(new Set(options.excluded ?? []))
      const call = (name: string, path: string) =>
        Effect.andThen(
          Ref.update(calls, (all) => [...all, `${name} ${path}`]),
          options.absent === true
            ? Effect.fail(
                new TimeMachineFailed({ path, reason: "Executable not found in $PATH: tmutil" }),
              )
            : Effect.void,
        )
      const timeMachine = TimeMachine.of({
        isExcluded: (path) =>
          Effect.andThen(
            call("isexcluded", path),
            Effect.map(Ref.get(excluded), (all) =>
              [...all].some((each) => path === each || path.startsWith(`${each}/`)),
            ),
          ),
        exclude: (path) =>
          Effect.andThen(
            call("addexclusion", path),
            options.failing === true
              ? Effect.fail(
                  new TimeMachineFailed({
                    path,
                    reason: `${path}: Error (100002) while attempting to change exclusion setting.`,
                  }),
                )
              : Ref.update(excluded, (all) => new Set([...all, path])),
          ),
      })
      return Context.make(TimeMachine, timeMachine).pipe(
        Context.add(
          TimeMachineCalls,
          TimeMachineCalls.of({
            calls: Ref.get(calls),
            unexclude: (path) =>
              Ref.update(excluded, (all) => new Set([...all].filter((each) => each !== path))),
          }),
        ),
      )
    }),
  )
