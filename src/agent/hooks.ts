// A worker's in-process hook callbacks (§ 4.2): PreToolUse, PostToolUse, SubagentStart,
// SubagentStop and PreCompact. They tell tutti what the worker is doing and when it compacts. They
// run while the tool call waits, so each returns at once with no decision ({}), records in a fiber
// of its own, and never fails: an error inside one, thrown or failed, is logged and swallowed, as
// orchestra's hooks always exit 0.
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  PreCompactHookInput,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Effect } from "effect"

/** The hook events a worker's activity comes from. */
export const activityEvents = [
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
] as const satisfies ReadonlyArray<HookEvent>

/** The SDK's hooks option. */
export type Hooks = Partial<Record<HookEvent, Array<HookCallbackMatcher>>>

/** What a worker's hook callbacks record. Either may fail; the failure is only logged. */
export interface Recorder {
  /** Every callback's input, for the worker's state (§ 4.2). */
  readonly activity: (input: HookInput) => Effect.Effect<void, unknown>
  /** A PreCompact callback's input: a compaction, for triage and the reviewer. */
  readonly compaction: (input: PreCompactHookInput) => Effect.Effect<void, unknown>
}

/** The warning when recording a hook callback of `ticket`'s worker fails. */
export const hookFailed = (ticket: string, event: string, cause: string): string =>
  `${ticket}'s ${event} hook failed to record: ${cause}`

/**
 * The hook callbacks of `ticket`'s worker, recording to `recorder` in the current context. `warn`
 * is told of a failure to record; Effect's logger is by default.
 */
export const activityHooks = (
  ticket: string,
  recorder: Recorder,
  warn: (message: string) => Effect.Effect<void> = (message) => Effect.logWarning(message),
): Effect.Effect<Hooks> =>
  Effect.map(Effect.context<never>(), (context) => {
    const run = Effect.runForkWith(context)
    const record = (input: HookInput): Effect.Effect<void> =>
      Effect.suspend(() =>
        input.hook_event_name === "PreCompact"
          ? Effect.andThen(recorder.activity(input), recorder.compaction(input))
          : recorder.activity(input),
      ).pipe(
        Effect.catchCause((cause) =>
          warn(hookFailed(ticket, input.hook_event_name, Cause.pretty(cause))),
        ),
        Effect.catchCause(() => Effect.void),
      )
    const callback: HookCallback = async (input) => {
      try {
        run(record(input))
      } catch {
        // Nothing a hook does may fail its tool call.
      }
      return {}
    }
    return Object.fromEntries(
      activityEvents.map((event) => [event, [{ hooks: [callback] }]]),
    ) satisfies Hooks
  })
