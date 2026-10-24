// The FiberSets the run forks its fibers into (§ 3.4). Effect 4 has no Supervisor, so each fiber
// the run forks into a scope that lasts as long as the run (the scheduler's tickets, the merge
// queue and its train and hand-backs, triage, the predictor, the usage limit's watchers) belongs
// to a set made here, registered under a name. Once the run's scope has closed, a set still holding
// fibers was made in a scope that outlives the run: a leak, which whole-run scenarios fail on
// (§ 13). A fiber forked with Effect.forkScoped into a scope that closes with the work it serves
// needs no set, as that scope interrupts it as it closes, and RunFibers.left doesn't see it: a
// ticket's watchers while its worker settles (work.ts's watchLimit and timeLimit, settle.ts's
// undeferAtLimit), the view's projection (runView.ts), the screen's followers (screen.ts), the
// interview's (interview.ts), the keep-awake command (keepAwake.ts) and the SIGTSTP log (quit.ts).
import { Context, Effect, FiberSet, Layer, type Scope } from "effect"

/** A registered set that still holds fibers. */
export interface Left {
  readonly name: string
  readonly fibers: number
}

export class RunFibers extends Context.Service<
  RunFibers,
  {
    /** A new FiberSet in the caller's scope, registered under `name` until that scope closes. */
    make<A = unknown, E = unknown>(
      name: string,
    ): Effect.Effect<FiberSet.FiberSet<A, E>, never, Scope.Scope>
    /** Every registered set that still holds fibers, in the order they were made. */
    readonly left: Effect.Effect<ReadonlyArray<Left>>
    /** Interrupts the fibers of every registered set, for a test to clean up after a leak. */
    readonly interruptAll: Effect.Effect<void>
  }
>()("tutti/run/RunFibers") {}

/** The registry. The live run and the tests use the same one. */
export const layer: Layer.Layer<RunFibers> = Layer.sync(RunFibers, () => {
  const sets = new Map<FiberSet.FiberSet<unknown, unknown>, string>()
  return RunFibers.of({
    make: <A, E>(name: string) =>
      Effect.gen(function* () {
        // Added first, so it runs after the set's own finalizer has interrupted its fibers.
        yield* Effect.addFinalizer(() => Effect.sync(() => sets.delete(set)))
        const set: FiberSet.FiberSet<A, E> = yield* FiberSet.make<A, E>()
        sets.set(set, name)
        return set
      }),
    left: Effect.gen(function* () {
      const left: Array<Left> = []
      for (const [set, name] of sets) {
        const fibers = yield* FiberSet.size(set)
        if (fibers > 0) left.push({ name, fibers })
      }
      return left
    }),
    interruptAll: Effect.forEach(sets.keys(), FiberSet.clear, { discard: true }),
  })
})
