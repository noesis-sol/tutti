// The Strays test layer: no process is listed or signalled. Each folder it is asked to stop is
// pushed onto `calls`, and `left` says what was left running there, by folder: what stop gives
// back, once, as the live one stops them, and only while the folder is there, as the live one
// finds none in a folder that has gone.
import { existsSync } from "node:fs"
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
          const stopped = existsSync(folder) ? (running.get(folder) ?? []) : []
          running.delete(folder)
          return stopped
        }),
    })
  })
