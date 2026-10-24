// AgentHost's live layer (§ 4.1, § 4.2, § 4.4, § 3.2): one Agent SDK query() per open worker
// session, in streaming input mode. A session's inbox is an Effect Queue the SDK reads as its
// prompt, an AsyncIterable<SDKUserMessage>; a message pushed while a turn is under way joins that
// turn or waits in the CLI's own queue (§ 4.1). Every message the session sends is recorded in
// Transcripts and folded into the worker's state (makeWorkers), and every message pushed into its
// inbox is recorded there as it is pushed; its hook callbacks are folded in too, and its stderr
// goes to the transcript's stderr.log (workerOptions).
//
// Each session's first system/init is checked (§ 4.1): the permission mode in effect, logged once
// when it isn't the one asked for; the MCP servers, where any the worker wasn't given ends it as a
// setup problem (§ 4.6); and the API key source, where a key billed beside the subscription login
// ends it likewise (§ 4.13). A worker ended so is Gone with `setup`, which stops the run (work.ts).
// Those fields are decoded with a Schema, not trusted to the SDK's types: a first system/init from
// a CLI of another version without readable MCP servers ends the worker as a setup problem
// (checkInit), since tutti can't tell what it got; one without the permission mode or the API key
// source skips that check, logged once.
//
// system/init comes only as the first turn starts, its model request already sent, so the same
// checks run first in the start, before the session is sent anything (checkBefore): the API key
// source of its initialize's account, and the MCP servers its mcpServerStatus() lists (checkStatus).
// A problem there ends the worker Gone with `setup`, as system/init's check does, and the session is
// sent nothing: the start or resume itself doesn't fail, so the run settles it as a setup problem
// whatever started it. What they can't read is left to system/init's check. Either way a setup problem kills
// Claude Code's process group at once, rather than close it with the SDK's grace, during which a
// turn under way would go on.
//
// A session lives in a scope of its own, inside the layer's: closing it, on purpose (close, end),
// because the session went (Gone), or with the layer's scope, ends the prompt, closes the query
// (the SDK ends Claude Code's stdin, then sends SIGTERM after its grace, docs/spikes/02-sdk-
// lifecycle.md § 2) and waits for the subprocess to exit, killing its process group, and its
// descendants' (killTree), if it hasn't within closeLimit (its SessionProcess's closeAndWait). A
// stream that ends or fails without tutti closing it, or a result with a startup_failure_reason,
// makes the worker Gone, its reason ending with what Claude Code last wrote to stderr.
//
// An interrupt's control requests, the interrupt and the cancel_async_message requests after it,
// have interruptLimit to be answered together; past it the query is aborted and the session closed,
// its worker Gone, so no caller hangs on a Claude Code that doesn't answer them (§ 4.8).
//
// Each ticket's session is one Lifecycle: Starting from the start (its query, the SDK's handle on
// it, made once Claude Code is spawned) until its first system/init is checked, Open from then on,
// and Closing from tutti closing it or its going until its Claude Code has exited. A start or
// resume waits for a Closing session's end, so two Claude Codes never share a session; the start
// itself runs in the session's scope, so closing a Starting session cancels it.
import { randomUUID } from "node:crypto"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import {
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  query,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect"
import { AppConfig, type SetupProblem } from "../cli/AppConfig.ts"
import type { WorkerPrompt } from "../project/prompt.ts"
import { readmeName } from "../project/requires.ts"
import { checkCommands } from "../project/settings.ts"
import { detail, Log, line } from "../run/log.ts"
import { OtherWorkers } from "../run/machine.ts"
import { type AccountProbe, type Billing, permissionModeLine } from "./Account.ts"
import {
  AgentGone,
  AgentHost,
  AgentProtocol,
  AgentStartFailed,
  type Message,
  makeWorkers,
  type Receipt,
  type Session,
  userMessage,
  type WorkerEntry,
  type Workers,
} from "./AgentHost.ts"
import type { Attention } from "./Attention.ts"
import { queryThrew } from "./claudeBinary.ts"
import { coreShare, workerEnv } from "./env.ts"
import { serverName } from "./interviewTools.ts"
import { type ChosenServers, checkInit, checkStatus, inProcess, noServers, withOwn } from "./mcp.ts"
import { interviewOptions, type SessionStart, workerCallbacks, workerOptions } from "./options.ts"
import { requiresServerName } from "./requiresTools.ts"
import {
  type SessionProcess,
  stderrQuoted,
  withSessionProcess,
  withStderr,
} from "./sessionProcess.ts"
import type { Transcripts } from "./Transcripts.ts"
import { projectHasSkills } from "./unusedTools.ts"
import { WorkerEvent } from "./WorkerState.ts"

/** How long a session has to start: Claude Code spawned and its initialize answered. */
export const startLimit: Duration.Duration = Duration.minutes(1)

/**
 * How long a closed session's Claude Code has to exit before tutti kills its process group: the
 * SDK's grace (2 s) and its SIGKILL after SIGTERM (5 s more), with time to spare.
 */
export const closeLimit: Duration.Duration = Duration.seconds(10)

/**
 * How long an interrupt's control requests, the interrupt and each `cancel_async_message`, have to
 * be answered together: the SDK gives them no timer, so a Claude Code alive but not answering would
 * hold the caller forever. Past it the session is aborted and its worker gone.
 */
export const interruptLimit: Duration.Duration = Duration.seconds(10)

/** Why a worker is gone when its Claude Code didn't answer an interrupt within `limit`. */
export const unansweredWhy = (limit: Duration.Duration): string =>
  `it didn't answer an interrupt within ${Duration.format(limit)}`

/** The capability system/init advertises when an interrupt can cancel the queued messages. */
export const cancelQueuedCapability = "interrupt_cancel_queued_v1"

/**
 * The Query's control requests its runtime has and its types lack (SDK 0.3.301, § 4.8):
 * `interrupt({ cancelQueued })`, and `cancelAsyncMessage(uuid)`, the `cancel_async_message` control
 * request, which answers whether it dropped the message from the queue.
 */
export interface QueuedControls {
  interrupt(options?: {
    readonly cancelQueued?: boolean
  }): Promise<SDKControlInterruptResponse | undefined>
  cancelAsyncMessage(uuid: string): Promise<boolean>
}

/** `query`'s controls, through the local type. */
export const queuedControls = (query: Query): QueuedControls => query as unknown as QueuedControls

/** The API key source system/init gives a session billed to the subscription login. */
const noKey = "none"

// The fields checkFirst reads of a session's first system/init beside its MCP servers (checkInit),
// each decoded on its own, so that one missing skips only its own check.
const decodePermissionMode = Schema.decodeUnknownResult(
  Schema.Struct({ permissionMode: Schema.String }),
)
const decodeApiKeySource = Schema.decodeUnknownResult(
  Schema.Struct({ apiKeySource: Schema.String }),
)
// The API key source of a session's initialize answer, which checkBefore reads.
const decodeAccountKey = Schema.decodeUnknownResult(
  Schema.Struct({ account: Schema.Struct({ apiKeySource: Schema.String }) }),
)

/** How long a session's mcpServerStatus() has to be answered before its start goes on unchecked. */
export const statusLimit: Duration.Duration = Duration.seconds(10)

/** The problems a check of the MCP servers failed with, as one. */
const problemsIn = (cause: Cause.Cause<SetupProblem>): string =>
  cause.reasons
    .flatMap((reason) => (reason._tag === "Fail" ? reason.error.problems : []))
    .join("; ")

/** The log line when the first system/init lacks `field`, so tutti doesn't check `what`. */
export const uncheckedLine = (field: string, what: string): string =>
  `system/init gives no ${field} tutti can read, so it doesn't check ${what}`

/** The problem when a worker would bill an API key while billing is the subscription login. */
export const apiKeyProblem = (source: string): string =>
  `workers would bill an API key (${source}), not the subscription login: Claude Code finds it in its own settings or login; remove it there, or run with --billing api`

/** Why a worker is gone when its stream ended without tutti closing it. */
export const endedWhy = "its session ended"

/** What the live layer takes beside its services: the run's worker setup. */
export interface LiveOptions {
  /** The run's worker prompt, TICKET_ID still in it. */
  readonly prompt: WorkerPrompt
  /** The MCP servers workers get. */
  readonly servers: ChosenServers
  /**
   * tutti's own in-process MCP server for a worker in the worktree given, with its requires tools
   * (requiresServerFor, § 4.11), each session's its own, beside `servers`; none when left out.
   */
  readonly ownServer?: (worktree: string) => Effect.Effect<McpSdkServerConfigWithInstance>
  /** What the account probe found: how workers are billed, and whether there's a subscription login. */
  readonly account: Pick<AccountProbe, "billing" | "subscription">
  /** tutti's environment, workers' is made from; process.env by default. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * The machine's cores, divided among the run's workers and the other runs' (coreShare,
   * OtherWorkers) as each session starts; availableParallelism().
   */
  readonly cores?: number
  /** How long an interrupt's control requests have to be answered; interruptLimit. */
  readonly interruptLimit?: Duration.Duration
  /** The Agent SDK's query(), which a test stands in for. */
  readonly query?: typeof query
}

// A session whose query tutti has made: its handle, from Claude Code's spawn until it has exited.
interface Live {
  readonly ticket: string
  readonly sessionId: string
  /** The MCP servers it was given: the workers', none for the probe, tutti's for the interview. */
  readonly servers: ChosenServers
  readonly entry: WorkerEntry
  readonly inbox: Queue.Queue<SDKUserMessage, Cause.Done>
  readonly query: Query
  readonly abort: AbortController
  /** Its lifecycle's scope: closing it closes the session. */
  readonly scope: Scope.Closeable
  /** Claude Code's process, spawned by the SDK as query() is called. */
  readonly process: SessionProcess
  /** The CLI's capabilities, from its initialize answer and each system/init. */
  readonly capabilities: Set<string>
  /** The startup_failure_reason of a result it sent. */
  readonly startupFailure: Deferred.Deferred<string>
}

/**
 * A ticket's session (§ 4.8), from its start or resume until its Claude Code has exited, in a scope
 * of its own. Starting until its first system/init has been checked, `session` its query once it is
 * made; Open from then on; Closing once tutti closes it (`closed`) or it goes, until `done`, when its
 * Claude Code has exited and the ticket has no session. A start or resume waits for a Closing
 * session's end; closing a Starting session cancels its start.
 */
type Lifecycle = Data.TaggedEnum<{
  Starting: {
    readonly sessionId: string
    readonly scope: Scope.Closeable
    readonly session: Live | undefined
  }
  Open: { readonly session: Live }
  Closing: {
    readonly sessionId: string
    readonly closed: boolean
    readonly done: Deferred.Deferred<void>
  }
}>

const Lifecycle = Data.taggedEnum<Lifecycle>()

/** The scope of a session not yet Closing. */
const scopeOf = (lifecycle: Lifecycle): Scope.Closeable | undefined =>
  lifecycle._tag === "Starting"
    ? lifecycle.scope
    : lifecycle._tag === "Open"
      ? lifecycle.session.scope
      : undefined

/** The query of a session Starting with one, or Open. */
const liveOf = (lifecycle: Lifecycle | undefined): Live | undefined =>
  lifecycle === undefined || lifecycle._tag === "Closing" ? undefined : lifecycle.session

/** Why a start fails when tutti closed or ended the session before it had started. */
export const closedWhy = "it was closed while it started"

/** Why a send fails when the session was closing as the message was pushed: it never went. */
export const closingWhy = "its session was closing, so the message never went"

/**
 * Pushes a message into the session's inbox; its uuid. An inbox already ended, the session closing,
 * takes nothing: the send is withdrawn, nothing recorded, and the worker gone.
 */
export const push = (
  workers: Workers,
  session: Pick<Live, "ticket" | "sessionId" | "entry" | "inbox">,
  message: Message,
): Effect.Effect<string, AgentGone> =>
  Effect.gen(function* () {
    const uuid = message.uuid ?? randomUUID()
    // Outstanding before the CLI can see it, so its turn's result can't come first.
    yield* workers.fold(session.entry, WorkerEvent.Sent({ session: session.sessionId, uuid }))
    const sdk = userMessage(message, uuid, session.sessionId)
    if (!(yield* Queue.offer(session.inbox, sdk))) {
      yield* workers.fold(
        session.entry,
        WorkerEvent.Cancelled({ session: session.sessionId, uuids: [uuid] }),
      )
      return yield* new AgentGone({ ticket: session.ticket, why: closingWhy })
    }
    yield* workers.sent(session.entry, session.sessionId, sdk)
    return uuid
  })

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** The capabilities listed in `value`'s `capabilities`, when it has them. */
const capabilitiesOf = (value: unknown): ReadonlyArray<string> => {
  const listed = (value as { capabilities?: unknown } | undefined)?.capabilities
  return Array.isArray(listed) ? listed.filter((c) => typeof c === "string") : []
}

/** What a failure says: its first error's message, or the cause's. */
const causeMessage = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") return messageOf(reason.error)
    if (reason._tag === "Die") return messageOf(reason.defect)
  }
  return Cause.pretty(cause)
}

