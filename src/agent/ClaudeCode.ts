// ClaudeCode: the one port through which tutti opens a Claude Code session, whatever the session
// is for: a worker's, the feature interview's or the environment probe's (AgentHostLive), the login
// probe's (Account), the usage probe's (UsageProbe) or an organ's (AgentSdkLanguageModel). Each
// says what its session is (a SessionSpec: the SDK's options without the launch's concerns), what
// it is sent, and how it is billed; the adapter does the rest the same way for all of them:
//
// - the environment, the run's WorkerEnv with a worker's share (or probeEnv's from tutti's own, for
//   the login probe) (§ 4.13);
// - the Claude Code to run (--claude, AppConfig's `claude`);
// - the spawn into a process group of its own, its stderr kept for the reason a session failed
//   (withSessionProcess, § 3.2);
// - the SDK's AbortController;
// - a query() that throws as it is called, as the SDK's does when it finds no Claude Code to run,
//   as LaunchFailed (queryThrew);
// - the session's end with its Scope: the query closed and Claude Code's exit waited for, its
//   process group killed if it hasn't exited within the launch's closeLimit (closeAndWait).
//
// The Query's control requests its types lack (QueuedControls) and the session's settings, which
// getSettings() gives though the SDK's types don't have it, are read here and nowhere else. A
// second agent host would plug in here, as another layer of this service.
import {
  type McpServerStatus,
  type Options,
  type Query,
  query,
  type SDKControlInitializeResponse,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  type Cause,
  Context,
  Data,
  type Duration,
  Effect,
  Layer,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { AppConfig, type AppConfigValue } from "../cli/AppConfig.ts"
import { queryThrew } from "./claudeBinary.ts"
import { probeEnv, sharedEnv, WorkerEnv } from "./env.ts"
import { stderrKept, withSessionProcess, withStderr } from "./sessionProcess.ts"

/**
 * What a session is, as the SDK's options say it, without what the adapter launches it with: its
 * environment, the Claude Code to run, its stderr, its AbortController and its spawn.
 */
export type SessionSpec = Omit<
  Options,
  "env" | "pathToClaudeCodeExecutable" | "stderr" | "abortController" | "spawnClaudeCodeProcess"
>

/** How a session is billed, which decides whether ANTHROPIC_API_KEY is in its environment (§ 4.13). */
export type BilledAs = Data.TaggedEnum<{
  /**
   * As workers are, in the run's WorkerEnv: the key removed beside the subscription login the
   * account probe found unless the run's billing is api. Organs and the usage probe are billed so
   * too.
   */
  Workers: Record<never, never>
  /** Never with the key: the login probe's, to find a subscription login the key would hide. */
  LoginProbe: Record<never, never>
}>

export const BilledAs = Data.taggedEnum<BilledAs>()

/** A worker's share of the machine, in its environment (§ 4.1): its checks keep to it. */
export interface WorkerShare {
  /** The merge check's time limit (checks.fast.timeout), for Bash's timeouts. */
  readonly checkTimeout: Duration.Duration
  /** Its share of the machine's cores (coreShare). */
  readonly cores: number
}

/** What a session is opened with. */
export interface Launch {
  readonly options: SessionSpec
  /**
   * What it is sent: one text, or a stream of messages that ends when the session's input does;
   * left out, its inbox, the messages `send` pushes, which ends as the session closes.
   */
  readonly prompt?: string | AsyncIterable<SDKUserMessage>
  readonly billedAs: BilledAs
  /** tutti's environment, the login probe's is made from; process.env when left out. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** A worker's share of the machine; none for a session that runs no checks. */
  readonly share?: WorkerShare
  /** Every piece of Claude Code's stderr, as it comes: a transcript's stderr.log, say. */
  readonly onStderr?: (data: string) => void
  /** How long Claude Code has to exit once its session is closed, before its group is killed. */
  readonly closeLimit: Duration.Duration
}

/** query() threw as it was called: no Claude Code to run, say. */
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("LaunchFailed", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/**
 * The session's stream, or one of its control requests, failed: `reason` what the SDK said, and
 * `stderr` the end of what Claude Code had written to stderr then (at most stderrKept characters),
 * as the SDK's own error says only its exit code when tutti spawns it (tutti-7l57).
 */
export class SessionFailed extends Schema.TaggedError<SessionFailed>()("SessionFailed", {
  reason: Schema.String,
  stderr: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }

  /** Its reason, then the end of its stderr, at most `max` characters of it, on one line. */
  quoted(max: number = stderrKept): string {
    return withStderr(this.reason, this.stderr.slice(-max).trim())
  }
}

/** An open Claude Code session: its messages, its control requests, and its process. */
export interface ClaudeSession {
  /** What the session sends, read once; a failure carries the end of its stderr. */
  readonly messages: Stream.Stream<SDKMessage, SessionFailed>
  /**
   * Pushes `message` into its inbox, for the CLI to fold into the running turn or queue (§ 4.1):
   * whether it went, false once the inbox has ended, the session closing, or for a session opened
   * with a prompt of its own.
   */
  readonly send: (message: SDKUserMessage) => Effect.Effect<boolean>
  /** Its initialize's answer. */
  readonly initialization: Effect.Effect<SDKControlInitializeResponse, SessionFailed>
  /** Its MCP servers and their status, as mcpServerStatus() lists them. */
  readonly mcpStatus: Effect.Effect<ReadonlyArray<McpServerStatus>, SessionFailed>
  /**
   * Its settings, with the settings files it skipped for errors: getSettings(), which Claude Code
   * 2.1.301 answers though the SDK's types lack it; undefined where the Query has none.
   */
  readonly settings: Effect.Effect<unknown, SessionFailed>
  /** How full its context window is, from the last response's usage (no token-count calls). */
  readonly contextUsage: Effect.Effect<unknown, SessionFailed>
  /** Interrupts its turn, cancelling the messages queued behind it with `cancelQueued` (§ 4.8). */
  readonly interrupt: (
    cancelQueued: boolean,
  ) => Effect.Effect<SDKControlInterruptResponse | undefined, SessionFailed>
  /** Drops the queued message `uuid` (cancel_async_message): whether it did. */
  readonly cancelQueued: (uuid: string) => Effect.Effect<boolean, SessionFailed>
  /** Aborts the session: the SDK ends Claude Code. */
  readonly abort: Effect.Effect<void>
  /** Kills Claude Code's process group at once, its descendants' first, and aborts the session. */
  readonly kill: Effect.Effect<void>
  /** Claude Code's PID while it runs; undefined before it is spawned and once it has exited. */
  readonly pid: () => number | undefined
  /** The end of what it wrote to stderr, at most `max` characters, trimmed: "" for nothing. */
  readonly stderrTail: (max?: number) => string
}

export class ClaudeCode extends Context.Service<
  ClaudeCode,
  {
    /** Opens a session, which ends, and its Claude Code with it, as the Scope closes. */
    readonly open: (launch: Launch) => Effect.Effect<ClaudeSession, LaunchFailed, Scope.Scope>
  }
>()("tutti/agent/ClaudeCode") {
  /** The layer over `open`, the SDK's query(), which a test stands in for. */
  static readonly layerWith = (open: typeof query): Layer.Layer<ClaudeCode, never, AppConfig> =>
    Layer.effect(
      ClaudeCode,
      Effect.gen(function* () {
        const config = yield* AppConfig
        // Resolved once, as the run starts (main.ts).
        const workers = yield* WorkerEnv
        return ClaudeCode.of({ open: opener(open, config, workers) })
      }),
    )

  /** The live layer, over the Agent SDK. */
  static readonly layer = ClaudeCode.layerWith(query)
}

/**
 * The Query's control requests its runtime has and its types lack (SDK 0.3.301, § 4.8):
 * `interrupt({ cancelQueued })`, `cancelAsyncMessage(uuid)`, the `cancel_async_message` control
 * request, which answers whether it dropped the message from the queue, and `getSettings()`, the
 * session's settings (Claude Code 2.1.301), where the Query has it.
 */
export interface QueuedControls {
  interrupt(options?: {
    readonly cancelQueued?: boolean
  }): Promise<SDKControlInterruptResponse | undefined>
  cancelAsyncMessage(uuid: string): Promise<boolean>
  readonly getSettings?: () => Promise<unknown>
}

/** `query`'s controls, through the local type. */
export const queuedControls = (query: Query): QueuedControls => query as unknown as QueuedControls

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The session's environment (§ 4.13): `workers`, the run's WorkerEnv, with the worker's share if it
 * has one; or probeEnv's, from tutti's own, for the login probe.
 */
export const launchEnv = (
  launch: Pick<Launch, "billedAs" | "env" | "share">,
  workers: Readonly<Record<string, string>>,
): Record<string, string> =>
  BilledAs.$match(launch.billedAs, {
    LoginProbe: () => probeEnv(launch.env === undefined ? {} : { env: launch.env }),
    Workers: () => (launch.share === undefined ? { ...workers } : sharedEnv(workers, launch.share)),
  })

const opener =
  (
    open: typeof query,
    config: Pick<AppConfigValue, "claude">,
    workers: Readonly<Record<string, string>>,
  ) =>
  (launch: Launch): Effect.Effect<ClaudeSession, LaunchFailed, Scope.Scope> =>
    Effect.gen(function* () {
      const abort = new AbortController()
      const inbox = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
      if (launch.prompt !== undefined) yield* Queue.end(inbox)
      const { options, process } = withSessionProcess({
        ...launch.options,
        env: launchEnv(launch, workers),
        ...(launch.onStderr === undefined ? {} : { stderr: launch.onStderr }),
        ...(config.claude === null ? {} : { pathToClaudeCodeExecutable: config.claude }),
        abortController: abort,
      })
      // Claude Code, spawned, is closed with the scope, though what opened it is interrupted.
      const handle: Query = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            open({
              prompt:
                launch.prompt ??
                Stream.toAsyncIterableWith(Stream.fromQueue(inbox), Context.empty()),
              options,
            }),
          catch: (cause) => new LaunchFailed({ reason: queryThrew(cause) }),
        }),
        (handle) => process.closeAndWait(() => handle.close(), launch.closeLimit),
      )
      // Closing the session ends its inbox first, and then closes it.
      yield* Effect.addFinalizer(() => Queue.end(inbox))
      const controls = queuedControls(handle)
      const failed = (cause: unknown) =>
        new SessionFailed({ reason: messageOf(cause), stderr: process.stderrTail() })
      const ask = <A>(request: () => Promise<A>) =>
        Effect.tryPromise({ try: request, catch: failed })
      const abortNow = Effect.sync(() => abort.abort())
      return {
        messages: Stream.fromAsyncIterable(handle, failed),
        send: (message) => Queue.offer(inbox, message),
        initialization: ask(() => handle.initializationResult()),
        mcpStatus: ask(() => handle.mcpServerStatus()),
        settings: ask(async () => {
          const getSettings = controls.getSettings
          return getSettings === undefined ? undefined : await getSettings.call(handle)
        }),
        contextUsage: ask(() => handle.getContextUsage({ detail: "summary" })),
        interrupt: (cancelQueued) => ask(() => controls.interrupt({ cancelQueued })),
        cancelQueued: (uuid) => ask(() => controls.cancelAsyncMessage(uuid)),
        abort: abortNow,
        kill: Effect.andThen(process.kill, abortNow),
        pid: () => {
          const child = process.child()
          return child !== undefined && child.exitCode === null && child.signalCode === null
            ? child.pid
            : undefined
        },
        stderrTail: process.stderrTail,
      } satisfies ClaudeSession
    })
