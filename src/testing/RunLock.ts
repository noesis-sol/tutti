// The RunLock's test layer (§ 3.3): the locks in memory, by git folder. A run takes both as the
// live layer does, refused with the same AlreadyRunning while another run in the layer holds
// either, and releases both when its scope closes. A rewrite names its new holder in tutti's.
import { Effect, Layer, Ref } from "effect"
import {
  AlreadyRunning,
  type HeldLock,
  type Program,
  RunLock,
  type SeenHolder,
} from "../services/RunLock.ts"

/** A lock held from the start, as if by another process: an orchestra running, say. */
export interface Held {
  readonly commonDir: string
  readonly program: Program
  readonly holder: SeenHolder
}

const key = (commonDir: string, program: Program) => `${program}\0${commonDir}`

/** The test layer, with `held` taken by other processes for as long as the layer lasts. */
export const layer = (held: ReadonlyArray<Held> = []) =>
  Layer.effect(
    RunLock,
    Effect.gen(function* () {
      const locks = yield* Ref.make(
        new Map(held.map((lock) => [key(lock.commonDir, lock.program), lock.holder])),
      )
      return RunLock.of({
        acquire: (request) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const taken = yield* Ref.modify(locks, (current) => {
                for (const program of ["tutti", "orchestra"] as const) {
                  const holder = current.get(key(request.commonDir, program))
                  if (holder !== undefined) return [{ program, holder }, current] as const
                }
                const next = new Map(current)
                next.set(key(request.commonDir, "tutti"), request.holder)
                next.set(key(request.commonDir, "orchestra"), {
                  ...request.holder,
                  version: `tutti ${request.holder.version}`,
                })
                return [undefined, next] as const
              })
              if (taken !== undefined) {
                return yield* new AlreadyRunning({ ...taken, repo: request.repo })
              }
              yield* Effect.addFinalizer(() =>
                Ref.update(locks, (current) => {
                  const next = new Map(current)
                  next.delete(key(request.commonDir, "tutti"))
                  next.delete(key(request.commonDir, "orchestra"))
                  return next
                }),
              )
              return {
                rewrite: (holder) =>
                  Ref.update(locks, (current) =>
                    new Map(current).set(key(request.commonDir, "tutti"), holder),
                  ),
              } satisfies HeldLock
            }),
          ),
      })
    }),
  )
