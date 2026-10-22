// AgentHost's test layer (§ 3.3, § 13): scripted sessions. Each ticket has a script, one list of
// steps per session: each start or resume plays the next. A step emits an SDK message, calls a
// hook, asks through Attention as canUseTool or onElicitation does, waits for a message sent to the
// session or for an interrupt, sleeps on the Clock (so TestClock moves it), runs an Effect (to
// change an in-memory Beads or Git as the worker would), or ends the session as gone. A session whose
// steps run out stays open, idle, until it is closed. Run under TestClock, a script plays the same
// way every time. Sends are taken as the CLI takes them (§ 4.1): one to a turn (Wait), folded into
// the running turn (Fold), several of one kind sharing a turn (Coalesce), or none, for a turn the
// CLI starts by itself.
//
// Every message is recorded in Transcripts and folded into the worker's state as the live layer
// does it (makeWorkers), and each send is recorded there as it is pushed. The layer speaks for the
// CLI where a script can't know the uuids: each send gets its command_lifecycle (`queued` when
// pushed, `started` when a Wait takes it, `completed` after the result of the turn that took it), a
// result lists in `user_message_uuids` the sends taken since the last result unless the script
// lists them itself, and an `idle` is held back while a send waits untaken, as the CLI sends `idle`
// only after the last queued turn. An interrupt cancels the sends still queued (§ 4.8): in its
// receipt, as `interrupt({ cancelQueued: true })` does, or one by one with `cancel_async_message`,
// as on a CLI without `interrupt_cancel_queued_v1`. Everything the layer is sent is recorded, in
// order: starts, resumes, messages as the SDK would get them (client_composed or origin human),
// interrupts and their receipts, cancel_async_message requests and their answers, the answers to
// permission requests and elicitations, closes and ends. Recording reads them back.
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  HookInput,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  Context,
  Data,
  type Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Semaphore,
} from "effect"
import {
  AgentGone,
  AgentHost,
  AgentStartFailed,
  type Message,
  makeWorkers,
  noFindings,
  type Receipt,
  type Session,
  type SetupFindings,
  userMessage,
  type WorkerEntry,
} from "../agent/AgentHost.ts"
import { Attention } from "../agent/Attention.ts"
import type { Transcripts } from "../agent/Transcripts.ts"
import { WorkerEvent } from "../agent/WorkerState.ts"

/** A step of a scripted session. */
export type Step = Data.TaggedEnum<{
  /** The session sends `message`; its `session_id` is the session's. */
  Emit: { readonly message: SDKMessage }
  /** An in-process hook callback is called with `input`. */
  Hook: { readonly input: HookInput }
  /** The session's canUseTool is called, through Attention; the step waits for the answer. */
  CanUseTool: {
    readonly toolName: string
    readonly input: Record<string, unknown>
    /** The SDK's options beside the signal: suggestions, defaultToNo, decisionReason, … */
    readonly options: Partial<Omit<Parameters<CanUseTool>[2], "signal">>
  }
  /** The session's onElicitation is called, through Attention; the step waits for the answer. */
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
  /** Waits for an interrupt not yet waited for. */
  AwaitInterrupt: Record<never, never>
  Sleep: { readonly duration: Duration.Input }
  /** Runs `effect`: what the worker does outside the session, to an in-memory Beads or Git. */
  Do: { readonly effect: Effect.Effect<void> }
  /** The session's stream ends without tutti closing it. */
  Gone: { readonly why: string }
  /** As the first step: the session doesn't start, and start or resume fails. */
  FailStart: { readonly reason: string; readonly startupFailureReason?: string }
}>

export const Step = Data.taggedEnum<Step>()

/** A session's steps. */
export type SessionScript = ReadonlyArray<Step>

/** A ticket's sessions, in the order they are started or resumed. */
export type Script = ReadonlyArray<SessionScript>

