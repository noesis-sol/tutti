// AgentHost's live layer (§ 4.1, § 4.2, § 4.4, § 3.2): one Agent SDK query() per open worker
// session, in streaming input mode. A session's inbox is an Effect Queue the SDK reads as its
// prompt, an AsyncIterable<SDKUserMessage>; a message pushed while a turn is under way joins that
// turn or waits in the CLI's own queue (§ 4.1). Every message the session sends is recorded in
// Transcripts and folded into the worker's state (makeWorkers), and every message pushed into its
// inbox is recorded there as it is pushed; its hook callbacks are folded in too, and its stderr
// goes to the transcript's stderr.log (workerOptions).
//
// Each session's first system/init is checked (§ 4.1): the permission mode in effect, logged once
// and kept for the START block when it isn't the one asked for; the MCP servers, where any the
// worker wasn't given ends it as a setup problem (§ 4.6); and the API key source, where a key
// billed beside the subscription login ends it likewise (§ 4.13).
//
// A session lives in a scope of its own, inside the layer's: closing it, on purpose (close, end),
// because the session went (Gone), or with the layer's scope, ends the prompt, closes the query
// (the SDK ends Claude Code's stdin, then sends SIGTERM after its grace, docs/spikes/02-sdk-
// lifecycle.md § 2) and waits for the subprocess to exit, killing its process group if it hasn't
// within closeLimit. A stream that ends or fails without tutti closing it, or a result with a
// startup_failure_reason, makes the worker Gone.
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
  type Options,
  type Query,
  query,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SpawnedProcess,
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
  Scope,
  Stream,
} from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
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
  noFindings,
  type Receipt,
  type Session,
  type SetupFindings,
  userMessage,
  type WorkerEntry,
} from "./AgentHost.ts"
import type { Attention } from "./Attention.ts"
import { coreShare, workerEnv } from "./env.ts"
import { serverName } from "./interviewTools.ts"
import { type ChosenServers, checkInit, inProcess, noServers } from "./mcp.ts"
import { interviewOptions, type SessionStart, workerCallbacks, workerOptions } from "./options.ts"
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
  /** What the account probe found: how workers are billed, and whether there's a subscription login. */
  readonly account: Pick<AccountProbe, "billing" | "subscription">
  /** tutti's environment, workers' is made from; process.env by default. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * The machine's cores, divided among the run's workers and the other runs' (coreShare,
   * OtherWorkers) as each session starts; availableParallelism().
   */
  readonly cores?: number
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
  /** Claude Code, once the SDK has spawned it: query() does at once. */
  readonly spawned: { child: SpawnedProcess | undefined }
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

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** The capabilities listed in `value`'s `capabilities`, when it has them. */
const capabilitiesOf = (value: unknown): ReadonlyArray<string> => {
  const listed = (value as { capabilities?: unknown } | undefined)?.capabilities
  return Array.isArray(listed) ? listed.filter((c) => typeof c === "string") : []
}

/**
 * Whether `child` has exited, or never started: a spawn that failed has no PID, and its process,
 * which never ran, never exits.
 */
const exited = (child: SpawnedProcess): boolean =>
  (child as { pid?: unknown }).pid === undefined ||
  child.exitCode !== null ||
  (child.signalCode ?? null) !== null

/** Kills `child`'s process group (it leads one, § 3.2); never a missing or bad PID. */
const killGroup = (child: SpawnedProcess) =>
  Effect.sync(() => {
    const pid = (child as { pid?: unknown }).pid
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  })

/** Waits until `child` exits. */
const exitOf = (child: SpawnedProcess) =>
  Effect.callback<void>((resume) => {
    if (exited(child)) return resume(Effect.void)
    const done = () => resume(Effect.void)
    child.once("exit", done)
    return Effect.sync(() => child.off("exit", done))
  })

