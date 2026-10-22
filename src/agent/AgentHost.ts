// The AgentHost service (§ 3.3, § 4.1, § 4.8): starting, resuming, messaging, interrupting,
// closing and ending worker sessions, one session at a time per ticket. Each worker has a
// WorkerState, folded from its session's messages, hooks and open attention requests (§ 4.2), which
// the host keeps in a SubscriptionRef from the worker's first start until it is ended; and a stream
// of its sessions' raw SDK messages, in the shape Transcripts records them. The host itself records
// every message in Transcripts, so a reader that subscribes late misses nothing from the file. It
// records there too each message it sends a worker, as it pushes it: the SDK doesn't echo them
// (tutti doesn't ask it to replay user messages), and the worker view shows them (§ 7.5).
//
// A call Claude Code denies without asking comes as a `permission_denied` (§ 4.5), which names the
// call's tool use but not its input: each worker keeps its last calls' inputs, from its assistant
// messages, so Attention can log the denial as `Bash(rm -rf build)`, record it and tally it. The
// account's rate-limit events, and which workers are UsageLimited, go to UsageLimits, for the
// usage-limit hold (§ 4.12). Each compaction a worker's PreCompact hook reports goes on one stream
// for the run to count and log (§ 4.2).
//
// The caller draws each new session's ID, and saves it once the session has begun (§ 4.8). A
// resumed session emits nothing until it is sent something (docs/spikes/02-sdk-lifecycle.md), so
// resume takes the message that carries it on.
//
// The live layer is src/agent/AgentHostLive.ts (over the Agent SDK); the test layer is
// src/testing/AgentHost.ts, which replays scripted sessions and records what it was sent.
import type {
  McpSdkServerConfigWithInstance,
  SDKMessage,
  SDKPermissionDeniedMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Equal,
  Option,
  PubSub,
  Ref,
  Schema,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { detail, Log } from "../run/log.ts"
import type { PermissionModeInEffect } from "./Account.ts"
import { Attention } from "./Attention.ts"
import { Transcripts } from "./Transcripts.ts"
import { UsageLimits } from "./UsageLimits.ts"
import { initial, reportWait, step, type Worker, WorkerEvent, WorkerState } from "./WorkerState.ts"

/**
 * Who wrote a message: tutti (sent `client_composed`, delivered as written, § 4.1) or a person at
 * the worker's composer (sent with `origin: { kind: "human" }`).
 */
export type From = "clientComposed" | "human"

/** A message for a worker. */
export interface Message {
  readonly text: string
  readonly from: From
  /** The uuid to send it with, drawn by the caller (the composer, § 7.5); drawn here when left out. */
  readonly uuid?: string
}

/** A session to start or resume: its ID, drawn by the caller, and where it runs (the worktree). */
export interface Session {
  readonly sessionId: string
  readonly cwd: string
  /**
   * A session with no ticket, the environment probe's (§ 4.9): no MCP servers and no worker
   * prompt, in the main checkout.
   */
  readonly probe?: true
  /**
   * The feature interview's session (§ 4.10), in the main checkout: its instructions and tutti's
   * own MCP server in place of the worker prompt and the workers' servers.
   */
  readonly interview?: InterviewSetup
}

/** What an interview's session is given beside the workers' options (§ 4.10). */
export interface InterviewSetup {
  /** The interview's instructions, appended to the claude_code preset. */
  readonly prompt: string
  /** tutti's in-process MCP server, with tickets_list, ticket_show and file_feature. */
  readonly server: McpSdkServerConfigWithInstance
}

/**
 * An interrupt's receipt (§ 4.8): the messages, by uuid, still queued, which will run, and those
 * cancelled, by the interrupt where the CLI advertises `interrupt_cancel_queued_v1`, else one by one
 * with `cancel_async_message`.
 */
export interface Receipt {
  readonly stillQueued: ReadonlyArray<string>
  readonly cancelled: ReadonlyArray<string>
}

/**
 * What workers' sessions said of the setup on their first system/init (§ 4.1): the permission mode
 * in effect, when it isn't the one asked for, and the setup problems that ended workers (MCP servers
 * they weren't given, an API key they would bill).
 */
export interface SetupFindings {
  /** null until a session's mode in effect differs from the one asked for. */
  readonly permissionMode: PermissionModeInEffect | null
  readonly problems: ReadonlyArray<string>
}

/** Nothing found yet. */
export const noFindings: SetupFindings = { permissionMode: null, problems: [] }

/** A message of a worker's session, as Transcripts records it. */
export interface SessionMessage {
  readonly session: string
  readonly message: SDKMessage
}

/** A compaction of a worker's context, as its PreCompact hook reports it. */
export interface Compaction {
  readonly ticket: string
  /** What triggered it: `auto`, or `manual` for `/compact`. */
  readonly trigger: string
}

/** The SDK user message that carries `message`, stamped `uuid`, into session `session`. */
export const userMessage = (message: Message, uuid: string, session: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: message.text },
  parent_tool_use_id: null,
  uuid: uuid as SDKUserMessage["uuid"] & string,
  session_id: session,
  ...(message.from === "clientComposed"
    ? { client_composed: true as const }
    : { origin: { kind: "human" as const } }),
})