/** What the layer was sent, in order. */
export type Sent = Data.TaggedEnum<{
  Started: { readonly ticket: string; readonly session: Session }
  Resumed: { readonly ticket: string; readonly session: Session }
  /** A message, as the SDK would get it: `client_composed`, or `origin: { kind: "human" }`. */
  Message: { readonly ticket: string; readonly message: SDKUserMessage }
  /**
   * A `cancel_async_message` request, sent after an interrupt for a message still queued, and its
   * answer: whether the message was dropped, or null when the CLI refused the request.
   */
  CancelAsync: {
    readonly ticket: string
    readonly uuid: string
    readonly cancelled: boolean | null
  }
  /** The interrupt's receipt, with the messages cancel_async_message cancelled under `cancelled`. */
  Interrupted: { readonly ticket: string; readonly receipt: Receipt }
  /** A canUseTool call's answer. */
  Answered: {
    readonly ticket: string
    readonly toolName: string
    readonly result: PermissionResult | null
  }
  /** An elicitation's answer. */
  Elicited: { readonly ticket: string; readonly result: ElicitationResult | null }
  Closed: { readonly ticket: string }
  Ended: { readonly ticket: string }
}>

export const Sent = Data.taggedEnum<Sent>()

/** What the layer was sent, for a test to look at. */
export class Recording extends Context.Service<
  Recording,
  {
    /** Everything, in order. */
    readonly all: Effect.Effect<ReadonlyArray<Sent>>
    /** What the ticket's worker was sent, in order. */
    sentTo(ticket: string): Effect.Effect<ReadonlyArray<Sent>>
    /** The messages the ticket's worker was sent, in order. */
    messages(ticket: string): Effect.Effect<ReadonlyArray<SDKUserMessage>>
    /** The names of each requires list the run took from a merge (takeRequires), in order. */
    readonly requires: Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
  }
>()("tutti/testing/AgentHost/Recording") {}

// A session being played.
interface Running {
  readonly sessionId: string
  readonly entry: WorkerEntry
  readonly inbox: Queue.Queue<SDKUserMessage>
  /** A message taken from the inbox and left for a later turn: the next to be taken. */
  readonly putBack: Array<SDKUserMessage>
  /** The uuids of the messages sent and not yet taken by a Wait: an interrupt's still_queued. */
  readonly queued: Ref.Ref<ReadonlyArray<string>>
  /** The uuids of the messages taken by a Wait since the last result: the next one's sends. */
  readonly taken: Ref.Ref<ReadonlyArray<string>>
  /** The uuids of the messages an interrupt cancelled: a Wait passes over them. */
  readonly cancelled: Set<string>
  readonly interrupts: Queue.Queue<void>
  /** The signal open requests are withdrawn by; an interrupt aborts it and draws another. */
  readonly controller: Ref.Ref<AbortController>
  fiber?: Fiber.Fiber<void>
}

// Whether a message is client_composed, or typed by you: queued messages coalesce by kind.
const composed = (message: SDKUserMessage) => message.client_composed === true

// A message's uuid, as the SDK's UUID type has them: the nth is ...-000000000001 and so on.
const uuidOf = (n: number): SDKUserMessage["uuid"] & string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/** What `layer` takes beside the scripts. */
export interface Options {
  /** The project's check commands: tool calls running them are `testing`. */
  readonly checks?: ReadonlyArray<string>
  /** What the sessions' first system/init said of the setup: nothing by default. */
  readonly setup?: SetupFindings
  /**
   * Whether an interrupt cancels the queued messages, as `interrupt({ cancelQueued: true })` does
   * where the CLI advertises `interrupt_cancel_queued_v1` (§ 4.8): the receipt lists them under
   * `cancelled`, not `still_queued`, and they never run. False by default: the host cancels each
   * one with `cancel_async_message` instead, answered as `cancelAsync` says.
   */
  readonly cancelQueued?: boolean
  /**
   * How the CLI answers `cancel_async_message`: by default it drops the message (`cancelled:
   * true`), which never runs; "refuse" fails the request, and "notQueued" answers `cancelled:
   * false`, as for a message its turn has already taken. A message not dropped stays queued and runs.
   */
  readonly cancelAsync?: "refuse" | "notQueued"
  /** The process each ticket's Claude Code would have while its session is open: none by default. */
  readonly processes?: ReadonlyMap<string, number>
}

/**
 * The scripted AgentHost, playing `scripts`' sessions for each ticket, and Recording. A start or
 * resume with no session left in its ticket's script fails AgentStartFailed.
 */
