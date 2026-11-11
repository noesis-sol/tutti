// The ID an evidence tag carries (§ 6.2, src/organs/evidence.ts), and a pasted_content tag's
// (src/agent/inView.ts): drawn afresh for each call from the system's secure random source, so
// text written before the call can't know it, and so can't close the tag early.
import { Effect } from "effect"

/** How many random bytes an evidence ID has; it is written as twice as many hex digits. */
export const idBytes = 8

/** A fresh evidence ID, from the system's secure random source: 16 hex digits. */
export const evidenceId: Effect.Effect<string> = Effect.sync(() =>
  Array.from(crypto.getRandomValues(new Uint8Array(idBytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join(""),
)
