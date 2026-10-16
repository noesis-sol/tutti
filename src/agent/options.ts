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
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type {
  CanUseTool,
  OnElicitation,
  Options,
  SpawnedProcess,
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
  /** activityHooks(ticket) (§ 4.2). */
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

/**
 * The SDK's spawn for a worker: Claude Code detached into a process group of its own, its stderr
 * decoded and passed to `stderr`. `signal`, the SDK's forwarded one, fires only after its graceful
 * close, so passing it to spawn is safe.
 */
export const spawnInOwnProcessGroup =
  (stderr: (data: string) => void) =>
  (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      signal: options.signal,
      windowsHide: true,
    })
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

/** A worker session's SDK options (§ 4.1). */
export const workerOptions = (input: WorkerOptionsInput): Options => {
  const { config, callbacks } = input
  const workers = config.settings.workers
  return {
    cwd: input.worktree,
    projectConfigRoot: config.repo,
    settingSources: ["user", "project", "local"],
    permissionMode: workers.permission_mode,
    ...(workers.model === null ? {} : { model: workers.model }),
    ...(workers.effort === null ? {} : { effort: workers.effort }),
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
    strictMcpConfig: true,
    ...(workers.ask_user_question ? {} : { disallowedTools: [askUserQuestionTool] }),
    canUseTool: callbacks.canUseTool,
    onElicitation: callbacks.onElicitation,
    hooks: callbacks.hooks,
    forwardSubagentText: true,
    includePartialMessages: true,
    stderr: callbacks.stderr,
    env: input.env,
    ...(config.claude === null ? {} : { pathToClaudeCodeExecutable: config.claude }),
    spawnClaudeCodeProcess: spawnInOwnProcessGroup(callbacks.stderr),
    abortController: input.abortController,
  }
}

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