export const layer = (
  scripts: Readonly<Record<string, Script>>,
  options: Options = {},
): Layer.Layer<AgentHost | Recording, never, Attention | Transcripts> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const attention = yield* Attention
      const workers = yield* makeWorkers(options.checks)
      const scope = yield* Effect.scope
      const left = new Map(Object.entries(scripts).map(([ticket, script]) => [ticket, [...script]]))
      const running = new Map<string, Running>()
      const sent: Array<Sent> = []
      const requires: Array<ReadonlyArray<string>> = []
      const drawn = yield* Ref.make(0)
      // Starts, resumes, closes, ends and a session going are one at a time.
      const one = yield* Semaphore.make(1)

      const record = (item: Sent) => Effect.sync(() => void sent.push(item))

      // The session's end, without tutti: its requests are withdrawn and its state is Gone.
      const gone = (ticket: string, session: Running, why: string) =>
        Effect.gen(function* () {
          if (running.get(ticket) !== session) return
          running.delete(ticket)
          ;(yield* Ref.get(session.controller)).abort()
          yield* workers.fold(session.entry, WorkerEvent.Ended({ session: session.sessionId, why }))
        }).pipe(one.withPermit)

      const emitIn = (session: Running, message: object) =>
        workers.emit(session.entry, session.sessionId, {
          ...message,
          session_id: session.sessionId,
        } as SDKMessage)

      const lifecycle = (session: Running, uuid: string, state: string) =>
        emitIn(session, { type: "command_lifecycle", command_uuid: uuid, state })

      // A scripted message, with what the CLI would add to it (see the header).
      const emitScripted = (session: Running, message: SDKMessage) =>
        Effect.gen(function* () {
          if (message.type === "result") {
            const taken = yield* Ref.getAndSet(session.taken, [])
            const listed = message.user_message_uuids ?? taken
            yield* emitIn(session, { ...message, user_message_uuids: listed })
            for (const uuid of listed) yield* lifecycle(session, uuid, "completed")
            return
          }
          const held =
            message.type === "system" &&
            message.subtype === "session_state_changed" &&
            message.state === "idle" &&
            (yield* Ref.get(session.queued)).length > 0
          if (!held) yield* emitIn(session, message)
        })

      // The next message not cancelled, waiting for one.
      const next = (session: Running): Effect.Effect<SDKUserMessage> =>
        Effect.flatMap(
          Effect.suspend(() => {
            const back = session.putBack.shift()
            return back === undefined ? Queue.take(session.inbox) : Effect.succeed(back)
          }),
          (message) =>
            session.cancelled.has(message.uuid ?? "") ? next(session) : Effect.succeed(message),
        )

      // The next message not cancelled, if one is waiting.
      const waiting = (session: Running): Effect.Effect<SDKUserMessage | undefined> =>
        Effect.flatMap(
          Effect.suspend(() => {
            const back = session.putBack.shift()
            return back === undefined
              ? Effect.map(Queue.poll(session.inbox), Option.getOrUndefined)
              : Effect.succeed(back)
          }),
          (message) =>
            message !== undefined && session.cancelled.has(message.uuid ?? "")
              ? waiting(session)
              : Effect.succeed(message),
        )

      // The turn takes the message: it is no longer queued, and the next result lists it.
      const take = (session: Running, message: SDKUserMessage) =>
        Effect.gen(function* () {
          const uuid = message.uuid ?? ""
          yield* Ref.update(session.queued, (uuids) => uuids.filter((u) => u !== uuid))
          yield* Ref.update(session.taken, (uuids) => [...uuids, uuid])
          yield* lifecycle(session, uuid, "started")
        })

      const play = (ticket: string, session: Running, step: Step): Effect.Effect<void> =>
        Step.$match(step, {
          Emit: ({ message }) => emitScripted(session, message),
          // As the live host's hook callbacks do, a PreCompact is a compaction too.
          Hook: ({ input }) =>
            Effect.andThen(
              workers.fold(session.entry, WorkerEvent.Hook({ session: session.sessionId, input })),
              input.hook_event_name === "PreCompact"
                ? workers.compacted(session.entry, input.trigger)
                : Effect.void,
            ),
          CanUseTool: ({ toolName, input, options }) =>
            Effect.gen(function* () {
              const callback = yield* attention.request(ticket)
              const { signal } = yield* Ref.get(session.controller)
              const n = yield* Ref.updateAndGet(drawn, (k) => k + 1)
              const result = yield* Effect.promise(() =>
                callback(toolName, input, {
                  toolUseID: `toolu_${n}`,
                  requestId: `req_${n}`,
                  ...options,
                  signal,
                }),
              )
              yield* record(Sent.Answered({ ticket, toolName, result }))
              yield* workers.counted(session.entry)
            }),
          Elicit: ({ request }) =>
            Effect.gen(function* () {
              const callback = yield* attention.elicitation(ticket)
              const { signal } = yield* Ref.get(session.controller)
              const n = yield* Ref.updateAndGet(drawn, (k) => k + 1)
              const result = yield* Effect.promise(() =>
                callback(request, { signal, requestId: `req_${n}` }),
              )
              yield* record(Sent.Elicited({ ticket, result }))
              yield* workers.counted(session.entry)
            }),
          Wait: () => Effect.flatMap(next(session), (message) => take(session, message)),
          Fold: () =>
            Effect.gen(function* () {
              yield* take(session, yield* next(session))
              let message = yield* waiting(session)
              while (message !== undefined) {
                yield* take(session, message)
                message = yield* waiting(session)
              }
            }),
          Coalesce: () =>
            Effect.gen(function* () {
              const first = yield* next(session)
              yield* take(session, first)
              let message = yield* waiting(session)
              while (message !== undefined && composed(message) === composed(first)) {
                yield* take(session, message)
                message = yield* waiting(session)
              }
              if (message !== undefined) session.putBack.unshift(message)
            }),
          AwaitInterrupt: () => Queue.take(session.interrupts),
          Sleep: ({ duration }) => Effect.sleep(duration),
          Do: ({ effect }) => effect,
          Gone: ({ why }) => gone(ticket, session, why),
          // Only a session's first step can fail its start; later, it does nothing.
          FailStart: () => Effect.void,
        })

      // Pushes a message into the session's inbox; its uuid.
      const push = (ticket: string, session: Running, message: Message) =>
        Effect.gen(function* () {
          const uuid = message.uuid ?? uuidOf(yield* Ref.updateAndGet(drawn, (k) => k + 1))
          const sdk = userMessage(message, uuid, session.sessionId)
          yield* record(Sent.Message({ ticket, message: sdk }))
          yield* workers.fold(session.entry, WorkerEvent.Sent({ session: session.sessionId, uuid }))
          yield* workers.sent(session.entry, session.sessionId, sdk)
          yield* lifecycle(session, uuid, "queued")
          yield* Ref.update(session.queued, (uuids) => [...uuids, uuid])
          yield* Queue.offer(session.inbox, sdk)
          return uuid as string
        })

      // Starts (or resumes) a session playing the ticket's next script.
      const begin = (ticket: string, session: Session, sentAs: Sent) =>
        Effect.gen(function* () {
          yield* record(sentAs)
          if (running.has(ticket)) {
            return yield* new AgentStartFailed({ ticket, reason: "a session is already open" })
          }
          const steps = left.get(ticket)?.shift()
          if (steps === undefined) {
            return yield* new AgentStartFailed({
              ticket,
              reason: "the script has no more sessions",
            })
          }
          const entry = yield* workers.open(ticket, session.sessionId)
          const first = steps[0]
          if (first?._tag === "FailStart") {
            yield* workers.fold(
              entry,
              WorkerEvent.Ended({ session: session.sessionId, why: first.reason }),
            )
            return yield* new AgentStartFailed({
              ticket,
              reason: first.reason,
              ...(first.startupFailureReason === undefined
                ? {}
                : { startupFailureReason: first.startupFailureReason }),
            })
          }
          const playing: Running = {
            sessionId: session.sessionId,
            entry,
            inbox: yield* Queue.unbounded<SDKUserMessage>(),
            putBack: [],
            queued: yield* Ref.make<ReadonlyArray<string>>([]),
            taken: yield* Ref.make<ReadonlyArray<string>>([]),
            cancelled: new Set(),
            interrupts: yield* Queue.unbounded<void>(),
            controller: yield* Ref.make(new AbortController()),
          }
          running.set(ticket, playing)
          // A session that has gone plays no more of its steps.
          playing.fiber = yield* Effect.gen(function* () {
            for (const step of steps) {
              if (running.get(ticket) !== playing) return
              yield* play(ticket, playing, step)
            }
          }).pipe(Effect.forkIn(scope))
          return playing
        }).pipe(one.withPermit)

      const session = (ticket: string) =>
        Effect.suspend(() => {
          const found = running.get(ticket)
          return found === undefined
            ? Effect.fail(new AgentGone({ ticket, why: "it has no open session" }))
            : Effect.succeed(found)
        })

      const close = (ticket: string) =>
        Effect.gen(function* () {
          const open = running.get(ticket)
          if (open === undefined) return
          running.delete(ticket)
          ;(yield* Ref.get(open.controller)).abort()
          if (open.fiber !== undefined) yield* Fiber.interrupt(open.fiber)
          yield* record(Sent.Closed({ ticket }))
          yield* workers.fold(open.entry, WorkerEvent.Closed({ session: open.sessionId }))
        })

      const host = AgentHost.of({
        start: (ticket, s) => Effect.asVoid(begin(ticket, s, Sent.Started({ ticket, session: s }))),
        resume: (ticket, s, message) =>
          Effect.flatMap(begin(ticket, s, Sent.Resumed({ ticket, session: s })), (playing) =>
            push(ticket, playing, message),
          ),
        send: (ticket, text, from, uuid) =>
          Effect.flatMap(session(ticket), (playing) =>
            push(ticket, playing, { text, from, ...(uuid === undefined ? {} : { uuid }) }),
          ),
        interrupt: (ticket) =>
          Effect.gen(function* () {
            const playing = yield* session(ticket)
            const queued = yield* Ref.get(playing.queued)
            const withdrawn: Array<string> = []
            if (options.cancelQueued === true) withdrawn.push(...queued)
            else {
              for (const uuid of queued) {
                const cancelled =
                  options.cancelAsync === "refuse" ? null : options.cancelAsync !== "notQueued"
                yield* record(Sent.CancelAsync({ ticket, uuid, cancelled }))
                if (cancelled === true) withdrawn.push(uuid)
              }
            }
            yield* Ref.update(playing.queued, (uuids) =>
              uuids.filter((u) => !withdrawn.includes(u)),
            )
            const receipt: Receipt = {
              stillQueued: queued.filter((uuid) => !withdrawn.includes(uuid)),
              cancelled: withdrawn,
            }
            for (const uuid of receipt.cancelled) {
              playing.cancelled.add(uuid)
              yield* lifecycle(playing, uuid, "cancelled")
            }
            yield* workers.fold(
              playing.entry,
              WorkerEvent.Cancelled({ session: playing.sessionId, uuids: receipt.cancelled }),
            )
            const controller = yield* Ref.getAndSet(playing.controller, new AbortController())
            controller.abort()
            yield* record(Sent.Interrupted({ ticket, receipt }))
            yield* Queue.offer(playing.interrupts, undefined)
            return receipt
          }),
        close: (ticket) => close(ticket).pipe(one.withPermit),
        end: (ticket) =>
          Effect.gen(function* () {
            yield* close(ticket)
            yield* record(Sent.Ended({ ticket }))
            yield* workers.forget(ticket)
          }).pipe(one.withPermit),
        takeRequires: (names) => Effect.sync(() => void requires.push(names)),
        current: workers.current,
        state: workers.state,
        messages: workers.messages,
        workers: workers.workers,
        compactions: workers.compactions,
        setup: Effect.succeed(options.setup ?? noFindings),
        processes: Effect.sync(
          () =>
            new Map(
              [...(options.processes ?? [])].filter(([ticket]) => running.has(ticket)),
            ) as ReadonlyMap<string, number>,
        ),
      })

      const recording = Recording.of({
        all: Effect.sync(() => [...sent]),
        sentTo: (ticket) => Effect.sync(() => sent.filter((item) => item.ticket === ticket)),
        messages: (ticket) =>
          Effect.sync(() =>
            sent.flatMap((item) =>
              item._tag === "Message" && item.ticket === ticket ? [item.message] : [],
            ),
          ),
        requires: Effect.sync(() => [...requires]),
      })
      return Context.make(AgentHost, host).pipe(Context.add(Recording, recording))
    }),
  )

