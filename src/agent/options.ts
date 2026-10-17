// A worker session's SDK options (§ 4.1), as a pure function of the run's configuration, the
// ticket, its worktree, the worker prompt, the chosen MCP servers, the session's callbacks, its
// environment and its session ID: `sessionId` for a new session, `resume` for a resumed one, never
// both (claude refuses the pair, docs/spikes/02-sdk-lifecycle.md).
//
// Claude Code is started detached, the leader of a process group of its own, so the SIGINT a
// terminal sends tutti's group on Ctrl+C doesn't reach it mid-turn (the spike's § 5). The SDK's
// SpawnedProcess is a Node ChildProcess, so this spawn is node:child_process's rather than
// effect/process's. The SDK reads a custom spawn's stdout and stdin only, so its stderr is passed
// to the session's stderr callback here.
//
// Each worker also gets a reaper (§ 3.2): a sh in a process group of its own, its stdin a pipe from
// tutti. Claude Code reads its own stdin's EOF only once a turn is over, so a busy worker would
// outlive a kill -9 of tutti (docs/spikes/02-sdk-lifecycle.md § 4). That kill closes the reaper's
// pipe too, and the reaper ends Claude Code's whole group: SIGTERM, then SIGKILL after a grace.
// A worker that ends normally takes its reaper with it.
import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type {
  CanUseTool,
  OnElicitation,
  Options,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import type { AppConfigValue } from "../cli/AppConfig.ts"
import { askUserQuestionTool, forTicket, type WorkerPrompt } from "../project/prompt.ts"
import { Attention } from "./Attention.ts"
import { activityHooks, type Hooks, type Recorder } from "./hooks.ts"
import { type ChosenServers, mcpServers } from "./mcp.ts"
import { Transcripts } from "./Transcripts.ts"

/** How a worker's session starts: a new one with the ID tutti drew, or a saved one resumed. */
export type SessionStart =
  | { readonly _tag: "New"; readonly sessionId: string }
  | { readonly _tag: "Resume"; readonly sessionId: string }

/** The callbacks a worker's session is given. */
export interface WorkerCallbacks {
  /** Attention's request(ticket) (§ 4.5). */
  readonly canUseTool: CanUseTool
  /** Attention's elicitation(ticket). */
  readonly onElicitation: OnElicitation
  /** activityHooks(ticket) (§ 4.2), with the verifier's foreground hook (§ 4.1). */
  readonly hooks: Hooks
  /** Transcripts' stderr(ticket) (§ 4.4). */
  readonly stderr: (data: string) => void
}

/** What a worker's options are made from. */
export interface WorkerOptionsInput {
  readonly config: Pick<AppConfigValue, "repo" | "settings" | "claude">
  readonly ticket: string
  /** The ticket's worktree, the session's folder. */
  readonly worktree: string
  /** The run's worker prompt, TICKET_ID still in it: the standing rules. */
  readonly prompt: WorkerPrompt
  readonly servers: ChosenServers
  readonly callbacks: WorkerCallbacks
  readonly session: SessionStart
  /** workerEnv()'s environment (§ 4.13). */
  readonly env: Record<string, string>
  readonly abortController: AbortController
}

/** How long a reaped group has between the reaper's SIGTERM and its SIGKILL, in whole seconds. */
export const reapGrace = 10

// The reaper's script: $1 is the group, $2 the grace. `read` returns once tutti's end of the pipe
// closes; the group is then given its SIGTERM, and its SIGKILL if it is still there after the grace.
const reaperScript =
  'read _; kill -TERM -"$1" 2>/dev/null; i=0; while [ "$i" -lt "$2" ] && kill -0 -"$1" 2>/dev/null; do sleep 1; i=$((i + 1)); done; kill -KILL -"$1" 2>/dev/null'

/**
 * Starts the reaper of the process group `child` leads, and returns it, or undefined when `child`
 * has no PID to reap. The reaper is killed when `child` exits; it holds no reference to tutti's
 * event loop.
 */
export const reap = (child: ChildProcess, grace: number = reapGrace): ChildProcess | undefined => {
  const group = child.pid
  if (group === undefined || !Number.isInteger(group) || group <= 1) return undefined
  const reaper = spawn("/bin/sh", ["-c", reaperScript, "reaper", String(group), String(grace)], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
    windowsHide: true,
  })
  reaper.on("error", () => {})
  reaper.stdin?.on("error", () => {})
  reaper.unref()
  const done = () => {
    if (reaper.exitCode === null && reaper.signalCode === null) reaper.kill("SIGKILL")
  }
  if (child.exitCode !== null || child.signalCode !== null) done()
  else child.once("exit", done)
  return reaper
}

/**
 * The SDK's spawn for a worker or the login probe: Claude Code detached into a process group of
 * its own, with a reaper (reap), its stderr decoded and passed to `stderr`. `signal`, the SDK's
 * forwarded one, fires only after its graceful close, so passing it to spawn is safe. It returns
 * the ChildProcess, whose `close` says its stderr has all been read.
 */
