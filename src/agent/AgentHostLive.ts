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
import { randomUUID } from "node:crypto"
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
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import type { WorkerPrompt } from "../project/prompt.ts"
import { detail, Log, line } from "../run/log.ts"
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
import { workerEnv } from "./env.ts"
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
}

// An open session.
interface Open {
  readonly ticket: string
  readonly sessionId: string
  /** The MCP servers it was given: the workers', none for the probe, tutti's for the interview. */
  readonly servers: ChosenServers
  readonly entry: WorkerEntry
  readonly inbox: Queue.Queue<SDKUserMessage, Cause.Done>
  readonly query: Query
  readonly abort: AbortController
  readonly scope: Scope.Closeable
  /** Claude Code, once the SDK has spawned it: query() does at once. */
  readonly spawned: { child: SpawnedProcess | undefined }
  /** Whether tutti is closing the session, or has let it go: its stream's end is no news. */
  closing: boolean
  /** Whether its first system/init has been checked. */
  checked: boolean
  /** The CLI's capabilities, from its initialize answer and each system/init. */
  readonly capabilities: Set<string>
  /** The startup_failure_reason of a result it sent. */
  startupFailure: string | undefined
}

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

/** The reason a session didn't start, from what failed its initialize. */
const startFailure = (open: Open, message: string): string => {
  if (open.startupFailure !== undefined) {
    return `Claude Code refused to start: ${open.startupFailure}`
  }
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
      const checks = [
        config.settings.checks.fast.command,
        config.settings.checks.full.command,
      ].filter((command): command is string => typeof command === "string" && command !== "")
      const workers = yield* makeWorkers(checks)
      const scope = yield* Effect.scope
      const services = yield* Effect.context<Attention | Transcripts>()
      const env = workerEnv({
        subscription: options.account.subscription,
        billing: config.billing,
        checkTimeout: config.settings.checks.fast.timeout,
        ...(options.env === undefined ? {} : { env: options.env }),
      })
      const requestedMode = config.settings.workers.permission_mode
      // Whether workers keep Skill (§ 4.1), decided once, from the main checkout, as the run begins.
      const skills = yield* projectHasSkills(config.repo)
      const findings = yield* Ref.make<SetupFindings>(noFindings)
      const open = new Map<string, Open>()
      // Tickets whose session is being made, so a second start is refused at once.
      const reserved = new Set<string>()

      const closeScope = (session: Open) =>
        Scope.close(session.scope, Exit.void).pipe(Effect.forkIn(scope), Effect.asVoid)

      /**
       * The session's end, without tutti closing it on purpose: the worker is Gone and the
       * session's scope closes, in a fiber of its own, since the caller may be its reader.
       */
      const gone = (session: Open, why: string) =>
        Effect.gen(function* () {
          if (open.get(session.ticket) === session) open.delete(session.ticket)
          if (session.closing) return
          session.closing = true
          yield* workers.fold(session.entry, WorkerEvent.Ended({ why }))
          yield* closeScope(session)
        })

      /** Ends the worker over a setup problem, before it does anything. */
      const setupProblem = (session: Open, problem: string) =>
        Effect.gen(function* () {
          yield* Ref.update(findings, (found) => ({
            ...found,
            problems: [...found.problems, problem],
          }))
          yield* log.write(detail`${session.ticket}: ${problem}`)
          session.abort.abort()
          yield* gone(session, problem)
        })

      /** Checks the session's first system/init (§ 4.1). */
      const checkFirst = (session: Open, init: SDKSystemMessage) =>
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
            return yield* setupProblem(session, problems.join("; "))
          }
          if (billedKey(options.account.billing, init.apiKeySource)) {
            return yield* setupProblem(session, apiKeyProblem(init.apiKeySource))
          }
        })

      const onMessage = (session: Open, message: SDKMessage) =>
        Effect.gen(function* () {
          yield* workers.emit(session.entry, session.sessionId, message)
          if (message.type === "system" && message.subtype === "init") {
            for (const capability of capabilitiesOf(message)) session.capabilities.add(capability)
            if (!session.checked) {
              session.checked = true
              yield* checkFirst(session, message)
            }
          } else if (
            message.type === "result" &&
            message.subtype !== "success" &&
            message.startup_failure_reason !== undefined
          ) {
            session.startupFailure = message.startup_failure_reason
            yield* gone(session, message.startup_failure_reason)
          }
        })

      /** Reads the session's stream to its end; an end tutti didn't ask for makes the worker Gone. */
      const read = (session: Open) =>
        Stream.fromAsyncIterable(session.query, (cause) => cause).pipe(
          Stream.runForEach((message) => onMessage(session, message)),
          Effect.exit,
          Effect.flatMap((exit) =>
            gone(session, Exit.isSuccess(exit) ? endedWhy : failedWhy(causeMessage(exit.cause))),
          ),
        )

      /** Closes the session: the prompt ends, the query closes, and Claude Code exits. */
      const shut = (session: Open) =>
        Effect.gen(function* () {
          session.closing = true
          yield* Queue.end(session.inbox)
          session.query.close()
          const child = session.spawned.child
          if (child === undefined) return
          yield* exitOf(child).pipe(
            Effect.timeoutOrElse({ duration: closeLimit, orElse: () => killGroup(child) }),
          )
        })

      /** Starts (or resumes) the ticket's session; it is open once Claude Code has answered. */
      const begin = (ticket: string, session: Session, how: SessionStart) =>
        Effect.gen(function* () {
          const free = yield* Effect.sync(() => {
            if (open.has(ticket) || reserved.has(ticket)) return false
            reserved.add(ticket)
            return true
          })
          if (!free) {
            return yield* new AgentStartFailed({ ticket, reason: "a session is already open" })
          }
          return yield* Effect.ensuring(
            make(ticket, session, how),
            Effect.sync(() => reserved.delete(ticket)),
          )
        })

      const make = (ticket: string, session: Session, how: SessionStart) =>
        Effect.gen(function* () {
          const there = yield* fs.exists(session.cwd).pipe(Effect.orElseSucceed(() => false))
          if (!there) {
            return yield* new AgentStartFailed({
              ticket,
              reason: `its folder isn't there: ${session.cwd}`,
            })
          }
          const entry = yield* workers.open(ticket)
          const callbacks = yield* Effect.provideContext(
            workerCallbacks(ticket, {
              activity: (input) => workers.fold(entry, WorkerEvent.Hook({ input })),
              // Counted and logged by the run; triage reads it from the transcript's compact_boundary.
              compaction: (input) => workers.compacted(entry, input.trigger),
            }),
            services,
          )
          const inbox = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
          const abort = new AbortController()
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
                  callbacks,
                  session: how,
                  env,
                  abortController: abort,
                })
          const spawn = sdkOptions.spawnClaudeCodeProcess
          const spawned: Open["spawned"] = { child: undefined }
          const opened: Open = {
            ticket,
            sessionId: session.sessionId,
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
            scope: yield* Scope.fork(scope),
            spawned,
            closing: false,
            checked: false,
            capabilities: new Set(),
            startupFailure: undefined,
          }
          // Closing the session's scope closes the session.
          yield* Scope.addFinalizer(opened.scope, shut(opened))
          open.set(ticket, opened)
          const reader = yield* read(opened).pipe(Effect.forkIn(opened.scope))

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
          const reason = startFailure(opened, causeMessage(initialized.cause))
          yield* gone(opened, reason)
          return yield* new AgentStartFailed({
            ticket,
            reason,
            ...(opened.startupFailure === undefined
              ? {}
              : { startupFailureReason: opened.startupFailure }),
          })
        })

      const sessionOf = (ticket: string) =>
        Effect.suspend(() => {
          const found = open.get(ticket)
          return found === undefined || found.closing
            ? Effect.fail(new AgentGone({ ticket, why: "it has no open session" }))
            : Effect.succeed(found)
        })

      /** Pushes a message into the session's inbox; its uuid. */
      const push = (session: Open, message: Message) =>
        Effect.gen(function* () {
          const uuid = message.uuid ?? randomUUID()
          // Outstanding before the CLI can see it, so its turn's result can't come first.
          yield* workers.fold(session.entry, WorkerEvent.Sent({ uuid }))
          const sdk = userMessage(message, uuid, session.sessionId)
          yield* workers.sent(session.entry, session.sessionId, sdk)
          yield* Queue.offer(session.inbox, sdk)
          return uuid as string
        })

      const close = (ticket: string) =>
        Effect.gen(function* () {
          const session = open.get(ticket)
          if (session === undefined) return
          open.delete(ticket)
          if (!session.closing) {
            session.closing = true
            yield* workers.fold(session.entry, WorkerEvent.Closed())
          }
          yield* Scope.close(session.scope, Exit.void)
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
                open.get(ticket) === session && !session.closing
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
            yield* workers.fold(session.entry, WorkerEvent.Cancelled({ uuids: receipt.cancelled }))
            return receipt
          }),
        close,
        end: (ticket) => Effect.andThen(close(ticket), workers.forget(ticket)),
        current: workers.current,
        state: workers.state,
        messages: workers.messages,
        workers: workers.workers,
        compactions: workers.compactions,
        setup: Ref.get(findings),
      })
    }),
  )

/** Whether a session with `source` as its API key source bills a key though `billing` says not. */
export const billedKey = (billing: Billing, source: string | undefined): boolean =>
  billing._tag === "Subscription" && source !== undefined && source !== noKey
