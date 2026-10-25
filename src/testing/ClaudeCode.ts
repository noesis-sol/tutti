// ClaudeCode's test layer (§ 3.3, § 13): scripted sessions, which the live AgentHost runs as it
// runs Claude Code's (src/testing/AgentHost.ts). Each session `open` gives plays a script, one list
// of steps, that `next` picks for its launch. A step emits an SDK message, calls the hooks of the
// session's options, asks its canUseTool or onElicitation, waits for a message sent to the session
// or for an interrupt, sleeps on the Clock (so TestClock moves it), answers getContextUsage, runs
// an Effect (to change an in-memory Beads or Git as the worker would), or ends the session's stream
// as gone. A session whose steps run out stays open, idle, until it is closed. Run under TestClock,
// a script plays the same way every time: its stream hands its reader a message once the one before
// has been taken in, and the step after an Emit plays once the reader has taken its message in.
// Sends are taken as the CLI takes them (§ 4.1): one to a turn (Wait), folded into the running turn
// (Fold), several of one kind sharing a turn (Coalesce), or none, for a turn the CLI starts by
// itself.
//
// The session speaks for the CLI where a script can't know the uuids: each send gets its
// command_lifecycle (`queued` when pushed, `started` when a Wait takes it, `completed` after the
// result of the turn that took it, `cancelled` when an interrupt cancels it), a result lists in
// `user_message_uuids` the sends taken since the last result unless the script lists them itself,
// and an `idle` is held back while a send waits untaken, as the CLI sends `idle` only after the
// last queued turn. Its initialize answers `{}`, and its mcpServerStatus() fails, unless the
// script's first step, Initialize, gives their answers. An interrupt cancels the sends still queued
// (§ 4.8): all of them in its answer when it is asked to cancel them (interrupt_cancel_queued_v1),
// else each that a cancel_async_message asks for, the AwaitInterrupt step waiting till each has
// been asked. What the session is sent is recorded, in order: its messages as the SDK gets them,
// cancel_async_message requests and their answers, and the answers to its permission requests and
// elicitations.
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  HookInput,
  McpServerStatus,
  PermissionResult,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  type Cause,
  Data,
  Deferred,
  type Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  type Scope,
  Stream,
} from "effect"
import type { Receipt, Session } from "../agent/AgentHost.ts"
import {
  ClaudeCode,
  type ClaudeSession,
  type Launch,
  type LaunchFailed,
  SessionFailed,
} from "../agent/ClaudeCode.ts"
import { stderrKept } from "../agent/sessionProcess.ts"
import type { TicketId } from "../services/Beads.ts"

/** A step of a scripted session. */
export type Step = Data.TaggedEnum<{
  /** The session sends `message`; its `session_id` is the session's. */
  Emit: { readonly message: SDKMessage }
  /** The session's hook callbacks for `input`'s event, and its tool's, are called with it. */
  Hook: { readonly input: HookInput }
  /** The session's canUseTool is called; the step waits for the answer. */
  CanUseTool: {
    readonly toolName: string
    readonly input: Record<string, unknown>
    /** The SDK's options beside the signal: suggestions, defaultToNo, decisionReason, … */
    readonly options: Partial<Omit<Parameters<CanUseTool>[2], "signal">>
  }
  /** The session's onElicitation is called; the step waits for the answer. */
  Elicit: { readonly request: ElicitationRequest }
  /** Waits for a message sent to the session (by start's caller, resume or send) and takes it. */
  Wait: Record<never, never>
  /**
   * Folds the messages waiting into the running turn, as the CLI does between tool rounds: waits
   * for one, then takes every other one waiting, of either kind.
   */
  Fold: Record<never, never>
  /**
   * Takes queued messages of one kind for a turn to share, as the CLI coalesces them: waits for
   * one, then takes those waiting behind it up to the first of the other kind (client_composed or
   * typed by you), which waits for a later turn.
   */
  Coalesce: Record<never, never>
  /** Waits for an interrupt not yet waited for, and the cancel_async_messages that follow it. */
  AwaitInterrupt: Record<never, never>
  Sleep: { readonly duration: Duration.Input }
  /**
   * The session answers getContextUsage() with `answer` from now on, as the live host asks it after
   * each finished turn, for the worker's context (§ 7.5); before, the request fails.
   */
  Context: { readonly answer: unknown }
  /** Runs `effect`: what the worker does outside the session, to an in-memory Beads or Git. */
  Do: { readonly effect: Effect.Effect<void> }
  /**
   * The session's stream ends without tutti closing it, Claude Code having written `why` to its
   * stderr.
   */
  Gone: { readonly why: string }
  /**
   * As the first step: the session doesn't start, its initialize failing with `reason`, and its
   * stream ends; first with a result that gives `startupFailureReason`, when there is one, as
   * Claude Code refusing to start sends it.
   */
  FailStart: { readonly reason: string; readonly startupFailureReason?: string }
  /**
   * As the first step: the session's initialize answer, `answer`, and its mcpServerStatus()
   * answer, `status`, when it gave one, which the host checks before it sends the session anything
   * (§ 4.1).
   */
  Initialize: { readonly answer: unknown; readonly status?: unknown }
}>

