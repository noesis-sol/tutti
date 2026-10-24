// AgentHost's live layer (§ 4.1, § 4.2, § 4.4, § 3.2): one Agent SDK query() per open worker
// session, in streaming input mode. A session's inbox is an Effect Queue the SDK reads as its
// prompt, an AsyncIterable<SDKUserMessage>; a message pushed while a turn is under way joins that
// turn or waits in the CLI's own queue (§ 4.1). Every message the session sends is recorded in
// Transcripts and folded into the worker's state (makeWorkers), and every message pushed into its
// inbox is recorded there as it is pushed; its hook callbacks are folded in too, and its stderr
// goes to the transcript's stderr.log (workerOptions).
//
// Each session's first system/init is checked (§ 4.1, sessionChecks.ts's `first`): the permission
// mode in effect, the MCP servers (§ 4.6) and the API key source (§ 4.13). A worker ended so is
// Gone with `setup`, which stops the run (work.ts). A first system/init from a CLI of another
// version without readable MCP servers ends the worker as a setup problem (checkInit), since tutti
// can't tell what it got.
//
// system/init comes only as the first turn starts, its model request already sent, so the same
// checks run first in the start, before the session is sent anything (`before`): the API key
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
//
// A resumed session keeps the system prompt it recorded as it began (`snapshot: true`, § 4.1), so
// the standing rules' notes that can change, the requires list's and the check's (changingNotes),
// reach it in the resume's message instead (resumedNotes): when they differ from those its session
// was started or last resumed with in this run, or when it was started in an earlier run, which
// may have had others.
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
  Scope,
  Stream,
} from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import type { WorkerPrompt } from "../project/prompt.ts"
import { readmeName } from "../project/requires.ts"
import { checkCommands } from "../project/settings.ts"
import { detail, Log } from "../run/log.ts"
import { OtherWorkers } from "../run/machine.ts"
import { timeoutAwake } from "../services/Wake.ts"
import type { AccountProbe } from "./Account.ts"
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
import { type ChosenServers, inProcess, noServers, withOwn } from "./mcp.ts"
import {
  changingNotes,
  interviewOptions,
  type SessionStart,
  workerCallbacks,
  workerOptions,
} from "./options.ts"
import { capabilitiesOf } from "./reading.ts"
import { requiresServerName } from "./requiresTools.ts"
import {
  cancelQueuedCapability,
  isLaunchFailure,
  launchFailed,
  makeChecks,
  setupLine,
  skippedLine,
  startFailure,
} from "./sessionChecks.ts"
import {
  type SessionProcess,
  stderrQuoted,
  withSessionProcess,
  withStderr,
} from "./sessionProcess.ts"
import type { Transcripts } from "./Transcripts.ts"
import { projectHasSkills } from "./unusedTools.ts"
import { WorkerEvent } from "./WorkerState.ts"

/**
 * What a resumed worker's message begins with when the standing rules' notes that can change,
 * `notes` (changingNotes), may differ from those its session recorded: those notes as they are now.
 */
export const resumedNotes = (notes: string): string =>
  "Your session keeps the system prompt it began with, so here is what your standing rules say " +
  `now of the project's requires list and its check, which may have changed since:\n\n` +
  `${notes.trim().replace(/\n{3,}/g, "\n\n")}\n\n`

/**
 * How long a session has to start: Claude Code spawned and its initialize answered, counted awake
 * (src/services/Wake.ts).
 */
export const startLimit: Duration.Duration = Duration.minutes(1)

/**
 * How long a closed session's Claude Code has to exit before tutti kills its process group: the
 * SDK's grace (2 s) and its SIGKILL after SIGTERM (5 s more), with time to spare.
 */
export const closeLimit: Duration.Duration = Duration.seconds(10)

/**
 * How long an interrupt's control requests, the interrupt and each `cancel_async_message`, have to
 * be answered together: the SDK gives them no timer, so a Claude Code alive but not answering would
 * hold the caller forever. Past it, counted awake (src/services/Wake.ts), the session is aborted
 * and its worker gone.
 */
export const interruptLimit: Duration.Duration = Duration.seconds(10)

/** Why a worker is gone when its Claude Code didn't answer an interrupt within `limit`. */
export const unansweredWhy = (limit: Duration.Duration): string =>
  `it didn't answer an interrupt within ${Duration.format(limit)}`

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

