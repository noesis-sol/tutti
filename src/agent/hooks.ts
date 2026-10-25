// A worker's in-process hook callbacks (§ 4.2): PreToolUse, PostToolUse, PostToolUseFailure,
// PermissionDenied, SubagentStart, SubagentStop and PreCompact. They tell tutti what the worker is doing and when it compacts. They
// run while the tool call waits, so each returns at once with no decision ({}), records in a fiber
// of the session's FiberSet (callbacks.ts), and never fails: an error inside one, thrown or failed, is logged and swallowed, as
// orchestra's hooks always exit 0.
//
// One more PreToolUse callback, matcher Agent, keeps the verifier in the foreground (§ 4.1): agents
// the main thread launches run in the background by default, and neither an agent definition's
// `background: false` nor CLAUDE_CODE_FORK_SUBAGENT=0 changes that. For a call whose
// `subagent_type` is the verifier it returns `updatedInput`, the call's input with
// `run_in_background: false`, and {} for any other. It sets no permissionDecision, so canUseTool
// and auto mode decide the call as before. It too returns at once and never fails.
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  PreCompactHookInput,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Effect, FiberSet, Predicate } from "effect"
import type { TicketId } from "../services/Beads.ts"
import type { SessionFibers } from "./callbacks.ts"

/** The hook events a worker's activity comes from. */
export const activityEvents = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
] as const satisfies ReadonlyArray<HookEvent>

/** The verifier's subagent type: the name the worker prompt gives it (§ 4.11). */
export const verifierAgent = "verifier"

/**
 * What the verifier's PreToolUse callback returns for `input`: for an Agent call to the verifier,
 * its input with `run_in_background: false`; for anything else, or input it can't read, {}.
 */
export const foregroundVerifier = (input: HookInput): HookJSONOutput => {
  try {
    if (input.hook_event_name !== "PreToolUse") return {}
    const toolInput = input.tool_input
    if (!Predicate.isObject(toolInput) || toolInput.subagent_type !== verifierAgent) return {}
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...toolInput, run_in_background: false },
      },
    }
  } catch {
    // Nothing a hook does may fail its tool call.
    return {}
  }
}

/** The verifier's PreToolUse callback, on Agent calls only. */
export const verifierMatcher: HookCallbackMatcher = {
  matcher: "Agent",
  hooks: [async (input) => foregroundVerifier(input)],
}

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
export const hookFailed = (ticket: TicketId, event: string, cause: string): string =>
  `${ticket}'s ${event} hook failed to record: ${cause}`

/**
 * The hook callbacks of `ticket`'s worker, recording to `recorder` in the current context as fibers
 * of the session's `fibers`, with the verifier's PreToolUse callback after its activity one. `warn`
 * is told of a failure to record; Effect's logger is by default.
 */
export const activityHooks = (
  ticket: TicketId,
  recorder: Recorder,
  fibers: SessionFibers,
  warn: (message: string) => Effect.Effect<void> = (message) => Effect.logWarning(message),
): Effect.Effect<Hooks> =>
  Effect.map(FiberSet.runtime(fibers)(), (run) => {
    const record = (input: HookInput, recording: () => Effect.Effect<void, unknown>) =>
      Effect.suspend(recording).pipe(
        Effect.catchCause((cause) =>
          warn(hookFailed(ticket, input.hook_event_name, Cause.pretty(cause))),
        ),
        Effect.catchCause(() => Effect.void),
      )
    const callback: HookCallback = async (input) => {
      try {
        run(record(input, () => recorder.activity(input)))
        // A compaction is recorded even when its activity can't be.
        if (input.hook_event_name === "PreCompact") {
          run(record(input, () => recorder.compaction(input)))
        }
      } catch {
        // Nothing a hook does may fail its tool call.
      }
      return {}
    }
    const hooks: Hooks = Object.fromEntries(
      activityEvents.map((event) => [event, [{ hooks: [callback] }]]),
    )
    hooks.PreToolUse?.push(verifierMatcher)
    return hooks
  })
