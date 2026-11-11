// The run's parts, assembled (run.ts, § 5): its services (services.ts), what holds it (holds.ts),
// its merge side (mergeSide.ts) and what starts its tickets (starting.ts), each made over those
// before it, in the run's scope, in that order: the scope releases them in the reverse.
import type { Effect, FileSystem, Scope } from "effect"
import { Effect as E } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Ledger } from "../ledger.ts"
import { type Holds, make as makeHolds } from "./holds.ts"
import { type MergeSide, make as makeMergeSide } from "./mergeSide.ts"
import { make as makeServices, type Services } from "./services.ts"
import type { RunEnv, RunOptions } from "./shared.ts"
import { make as makeStarting, type Starting } from "./starting.ts"

/** The run's parts, each made over those before it. */
export interface RunParts {
  readonly options: RunOptions
  /** When the run began, in ms since the epoch. */
  readonly begun: number
  readonly services: Services
  readonly holds: Holds
  readonly merge: MergeSide
  readonly starting: Starting
}

/** The run's parts, assembled in the run's scope: begun at `begun`, as `options` say. */
export const assemble = (
  options: RunOptions,
  begun: number,
): Effect.Effect<
  RunParts,
  never,
  RunEnv | Ledger | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  E.gen(function* () {
    const services = yield* makeServices(options, begun)
    const holds = yield* makeHolds(services)
    const merge = yield* makeMergeSide(services, holds)
    const starting = yield* makeStarting(options, services, holds, merge)
    return { options, begun, services, holds, merge, starting }
  })