/** Why a worker is gone when its start failed: an AgentStartFailed's reason, or the cause's. */
const startWhy = (cause: Cause.Cause<unknown>): string => {
  const failed = cause.reasons.find((reason) => reason._tag === "Fail")?.error
  return failed instanceof AgentStartFailed ? failed.reason : causeMessage(cause)
}

/** Why a worker is gone, and its start failed, when Claude Code couldn't be spawned (§ 4.8). */
const launchFailed = "Claude Code couldn't be launched"

// The SDK reports any spawn that fails as a libc mismatch (docs/spikes/02-sdk-lifecycle.md § 3).
/** Whether `message`, from the SDK, is a spawn that failed. */
const isLaunchFailure = (message: string): boolean => message.includes("failed to launch")

/**
 * The reason a session didn't start, from its startup_failure_reason, if it sent one, and what
 * failed its initialize.
 */
const startFailure = (refused: string | undefined, message: string, stderr: string): string => {
  if (refused !== undefined) return `Claude Code refused to start: ${refused}`
  return withStderr(isLaunchFailure(message) ? launchFailed : message, stderr)
}

/** Why a worker is gone when its stream failed without tutti closing it. */
const failedWhy = (message: string, stderr: string): string =>
  withStderr(isLaunchFailure(message) ? launchFailed : `${endedWhy}: ${message}`, stderr)

