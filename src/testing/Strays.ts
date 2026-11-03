// The Strays test layer: no process is listed or signalled. Each folder it is asked to stop is
// pushed onto `calls`, and `left` says what was left running there, by folder: what stop gives
// back, once, as the live one stops them, and only while the folder is there, as the live one
// finds none in a folder that has gone; those a stop spares are left running, and `running` gives
// what is left there. Asking what is running isn't a call.
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
      stop: (folder, spare = []) =>
        Effect.sync(() => {
          calls.push(folder)
          const there = existsSync(folder) ? (running.get(folder) ?? []) : []
          const stopped = there.filter((stray) => !spare.includes(stray.pid))
          const kept = there.filter((stray) => spare.includes(stray.pid))
          if (kept.length === 0) running.delete(folder)
          else running.set(folder, kept)
          return stopped
        }),
      running: (folder) =>
        Effect.sync(() => (existsSync(folder) ? (running.get(folder) ?? []) : [])),
    })
  })
