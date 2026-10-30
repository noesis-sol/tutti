// The Strays test layer: no process is listed or signalled. Each folder it is asked to stop is
// pushed onto `calls`, and `left` says what it was left running there, by folder: what stop gives
// back, once, as the live one stops them.
import { Effect, Layer } from "effect"
import { type Stray, Strays } from "../services/Strays.ts"

/** The test layer; each folder asked for is pushed onto `calls` when one is given. */
export const layer = (
  left: Readonly<Record<string, ReadonlyArray<Stray>>> = {},
  calls: Array<string> = [],
) =>
  Layer.sync(Strays, () => {
    const running = new Map(Object.entries(left))
    return Strays.of({
      stop: (folder) =>
        Effect.sync(() => {
          calls.push(folder)
          const stopped = running.get(folder) ?? []
          running.delete(folder)
          return stopped
        }),
    })
  })