/** A session couldn't be started or resumed. */
export class AgentStartFailed extends Schema.TaggedError<AgentStartFailed>()("AgentStartFailed", {
  ticket: Schema.String,
  reason: Schema.String,
  /** The CLI's `startup_failure_reason` (`cwd_unavailable`, `org_config_refused`, …), if it gave one. */
  startupFailureReason: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return `${this.ticket}'s worker didn't start: ${this.reason}`
  }
}

/** The ticket's worker has no open session: never started, closed, ended or gone. */
export class AgentGone extends Schema.TaggedError<AgentGone>()("AgentGone", {
  ticket: Schema.String,
  why: Schema.String,
}) {
  override get message(): string {
    return `${this.ticket}'s worker is gone: ${this.why}`
  }
}

/** The session answered outside the protocol: a control request that failed, say. */
export class AgentProtocol extends Schema.TaggedError<AgentProtocol>()("AgentProtocol", {
  ticket: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.ticket}'s worker broke the protocol: ${this.detail}`
  }
}

export class AgentHost extends Context.Service<
  AgentHost,
  {
    /**
     * Starts a new session for the ticket's worker with the ID `session.sessionId`. Its state
     * starts again at Starting. Fails when the worker already has an open session; one closing is
     * waited for, until its Claude Code has exited.
     */
    start(ticket: string, session: Session): Effect.Effect<void, AgentStartFailed>
    /**
     * Resumes the session `session.sessionId` (without forking it) and sends it `message`, as
     * `send` does: the message's uuid. Fails when the worker already has an open session; one
     * closing is waited for, until its Claude Code has exited.
     */
    resume(
      ticket: string,
      session: Session,
      message: Message,
    ): Effect.Effect<string, AgentStartFailed>
    /**
     * Pushes a message into the worker's inbox: the CLI may fold it into the running turn or queue
     * it, alone or sharing a turn with another (§ 4.1). Its uuid, `uuid` when given, which the
     * session's results and an interrupt's receipt name it by.
     */
    send(ticket: string, text: string, from: From, uuid?: string): Effect.Effect<string, AgentGone>
    /**
     * Interrupts the worker's turn and cancels the messages queued behind it (§ 4.8); open requests
     * are withdrawn. The receipt.
     */
    interrupt(ticket: string): Effect.Effect<Receipt, AgentGone | AgentProtocol>
    /**
     * Closes the worker's session on purpose, keeping its ID for a resume: its state is Closed.
     * A session still starting is cancelled, its start failing; one closing or gone is waited for,
     * until its Claude Code has exited. Nothing happens when it has no session.
     */
    close(ticket: string): Effect.Effect<void>
    /** Closes the worker's session if it is open and forgets the worker: its streams end. */
    end(ticket: string): Effect.Effect<void>
    /**
     * The run's requires list has the entries `names` from now on, a merge having changed it: the
     * workers started or resumed after are told so (requiresNote); before, the settings' entries.
     */
    takeRequires(names: ReadonlyArray<string>): Effect.Effect<void>
    /** The worker's state now. */
    current(ticket: string): Effect.Effect<WorkerState, AgentGone>
    /**
     * Whether the worker's current session has begun, its first system/init come (§ 4.8): now, then
     * on each change, until it is ended. A session that has ended after it began still has.
     */
    begun(ticket: string): Stream.Stream<boolean, AgentGone>
    /** The worker's state: now, then on each change, across its sessions, until it is ended. */
    state(ticket: string): Stream.Stream<WorkerState, AgentGone>
    /** Its sessions' messages, from now on, until it is ended. */
    messages(ticket: string): Stream.Stream<SessionMessage, AgentGone>
    /**
     * The tickets of the workers the host knows, from each one's first start until it is ended:
     * now, then on each change.
     */
    readonly workers: Stream.Stream<ReadonlySet<string>>
    /** Every worker's compactions, from now on, as their PreCompact hooks report them (§ 4.2). */
    readonly compactions: Stream.Stream<Compaction>
    /** What the sessions' first system/init said of the setup, so far. */
    readonly setup: Effect.Effect<SetupFindings>
    /**
     * The process of each open session's Claude Code, by ticket: the leader of a process group of
     * its own (§ 3.2), for its memory on the dashboard's load line (src/run/load.ts).
     */
    readonly processes: Effect.Effect<ReadonlyMap<string, number>>
  }