export const Step = Data.taggedEnum<Step>()

/** A session's steps. */
export type SessionScript = ReadonlyArray<Step>

/** What the scripted sessions and their host were sent, in order. */
export type Sent = Data.TaggedEnum<{
  Started: { readonly ticket: TicketId; readonly session: Session }
  Resumed: { readonly ticket: TicketId; readonly session: Session }
  /** A message, as the SDK gets it: `client_composed`, or `origin: { kind: "human" }`. */
  Message: { readonly ticket: TicketId; readonly message: SDKUserMessage }
  /**
   * A `cancel_async_message` request, sent after an interrupt for a message still queued, and its
   * answer: whether the message was dropped, or null when the CLI refused the request.
   */
  CancelAsync: {
    readonly ticket: TicketId
    readonly uuid: string
    readonly cancelled: boolean | null
  }
  /**
   * The interrupt's receipt, with the messages cancel_async_message cancelled under `cancelled`.
   */
  Interrupted: { readonly ticket: TicketId; readonly receipt: Receipt }
  /** A canUseTool call's answer. */
  Answered: {
    readonly ticket: TicketId
    readonly toolName: string
    readonly result: PermissionResult | null
  }
  /** An elicitation's answer. */
  Elicited: { readonly ticket: TicketId; readonly result: ElicitationResult | null }
  Closed: { readonly ticket: TicketId }
  Ended: { readonly ticket: TicketId }
}>

export const Sent = Data.taggedEnum<Sent>()

/** What a session plays: the ticket it is for, and its steps. */
export interface Played {
  readonly ticket: TicketId
  readonly steps: SessionScript
}

/** How the scripted sessions are played. */
export interface Scripted {
  /** What the session `launch` opens plays; LaunchFailed when there is nothing for it to play. */
  readonly next: (launch: Launch) => Effect.Effect<Played, LaunchFailed>
  /** Records what a session was sent. */
  readonly record: (sent: Sent) => Effect.Effect<void>
  /** The next of the numbers the IDs of tool calls and requests are made from. */
  readonly draw: Effect.Effect<number>
  /**
   * How the CLI answers `cancel_async_message`: by default it drops the message (`cancelled:
   * true`), which never runs; "refuse" fails the request, and "notQueued" answers `cancelled:
   * false`, as for a message its turn has already taken. A message not dropped stays queued and
   * runs.
   */
  readonly cancelAsync?: "refuse" | "notQueued"
  /** The process each ticket's Claude Code has while its session runs: none by default. */
  readonly processes?: ReadonlyMap<string, number>
  /**
   * How long a closed session's Claude Code takes to exit, on the Clock, which its close waits for:
   * none by default. One that ended by itself, or was killed or aborted, has exited already.
   */
  readonly closeTakes?: Duration.Input
}

// A message for the session's reader, with what is told once it has been taken in.
interface Out {
  readonly message: SDKMessage
  readonly taken: Deferred.Deferred<void> | undefined
}

// A message's type; undefined where reading it throws.
const typeOf = (message: SDKMessage): unknown => {
  try {
    return message.type
  } catch {
    return undefined
  }
}

// Whether a message is client_composed, or typed by you: queued messages coalesce by kind.
const composed = (message: SDKUserMessage) => message.client_composed === true