/**
 * The live AgentHost, over the Agent SDK, its workers' sessions set up by `options` and AppConfig.
 */
export const layer = (
  options: LiveOptions,
): Layer.Layer<
  AgentHost,
  never,
  AppConfig | Attention | Transcripts | Log | FileSystem.FileSystem
> =>
  Layer.effect(
    AgentHost,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const log = yield* Log
      const fs = yield* FileSystem.FileSystem
      const workers = yield* makeWorkers(checkCommands(config.settings))
      const scope = yield* Effect.scope
      const services = yield* Effect.context<Attention | Transcripts>()
      const otherWorkers = yield* OtherWorkers
      const cores = options.cores ?? availableParallelism()
      const openQuery = options.query ?? query
      // A session's environment, its share of the cores taken as it starts, from the other runs'
      // workers the run last read: one started as another run begins keeps more than its share.
      const envNow = Effect.map(otherWorkers.others, (others) =>
        workerEnv({
          subscription: options.account.subscription,
          billing: config.billing,
          checkTimeout: config.settings.checks.fast.timeout,
          cores: coreShare(cores, config.settings.concurrent, others, config.machineWorkers),
          ...(options.env === undefined ? {} : { env: options.env }),
        }),
      )
      const requestedMode = config.settings.workers.permission_mode
      // Whether workers keep Skill (§ 4.1), decided once, from the main checkout, as the run begins.
      const skills = yield* projectHasSkills(config.repo)
      // Whether workers that change the requires list write the README's section again (§ 4.11).
      const readme = yield* fs
        .exists(join(config.repo, readmeName))
        .pipe(Effect.orElseSucceed(() => false))
      // The names of the run's requires list, as the workers starting now are told it (requiresNote).
      const requires = yield* Ref.make<ReadonlyArray<string>>(
        config.settings.requires.map((r) => r.name),
      )
      // Whether a session's permission mode in effect, not the one asked for, has been logged.
      const modeSaid = yield* Ref.make(false)
      // The fields of the first system/init whose check was skipped, logged once each (unchecked).
      const uncheckedFields = yield* Ref.make<ReadonlySet<string>>(new Set())
      const sessions = new Map<string, Lifecycle>()
      const interruptWithin = options.interruptLimit ?? interruptLimit

      /**
       * Moves the ticket's session, if `of` is still its scope, to Closing: closed on purpose when
       * `why` is undefined, else gone for `why` (over a setup problem when `setup`), as its worker's
       * state says from now on. The effect that then closes it, its scope and with it Claude Code,
       * and ends it: undefined when the ticket's session is another or is Closing already.
       */
      const closing = (
        ticket: string,
        of: Scope.Closeable,
        why: string | undefined,
        setup = false,
      ) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>()
          const moved = yield* Effect.sync(() => {
            const current = sessions.get(ticket)
            if (current === undefined || scopeOf(current) !== of) return undefined
            const sessionId =
              current._tag === "Open" ? current.session.sessionId : current.sessionId
            const next = Lifecycle.Closing({ sessionId, closed: why === undefined, done })
            sessions.set(ticket, next)
            return next
          })
          if (moved === undefined) return undefined
          const entry = yield* Effect.option(workers.get(ticket))
          if (Option.isSome(entry)) {
            const session = moved.sessionId
            yield* workers.fold(
              entry.value,
              why === undefined
                ? WorkerEvent.Closed({ session })
                : WorkerEvent.Ended({ session, why, ...(setup ? { setup: true as const } : {}) }),
            )
          }
          // The ticket has no session before a start waiting for this one's end goes on.
          const ended = Effect.andThen(
            Effect.sync(() => {
              if (sessions.get(ticket) === moved) sessions.delete(ticket)
            }),
            Deferred.succeed(done, undefined),
          )
          return Effect.uninterruptible(Effect.ensuring(Scope.close(of, Exit.void), ended))
        })

      /**
       * The session's end, without tutti closing it on purpose: the worker is Gone and the
       * session closes, in a fiber of its own, since the caller may be its reader. `setup` when it
       * ended over a setup problem.
       */
      const gone = (session: Live, why: string, setup = false) =>
        Effect.gen(function* () {
          const close = yield* closing(session.ticket, session.scope, why, setup)
          if (close !== undefined) yield* Effect.forkIn(close, scope)
        })

      /**
       * Ends the worker over a setup problem, before it does anything: Gone with `setup`, its process
       * group killed at once, not given the SDK's grace.
       */
      const setupProblem = (session: Live, problem: string) =>
        Effect.gen(function* () {
          yield* log.write(detail`${session.ticket}: ${problem}`)
          yield* session.process.kill
          session.abort.abort()
          yield* gone(session, problem, true)
        })

      /** Logs, once in the run, that the first system/init lacks `field`, so `what` isn't checked. */
      const unchecked = (field: string, what: string) =>
        Effect.gen(function* () {
          const first = yield* Ref.modify(uncheckedFields, (fields) =>
            fields.has(field) ? [false, fields] : [true, new Set([...fields, field])],
          )
          if (first) yield* log.write(line`${uncheckedLine(field, what)}`)
        })

      /** Checks the session's first system/init (§ 4.1): the setup problem it shows, if any. */
      const checkFirst = (session: Live, init: SDKSystemMessage) =>
        Effect.gen(function* () {
          const mode = decodePermissionMode(init)
          if (Result.isFailure(mode)) {
            yield* unchecked("permissionMode", `the permission mode in effect is ${requestedMode}`)
          } else if (mode.success.permissionMode !== requestedMode) {
            const inEffect = mode.success.permissionMode
            if (!(yield* Ref.getAndSet(modeSaid, true))) {
              yield* log.write(line`${permissionModeLine({ requested: requestedMode, inEffect })}`)
            }
          }
          const mcp = yield* Effect.exit(checkInit(init, session.servers))
          if (Exit.isFailure(mcp)) return problemsIn(mcp.cause)
          if (options.account.billing._tag !== "Subscription") return undefined
          const key = decodeApiKeySource(init)
          if (Result.isFailure(key)) {
            yield* unchecked(
              "apiKeySource",
              "that workers bill the subscription login, not an API key",
            )
            return undefined
          }
          if (billedKey(options.account.billing, key.success.apiKeySource)) {
            return apiKeyProblem(key.success.apiKeySource)
          }
          return undefined
        })

      /**
       * Checks a session before it is sent anything, from its initialize answer, `initialized`, and
       * its mcpServerStatus(): the setup problem they show, if any. What either doesn't say, or says
       * in a shape tutti can't read, is left to the first system/init's check (checkFirst).
       */
      const checkBefore = (session: Live, initialized: unknown) =>
        Effect.gen(function* () {
          const status = yield* Effect.tryPromise(() => session.query.mcpServerStatus()).pipe(
            Effect.timeout(statusLimit),
            Effect.option,
          )
          if (Option.isSome(status)) {
            const mcp = yield* Effect.exit(checkStatus(status.value, session.servers))
            if (Exit.isFailure(mcp)) return problemsIn(mcp.cause)
          }
          const key = decodeAccountKey(initialized)
          if (Result.isSuccess(key)) {
            const source = key.success.account.apiKeySource
            if (billedKey(options.account.billing, source)) return apiKeyProblem(source)
          }
          return undefined
        })

      /** Whether `session` is still its ticket's, Starting. */
      const starting = (session: Live) => {
        const current = sessions.get(session.ticket)
        return current?._tag === "Starting" && current.session === session
      }

      /** Its first system/init checked, a Starting session is Open, or ends over a setup problem. */
      const born = (session: Live, init: SDKSystemMessage) =>
        Effect.gen(function* () {
          const problem = yield* checkFirst(session, init)
          if (problem !== undefined) return yield* setupProblem(session, problem)
          yield* Effect.sync(() => {
            if (starting(session)) sessions.set(session.ticket, Lifecycle.Open({ session }))
          })
        })

      const onMessage = (session: Live, message: SDKMessage) =>
        Effect.gen(function* () {
          yield* workers.emit(session.entry, session.sessionId, message)
          if (message.type === "system" && message.subtype === "init") {
            for (const capability of capabilitiesOf(message)) session.capabilities.add(capability)
            if (starting(session)) yield* born(session, message)
          } else if (
            message.type === "result" &&
            message.subtype !== "success" &&
            message.startup_failure_reason !== undefined
          ) {
            yield* Deferred.succeed(session.startupFailure, message.startup_failure_reason)
            yield* gone(session, message.startup_failure_reason)
          }
        })

      /**
       * A message `onMessage` died on, a CLI of another version sending a shape tutti didn't
       * expect: written to the log and skipped, so the session reads on.
       */
      const skipped = (session: Live, defect: unknown) =>
        log.write(
          detail`${session.ticket}: a message tutti couldn't take in, skipped: ${messageOf(defect)}`,
        )

      /**
       * Reads the session's stream to its end, a message that dies skipped; an end tutti didn't ask
       * for makes the worker Gone.
       */
      const read = (session: Live) =>
        Stream.fromAsyncIterable(session.query, (cause) => cause).pipe(
          Stream.runForEach((message) =>
            onMessage(session, message).pipe(
              Effect.catchDefect((defect) => skipped(session, defect)),
            ),
          ),
          Effect.exit,
          Effect.flatMap((exit) =>
            gone(
              session,
              Exit.isSuccess(exit)
                ? withStderr(endedWhy, session.process.stderrTail(stderrQuoted))
                : failedWhy(causeMessage(exit.cause), session.process.stderrTail(stderrQuoted)),
            ),
          ),
        )

      /** Closes the session: the prompt ends, the query closes, and Claude Code exits. */
      const shut = (session: Live) =>
        Effect.gen(function* () {
          yield* Queue.end(session.inbox)
          yield* session.process.closeAndWait(() => session.query.close(), closeLimit)
        })

      /**
       * The ticket's session `sessionId`, Starting in a scope of its own, once the ticket has no
       * other: a Closing one's end is waited for, and one Starting or Open fails it.
       */
      const reserve = (
        ticket: string,
        sessionId: string,
      ): Effect.Effect<Scope.Closeable, AgentStartFailed> =>
        Effect.suspend(() => {
          const current = sessions.get(ticket)
          if (current?._tag === "Closing") {
            return Effect.andThen(Deferred.await(current.done), reserve(ticket, sessionId))
          }
          if (current !== undefined) {
            return Effect.fail(
              new AgentStartFailed({ ticket, reason: "a session is already open" }),
            )
          }
          const of = Scope.forkUnsafe(scope)
          sessions.set(ticket, Lifecycle.Starting({ sessionId, scope: of, session: undefined }))
          return Effect.succeed(of)
        })

      /**
       * Closes the ticket's session, if `of` is still its scope, on purpose (`why` undefined) or
       * gone for `why`, and waits for its end.
       */
      const closeIn = (ticket: string, of: Scope.Closeable, why: string | undefined) =>
        Effect.flatMap(closing(ticket, of, why), (close) => close ?? Effect.void)

      /**
       * Starts (or resumes) the ticket's session; it is open once Claude Code has answered. The
       * start runs in the session's scope, so closing the session while it starts cancels it. A
       * setup problem found as it starts (checkBefore) doesn't fail it: its worker is Gone with
       * `setup`, as one its first system/init shows makes it, and `problem` says what it was; the
       * caller sends it nothing.
       */
      const begin = (ticket: string, session: Session, how: SessionStart) =>
        Effect.gen(function* () {
          const of = yield* reserve(ticket, session.sessionId)
          const started = yield* Effect.forkIn(make(ticket, session, how, of), of)
          const exit = yield* Fiber.await(started).pipe(
            Effect.onInterrupt(() => closeIn(ticket, of, undefined)),
          )
          if (Exit.isSuccess(exit)) {
            // Here, not in the start, which runs in the session's scope that this closes.
            const { opened, problem } = exit.value
            if (problem !== undefined) yield* setupProblem(opened, problem)
            return exit.value
          }
          const cancelled = Cause.hasInterruptsOnly(exit.cause)
          yield* closeIn(ticket, of, cancelled ? closedWhy : startWhy(exit.cause))
          if (cancelled) return yield* new AgentStartFailed({ ticket, reason: closedWhy })
          return yield* Effect.failCause(exit.cause)
        })

      const make = (ticket: string, session: Session, how: SessionStart, of: Scope.Closeable) =>
        Effect.gen(function* () {
          const there = yield* fs.exists(session.cwd).pipe(Effect.orElseSucceed(() => false))
          if (!there) {
            return yield* new AgentStartFailed({
              ticket,
              reason: `its folder isn't there: ${session.cwd}`,
            })
          }
          const sessionId = session.sessionId
          const entry = yield* workers.open(ticket, sessionId, how._tag === "Resume")
          const callbacks = yield* Effect.provideContext(
            workerCallbacks(ticket, {
              activity: (input) =>
                workers.fold(entry, WorkerEvent.Hook({ session: sessionId, input })),
              // Counted and logged by the run; triage reads it from the transcript's compact_boundary.
              compaction: (input) => workers.compacted(entry, input.trigger),
            }),
            services,
          )
          const inbox = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
          const abort = new AbortController()
          const env = yield* envNow
          const setup = session.interview
          const servers =
            setup !== undefined
              ? inProcess(serverName, setup.server, options.servers.chrome === true)
              : session.probe === true
                ? noServers
                : options.ownServer === undefined
                  ? options.servers
                  : withOwn(
                      options.servers,
                      requiresServerName,
                      yield* options.ownServer(session.cwd),
                    )
          const asked: Options =
            setup !== undefined
              ? interviewOptions({
                  config,
                  setup,
                  chrome: options.servers.chrome === true,
                  callbacks,
                  session: how,
                  env,
                  abortController: abort,
                })
              : workerOptions({
                  config,
                  ticket,
                  worktree: session.cwd,
                  prompt: session.probe === true ? null : options.prompt,
                  servers,
                  skills,
                  readme,
                  requires: yield* Ref.get(requires),
                  callbacks,
                  session: how,
                  env,
                  abortController: abort,
                })
          const { options: sdkOptions, process: claude } = withSessionProcess(asked)
          const startupFailure = yield* Deferred.make<string>()
          // Claude Code, spawned, is closed with the session's scope, though the start is cancelled.
          const opened = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              // The SDK's query() throws as it is called when it finds no Claude Code to run.
              const handle = yield* Effect.try({
                try: () =>
                  openQuery({
                    prompt: Stream.toAsyncIterableWith(Stream.fromQueue(inbox), Context.empty()),
                    options: sdkOptions,
                  }),
                catch: (cause) => new AgentStartFailed({ ticket, reason: queryThrew(cause) }),
              })
              const opened: Live = {
                ticket,
                sessionId,
                servers,
                entry,
                inbox,
                query: handle,
                abort,
                scope: of,
                process: claude,
                capabilities: new Set(),
                startupFailure,
              }
              yield* Scope.addFinalizer(of, shut(opened))
              yield* Effect.sync(() => {
                const current = sessions.get(ticket)
                if (current?._tag === "Starting" && current.scope === of) {
                  sessions.set(
                    ticket,
                    Lifecycle.Starting({ sessionId, scope: of, session: opened }),
                  )
                }
              })
              return opened
            }),
          )
          const reader = yield* read(opened).pipe(Effect.forkIn(of))

          const initialized = yield* Effect.tryPromise({
            try: () => opened.query.initializationResult(),
            catch: (cause): unknown => cause,
          }).pipe(
            Effect.timeoutOrElse({
              duration: startLimit,
              orElse: () => Effect.fail(`no answer within ${Duration.format(startLimit)}`),
            }),
            Effect.exit,
          )
          if (Exit.isSuccess(initialized)) {
            for (const capability of capabilitiesOf(initialized.value)) {
              opened.capabilities.add(capability)
            }
            return { opened, problem: yield* checkBefore(opened, initialized.value) }
          }
          // A startup failure's result comes just before the stream ends: the reader sees it.
          yield* Fiber.await(reader).pipe(Effect.timeout(closeLimit), Effect.ignore)
          // Closed on purpose while it started: the initialize failed for that.
          const now = sessions.get(ticket)
          if (now?._tag === "Closing" && now.closed) {
            return yield* new AgentStartFailed({ ticket, reason: closedWhy })
          }
          const refused = (yield* Deferred.isDone(startupFailure))
            ? yield* Deferred.await(startupFailure)
            : undefined
          const reason = startFailure(
            refused,
            causeMessage(initialized.cause),
            claude.stderrTail(stderrQuoted),
          )
          yield* gone(opened, reason)
          return yield* new AgentStartFailed({
            ticket,
            reason,
            ...(refused === undefined ? {} : { startupFailureReason: refused }),
          })
        })

      const sessionOf = (ticket: string) =>
        Effect.suspend(() => {
          const found = liveOf(sessions.get(ticket))
          return found === undefined
            ? Effect.fail(new AgentGone({ ticket, why: "it has no open session" }))
            : Effect.succeed(found)
        })

      /** Closes the ticket's session on purpose, cancelling its start, or waits for its end. */
      const close = (ticket: string): Effect.Effect<void> =>
        Effect.suspend(() => {
          const current = sessions.get(ticket)
          if (current === undefined) return Effect.void
          if (current._tag === "Closing") return Deferred.await(current.done)
          const of = current._tag === "Starting" ? current.scope : current.session.scope
          return Effect.flatMap(closing(ticket, of, undefined), (closed) => {
            if (closed !== undefined) return closed
            // It went meanwhile.
            const now = sessions.get(ticket)
            return now?._tag === "Closing" ? Deferred.await(now.done) : Effect.void
          })
        })

      /** Interrupts the session's turn and cancels the messages queued behind it: its receipt. */
      const interruptIn = (session: Live) =>
        Effect.gen(function* () {
          const ticket = session.ticket
          const cancelQueued = session.capabilities.has(cancelQueuedCapability)
          const controls = queuedControls(session.query)
          const response = yield* Effect.tryPromise({
            try: () => controls.interrupt({ cancelQueued }),
            catch: (cause) =>
              liveOf(sessions.get(ticket)) === session
                ? new AgentProtocol({ ticket, detail: `interrupt failed: ${messageOf(cause)}` })
                : new AgentGone({ ticket, why: "its session ended during the interrupt" }),
          })
          const stillQueued = response?.still_queued ?? []
          // Without cancelQueued, each message still queued is cancelled at once, before the
          // interrupted turn's result starts the next turn; one that runs all the same, refused
          // or already taken (cancelled: false), is accepted.
          const withdrawn = cancelQueued
            ? []
            : yield* Effect.forEach(
                stillQueued,
                (uuid) =>
                  Effect.tryPromise(() => controls.cancelAsyncMessage(uuid)).pipe(
                    Effect.orElseSucceed(() => false),
                    Effect.map((cancelled) => (cancelled === true ? [uuid] : [])),
                  ),
                { concurrency: "unbounded" },
              ).pipe(Effect.map((each) => each.flat()))
          const receipt: Receipt = {
            stillQueued: stillQueued.filter((uuid) => !withdrawn.includes(uuid)),
            cancelled: [...(response?.cancelled ?? []), ...withdrawn],
          }
          yield* workers.fold(
            session.entry,
            WorkerEvent.Cancelled({ session: session.sessionId, uuids: receipt.cancelled }),
          )
          return receipt
        })

      /**
       * The end of an interrupt whose control requests weren't answered within its time limit: the
       * session is aborted and closed, its worker gone.
       */
      const unanswered = (session: Live) =>
        Effect.gen(function* () {
          const why = unansweredWhy(interruptWithin)
          yield* log.write(detail`${session.ticket}: ${why}`)
          yield* gone(session, why)
          session.abort.abort()
          return yield* new AgentGone({ ticket: session.ticket, why })
        })

      return AgentHost.of({
        start: (ticket, session) =>
          Effect.asVoid(begin(ticket, session, { _tag: "New", sessionId: session.sessionId })),
        // A session stopped over a setup problem as it resumed is sent nothing: the message's uuid
        // all the same, its worker Gone with `setup` for the caller to settle.
        resume: (ticket, session, message) =>
          Effect.flatMap(
            begin(ticket, session, { _tag: "Resume", sessionId: session.sessionId }),
            ({ opened, problem }) =>
              problem === undefined
                ? push(workers, opened, message).pipe(
                    Effect.catchTag(
                      "AgentGone",
                      () => new AgentStartFailed({ ticket, reason: closedWhy }),
                    ),
                  )
                : Effect.succeed(message.uuid ?? randomUUID()),
          ),
        send: (ticket, text, from, uuid) =>
          Effect.flatMap(sessionOf(ticket), (session) =>
            push(workers, session, { text, from, ...(uuid === undefined ? {} : { uuid }) }),
          ),
        interrupt: (ticket) =>
          Effect.flatMap(sessionOf(ticket), (session) =>
            interruptIn(session).pipe(
              Effect.timeoutOrElse({
                duration: interruptWithin,
                orElse: () => unanswered(session),
              }),
            ),
          ),
        close,
        end: (ticket) => Effect.andThen(close(ticket), workers.forget(ticket)),
        takeRequires: (names) => Ref.set(requires, names),
        current: workers.current,
        begun: workers.begun,
        state: workers.state,
        messages: workers.messages,
        subscribe: workers.subscribe,
        workers: workers.workers,
        compactions: workers.compactions,
        processes: Effect.sync(() => {
          const pids = new Map<string, number>()
          for (const [ticket, lifecycle] of sessions) {
            const child = liveOf(lifecycle)?.process.child()
            if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null)
              pids.set(ticket, child.pid)
          }
          return pids
        }),
      })
    }),
  )

/** Whether a session with `source` as its API key source bills a key though `billing` says not. */
export const billedKey = (billing: Billing, source: string | undefined): boolean =>
  billing._tag === "Subscription" && source !== undefined && source !== noKey