export const spawnInOwnProcessGroup =
  (stderr: (data: string) => void) =>
  (options: SpawnOptions): ChildProcessWithoutNullStreams => {
    const child = spawn(options.command, options.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      signal: options.signal,
      windowsHide: true,
    })
    reap(child)
    const decoder = new StringDecoder("utf8")
    const pass = (text: string) => {
      if (text === "") return
      try {
        stderr(text)
      } catch {
        // A transcript that can't be written mustn't end the session.
      }
    }
    child.stderr.on("data", (chunk: Buffer) => pass(decoder.write(chunk)))
    child.stderr.once("close", () => pass(decoder.end()))
    child.stderr.on("error", () => {})
    return child
  }

/** What every session tutti starts with the workers' options is given: a worker's or the probe's. */
interface SharedInput {
  readonly config: Pick<AppConfigValue, "repo" | "settings" | "claude">
  readonly env: Record<string, string>
  readonly stderr: (data: string) => void
  readonly abortController: AbortController
  /** Told of Claude Code's process once the SDK has spawned it. */
  readonly spawned?: (child: ChildProcessWithoutNullStreams) => void
}

/**
 * The options a worker's session and the login probe's share (§ 4.13: the probe runs with the
 * workers' options), so the two can't drift: the settings Claude Code reads, the permission mode,
 * model and effort, strict MCP config, the environment, and the spawn into a process group.
 */
const sharedOptions = (input: SharedInput) => {
  const workers = input.config.settings.workers
  const spawn = spawnInOwnProcessGroup(input.stderr)
  const spawned = input.spawned
  return {
    projectConfigRoot: input.config.repo,
    settingSources: ["user", "project", "local"],
    permissionMode: workers.permission_mode,
    ...(workers.model === null ? {} : { model: workers.model }),
    ...(workers.effort === null ? {} : { effort: workers.effort }),
    strictMcpConfig: true,
    ...(workers.ask_user_question ? {} : { disallowedTools: [askUserQuestionTool] }),
    stderr: input.stderr,
    env: input.env,
    ...(input.config.claude === null ? {} : { pathToClaudeCodeExecutable: input.config.claude }),
    spawnClaudeCodeProcess:
      spawned === undefined
        ? spawn
        : (options: SpawnOptions) => {
            const child = spawn(options)
            spawned(child)
            return child
          },
    abortController: input.abortController,
  } satisfies Options
}

/** A worker session's SDK options (§ 4.1). */
export const workerOptions = (input: WorkerOptionsInput): Options => {
  const { callbacks } = input
  return {
    ...sharedOptions({
      config: input.config,
      env: input.env,
      stderr: callbacks.stderr,
      abortController: input.abortController,
    }),
    cwd: input.worktree,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: forTicket(input.prompt, input.ticket),
      snapshot: true,
    },
    ...(input.session._tag === "New"
      ? { sessionId: input.session.sessionId }
      : { resume: input.session.sessionId }),
    mcpServers: mcpServers(input.servers),
    canUseTool: callbacks.canUseTool,
    onElicitation: callbacks.onElicitation,
    hooks: callbacks.hooks,
    forwardSubagentText: true,
    includePartialMessages: true,
  }
}

/** What the login probe's options are made from. */
export interface ProbeOptionsInput {
  readonly config: Pick<AppConfigValue, "repo" | "settings" | "claude">
  /** probeEnv()'s environment (§ 4.13): the workers' without ANTHROPIC_API_KEY. */
  readonly env: Record<string, string>
  /** Every line the probe's Claude Code writes to stderr. */
  readonly stderr: (data: string) => void
  /** Told of Claude Code's process once the SDK has spawned it, to wait for its exit. */
  readonly spawned: (child: ChildProcessWithoutNullStreams) => void
  readonly abortController: AbortController
}

/**
 * The login probe's SDK options (§ 4.13): the workers' shared options, in the main checkout, with
 * no MCP servers and no session saved. It is sent no prompt, so it has no ticket, standing rules,
 * session ID, permission callbacks or hooks: nothing it could call them for.
 */
export const probeOptions = (input: ProbeOptionsInput): Options => ({
  ...sharedOptions(input),
  cwd: input.config.repo,
  mcpServers: {},
  persistSession: false,
})

/** The callbacks of `ticket`'s worker, from Attention and Transcripts, its hooks recording to `recorder`. */
export const workerCallbacks = (ticket: string, recorder: Recorder) =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const transcripts = yield* Transcripts
    return {
      canUseTool: yield* attention.request(ticket),
      onElicitation: yield* attention.elicitation(ticket),
      hooks: yield* activityHooks(ticket, recorder),
      stderr: transcripts.stderr(ticket),
    } satisfies WorkerCallbacks
  })