// Step constructors.

export const emit = (message: object): Step => Step.Emit({ message: message as SDKMessage })
export const hook = (input: object): Step => Step.Hook({ input: input as HookInput })
export const canUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: Partial<Omit<Parameters<CanUseTool>[2], "signal">> = {},
): Step => Step.CanUseTool({ toolName, input, options })
export const elicit = (request: ElicitationRequest): Step => Step.Elicit({ request })
export const wait: Step = Step.Wait()
export const fold: Step = Step.Fold()
export const coalesce: Step = Step.Coalesce()
export const awaitInterrupt: Step = Step.AwaitInterrupt()
export const sleep = (duration: Duration.Input): Step => Step.Sleep({ duration })
export const run = (effect: Effect.Effect<void>): Step => Step.Do({ effect })
export const gone = (why: string): Step => Step.Gone({ why })
export const failStart = (reason: string, startupFailureReason?: string): Step =>
  Step.FailStart({
    reason,
    ...(startupFailureReason === undefined ? {} : { startupFailureReason }),
  })

// SDK messages, as docs/spikes/01-sdk-session.md recorded them, with the fields tutti reads.

/** `system/init`, which starts every turn. */
export const init = (fields: object = {}) =>
  emit({
    type: "system",
    subtype: "init",
    permissionMode: "auto",
    apiKeySource: "none",
    cwd: "",
    tools: [],
    mcp_servers: [],
    model: "claude",
    slash_commands: [],
    output_style: "default",
    ...fields,
  })