/** What a failure says: its first error's message, or the cause's. */
const causeMessage = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") return messageOf(reason.error)
    if (reason._tag === "Die") return messageOf(reason.defect)
  }
  return Cause.pretty(cause)
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
const startFailure = (refused: string | undefined, message: string): string => {
  if (refused !== undefined) return `Claude Code refused to start: ${refused}`
  return isLaunchFailure(message) ? launchFailed : message
}

/** Why a worker is gone when its stream failed without tutti closing it. */
const failedWhy = (message: string): string =>
  isLaunchFailure(message) ? launchFailed : `${endedWhy}: ${message}`

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
      const findings = yield* Ref.make<SetupFindings>(noFindings)
      const sessions = new Map<string, Lifecycle>()

      /**
       * Moves the ticket's session, if `of` is still its scope, to Closing: closed on purpose when
       * `why` is undefined, else gone for `why`, as its worker's state says from now on. The effect
       * that then closes it, its scope and with it Claude Code, and ends it: undefined when the
       * ticket's session is another or is Closing already.
       */
      const closing = (ticket: string, of: Scope.Closeable, why: string | undefined) =>
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
                : WorkerEvent.Ended({ session, why }),
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
       * session closes, in a fiber of its own, since the caller may be its reader.
       */
      const gone = (session: Live, why: string) =>
        Effect.gen(function* () {
          const close = yield* closing(session.ticket, session.scope, why)
          if (close !== undefined) yield* Effect.forkIn(close, scope)
        })

      /** Ends the worker over a setup problem, before it does anything. */
      const setupProblem = (session: Live, problem: string) =>
        Effect.gen(function* () {
          yield* Ref.update(findings, (found) => ({
            ...found,
            problems: [...found.problems, problem],
          }))
          yield* log.write(detail`${session.ticket}: ${problem}`)
          session.abort.abort()
          yield* gone(session, problem)
        })

      /** Checks the session's first system/init (§ 4.1): the setup problem it shows, if any. */
      const checkFirst = (session: Live, init: SDKSystemMessage) =>
        Effect.gen(function* () {
          if (init.permissionMode !== requestedMode) {
            const first = yield* Ref.modify(findings, (found) =>
              found.permissionMode === null
                ? [
                    true,
                    {
                      ...found,
                      permissionMode: { requested: requestedMode, inEffect: init.permissionMode },
                    },
                  ]
                : [false, found],
            )
            if (first) {
              yield* log.write(
                line`${permissionModeLine({ requested: requestedMode, inEffect: init.permissionMode })}`,
              )
            }
          }
          const mcp = yield* Effect.exit(checkInit(init, session.servers))
          if (Exit.isFailure(mcp)) {
            const problems = mcp.cause.reasons.flatMap((reason) =>
              reason._tag === "Fail" ? reason.error.problems : [],
            )
            return problems.join("; ")
          }
          if (billedKey(options.account.billing, init.apiKeySource)) {
            return apiKeyProblem(init.apiKeySource)
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

      /** Reads the session's stream to its end; an end tutti didn't ask for makes the worker Gone. */
      const read = (session: Live) =>
        Stream.fromAsyncIterable(session.query, (cause) => cause).pipe(
          Stream.runForEach((message) => onMessage(session, message)),
          Effect.exit,
          Effect.flatMap((exit) =>
            gone(session, Exit.isSuccess(exit) ? endedWhy : failedWhy(causeMessage(exit.cause))),
          ),
        )

      /** Closes the session: the prompt ends, the query closes, and Claude Code exits. */
      const shut = (session: Live) =>
        Effect.gen(function* () {
          yield* Queue.end(session.inbox)
          session.query.close()
          const child = session.spawned.child
          if (child === undefined) return
          yield* exitOf(child).pipe(
            Effect.timeoutOrElse({ duration: closeLimit, orElse: () => killGroup(child) }),
          )
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
       * start runs in the session's scope, so closing the session while it starts cancels it.
       */
      const begin = (ticket: string, session: Session, how: SessionStart) =>
        Effect.gen(function* () {
          const of = yield* reserve(ticket, session.sessionId)
          const started = yield* Effect.forkIn(make(ticket, session, how, of), of)
          const exit = yield* Fiber.await(started).pipe(
            Effect.onInterrupt(() => closeIn(ticket, of, undefined)),
          )
          if (Exit.isSuccess(exit)) return exit.value
          const cancelled = Cause.hasInterruptsOnly(exit.cause)
          yield* closeIn(ticket, of, cancelled ? closedWhy : causeMessage(exit.cause))
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
          const entry = yield* workers.open(ticket, sessionId)
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
                : options.servers
          const sdkOptions: Options =
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
          const spawn = sdkOptions.spawnClaudeCodeProcess
          const spawned: Live["spawned"] = { child: undefined }
          const startupFailure = yield* Deferred.make<string>()
          // Claude Code, spawned, is closed with the session's scope, though the start is cancelled.
          const opened = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const opened: Live = {
                ticket,
                sessionId,
                servers,
                entry,
                inbox,
                query: query({
                  prompt: Stream.toAsyncIterableWith(Stream.fromQueue(inbox), Context.empty()),
                  options: {
                    ...sdkOptions,
                    ...(spawn === undefined
                      ? {}
                      : {
                          spawnClaudeCodeProcess: (spawnOptions) => {
                            const child = spawn(spawnOptions)
                            spawned.child = child
                            return child
                          },
                        }),
                  },
                }),
                abort,
                scope: of,
                spawned,
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
            return opened
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
          const reason = startFailure(refused, causeMessage(initialized.cause))
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

      /** Pushes a message into the session's inbox; its uuid. */
      const push = (session: Live, message: Message) =>
        Effect.gen(function* () {
          const uuid = message.uuid ?? randomUUID()
          // Outstanding before the CLI can see it, so its turn's result can't come first.
          yield* workers.fold(session.entry, WorkerEvent.Sent({ session: session.sessionId, uuid }))
          const sdk = userMessage(message, uuid, session.sessionId)
          yield* workers.sent(session.entry, session.sessionId, sdk)
          yield* Queue.offer(session.inbox, sdk)
          return uuid as string
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

      return AgentHost.of({
        start: (ticket, session) =>
          Effect.asVoid(begin(ticket, session, { _tag: "New", sessionId: session.sessionId })),
        resume: (ticket, session, message) =>
          Effect.flatMap(
            begin(ticket, session, { _tag: "Resume", sessionId: session.sessionId }),
            (opened) => push(opened, message),
          ),
        send: (ticket, text, from, uuid) =>
          Effect.flatMap(sessionOf(ticket), (session) =>
            push(session, { text, from, ...(uuid === undefined ? {} : { uuid }) }),
          ),
        interrupt: (ticket) =>
          Effect.gen(function* () {
            const session = yield* sessionOf(ticket)
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
          }),
        close,
        end: (ticket) => Effect.andThen(close(ticket), workers.forget(ticket)),
        takeRequires: (names) => Ref.set(requires, names),
        current: workers.current,
        begun: workers.begun,
        state: workers.state,
        messages: workers.messages,
        workers: workers.workers,
        compactions: workers.compactions,
        setup: Ref.get(findings),
        processes: Effect.sync(() => {
          const pids = new Map<string, number>()
          for (const [ticket, lifecycle] of sessions) {
            const child = liveOf(lifecycle)?.spawned.child
            const pid = (child as { pid?: unknown } | undefined)?.pid
            if (child !== undefined && !exited(child) && typeof pid === "number")
              pids.set(ticket, pid)
          }
          return pids
        }),
      })
    }),
  )

/** Whether a session with `source` as its API key source bills a key though `billing` says not. */
export const billedKey = (billing: Billing, source: string | undefined): boolean =>
  billing._tag === "Subscription" && source !== undefined && source !== noKey
