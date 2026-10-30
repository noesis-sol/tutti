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
//
// The verifier's Agent call shows a verifier round too (verifierEvent): its PreToolUse the round's
// start, with the commits its prompt names, and its PostToolUse or PostToolUseFailure its end. The
// host keeps each worker's rounds as it folds the activity (AgentHost.ts), so that a ticket deferred
// after three rounds with its last fix unverified gets one more (src/run/lastRound.ts).
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  PreCompactHookInput,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Data, Effect, FiberSet, Predicate } from "effect"
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

/**
 * A verifier round as the worker's hooks show it (§ 4.11): its Agent call `call` began, its prompt
 * naming `commits`, the hashes in it, one of them the commit the worker gave it; or the call ended,
 * done or failed.
 */
export type VerifierEvent = Data.TaggedEnum<{
  Began: { readonly call: string; readonly commits: ReadonlyArray<string> }
  Ended: { readonly call: string }
}>

export const VerifierEvent = Data.taggedEnum<VerifierEvent>()

/** The words in `text` that may be commit hashes, abbreviated or whole, each once, in order. */
export const hashesIn = (text: string): ReadonlyArray<string> => [
  ...new Set(text.match(/(?<![0-9A-Za-z])[0-9a-f]{7,64}(?![0-9A-Za-z])/g) ?? []),
]

/**
 * The verifier round `input` shows: a PreToolUse of an Agent call to the verifier begins one, its
 * PostToolUse or PostToolUseFailure ends it; undefined for anything else, or input it can't read.
 */
export const verifierEvent = (input: HookInput): VerifierEvent | undefined => {
  try {
    if (
      input.hook_event_name !== "PreToolUse" &&
      input.hook_event_name !== "PostToolUse" &&
      input.hook_event_name !== "PostToolUseFailure"
    ) {
      return undefined
    }
    const toolInput = input.tool_input
    if (input.tool_name !== "Agent" || !Predicate.isObject(toolInput)) return undefined
    if (toolInput.subagent_type !== verifierAgent) return undefined
    const call = input.tool_use_id
    if (input.hook_event_name !== "PreToolUse") return VerifierEvent.Ended({ call })
    const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : ""
    return VerifierEvent.Began({ call, commits: hashesIn(prompt) })
  } catch {
    return undefined
  }
}

/** A verifier round: its Agent call, the hashes its prompt names, and whether it has ended. */
export interface VerifierRound {
  readonly call: string
  readonly commits: ReadonlyArray<string>
  readonly ended: boolean
}

/**
 * A worker's verifier rounds in this run, across its sessions, oldest first; `lastRound` once tutti
 * has given it one more (src/run/lastRound.ts).
 */
export interface VerifierRounds {
  readonly rounds: ReadonlyArray<VerifierRound>
  readonly lastRound: boolean
}

export const noRounds: VerifierRounds = { rounds: [], lastRound: false }

/** `rounds` with `event` in it: a round begun added, one ended marked so. */
export const roundStep = (rounds: VerifierRounds, event: VerifierEvent): VerifierRounds => {
  if (event._tag === "Began") {
    if (rounds.rounds.some((round) => round.call === event.call)) return rounds
    const round = { call: event.call, commits: event.commits, ended: false }
    return { ...rounds, rounds: [...rounds.rounds, round] }
  }
  return {
    ...rounds,
    rounds: rounds.rounds.map((round) =>
      round.call === event.call ? { ...round, ended: true } : round,
    ),
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