export const sessionState = (state: "running" | "requires_action" | "idle") =>
  emit({ type: "system", subtype: "session_state_changed", state })

/** A turn's clean result. */
export const result = (text = "DONE", fields: object = {}) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    num_turns: 1,
    ...fields,
  })

/** A turn's result with `is_error`: an API error ending it (a 429 is the usage limit, § 4.12). */
export const apiErrorResult = (text: string, status: number) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: true,
    result: text,
    api_error_status: status,
    num_turns: 1,
  })

/** An interrupted turn's result, as the spike saw it. */
export const interruptedResult = emit({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: [],
  num_turns: 1,
})

export const apiRetry = (attempt: number, status: number | null = 529, max = 10) =>
  emit({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: max,
    retry_delay_ms: 500,
    error_status: status,
    error: "overloaded",
  })

/** `background_tasks_changed`: the live tasks, replacing the set; ambient ones don't count. */
export const backgroundTasks = (
  ...tasks: ReadonlyArray<{ readonly id: string; readonly ambient?: boolean }>
) =>
  emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map(({ id, ambient }) => ({
      task_id: id,
      task_type: "local_bash",
      description: id,
      ...(ambient === undefined ? {} : { ambient }),
    })),
  })

/**
 * A background task's end, as the CLI sends it (docs/spikes/01-sdk-session.md, item 4):
 * `task_updated` (completed), `task_notification`, then the live set without it, `left`.
 */
