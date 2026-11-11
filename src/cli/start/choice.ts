// What a bare `tutti`'s run (src/main.ts's runFrom) works on, settled as it starts: --ticket's
// scope, or the epic a --feature interview files, or a spec's root epic; a spec chosen at the
// start question, and the lock's holder named after it. Each start step reads it as it is then.
import type { AppConfigValue } from "../../core/AppConfig.ts"
import type { Spec } from "../../run/spec.ts"
import type { Started } from "../../run/startup.ts"
import type { TicketId } from "../../services/Beads.ts"
import type { Holder } from "../../services/RunLock.ts"

/** What the run works on, as the start settles it: each field is set as a step learns it. */
export interface Choice {
  /** The run's scope: --ticket's, the epic --feature filed, or a spec's root epic. */
  scope: TicketId | null
  /** The request a feature run was talked through from: --feature's, or New feature's. */
  feature: string | null
  /** The spec: --spec's, or the one chosen at the start question. */
  spec: Spec | null
  /** The configuration, its refinement as the spec chosen at the start question asks. */
  config: AppConfigValue
  /** The run as the startup checks and the pre-flight left it, with the spec chosen. */
  started: Started
  /** The run lock's holder, rewritten as the run learns its feature or spec. */
  holder: Holder
}
