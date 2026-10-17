// The AgentHost service (§ 3.3, § 4.1, § 4.8): starting, resuming, messaging, interrupting,
// closing and ending worker sessions, one session at a time per ticket. Each worker has a
// WorkerState, folded from its session's messages, hooks and open attention requests (§ 4.2), which
// the host keeps in a SubscriptionRef from the worker's first start until it is ended; and a stream
// of its sessions' raw SDK messages, in the shape Transcripts records them. The host itself records
// every message in Transcripts, so a reader that subscribes late misses nothing from the file.
//
// The caller draws each new session's ID and saves it before starting it (§ 4.8). A resumed
// session emits nothing until it is sent something (docs/spikes/02-sdk-lifecycle.md), so resume
// takes the message that carries it on.
//
// The live layer is src/agent/AgentHostLive.ts (over the Agent SDK); the test layer is
// src/testing/AgentHost.ts, which replays scripted sessions and records what it was sent.
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Equal,
  Option,
  PubSub,
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
}

/** A session to start or resume: its ID, drawn by the caller, and where it runs (the worktree). */
export interface Session {
  readonly sessionId: string
  readonly cwd: string
}

/**
 * An interrupt's receipt (§ 4.8): the messages, by uuid, still queued, which will run, and those
 * the interrupt cancelled, where the CLI advertises `interrupt_cancel_queued_v1`.
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

/** The SDK user message that carries `message`, stamped `uuid`, into session `session`. */
export const userMessage = (
  message: Message,
  uuid: SDKUserMessage["uuid"] & string,
  session: string,
): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: message.text },
  parent_tool_use_id: null,
  uuid,
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
     * starts again at Starting. Fails when the worker already has an open session.
     */
    start(ticket: string, session: Session): Effect.Effect<void, AgentStartFailed>
    /**
     * Resumes the session `session.sessionId` (without forking it) and sends it `message`, as
     * `send` does: the message's uuid. Fails when the worker already has an open session.
     */
    resume(
      ticket: string,
      session: Session,
      message: Message,
    ): Effect.Effect<string, AgentStartFailed>
    /**
     * Pushes a message into the worker's inbox: the CLI may fold it into the running turn or queue
     * it, alone or sharing a turn with another (§ 4.1). Its uuid, which the session's results and
     * an interrupt's receipt name it by.
     */
    send(ticket: string, text: string, from: From): Effect.Effect<string, AgentGone>
    /** Interrupts the worker's turn; open requests are withdrawn. The receipt. */
    interrupt(ticket: string): Effect.Effect<Receipt, AgentGone | AgentProtocol>
    /**
     * Closes the worker's session on purpose, keeping its ID for a resume: its state is Closed.
     * Nothing happens when it has no open session.
     */
    close(ticket: string): Effect.Effect<void>
    /** Closes the worker's session if it is open and forgets the worker: its streams end. */
    end(ticket: string): Effect.Effect<void>
    /** The worker's state now. */
    current(ticket: string): Effect.Effect<WorkerState, AgentGone>
    /** The worker's state: now, then on each change, across its sessions, until it is ended. */
    state(ticket: string): Stream.Stream<WorkerState, AgentGone>
    /** Its sessions' messages, from now on, until it is ended. */
    messages(ticket: string): Stream.Stream<SessionMessage, AgentGone>
    /** What the sessions' first system/init said of the setup, so far. */
    readonly setup: Effect.Effect<SetupFindings>
  }
>()("tutti/agent/AgentHost") {}

/** A worker the host knows: from its first start until it is ended. */
export interface WorkerEntry {
  readonly ticket: string
  /** The reducer's worker: its state and what it is derived from. */
  readonly worker: SubscriptionRef.SubscriptionRef<Worker>
  /** Its state alone, set only when it changes. */
  readonly state: SubscriptionRef.SubscriptionRef<WorkerState>
  readonly messages: PubSub.PubSub<SessionMessage>
  /** Done when the worker is ended: its streams end with it. */
  readonly ended: Deferred.Deferred<void>
}