export const taskEnds = (
  id: string,
  ...left: ReadonlyArray<{ readonly id: string; readonly ambient?: boolean }>
): ReadonlyArray<Step> => [
  emit({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed" } }),
  emit({
    type: "system",
    subtype: "task_notification",
    task_id: id,
    status: "completed",
    output_file: `/tmp/tasks/${id}.output`,
    summary: `Background command "${id}" completed`,
  }),
  backgroundTasks(...left),
]

/**
 * The turn the CLI starts by itself, with no send of tutti's: to report a finished task, about
 * 70 ms after the set emptied (the spike saw 69), or for an event a Monitor watch saw.
 */
export const selfStartedTurn = (
  steps: ReadonlyArray<Step> = [],
  end: Step = result(),
): ReadonlyArray<Step> => [
  sleep("70 millis"),
  sessionState("running"),
  init(),
  ...steps,
  end,
  sessionState("idle"),
]

/** `rate_limit_event`; `resetsAt` in seconds since the epoch, as the API's header has it. */
export const rateLimit = (
  status: "allowed" | "allowed_warning" | "rejected",
  resetsAt?: number,
  utilization?: number,
) =>
  emit({
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      rateLimitType: "five_hour",
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(utilization === undefined ? {} : { utilization }),
    },
  })

export const assistantText = (text: string, fields: object = {}) =>
  emit({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    ...fields,
  })

let toolIds = 0

/**
 * A tool call the session makes and its result: the PreToolUse hook, the assistant's tool_use,
 * `effect` (what the call does, to an in-memory Beads or Git), the tool_result and PostToolUse.
 */
export const tool = (
  name: string,
  input: Record<string, unknown>,
  effect?: Effect.Effect<void>,
): ReadonlyArray<Step> => {
  const id = `toolu_s${++toolIds}`
  return [
    hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id }),
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      parent_tool_use_id: null,
    }),
    ...(effect === undefined ? [] : [run(effect)]),
    emit({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
      parent_tool_use_id: null,
    }),
    hook({ hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_use_id: id }),
  ]
}

