// A session's FiberSet for the tests that call its callbacks themselves (src/agent/callbacks.ts):
// in a scope of its own that never closes, so a callback can run after the effect that made it.
import { Effect, Scope } from "effect"
import { type SessionFibers, sessionFibers } from "../src/agent/callbacks.ts"

/** A new FiberSet for a session's callbacks, in a scope that stays open. */
export const openFibers = (): SessionFibers =>
  Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(sessionFibers, scope)))