/** How long a session's mcpServerStatus() has to be answered before its start goes on unchecked. */
export const statusLimit: Duration.Duration = Duration.seconds(10)

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

/** What Effect.uninterruptibleMask gives: runs an effect as interruptible as its caller was. */
type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

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
      const checks = yield* makeChecks({
        log,
        permissionMode: config.settings.workers.permission_mode,
        billing: options.account.billing,
      })
      const sessions = new Map<string, Lifecycle>()
      // The changing notes (changingNotes) each ticket's worker was last given, as its session
      // started or in its last resume's message: a resume with others tells it them (resumedNotes).
      const notesGiven = new Map<string, string>()
      const interruptWithin = options.interruptLimit ?? interruptLimit

      /**
       * Moves the ticket's session, if `of` is still its scope, to Closing: closed on purpose when
       * `why` is undefined, else gone for `why` (over a setup problem when `setup`), as its worker's
       * state says from now on. The effect that then closes it, its scope and with it Claude Code,
       * and ends it: undefined when the ticket's session is another or is Closing already. Its
       * caller runs that close uninterruptibly from this on: a session moved to Closing that never
       * closes holds a start waiting for its end for ever.
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
        }).pipe(Effect.uninterruptible)

      /**
       * The session's end, without tutti closing it on purpose: the worker is Gone and the
       * session closes, in a fiber of its own, since the caller may be its reader. `setup` when it
       * ended over a setup problem.
       */
      const gone = (session: Live, why: string, setup = false) =>
        Effect.gen(function* () {
          const close = yield* closing(session.ticket, session.scope, why, setup)
          if (close !== undefined) yield* Effect.forkIn(close, scope)
        }).pipe(Effect.uninterruptible)

      /**
       * Ends the worker over a setup problem, before it does anything: Gone with `setup`, its process
       * group killed at once, not given the SDK's grace.
       */
      const setupProblem = (session: Live, problem: string) =>
        Effect.gen(function* () {
          yield* log.write(setupLine(session.ticket, problem))
          yield* session.process.kill
          session.abort.abort()
          yield* gone(session, problem, true)
        })

      /** Whether `session` is still its ticket's, Starting. */
      const starting = (session: Live) => {
        const current = sessions.get(session.ticket)
        return current?._tag === "Starting" && current.session === session
      }

      /** Its first system/init checked, a Starting session is Open, or ends over a setup problem. */
      const born = (session: Live, init: SDKMessage) =>
        Effect.gen(function* () {
          const problem = yield* checks.first(init, session.servers)
          if (problem !== undefined) return yield* setupProblem(session, problem)
          yield* Effect.sync(() => {
            if (starting(session)) sessions.set(session.ticket, Lifecycle.Open({ session }))
          })
        })

      const onMessage = (session: Live, message: SDKMessage) =>
        Effect.gen(function* () {
          const reading = yield* workers.emit(session.entry, session.sessionId, message)
          if (reading._tag === "Init") {
            for (const capability of reading.capabilities) session.capabilities.add(capability)
            if (starting(session)) yield* born(session, message)
          } else if (reading._tag === "Result" && reading.startupFailure !== null) {
            const refused = reading.startupFailure
            yield* Deferred.succeed(session.startupFailure, refused)
            yield* gone(session, refused)
          }
        })

      /**
       * Reads the session's stream to its end, a message that dies skipped; an end tutti didn't ask
       * for makes the worker Gone.
       */
      const read = (session: Live) =>
        Stream.fromAsyncIterable(session.query, (cause) => cause).pipe(
          Stream.runForEach((message) =>
            onMessage(session, message).pipe(
              Effect.catchDefect((defect) => log.write(skippedLine(session.ticket, defect))),
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
       * other: a Closing one's end is waited for, and one Starting or Open fails it. Run
       * uninterruptibly, so that nothing comes between it and what closes the scope it gives;
       * it waits for a Closing one's end in `restore`.
       */
      const reserve = (
        ticket: string,
        sessionId: string,
        restore: Restore,
      ): Effect.Effect<Scope.Closeable, AgentStartFailed> =>
        Effect.suspend(() => {
          const current = sessions.get(ticket)
          if (current?._tag === "Closing") {
            return Effect.andThen(
              restore(Deferred.await(current.done)),
              reserve(ticket, sessionId, restore),
            )
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
        Effect.uninterruptible(
          Effect.flatMap(closing(ticket, of, why), (close) => close ?? Effect.void),
        )

      /**
       * Starts (or resumes) the ticket's session; it is open once Claude Code has answered. The
       * start runs in the session's scope, so closing the session while it starts cancels it. A
       * setup problem found as it starts (checkBefore) doesn't fail it: its worker is Gone with
       * `setup`, as one its first system/init shows makes it, and `problem` says what it was; the
       * caller sends it nothing. Interrupted once its session is reserved, it closes it: the
       * reserving, the forking and the closing on interrupt are uninterruptible together, so an
       * interrupt can't leave the ticket Starting with nothing to close it.
       */
      const begin = (ticket: string, session: Session, how: SessionStart) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const of = yield* reserve(ticket, session.sessionId, restore)
            const started = yield* Effect.forkIn(make(ticket, session, how, of), of)
            return yield* restore(settle(ticket, of, started)).pipe(
              Effect.onInterrupt(() => closeIn(ticket, of, undefined)),
            )
          }),
        )

      /** Waits for the start `started` in the session's scope `of`, and settles what it ended in. */
      const settle = <A extends { readonly opened: Live; readonly problem: string | undefined }, E>(
        ticket: string,
        of: Scope.Closeable,
        started: Fiber.Fiber<A, E>,
      ) =>
        Effect.gen(function* () {
          const exit = yield* Fiber.await(started)
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
          const prompt = session.probe === true ? null : options.prompt
          const requiresNow = yield* Ref.get(requires)
          // A worker's changing notes; none for the probe or an interview.
          const notes =
            setup !== undefined || prompt === null
              ? undefined
              : changingNotes({ config, servers, readme, requires: requiresNow }, prompt)
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
                  prompt,
                  servers,
                  skills,
                  readme,
                  requires: requiresNow,
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
            timeoutAwake({
              duration: startLimit,
              orElse: () => Effect.fail(`no answer within ${Duration.format(startLimit)}`),
            }),
            Effect.exit,
          )
          if (Exit.isSuccess(initialized)) {
            for (const capability of capabilitiesOf(initialized.value)) {
              opened.capabilities.add(capability)
            }
            const status = yield* Effect.tryPromise(() => opened.query.mcpServerStatus()).pipe(
              Effect.timeout(statusLimit),
              Effect.option,
            )
            const problem = yield* checks.before(initialized.value, status, servers)
            return { opened, problem, notes }
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
          return Effect.uninterruptibleMask((restore) =>
            Effect.flatMap(closing(ticket, of, undefined), (closed) => {
              if (closed !== undefined) return closed
              // It went meanwhile.
              const now = sessions.get(ticket)
              return now?._tag === "Closing" ? restore(Deferred.await(now.done)) : Effect.void
            }),
          )
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
          Effect.map(
            begin(ticket, session, { _tag: "New", sessionId: session.sessionId }),
            ({ notes }) => {
              if (notes === undefined) notesGiven.delete(ticket)
              else notesGiven.set(ticket, notes)
            },
          ),
        // A session stopped over a setup problem as it resumed is sent nothing: the message's uuid
        // all the same, its worker Gone with `setup` for the caller to settle. One whose changing
        // notes may differ from those it recorded is told them first (resumedNotes).
        resume: (ticket, session, message) =>
          Effect.flatMap(
            begin(ticket, session, { _tag: "Resume", sessionId: session.sessionId }),
            ({ opened, problem, notes }) => {
              if (problem !== undefined) return Effect.succeed(message.uuid ?? randomUUID())
              const sent =
                notes === undefined || notesGiven.get(ticket) === notes
                  ? push(workers, opened, message)
                  : Effect.tap(
                      push(workers, opened, {
                        ...message,
                        text: resumedNotes(notes) + message.text,
                      }),
                      () => Effect.sync(() => void notesGiven.set(ticket, notes)),
                    )
              return sent.pipe(
                Effect.catchTag(
                  "AgentGone",
                  () => new AgentStartFailed({ ticket, reason: closedWhy }),
                ),
              )
            },
          ),
        send: (ticket, text, from, uuid) =>
          Effect.flatMap(sessionOf(ticket), (session) =>
            push(workers, session, { text, from, ...(uuid === undefined ? {} : { uuid }) }),
          ),
        interrupt: (ticket) =>
          Effect.flatMap(sessionOf(ticket), (session) =>
            interruptIn(session).pipe(
              timeoutAwake({
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
        answered: workers.answered,
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