/** Bash running `command`, doing `effect`. */
export const bash = (command: string, effect?: Effect.Effect<void>) =>
  tool("Bash", { command }, effect)

/** What the CLI tells the worker when the safety check denies a held removal in auto mode. */
export const heldRemovalMessage =
  "Only a person may approve such a removal, and no person did (the permission prompt timed out, or this session cannot prompt)"

/**
 * A tool call Claude Code denies without asking, as the spike saw it in auto mode
 * (docs/spikes/01-sdk-session.md): the assistant's tool_use, a `permission_denied` naming what
 * denied it (`decision_reason_type`, left out when `by` is undefined) and why, and the tool_result
 * with the refusal it tells the worker, `message`. No canUseTool call, and no hooks.
 */
export const deniedTool = (
  name: string,
  input: Record<string, unknown>,
  denial: {
    readonly by: string | undefined
    readonly reason?: string
    readonly message?: string
    readonly agentId?: string
  },
): ReadonlyArray<Step> => {
  const id = `toolu_s${++toolIds}`
  const message = denial.message ?? `Permission to use ${name} has been denied.`
  return [
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      parent_tool_use_id: null,
    }),
    emit({
      type: "system",
      subtype: "permission_denied",
      tool_name: name,
      tool_use_id: id,
      ...(denial.agentId === undefined ? {} : { agent_id: denial.agentId }),
      ...(denial.by === undefined ? {} : { decision_reason_type: denial.by }),
      ...(denial.reason === undefined ? {} : { decision_reason: denial.reason }),
      message,
      uuid: `00000000-0000-4000-8000-d${String(toolIds).padStart(11, "0")}`,
    }),
    emit({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: message, is_error: true }],
      },
      parent_tool_use_id: null,
    }),
  ]
}

/**
 * A turn: it waits for a message, then system/init and running, `steps`, `end` (a clean result by
 * default) and idle.
 */
export const turn = (steps: ReadonlyArray<Step>, end: Step = result()): SessionScript => [
  wait,
  init(),
  sessionState("running"),
  ...steps,
  end,
  sessionState("idle"),
]

/** A turn the queued messages of one kind share (Coalesce); its result lists them all. */
export const coalescedTurn = (steps: ReadonlyArray<Step>, end: Step = result()): SessionScript => [
  coalesce,
  ...turn(steps, end).slice(1),
]

// The common scripts: one session each. A ticket's script is a list of them, one per start or
// resume. The effects stand for what the worker's commands do to an in-memory Beads or Git.

/** What a helper's commands do. */
export interface Effects {
  readonly claim?: Effect.Effect<void>
  readonly commit?: Effect.Effect<void>
  readonly close?: Effect.Effect<void>
  readonly defer?: Effect.Effect<void>
  readonly file?: Effect.Effect<void>
}