>()("tutti/agent/AgentHost") {}

/** A worker the host knows: from its first start until it is ended. */
export interface WorkerEntry {
  readonly ticket: string
  /** The ID of its session now, the last started or resumed: events of any other aren't folded. */
  readonly session: Ref.Ref<string>
  /** The reducer's worker: its state and what it is derived from. */
  readonly worker: SubscriptionRef.SubscriptionRef<Worker>
  /** Its state alone, set only when it changes. */
  readonly state: SubscriptionRef.SubscriptionRef<WorkerState>
  readonly messages: PubSub.PubSub<SessionMessage>
  /** Done when the worker is ended: its streams end with it. */
  readonly ended: Deferred.Deferred<void>
  /** The inputs of its last `callsKept` tool calls, its subagents' too, by tool use ID. */
  readonly calls: Map<string, Readonly<Record<string, unknown>>>
}

/** How many of a worker's last tool calls keep their input, for the denials that name them. */
export const callsKept = 64

/** The tool calls in an assistant message, its subagents' too: each one's ID and input. */
const toolUses = (
  message: SDKMessage,
): ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> => {
  if (message.type !== "assistant") return []
  const content: unknown = message.message.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) => {
    const b = block as { readonly type?: unknown; readonly id?: unknown; readonly input?: unknown }
    return b.type === "tool_use" &&
      typeof b.id === "string" &&
      typeof b.input === "object" &&
      b.input !== null
      ? [[b.id, b.input as Readonly<Record<string, unknown>>] as const]
      : []
  })
}

/** Keeps the message's tool calls' inputs in `calls`, the oldest going past `callsKept`. */
const keepCalls = (calls: WorkerEntry["calls"], message: SDKMessage): void => {
  for (const [id, input] of toolUses(message)) {
    calls.delete(id)
    calls.set(id, input)
  }
  for (const id of calls.keys()) {
    if (calls.size <= callsKept) break
    calls.delete(id)
  }
}

/** Whether `message` is a `permission_denied`: a call Claude Code denied without asking. */
const isDenial = (message: SDKMessage): message is SDKPermissionDeniedMessage =>
  message.type === "system" && message.subtype === "permission_denied"

/** The workers a host knows, and how their state moves: what the live and test layers share. */
export interface Workers {
  /**
   * The ticket's worker, made if the host doesn't know it, its state back at Starting for its new
   * session `session`, whose events alone it folds from now on. Its open attention requests are
   * counted into its state from then on.
   */
  readonly open: (ticket: string, session: string) => Effect.Effect<WorkerEntry>
  readonly get: (ticket: string) => Effect.Effect<WorkerEntry, AgentGone>
  /**
   * Folds `event` into the worker's state, at the clock's time, unless it is of an earlier session
   * than the worker's now; UsageLimits, when there is one, is told when it becomes UsageLimited or
   * stops being so.
   */
  readonly fold: (entry: WorkerEntry, event: WorkerEvent) => Effect.Effect<void>
  /**
   * A message of the session `session`: recorded in Transcripts, published and folded in; a
   * `permission_denied` is recorded through Attention too, and a `rate_limit_event`'s info is
   * reported to UsageLimits, when there is one (§ 4.12).
   */
  readonly emit: (entry: WorkerEntry, session: string, message: SDKMessage) => Effect.Effect<void>
  /**
   * A message sent into the session `session`, as it is pushed: recorded in Transcripts alone. The
   * session doesn't send it back, so it isn't published, and the send is folded in as `Sent`.
   */
  readonly sent: (
    entry: WorkerEntry,
    session: string,
    message: SDKUserMessage,
  ) => Effect.Effect<void>
  /** A compaction of the worker's context, `trigger` its PreCompact hook's: published. */
  readonly compacted: (entry: WorkerEntry, trigger: string) => Effect.Effect<void>
  /** Every worker's compactions, from now on. */
  readonly compactions: Stream.Stream<Compaction>
  /** Waits until the worker's state counts every one of its open attention requests. */
  readonly counted: (entry: WorkerEntry) => Effect.Effect<void>
  /** Forgets the worker: its streams end. */
  readonly forget: (ticket: string) => Effect.Effect<void>
  readonly current: (ticket: string) => Effect.Effect<WorkerState, AgentGone>
  readonly begun: (ticket: string) => Stream.Stream<boolean, AgentGone>
  readonly state: (ticket: string) => Stream.Stream<WorkerState, AgentGone>
  readonly messages: (ticket: string) => Stream.Stream<SessionMessage, AgentGone>
  /** The tickets of the workers it knows: now, then on each change. */
  readonly workers: Stream.Stream<ReadonlySet<string>>
}