/** The workers a host knows, and how their state moves: what the live and test layers share. */
export interface Workers {
  /**
   * The ticket's worker, made if the host doesn't know it, its state back at Starting for a new
   * session. Its open attention requests are counted into its state from then on.
   */
  readonly open: (ticket: string) => Effect.Effect<WorkerEntry>
  readonly get: (ticket: string) => Effect.Effect<WorkerEntry, AgentGone>
  /** Folds `event` into the worker's state, at the clock's time. */
  readonly fold: (entry: WorkerEntry, event: WorkerEvent) => Effect.Effect<void>
  /** A message of the session `session`: recorded in Transcripts, published and folded in. */
  readonly emit: (entry: WorkerEntry, session: string, message: SDKMessage) => Effect.Effect<void>
  /** Waits until the worker's state counts every one of its open attention requests. */
  readonly counted: (entry: WorkerEntry) => Effect.Effect<void>
  /** Forgets the worker: its streams end. */
  readonly forget: (ticket: string) => Effect.Effect<void>
  readonly current: (ticket: string) => Effect.Effect<WorkerState, AgentGone>
  readonly state: (ticket: string) => Stream.Stream<WorkerState, AgentGone>
  readonly messages: (ticket: string) => Stream.Stream<SessionMessage, AgentGone>
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
    // Folds are serialised, so the state set last is the one the last fold gave.
    const one = yield* Semaphore.make(1)
    const log = yield* Effect.serviceOption(Log)

    const late = (ticket: string) => {
      const text = `a background task ended and no turn came to report it within ${reportWait}; not waiting for it`
      return Option.match(log, {
        onNone: () => Effect.logWarning(`${ticket}: ${text}`),
        onSome: (each) => each.write(detail`${ticket}: ${text}`),
      })
    }

    const fold = (entry: WorkerEntry, event: WorkerEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const before = yield* SubscriptionRef.get(entry.worker)
        const next = yield* SubscriptionRef.updateAndGet(entry.worker, (w) => step(w, event, now))
        const shown = yield* SubscriptionRef.get(entry.state)
        if (!Equal.equals(shown, next.state)) yield* SubscriptionRef.set(entry.state, next.state)
        if (next.report !== null && next.report !== before.report) {
          yield* awaitReport(entry, next.report)
        }
      }).pipe(one.withPermit)

    // A finished task's report to come, since `since` (§ 4.2): a turn starting ends the wait; if
    // none starts within reportWait, the worker stops waiting for it and the log says so.
    const awaitReport = (entry: WorkerEntry, since: number): Effect.Effect<void> =>
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
        yield* fold(entry, WorkerEvent.ReportLate({ since }))
      }).pipe(Effect.raceFirst(Deferred.await(entry.ended)), Effect.forkIn(scope), Effect.asVoid)

    const openCount = (ticket: string) =>
      Effect.map(attention.current, (all) => all.filter((r) => r.ticket === ticket).length)

    const make = (ticket: string) =>
      Effect.gen(function* () {
        const entry: WorkerEntry = {
          ticket,
          worker: yield* SubscriptionRef.make(initial(checks)),
          state: yield* SubscriptionRef.make<WorkerState>(WorkerState.Starting()),
          messages: yield* PubSub.unbounded<SessionMessage>(),
          ended: yield* Deferred.make<void>(),
        }
        // Counts its open requests into its state, until it is ended; it has counted the requests
        // open now before the entry is handed out, so none is missed.
        const listening = yield* Deferred.make<void>()
        yield* attention.openFor(ticket).pipe(
          Stream.runForEach((open) =>
            Effect.andThen(
              fold(entry, WorkerEvent.Requests({ pending: open.length })),
              Deferred.succeed(listening, undefined),
            ),
          ),
          Effect.raceFirst(Deferred.await(entry.ended)),
          Effect.forkIn(scope),
        )
        yield* Deferred.await(listening)
        return entry
      })

    const open = (ticket: string) =>
      Effect.gen(function* () {
        const found = known.get(ticket)
        if (found === undefined) {
          const entry = yield* make(ticket)
          known.set(ticket, entry)
          return entry
        }
        const pending = yield* openCount(ticket)
        yield* SubscriptionRef.set(found.worker, { ...initial(checks), pending })
        yield* fold(found, WorkerEvent.Requests({ pending }))
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
          yield* fold(entry, WorkerEvent.Message({ message }))
        }),
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
          yield* Deferred.succeed(found.ended, undefined)
        }),
      current: (ticket) => Effect.flatMap(get(ticket), (entry) => SubscriptionRef.get(entry.state)),
      state: (ticket) =>
        Stream.unwrap(
          Effect.map(get(ticket), (entry) => until(entry, SubscriptionRef.changes(entry.state))),
        ),
      messages: (ticket) =>
        Stream.unwrap(
          Effect.map(get(ticket), (entry) => until(entry, Stream.fromPubSub(entry.messages))),
        ),
    }
  })