/** A scripted session, playing `played` in the scope it is opened in. */
const playing = (
  scripted: Scripted,
  launch: Launch,
  { ticket, steps }: Played,
): Effect.Effect<ClaudeSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const options = launch.options
    const sessionId = options.sessionId ?? options.resume ?? ""
    const first = steps[0]
    const out = yield* Queue.unbounded<Out, Cause.Done>()
    const inbox = yield* Queue.unbounded<SDKUserMessage>()
    const interrupts = yield* Queue.unbounded<void>()
    // The uuids of the messages sent and not yet taken by a Wait: an interrupt's still_queued.
    const queued = yield* Ref.make<ReadonlyArray<string>>([])
    // The uuids of the messages taken by a Wait since the last result: the next one's sends.
    const taken = yield* Ref.make<ReadonlyArray<string>>([])
    // The signal open requests are withdrawn by; an interrupt aborts it and draws another.
    const controller = yield* Ref.make(new AbortController())
    // A message taken from the inbox and left for a later turn: the next to be taken.
    const putBack: Array<SDKUserMessage> = []
    // The uuids of the messages an interrupt cancelled: a Wait passes over them.
    const cancelled = new Set<string>()
    // The still_queued of the last interrupt that didn't cancel them, not yet asked to cancel.
    const unasked = new Set<string>()
    const state = {
      /** Whether the inbox has ended: the session closing. */
      closed: false,
      /** Whether Claude Code has exited by itself, or was killed or aborted. */
      exited: false,
      stderr: "",
      context: undefined as unknown,
      /** The message the reader last took, told once it has taken it in. */
      reading: undefined as Deferred.Deferred<void> | undefined,
      /** Told once the last interrupt's still_queued have all been asked to cancel. */
      asked: undefined as Deferred.Deferred<void> | undefined,
    }

    // The message as the session sends it, with its session ID: its fields as they are, a getter
    // that throws too, for the reader to die taking it in.
    const stamped = (message: object) =>
      Object.defineProperties(
        {},
        {
          ...Object.getOwnPropertyDescriptors(message),
          session_id: { value: sessionId, enumerable: true, writable: true, configurable: true },
        },
      ) as SDKMessage

    /** Sends `message` and waits until the reader has taken it in. */
    const emit = (message: object) =>
      Effect.gen(function* () {
        const read = yield* Deferred.make<void>()
        yield* Queue.offer(out, { message: stamped(message), taken: read })
        yield* Deferred.await(read)
      })

    /** Sends `message` without waiting for the reader. */
    const tell = (message: object) =>
      Effect.asVoid(Queue.offer(out, { message: stamped(message), taken: undefined }))

    const lifecycle = (uuid: string, state: string) => ({
      type: "command_lifecycle",
      command_uuid: uuid,
      state,
    })

    /** Ends the stream: Claude Code has exited. */
    const exit = Effect.suspend(() => {
      state.exited = true
      return Effect.asVoid(Queue.end(out))
    })

    // A scripted message, with what the CLI would add to it (see the header).
    const emitScripted = (message: SDKMessage) =>
      Effect.gen(function* () {
        const type = typeOf(message)
        if (type === "result" && message.type === "result") {
          const sends = yield* Ref.getAndSet(taken, [])
          const listed = message.user_message_uuids ?? sends
          yield* emit({ ...message, user_message_uuids: listed })
          for (const uuid of listed) yield* emit(lifecycle(uuid, "completed"))
          return
        }
        const held =
          type === "system" &&
          message.type === "system" &&
          message.subtype === "session_state_changed" &&
          message.state === "idle" &&
          (yield* Ref.get(queued)).length > 0
        if (!held) yield* emit(message)
      })

    // Calls the session's hook callbacks for `input`: its event's, all of them or its tool's. Their
    // answers aren't waited for: what they record, they record in fibers of their own, and a
    // promise's end is no step TestClock's adjust waits for.
    const callHooks = (input: HookInput) =>
      Effect.gen(function* () {
        const { signal } = yield* Ref.get(controller)
        const toolName = "tool_name" in input ? input.tool_name : undefined
        const toolUseId = "tool_use_id" in input ? input.tool_use_id : undefined
        for (const matcher of options.hooks?.[input.hook_event_name] ?? []) {
          if (matcher.matcher !== undefined && matcher.matcher !== toolName) continue
          for (const callback of matcher.hooks) {
            yield* Effect.sync(() => void callback(input, toolUseId, { signal }).catch(() => {}))
          }
        }
      })

    // The next message not cancelled, waiting for one.
    const next = (): Effect.Effect<SDKUserMessage> =>
      Effect.flatMap(
        Effect.suspend(() => {
          const back = putBack.shift()
          return back === undefined ? Queue.take(inbox) : Effect.succeed(back)
        }),
        (message) => (cancelled.has(message.uuid ?? "") ? next() : Effect.succeed(message)),
      )

    // The next message not cancelled, if one is waiting.
    const waiting = (): Effect.Effect<SDKUserMessage | undefined> =>
      Effect.flatMap(
        Effect.suspend(() => {
          const back = putBack.shift()
          return back === undefined
            ? Effect.map(Queue.poll(inbox), Option.getOrUndefined)
            : Effect.succeed(back)
        }),
        (message) =>
          message !== undefined && cancelled.has(message.uuid ?? "")
            ? waiting()
            : Effect.succeed(message),
      )

    // The turn takes the message: it is no longer queued, and the next result lists it.
    const take = (message: SDKUserMessage) =>
      Effect.gen(function* () {
        const uuid = message.uuid ?? ""
        yield* Ref.update(queued, (uuids) => uuids.filter((u) => u !== uuid))
        yield* Ref.update(taken, (uuids) => [...uuids, uuid])
        yield* emit(lifecycle(uuid, "started"))
      })

    // The queued messages `uuids` are cancelled: none will run.
    const cancel = (uuids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* Ref.update(queued, (all) => all.filter((u) => !uuids.includes(u)))
        for (const uuid of uuids) {
          cancelled.add(uuid)
          yield* tell(lifecycle(uuid, "cancelled"))
        }
      })

    // The last interrupt's still_queued have one fewer to be asked to cancel: `uuid`.
    const askedFor = (uuid: string) =>
      Effect.suspend(() => {
        unasked.delete(uuid)
        return unasked.size === 0 && state.asked !== undefined
          ? Deferred.succeed(state.asked, undefined)
          : Effect.void
      })

    const callbackOf = <A>(callback: A | undefined, name: string): Effect.Effect<A> =>
      callback === undefined
        ? Effect.die(new Error(`the session's options have no ${name}`))
        : Effect.succeed(callback)

    const play = (step: Step): Effect.Effect<void> =>
      Step.$match(step, {
        Emit: ({ message }) => emitScripted(message),
        Hook: ({ input }) => callHooks(input),
        CanUseTool: ({ toolName, input, options: given }) =>
          Effect.gen(function* () {
            const callback = yield* callbackOf(options.canUseTool, "canUseTool")
            const { signal } = yield* Ref.get(controller)
            const n = yield* scripted.draw
            const result = yield* Effect.promise(() =>
              callback(toolName, input, {
                toolUseID: `toolu_${n}`,
                requestId: `req_${n}`,
                ...given,
                signal,
              }),
            )
            yield* scripted.record(Sent.Answered({ ticket, toolName, result }))
          }),
        Elicit: ({ request }) =>
          Effect.gen(function* () {
            const callback = yield* callbackOf(options.onElicitation, "onElicitation")
            const { signal } = yield* Ref.get(controller)
            const n = yield* scripted.draw
            const result = yield* Effect.promise(() =>
              callback(request, { signal, requestId: `req_${n}` }),
            )
            yield* scripted.record(Sent.Elicited({ ticket, result }))
          }),
        Wait: () => Effect.flatMap(next(), take),
        Fold: () =>
          Effect.gen(function* () {
            yield* take(yield* next())
            let message = yield* waiting()
            while (message !== undefined) {
              yield* take(message)
              message = yield* waiting()
            }
          }),
        Coalesce: () =>
          Effect.gen(function* () {
            const first = yield* next()
            yield* take(first)
            let message = yield* waiting()
            while (message !== undefined && composed(message) === composed(first)) {
              yield* take(message)
              message = yield* waiting()
            }
            if (message !== undefined) putBack.unshift(message)
          }),
        AwaitInterrupt: () =>
          Effect.andThen(
            Queue.take(interrupts),
            Effect.suspend(() =>
              state.asked === undefined ? Effect.void : Deferred.await(state.asked),
            ),
          ),
        Sleep: ({ duration }) => Effect.sleep(duration),
        Context: ({ answer }) =>
          Effect.sync(() => {
            state.context = answer
          }),
        Do: ({ effect }) => effect,
        Gone: ({ why }) =>
          Effect.suspend(() => {
            state.stderr = why
            return exit
          }),
        FailStart: ({ startupFailureReason }) =>
          Effect.andThen(
            startupFailureReason === undefined
              ? Effect.void
              : emit({
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  errors: [`startup failed: ${startupFailureReason}`],
                  num_turns: 0,
                  startup_failure_reason: startupFailureReason,
                }),
            exit,
          ),
        // Read by the start itself.
        Initialize: () => Effect.void,
      })

    // Closing the session ends its inbox, stops its script, and waits for its Claude Code to exit.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        state.closed = true
        ;(yield* Ref.get(controller)).abort()
        if (!state.exited && scripted.closeTakes !== undefined) {
          yield* Effect.sleep(scripted.closeTakes)
        }
      }),
    )
    // Only a session's first step can fail its start; one that has exited plays no more steps.
    const played = first?._tag === "FailStart" ? [first] : steps
    yield* Effect.forkScoped(
      Effect.interruptible(
        Effect.gen(function* () {
          for (const step of played) {
            if (state.exited) return
            yield* play(step)
          }
        }),
      ),
    )

    const failed = (reason: string) => new SessionFailed({ reason, stderr: state.stderr })
    const kill = Effect.andThen(
      Effect.flatMap(Ref.get(controller), (each) => Effect.sync(() => each.abort())),
      exit,
    )
    return {
      messages: Stream.fromEffectRepeat(
        Effect.gen(function* () {
          if (state.reading !== undefined) yield* Deferred.succeed(state.reading, undefined)
          const { message, taken: read } = yield* Queue.take(out)
          state.reading = read
          return message
        }),
      ),
      send: (message) =>
        Effect.gen(function* () {
          if (state.closed) return false
          const uuid = message.uuid ?? ""
          yield* scripted.record(Sent.Message({ ticket, message }))
          yield* Ref.update(queued, (uuids) => [...uuids, uuid])
          yield* tell(lifecycle(uuid, "queued"))
          yield* Queue.offer(inbox, message)
          return true
        }),
      initialization:
        first?._tag === "FailStart"
          ? Effect.fail(failed(first.reason))
          : Effect.succeed(
              (first?._tag === "Initialize" ? first.answer : {}) as SDKControlInitializeResponse,
            ),
      mcpStatus:
        first?._tag === "Initialize" && first.status !== undefined
          ? Effect.succeed(first.status as ReadonlyArray<McpServerStatus>)
          : Effect.fail(failed("the script gives no mcpServerStatus() answer")),
      settings: Effect.succeed(undefined),
      contextUsage: Effect.suspend(() =>
        state.context === undefined
          ? Effect.fail(failed("the script gives no getContextUsage() answer"))
          : Effect.succeed(state.context),
      ),
      interrupt: (cancelQueued) =>
        Effect.gen(function* () {
          const still = yield* Ref.get(queued)
          if (cancelQueued) yield* cancel(still)
          else {
            for (const uuid of still) unasked.add(uuid)
            state.asked = unasked.size === 0 ? undefined : yield* Deferred.make<void>()
          }
          const old = yield* Ref.getAndSet(controller, new AbortController())
          old.abort()
          yield* Queue.offer(interrupts, undefined)
          return (
            cancelQueued
              ? { still_queued: [], cancelled: [...still] }
              : { still_queued: [...still] }
          ) as SDKControlInterruptResponse
        }),
      cancelQueued: (uuid) =>
        Effect.gen(function* () {
          const answer =
            scripted.cancelAsync === "refuse" ? null : scripted.cancelAsync !== "notQueued"
          yield* scripted.record(Sent.CancelAsync({ ticket, uuid, cancelled: answer }))
          if (answer === true) yield* cancel([uuid])
          yield* askedFor(uuid)
          if (answer === null) return yield* failed("cancel_async_message refused")
          return answer
        }),
      abort: kill,
      kill,
      pid: () => (state.exited ? undefined : scripted.processes?.get(ticket)),
      stderrTail: (max = stderrKept) => state.stderr.slice(-max).trim(),
    } satisfies ClaudeSession
  })

/** ClaudeCode playing scripted sessions, as `scripted` picks and records them. */
export const layer = (scripted: Scripted): Layer.Layer<ClaudeCode> =>
  Layer.succeed(
    ClaudeCode,
    ClaudeCode.of({
      open: (launch) =>
        Effect.flatMap(scripted.next(launch), (played) => playing(scripted, launch, played)),
    }),
  )