/**
 * The workers of a host whose project's check commands are `checks` (they classify as testing).
 * Each worker's attention counter, and its wait for a finished task's report, runs in the scope. A
 * report that doesn't come is written to the Log, when there is one, else logged as a warning.
 */
export const makeWorkers = (
  checks: ReadonlyArray<string> = [],
): Effect.Effect<Workers, never, Attention | Transcripts | Scope.Scope> =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const transcripts = yield* Transcripts
    const scope = yield* Effect.scope
    const known = new Map<string, WorkerEntry>()
    // Set as `known` changes, for the streams of the workers it knows.
    const knownTickets = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set())
    // Folds are serialised, so the state set last is the one the last fold gave.
    const one = yield* Semaphore.make(1)
    const compactions = yield* PubSub.unbounded<Compaction>()
    const log = yield* Effect.serviceOption(Log)
    const usage = yield* Effect.serviceOption(UsageLimits)

    const late = (ticket: string) => {
      const text = `a background task ended and no turn came to report it within ${reportWait}; not waiting for it`
      return Option.match(log, {
        onNone: () => Effect.logWarning(`${ticket}: ${text}`),
        onSome: (each) => each.write(detail`${ticket}: ${text}`),
      })
    }

    const fold = (entry: WorkerEntry, event: WorkerEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.session !== (yield* Ref.get(entry.session))) return
        const now = yield* Clock.currentTimeMillis
        const before = yield* SubscriptionRef.get(entry.worker)
        const next = yield* SubscriptionRef.updateAndGet(entry.worker, (w) => step(w, event, now))
        const shown = yield* SubscriptionRef.get(entry.state)
        if (!Equal.equals(shown, next.state)) {
          yield* SubscriptionRef.set(entry.state, next.state)
          if (Option.isSome(usage)) {
            const { state } = next
            yield* usage.value.limited(
              entry.ticket,
              state._tag === "UsageLimited" ? state.resetsAt : undefined,
            )
          }
        }
        if (next.report !== null && next.report !== before.report) {
          yield* awaitReport(entry, event.session, next.report)
        }
      }).pipe(one.withPermit)

    // A finished task's report to come in the session `session`, since `since` (§ 4.2): a turn
    // starting ends the wait; if none starts within reportWait, the worker stops waiting for it and
    // the log says so.
    const awaitReport = (entry: WorkerEntry, session: string, since: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const reported = SubscriptionRef.changes(entry.worker).pipe(
          Stream.takeUntil((w) => w.report !== since),
          Stream.runDrain,
        )
        const waited = yield* Effect.sleep(reportWait).pipe(
          Effect.as(true),
          Effect.raceFirst(Effect.as(reported, false)),
        )
        if (!waited) return
        yield* late(entry.ticket)
        yield* fold(entry, WorkerEvent.ReportLate({ session, since }))
      }).pipe(Effect.raceFirst(Deferred.await(entry.ended)), Effect.forkIn(scope), Effect.asVoid)

    const openCount = (ticket: string) =>
      Effect.map(attention.current, (all) => all.filter((r) => r.ticket === ticket).length)

    // The worker's open requests, counted in its session now.
    const requests = (entry: WorkerEntry, pending: number) =>
      Effect.flatMap(Ref.get(entry.session), (session) =>
        fold(entry, WorkerEvent.Requests({ session, pending })),
      )

    const make = (ticket: string, session: string) =>
      Effect.gen(function* () {
        const entry: WorkerEntry = {
          ticket,
          session: yield* Ref.make(session),
          worker: yield* SubscriptionRef.make(initial(checks)),
          state: yield* SubscriptionRef.make<WorkerState>(WorkerState.Starting()),
          messages: yield* PubSub.unbounded<SessionMessage>(),
          ended: yield* Deferred.make<void>(),
          calls: new Map(),
        }
        // Counts its open requests into its state, until it is ended; it has counted the requests
        // open now before the entry is handed out, so none is missed.
        const listening = yield* Deferred.make<void>()
        yield* attention.openFor(ticket).pipe(
          Stream.runForEach((open) =>
            Effect.andThen(requests(entry, open.length), Deferred.succeed(listening, undefined)),
          ),
          Effect.raceFirst(Deferred.await(entry.ended)),
          Effect.forkIn(scope),
        )
        yield* Deferred.await(listening)
        return entry
      })

    const open = (ticket: string, session: string) =>
      Effect.gen(function* () {
        const found = known.get(ticket)
        if (found === undefined) {
          const entry = yield* make(ticket, session)
          known.set(ticket, entry)
          yield* SubscriptionRef.set(knownTickets, new Set(known.keys()))
          return entry
        }
        const pending = yield* openCount(ticket)
        yield* Ref.set(found.session, session)
        yield* SubscriptionRef.set(found.worker, { ...initial(checks), pending })
        yield* fold(found, WorkerEvent.Requests({ session, pending }))
        return found
      })

    const get = (ticket: string) =>
      Effect.suspend(() => {
        const found = known.get(ticket)
        return found === undefined
          ? Effect.fail(new AgentGone({ ticket, why: "it has no worker" }))
          : Effect.succeed(found)
      })

    const until = <A, E, R>(entry: WorkerEntry, stream: Stream.Stream<A, E, R>) =>
      Stream.interruptWhen(stream, Deferred.await(entry.ended))

    return {
      open,
      get,
      fold,
      emit: (entry, session, message) =>
        Effect.gen(function* () {
          yield* transcripts.record(entry.ticket, session, message)
          yield* PubSub.publish(entry.messages, { session, message })
          yield* fold(entry, WorkerEvent.Message({ session, message }))
          keepCalls(entry.calls, message)
          if (isDenial(message)) {
            yield* attention.denial(entry.ticket, message, entry.calls.get(message.tool_use_id))
          }
          if (message.type === "rate_limit_event" && Option.isSome(usage)) {
            yield* usage.value.report(message.rate_limit_info)
          }
        }),
      sent: (entry, session, message) => transcripts.record(entry.ticket, session, message),
      compacted: (entry, trigger) =>
        Effect.asVoid(PubSub.publish(compactions, { ticket: entry.ticket, trigger })),
      compactions: Stream.fromPubSub(compactions),
      counted: (entry) =>
        Effect.gen(function* () {
          const open = yield* openCount(entry.ticket)
          yield* SubscriptionRef.changes(entry.worker).pipe(
            Stream.takeUntil((w) => w.pending === open || w.end !== null),
            Stream.runDrain,
          )
        }),
      forget: (ticket) =>
        Effect.gen(function* () {
          const found = known.get(ticket)
          if (found === undefined) return
          known.delete(ticket)
          yield* SubscriptionRef.set(knownTickets, new Set(known.keys()))
          if (Option.isSome(usage)) yield* usage.value.limited(ticket, undefined)
          yield* Deferred.succeed(found.ended, undefined)
        }),
      current: (ticket) => Effect.flatMap(get(ticket), (entry) => SubscriptionRef.get(entry.state)),
      begun: (ticket) =>
        Stream.unwrap(
          Effect.map(get(ticket), (entry) =>
            until(
              entry,
              SubscriptionRef.changes(entry.worker).pipe(
                Stream.map((worker) => worker.started),
                Stream.changes,
              ),
            ),
          ),
        ),
      state: (ticket) =>
        Stream.unwrap(
          Effect.map(get(ticket), (entry) => until(entry, SubscriptionRef.changes(entry.state))),
        ),
      messages: (ticket) =>
        Stream.unwrap(
          Effect.map(get(ticket), (entry) => until(entry, Stream.fromPubSub(entry.messages))),
        ),
      workers: SubscriptionRef.changes(knownTickets),
    }
  })
