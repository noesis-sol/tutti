// How the Agent SDK's callbacks enter Effect (§ 4.1): canUseTool and onElicitation (Attention),
// the hook callbacks (hooks.ts) and the in-process MCP servers' tool handlers (requiresTools.ts,
// breakdownTools.ts, answerTalk.ts). Each runs its effect as a fiber of a FiberSet in its session's
// scope (AgentHostLive's make, a breakdown's or a talk's for its tools), not as a root fiber: closing
// the session interrupts what its callbacks still run, a request a person hasn't answered or a tool
// call under way, as the run's end closes the session.
//
// Both servers' handlers follow one rule (toolHandler): the call stops with its abort signal, and a
// failure or defect is the call's refusal, saying what went wrong, rather than a rejected promise.
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk"
import { Cause, Effect, FiberSet, Predicate, type Scope } from "effect"

/** The FiberSet a session's callbacks run in: in the session's scope, so closing it ends them. */
export type SessionFibers = FiberSet.FiberSet<unknown, unknown>

/** A new FiberSet for a session's callbacks, in the caller's scope: the session's. */
export const sessionFibers: Effect.Effect<SessionFibers, never, Scope.Scope> = FiberSet.make()

/** What a tool call answers. */
export type ToolAnswer = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>

/** A tool's answer, saying `text`. */
export const toolAnswer = (text: string): ToolAnswer => ({ content: [{ type: "text", text }] })

/** A tool's refusal, a tool error saying `text`. */
export const toolRefusal = (text: string): ToolAnswer => ({
  content: [{ type: "text", text }],
  isError: true,
})

/** The abort signal an MCP call's `extra` carries, if it carries one. */
export const signalOf = (extra: unknown): AbortSignal | undefined => {
  const signal = Predicate.hasProperty(extra, "signal") ? extra.signal : undefined
  return signal instanceof AbortSignal ? signal : undefined
}

/** What a tool call that failed or died answers. */
export const failedCall = (cause: Cause.Cause<unknown>): ToolAnswer =>
  toolRefusal(`tutti couldn't do it: ${Cause.pretty(cause)}`)

/**
 * The handler rule of tutti's MCP servers, run in `fibers` with the caller's services: a call's
 * effect, given the call's `extra`, as the promise the SDK awaits. It stops with the call's abort
 * signal; a failure or a defect is its refusal (failedCall).
 */
export const toolHandler = <R = never>(fibers: SessionFibers) =>
  Effect.map(
    FiberSet.runtimePromise(fibers)<R>(),
    (run) =>
      (effect: Effect.Effect<ToolAnswer, unknown, R>, extra: unknown): Promise<ToolAnswer> => {
        const signal = signalOf(extra)
        return run(
          effect.pipe(Effect.catchCause((cause) => Effect.succeed(failedCall(cause)))),
          signal === undefined ? undefined : { signal },
        )
      },
  )