/** The check the helpers run; pass it in `checks` for its runs to be `testing`. */
export const checkCommand = "scripts/check-fast.sh"

/** Claims its ticket, edits, runs the check, commits and closes the ticket. */
export const claimsAndCloses = (ticket: string, effects: Effects = {}): SessionScript =>
  turn(
    [
      ...bash(`bd update ${ticket} --claim`, effects.claim),
      ...tool("Edit", { file_path: "src/main.ts", old_string: "a", new_string: "b" }),
      ...bash(checkCommand),
      ...bash(`git commit -am "Change (${ticket})"`, effects.commit),
      ...bash(`bd close ${ticket}`, effects.close),
    ],
    result(`Closed ${ticket}.`),
  )

/** Claims its ticket, notes why it can't finish and defers it. */
export const defers = (ticket: string, effects: Effects = {}): SessionScript =>
  turn(
    [
      ...bash(`bd update ${ticket} --claim`, effects.claim),
      ...bash(`bd update ${ticket} --append-notes "Can't finish: needs a design"`),
      ...bash(`bd defer ${ticket}`, effects.defer),
    ],
    result(`Deferred ${ticket}.`),
  )

/** Claims its ticket, files a question for the maintainer, and puts its ticket back to open. */
export const filesQuestion = (ticket: string, effects: Effects = {}): SessionScript =>
  turn(
    [
      ...bash(`bd update ${ticket} --claim`, effects.claim),
      ...bash(
        `bd create --type=task --labels human --deps blocks:${ticket} --title "Which way?"`,
        effects.file,
      ),
      ...bash(`bd update ${ticket} --status open --append-notes "Waiting on a question"`),
    ],
    result(`Asked about ${ticket}.`),
  )

/**
 * Asks permission for a tool call (Bash `rm -rf build` by default) and, once answered, makes it
 * and ends its turn.
 */
export const asksPermission = (
  call: {
    readonly tool?: string
    readonly input?: Record<string, unknown>
    readonly options?: Partial<Omit<Parameters<CanUseTool>[2], "signal">>
  } = {},
): SessionScript => {
  const name = call.tool ?? "Bash"
  const input = call.input ?? { command: "rm -rf build" }
  return turn([canUseTool(name, input, call.options), ...tool(name, input)])
}

/**
 * Runs Bash `command` in the background (task `b1`) and ends its turn while it runs: idle comes
 * with the task live. After `runs` the task ends and the CLI starts a turn to report it, which
 * reads its output; with `reported` false, no such turn comes.
 */
export const backgroundCommand = (
  command: string,
  runs: Duration.Input,
  options: { readonly reported?: boolean } = {},
): SessionScript => [
  ...turn([...tool("Bash", { command, run_in_background: true }), backgroundTasks({ id: "b1" })]),
  sleep(runs),
  ...taskEnds("b1"),
  ...(options.reported === false
    ? []
    : selfStartedTurn(tool("Read", { file_path: "/tmp/tasks/b1.output" }))),
]

/**
 * Sets a Monitor watch (task `m1`, `local_bash` and not ambient, as the spike saw) and ends its
 * turn while it watches. After `quiet` the watch sees an event, which starts a turn by itself; the
 * watch is still live after it.
 */
export const monitorWatch = (quiet: Duration.Input): SessionScript => [
  ...turn([
    ...tool("Monitor", { command: "tail -f .tutti/tutti.log", description: "the run's log" }),
    backgroundTasks({ id: "m1" }),
  ]),
  sleep(quiet),
  ...selfStartedTurn([assistantText("A new line in the log.")]),
]

/**
 * Hits the usage limit: a rejected rate_limit_event resetting at `resetsAt` (seconds since the
 * epoch), retries, and the turn's result with is_error and status 429.
 */
export const hitsUsageLimit = (resetsAt: number): SessionScript => [
  wait,
  init(),
  sessionState("running"),
  rateLimit("rejected", resetsAt, 1),
  apiRetry(1, 429),
  assistantText("API Error: usage limit reached", { error: "rate_limit" }),
  apiErrorResult("API Error: usage limit reached", 429),
  sessionState("idle"),
]
