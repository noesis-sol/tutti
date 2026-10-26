// The AgentHost service (§ 3.3, § 4.1, § 4.8): starting, resuming, messaging, interrupting,
// closing and ending worker sessions, one session at a time per ticket. Each worker has a
// WorkerState, folded from its session's messages, hooks and open attention requests (§ 4.2), which
// the host keeps in a SubscriptionRef from the worker's first start until it is ended. The host
// records every message of its sessions in Transcripts, and reads it once (src/agent/reading.ts)
// for all that takes it in. It records there too each message it sends a worker, as it pushes it:
// the SDK doesn't echo them (tutti doesn't ask it to replay user messages), and the worker view
// shows them (§ 7.5). Whether a send is answered is the worker's state's to say: it is outstanding
// there from its push until a message of the session, or an interrupt, says it no longer is.
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
// The live layer is src/agent/AgentHostLive.ts (over ClaudeCode, the Agent SDK's port); the test
// layer is src/testing/AgentHost.ts, the live layer over ClaudeCode's scripted sessions
// (src/testing/ClaudeCode.ts), which records what it was sent.
import type {
  McpSdkServerConfigWithInstance,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  Clock,
  Context,
  type Data,
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
import type { efforts } from "../project/settings.ts"
import { detail, Log } from "../run/log.ts"
import { Spending } from "../run/spending.ts"
import type { TicketId } from "../services/Beads.ts"
import { Attention } from "./Attention.ts"
import type { ContextUsage } from "./contextUsage.ts"
import { type Call, type Reading, read } from "./reading.ts"
import type { SessionKind } from "./sessionKind.ts"
import { Transcripts } from "./Transcripts.ts"
import { UsageLimits } from "./UsageLimits.ts"
import { initial, reportWait, step, type Worker, WorkerEvent, WorkerState } from "./WorkerState.ts"

/**
 * Who wrote a message: tutti (sent `client_composed`, delivered as written, § 4.1) or a person at
 * the worker's composer (sent with `origin: { kind: "human" }`).
 */
export type From = "clientComposed" | "human"

declare const messageUuidBrand: unique symbol

/**
 * The uuid a message to a worker is sent under, which its session's results and an interrupt's
 * receipt name it by: a type of its own, so it can't be passed for a ticket or a session beside it.
 */
export type MessageUuid = ReturnType<typeof crypto.randomUUID> & {
  readonly [messageUuidBrand]: true
}

export const MessageUuid = {
  /** A new message's uuid. */
  draw: (): MessageUuid => crypto.randomUUID() as MessageUuid,
} as const

/** A message for a worker. */
export interface Message {
  readonly text: string
  readonly from: From
  /** The uuid to send it with, drawn by the caller (the composer, § 7.5); drawn here when left out. */
  readonly uuid?: MessageUuid | undefined
}

/** A session to start or resume: its ID, drawn by the caller, and where it runs (the worktree). */
export interface Session {
  readonly sessionId: string
  readonly cwd: string
  /** What it is for (sessionKind.ts); a worker's when left out. */
  readonly kind?: SessionKind
}

/** What an interview's session is given beside the workers' options (§ 4.10). */
export interface InterviewSetup {
  /** The interview's instructions, appended to the claude_code preset. */
  readonly prompt: string
  /** tutti's in-process MCP server, with tickets_list, ticket_show and file_feature. */
  readonly server: McpSdkServerConfigWithInstance
  /**
   * A spec's breakdown (§ 4.14) on the same footing: its built-in tools in place of the
   * interview's, its own tools (qualified) allowed without asking in place of the interview's,
   * `dontAsk` with nobody there (headless), and its effort.
   */
  readonly breakdown?: {
    readonly builtins: ReadonlyArray<string>
    readonly allowed: ReadonlyArray<string>
    readonly headless: boolean
    readonly effort: (typeof efforts)[number] | null
  }
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

/** A compaction of a worker's context, as its PreCompact hook reports it. */
export interface Compaction {
  readonly ticket: TicketId
  /** What triggered it: `auto`, or `manual` for `/compact`. */
  readonly trigger: string
}

/** The SDK user message that carries `message`, stamped `uuid`, into session `session`. */
export const userMessage = (
  message: Message,
  { uuid, session }: { readonly uuid: MessageUuid; readonly session: string },
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
     * starts again at Starting. Fails when the worker already has an open session; one closing is
     * waited for, until its Claude Code has exited.
     */
    start(ticket: TicketId, session: Session): Effect.Effect<void, AgentStartFailed>
    /**
     * Resumes the session `session.sessionId` (without forking it) and sends it `message`, as
     * `send` does: the message's uuid. Fails when the worker already has an open session; one
     * closing is waited for, until its Claude Code has exited.
     */
    resume(
      ticket: TicketId,
      session: Session,
      message: Message,
    ): Effect.Effect<MessageUuid, AgentStartFailed>
    /**
     * Pushes a message into the worker's inbox: the CLI may fold it into the running turn or queue
     * it, alone or sharing a turn with another (§ 4.1). Its uuid, the message's when given, which
     * the session's results and an interrupt's receipt name it by. Fails when the worker has no
     * open session, or it is closing: the message didn't go.
     */
    send(ticket: TicketId, message: Message): Effect.Effect<MessageUuid, AgentGone>
    /**
     * Interrupts the worker's turn and cancels the messages queued behind it (§ 4.8); open requests
     * are withdrawn. The receipt.
     */
    interrupt(ticket: TicketId): Effect.Effect<Receipt, AgentGone | AgentProtocol>
    /**
     * Closes the worker's session on purpose, keeping its ID for a resume: its state is Closed.
     * A session still starting is cancelled, its start failing; one closing or gone is waited for,
     * until its Claude Code has exited. Nothing happens when it has no session.
     */
    close(ticket: TicketId): Effect.Effect<void>
    /**
     * Closes the worker's session if it is open and forgets the worker: its streams end, and its
     * transcript's memory and open files are let go of. A later start or resume knows it afresh.
     */
    end(ticket: TicketId): Effect.Effect<void>
    /**
     * The run's requires list has the entries `names` from now on, a merge having changed it: the
     * workers started after are told so in their standing rules (requiresNote), and those resumed
     * after in their resume's message (resumedNotes), as a resumed session keeps the system prompt
     * it began with; before, the settings' entries.
     */
    takeRequires(names: ReadonlyArray<string>): Effect.Effect<void>
    /** The worker's state now. */
    current(ticket: TicketId): Effect.Effect<WorkerState, AgentGone>
    /**
     * Whether the worker's current session has begun, its first system/init come (§ 4.8): now, then
     * on each change, until it is ended. A session that has ended after it began still has.
     */
    begun(ticket: TicketId): Stream.Stream<boolean, AgentGone>
    /** The worker's state: now, then on each change, across its sessions, until it is ended. */
    state(ticket: TicketId): Stream.Stream<WorkerState, AgentGone>
    /**
     * Waits until the worker's send `uuid` is no longer outstanding (§ 4.2): a message of its
     * session, or an interrupt, said it was answered or cancelled; or its session ended, or a new
     * one began, a resume or a start, with none of the sends before it outstanding; or the worker
     * was ended, or the host never knew it. A send is outstanding from its push, before it reaches
     * the session, so a wait begun once `send` has returned misses no answer, however soon it came.
     */
    answered(ticket: TicketId, uuid: MessageUuid): Effect.Effect<void>
    /**
     * The tickets of the workers the host knows, from each one's first start until it is ended:
     * now, then on each change.
     */
    readonly workers: Stream.Stream<ReadonlySet<TicketId>>
    /** Every worker's compactions, from now on, as their PreCompact hooks report them (§ 4.2). */
    readonly compactions: Stream.Stream<Compaction>
    /**
     * How full each worker's context window is, by ticket, as its session last said after a model
     * call or a finished turn (§ 7.5): now, then on each change. A worker ended is left out.
     */
    readonly contexts: Stream.Stream<ReadonlyMap<TicketId, ContextUsage>>
    /**
     * The process of each open session's Claude Code, by ticket: the leader of a process group of
     * its own (§ 3.2), for its memory on the dashboard's load line (src/run/load.ts).
     */
    readonly processes: Effect.Effect<ReadonlyMap<TicketId, number>>
  }
>()("tutti/agent/AgentHost") {}

/** A worker the host knows: from its first start until it is ended. */
export interface WorkerEntry {
  readonly ticket: TicketId
  /** The ID of its session now, the last started or resumed: events of any other aren't folded. */
  readonly session: Ref.Ref<string>
  /** The reducer's worker: its state and what it is derived from. */
  readonly worker: SubscriptionRef.SubscriptionRef<Worker>
  /** Its state alone, set only when it changes. */
  readonly state: SubscriptionRef.SubscriptionRef<WorkerState>
  /** Done when the worker is ended: its streams end with it. */
  readonly ended: Deferred.Deferred<void>
  /** The inputs of its last `callsKept` tool calls, its subagents' too, by tool use ID. */
  readonly calls: Map<string, Readonly<Record<string, unknown>>>
}

/** How many pages of a transcript are read back for a resumed session's last result. */
export const spendingPages = 25

/** How many of a worker's last tool calls keep their input, for the denials that name them. */
export const callsKept = 64

/** Keeps the inputs of a message's tool calls, `made`, in `calls`, the oldest going past `callsKept`. */
const keepCalls = (calls: WorkerEntry["calls"], made: ReadonlyArray<Call>): void => {
  for (const [id, input] of made) {
    calls.delete(id)
    calls.set(id, input)
  }
  for (const id of calls.keys()) {
    if (calls.size <= callsKept) break
    calls.delete(id)
  }
}

/** The workers a host knows, and how their state moves; its test layer runs the live host too. */
export interface Workers {
  /**
   * The ticket's worker, made if the host doesn't know it, its state back at Starting for its new
   * session `session`, whose events alone it folds from now on. Its open attention requests are
   * counted into its state from then on. A `resumed` session's totals are seeded into Spending, when
   * there is one, from its last result in the ticket's transcript; a new session has none there.
   */
  readonly open: (
    ticket: TicketId,
    opened: { readonly session: string; readonly resumed: boolean },
  ) => Effect.Effect<WorkerEntry>
  readonly get: (ticket: TicketId) => Effect.Effect<WorkerEntry, AgentGone>
  /**
   * Folds `event` into the worker's state, at the clock's time, unless it is of an earlier session
   * than the worker's now; UsageLimits, when there is one, is told when it becomes UsageLimited or
   * stops being so.
   */
  readonly fold: (entry: WorkerEntry, event: WorkerEvent) => Effect.Effect<void>
  /**
   * A message of the session `session`: recorded in Transcripts, read, and folded in (a partial
   * `stream_event` only while an api_retry holds, the one thing it changes). One it can't read is
   * logged; an assistant message's calls are kept for the denials that name them, a
   * `permission_denied` is recorded through Attention, a `rate_limit_event` is reported to
   * UsageLimits, when there is one (§ 4.12), and a result, read or not, goes to Spending, when
   * there is one, for its `turn` record (§ 10), as does an assistant message, for its usage counted
   * live until then (§ 7.5). What it read, for the host to read no more of it.
   */
  readonly emit: (
    entry: WorkerEntry,
    session: string,
    message: SDKMessage,
  ) => Effect.Effect<Reading>
  /**
   * A message sent into the session `session`, as it is pushed: recorded in Transcripts alone. The
   * session doesn't send it back; the send is folded in as `Sent`.
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
  /** How full the worker's context window is, as its session said after a model call or a turn. */
  readonly measured: (entry: WorkerEntry, usage: ContextUsage) => Effect.Effect<void>
  /** How full each worker's context window is, by ticket: now, then on each change. */
  readonly contexts: Stream.Stream<ReadonlyMap<TicketId, ContextUsage>>
  /** Forgets the worker: its streams end, and its transcript's memory and files are let go of. */
  readonly forget: (ticket: TicketId) => Effect.Effect<void>
  readonly current: (ticket: TicketId) => Effect.Effect<WorkerState, AgentGone>
  readonly begun: (ticket: TicketId) => Stream.Stream<boolean, AgentGone>
  readonly state: (ticket: TicketId) => Stream.Stream<WorkerState, AgentGone>
  readonly answered: (ticket: TicketId, uuid: string) => Effect.Effect<void>
  /** The tickets of the workers it knows: now, then on each change. */
  readonly workers: Stream.Stream<ReadonlySet<TicketId>>
}

/**
 * The workers of a host whose project's check commands are `checks` (they classify as testing).
 * Each worker's attention counter, and its wait for a finished task's report, runs in the scope. A
 * report that doesn't come is written to the Log.
 */
export const makeWorkers = (
  checks: ReadonlyArray<string> = [],
): Effect.Effect<Workers, never, Attention | Transcripts | Log | Scope.Scope> =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const transcripts = yield* Transcripts
    const scope = yield* Effect.scope
    const known = new Map<TicketId, WorkerEntry>()
    // Set as `known` changes, for the streams of the workers it knows.
    const knownTickets = yield* SubscriptionRef.make<ReadonlySet<TicketId>>(new Set())
    // Folds are serialised, so the state set last is the one the last fold gave.
    const one = yield* Semaphore.make(1)
    const compactions = yield* PubSub.unbounded<Compaction>()
    const contexts = yield* SubscriptionRef.make<ReadonlyMap<TicketId, ContextUsage>>(new Map())
    const log = yield* Log
    const usage = yield* Effect.serviceOption(UsageLimits)
    const spending = yield* Effect.serviceOption(Spending)

    const late = (ticket: TicketId) => {
      const text = `a background task ended and no turn came to report it within ${reportWait}; not waiting for it`
      return log.write(detail`${ticket}: ${text}`)
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

    // A message whose fields the worker's state reads didn't read: it was no change (§ 4.2).
    const misread = (
      ticket: TicketId,
      { kind, why }: Data.TaggedEnum.Value<Reading, "Unreadable">,
    ) => {
      const text = `a ${kind} message it couldn't read, left out of its state: ${why}`
      return log.write(detail`${ticket}: ${text}`)
    }

    const openCount = (ticket: TicketId) =>
      Effect.map(attention.current, (all) => all.filter((r) => r.ticket === ticket).length)

    // The worker's open requests, counted in its session now.
    const requests = (entry: WorkerEntry, pending: number) =>
      Effect.flatMap(Ref.get(entry.session), (session) =>
        fold(entry, WorkerEvent.Requests({ session, pending })),
      )

    const make = (ticket: TicketId, session: string) =>
      Effect.gen(function* () {
        const entry: WorkerEntry = {
          ticket,
          session: yield* Ref.make(session),
          worker: yield* SubscriptionRef.make(initial(checks)),
          state: yield* SubscriptionRef.make<WorkerState>(WorkerState.Starting()),
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

    // The session's totals as its last result in the ticket's transcript gave them, for Spending,
    // so the first turn of a session resumed from an earlier run counts only its own share (§ 10).
    const seedSpending = (ticket: TicketId, session: string) =>
      Effect.gen(function* () {
        if (Option.isNone(spending) || (yield* spending.value.knows(session))) return
        let before: number | undefined
        for (let pages = 0; pages < spendingPages; pages++) {
          const items = yield* transcripts.page(ticket, before)
          const last = items.findLast(
            (item) => item.session === session && item.message.type === "result",
          )
          if (last !== undefined) return yield* spending.value.seed(session, last.message)
          const first = items[0]
          if (first === undefined || first.seq <= 1) return
          before = first.seq
        }
      })

    const forgetContext = (ticket: TicketId) =>
      SubscriptionRef.updateSome(contexts, (all) => {
        if (!all.has(ticket)) return Option.none()
        const left = new Map(all)
        left.delete(ticket)
        return Option.some(left)
      })

    const open: Workers["open"] = (ticket, { session, resumed }) =>
      Effect.gen(function* () {
        if (resumed) yield* seedSpending(ticket, session)
        // A new session's context starts empty: the last one's figure is no longer its.
        else yield* forgetContext(ticket)
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

    const get = (ticket: TicketId) =>
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
          yield* transcripts.record(entry.ticket, { session, message })
          const reading = read(message)
          // All a partial message can change of the worker's state is to end an api_retry, so it is
          // folded only while one holds: the rest are cheap to pass on (§ 4.4).
          if (reading._tag === "Partial") {
            if ((yield* SubscriptionRef.get(entry.worker)).retry !== null) {
              yield* fold(entry, WorkerEvent.Message({ session, reading }))
            }
            return reading
          }
          yield* fold(entry, WorkerEvent.Message({ session, reading }))
          switch (reading._tag) {
            case "Unreadable":
              yield* misread(entry.ticket, reading)
              if (reading.windows !== undefined && Option.isSome(usage)) {
                yield* usage.value.report({ info: null, windows: reading.windows })
              }
              // Spending reads a result's figures defensively itself: a turn it ended still cost.
              if (message.type === "result" && Option.isSome(spending)) {
                yield* spending.value.message(entry.ticket, { session, message })
              }
              break
            case "Assistant":
              keepCalls(entry.calls, reading.calls)
              // Its usage, counted live until the turn's result (§ 7.5).
              if (Option.isSome(spending)) {
                yield* spending.value.message(entry.ticket, { session, message })
              }
              break
            case "Denied": {
              const denied = reading.message
              yield* attention.denial(entry.ticket, denied, entry.calls.get(denied.tool_use_id))
              break
            }
            case "RateLimit":
              if (Option.isSome(usage)) yield* usage.value.report(reading)
              break
            case "Result":
              if (Option.isSome(spending)) {
                yield* spending.value.message(entry.ticket, { session, message: reading.message })
              }
              break
          }
          return reading
        }),
      sent: (entry, session, message) => transcripts.record(entry.ticket, { session, message }),
      compacted: (entry, trigger) =>
        Effect.asVoid(PubSub.publish(compactions, { ticket: entry.ticket, trigger })),
      compactions: Stream.fromPubSub(compactions),
      measured: (entry, usage) =>
        Effect.suspend(() =>
          known.get(entry.ticket) === entry
            ? SubscriptionRef.update(contexts, (all) => new Map(all).set(entry.ticket, usage))
            : Effect.void,
        ),
      contexts: SubscriptionRef.changes(contexts),
      forget: (ticket) =>
        Effect.gen(function* () {
          yield* transcripts.release(ticket)
          const found = known.get(ticket)
          if (found === undefined) return
          known.delete(ticket)
          yield* SubscriptionRef.set(knownTickets, new Set(known.keys()))
          yield* forgetContext(ticket)
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
      answered: (ticket, uuid) =>
        Effect.suspend(() => {
          const found = known.get(ticket)
          if (found === undefined) return Effect.void
          return until(
            found,
            SubscriptionRef.changes(found.worker).pipe(
              Stream.takeUntil((w) => w.end !== null || !w.outstanding.includes(uuid)),
            ),
          ).pipe(Stream.runDrain)
        }),
      workers: SubscriptionRef.changes(knownTickets),
    }
  })
