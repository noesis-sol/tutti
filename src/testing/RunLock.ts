// The RunLock's test layer (§ 3.3): the lock files in memory, by git folder. A run takes both as
// the live layer does, writing each the text live writes (tuttiLockText, orchestraLockText), and
// is refused with the same AlreadyRunning, its holder read back with parseHolder, while another
// run in the layer holds either; it releases both when its scope closes. A rewrite writes its new
// holder to tutti's. A probe sees the locks held in the layer, as acquire would.
import { Effect, Layer, Ref } from "effect"
import {
  AlreadyRunning,
  type HeldLock,
  orchestraLockText,
  type Program,
  parseHolder,
  RunLock,
  type SeenHolder,
  tuttiLockText,
} from "../services/RunLock.ts"

/** A lock held from the start, as if by another process: an orchestra running, say. */
export interface Held {
  readonly commonDir: string
  readonly program: Program
  readonly holder: SeenHolder
}

const key = (commonDir: string, program: Program) => `${program}\0${commonDir}`

/** The refusal for the first of the locks at `commonDir` held in `texts`, or undefined. */
const takenIn = (texts: ReadonlyMap<string, string>, commonDir: string, repo: string) => {
  for (const program of ["tutti", "orchestra"] as const) {
    const text = texts.get(key(commonDir, program))
    if (text !== undefined) return new AlreadyRunning({ program, holder: parseHolder(text), repo })
  }
  return undefined
}

/** The test layer, with `held` taken by other processes for as long as the layer lasts. */
export const layer = (held: ReadonlyArray<Held> = []) =>
  Layer.effect(
    RunLock,
    Effect.gen(function* () {
      const texts = yield* Ref.make(
        new Map(
          held.map((lock) => [key(lock.commonDir, lock.program), JSON.stringify(lock.holder)]),
        ),
      )
      return RunLock.of({
        acquire: (request) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const taken = yield* Ref.modify(texts, (current) => {
                const refused = takenIn(current, request.commonDir, request.repo)
                if (refused !== undefined) return [refused, current] as const
                const next = new Map(current)
                next.set(key(request.commonDir, "tutti"), tuttiLockText(request.holder))
                next.set(key(request.commonDir, "orchestra"), orchestraLockText(request.holder))
                return [undefined, next] as const
              })
              if (taken !== undefined) return yield* taken
              yield* Effect.addFinalizer(() =>
                Ref.update(texts, (current) => {
                  const next = new Map(current)
                  next.delete(key(request.commonDir, "tutti"))
                  next.delete(key(request.commonDir, "orchestra"))
                  return next
                }),
              )
              return {
                rewrite: (holder) =>
                  Ref.update(texts, (current) =>
                    new Map(current).set(key(request.commonDir, "tutti"), tuttiLockText(holder)),
                  ),
              } satisfies HeldLock
            }),
          ),
        probe: (request) =>
          Effect.map(Ref.get(texts), (current) =>
            takenIn(current, request.commonDir, request.repo),
          ),
      })
    }),
  )
