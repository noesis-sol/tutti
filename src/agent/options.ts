// A worker session's SDK options (§ 4.1), as a pure function of the run's configuration, the
// ticket, its worktree, the worker prompt, the chosen MCP servers, the session's callbacks and its
// session ID: `sessionId` for a new session, `resume` for a resumed one, never both (claude refuses
// the pair, docs/spikes/02-sdk-lifecycle.md). They are a SessionSpec: what the session is, without
// its launch (the environment, the executable, the spawn, the abort), which ClaudeCode adds.
// The login probe's (§ 4.13) and the feature interview's (§ 4.10) are made from the same shared
// options.
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
// A worker that ends normally takes its reaper with it. The reaper is src/services/reaper.ts's.
//
// Claude Code's Bash shells are detached, each leading a group of its own, and only its own
// shutdown stops them. So a SIGKILL of Claude Code, the reaper's or the SDK's (5 s after its
// SIGTERM, which is 2 s after close), kills its descendants' groups first (killTree,
// src/services/processTree.ts), and its commands don't run on without it.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type {
  CanUseTool,
  HookCallbackMatcher,
  OnElicitation,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import type { AppConfigValue } from "../cli/AppConfig.ts"
import {
  askUserQuestionTool,
  checkNote,
  forTicket,
  requiresNote,
  usageLimitNote,
  type WorkerPrompt,
} from "../project/prompt.ts"
import { killTree } from "../services/processTree.ts"
import { reap, reapGrace } from "../services/reaper.ts"
import type { InterviewSetup } from "./AgentHost.ts"
import { Attention } from "./Attention.ts"
import type { SessionSpec } from "./ClaudeCode.ts"
import type { SessionFibers } from "./callbacks.ts"
import { activityHooks, type Hooks, type Recorder } from "./hooks.ts"
import { qualifiedToolNames, serverName } from "./interviewTools.ts"
import { type ChosenServers, chromeArgs, hasOwn, mcpServers } from "./mcp.ts"
import { qualifiedRequiresTool, requiresServerName } from "./requiresTools.ts"
import { Transcripts } from "./Transcripts.ts"
import { deniedTools } from "./unusedTools.ts"

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
  readonly config: Pick<AppConfigValue, "repo" | "settings">
  readonly ticket: string
  /** The ticket's worktree, the session's folder. */
  readonly worktree: string
  /** The run's worker prompt, TICKET_ID still in it: the standing rules; null for the probe. */
  readonly prompt: WorkerPrompt | null
  readonly servers: ChosenServers
  /** Whether the project has skills (projectHasSkills): its workers keep Skill. */
  readonly skills: boolean
  /**
   * Whether the main checkout has a README.md, whose section on what to install a worker that
   * changes the requires list writes again (requiresNote).
   */
  readonly readme?: boolean
  /** The names of the run's requires list now (requiresNote); the settings' when left out. */
  readonly requires?: ReadonlyArray<string>
  readonly callbacks: WorkerCallbacks
  readonly session: SessionStart
}

/**
 * The SDK's spawn for a worker or the login probe: Claude Code detached into a process group of
 * its own, with a reaper that ends its descendants' groups too (reap), its stderr decoded and
 * passed to `stderr`. `signal`, the SDK's forwarded one, fires only after its graceful close, so
 * passing it to spawn is safe. It returns the ChildProcess, whose `close` says its stderr has all
 * been read, and whose kill("SIGKILL"), as the SDK sends it, is killTree's.
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
    reap(child, reapGrace, true)
    const kill = child.kill.bind(child)
    child.kill = (signal) => {
      if ((signal === "SIGKILL" || signal === 9) && child.exitCode === null) killTree(child.pid)
      return kill(signal)
    }
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
  readonly config: Pick<AppConfigValue, "repo" | "settings">
  /** Whether the session gets Claude in Chrome: the project's choice, never the probe's. */
  readonly chrome: boolean
  /** Whether the session keeps Skill, the project having skills (projectHasSkills). */
  readonly skills: boolean
}

/**
 * The options a worker's session and the login probe's share (§ 4.13: the probe runs with the
 * workers' options), so the two can't drift: the settings Claude Code reads, the permission mode,
 * model and effort, strict MCP config and Chrome (chromeArgs), the tools denied (the unused ones,
 * deniedTools, and AskUserQuestion when workers.ask_user_question is off).
 */
const sharedOptions = (input: SharedInput) => {
  const workers = input.config.settings.workers
  return {
    projectConfigRoot: input.config.repo,
    settingSources: ["user", "project", "local"],
    permissionMode: workers.permission_mode,
    ...(workers.model === null ? {} : { model: workers.model }),
    ...(workers.effort === null ? {} : { effort: workers.effort }),
    strictMcpConfig: true,
    extraArgs: chromeArgs(input),
    disallowedTools: [
      ...deniedTools(input.skills),
      ...(workers.ask_user_question ? [] : [askUserQuestionTool]),
    ],
  } satisfies SessionSpec
}

/**
 * A worker's PreToolUse hook that allows tutti's requires_readme without asking: it writes only
 * the README's section generated from the list, in the worker's own worktree. requires_check runs
 * the commands of the main checkout's list, so the permission mode decides it; those the branch adds
 * or changes it gives back for the worker to run with Bash, where the permission mode sees them.
 */
export const allowRequiresReadme: HookCallbackMatcher = {
  matcher: qualifiedRequiresTool("requires_readme"),
  hooks: [
    async () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "tutti's own requires tool",
      },
    }),
  ],
}

/**
 * The notes of a worker's standing rules that can change between its session's launches: the
 * requires list's (requiresNote), which a merge changes mid-run, and the check's (checkNote), which
 * a later run may have changed. A resumed session keeps the system prompt it recorded as it began
 * (`snapshot: true`), so the host tells it these in its message instead where they may differ.
 */
export const changingNotes = (
  input: Pick<WorkerOptionsInput, "config" | "servers" | "readme" | "requires">,
  prompt: WorkerPrompt,
): string =>
  requiresNote(
    input.requires ?? input.config.settings.requires.map((r) => r.name),
    prompt.text,
    input.readme === true,
    hasOwn(input.servers, requiresServerName),
  ) +
  checkNote(input.config.settings.checks.own.command ?? input.config.settings.checks.fast.command)

/**
 * A worker session's SDK options (§ 4.1). A worker whose servers have tutti's own (withOwn) is told
 * of its requires tools, and is allowed requires_readme without asking (allowRequiresReadme).
 */
export const workerOptions = (input: WorkerOptionsInput): SessionSpec => {
  const { callbacks } = input
  const own = hasOwn(input.servers, requiresServerName)
  return {
    ...sharedOptions({
      config: input.config,
      chrome: input.servers.chrome === true,
      skills: input.skills,
    }),
    cwd: input.worktree,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(input.prompt === null
        ? {}
        : {
            append:
              forTicket(input.prompt, input.ticket) +
              changingNotes(input, input.prompt) +
              usageLimitNote,
          }),
      snapshot: true,
    },
    ...(input.session._tag === "New"
      ? { sessionId: input.session.sessionId }
      : { resume: input.session.sessionId }),
    mcpServers: mcpServers(input.servers),
    canUseTool: callbacks.canUseTool,
    onElicitation: callbacks.onElicitation,
    hooks: own
      ? {
          ...callbacks.hooks,
          PreToolUse: [...(callbacks.hooks.PreToolUse ?? []), allowRequiresReadme],
        }
      : callbacks.hooks,
    forwardSubagentText: true,
    includePartialMessages: true,
  }
}

/** What the login probe's options are made from. */
export interface ProbeOptionsInput {
  readonly config: Pick<AppConfigValue, "repo" | "settings">
}

/**
 * The login probe's SDK options (§ 4.13): the workers' shared options, in the main checkout, with
 * no MCP servers, no Chrome and no session saved. It is sent no prompt, so it has no ticket, standing rules,
 * session ID, permission callbacks or hooks: nothing it could call them for. Nor does it need Skill,
 * whatever skills the project has.
 */
export const probeOptions = (input: ProbeOptionsInput): SessionSpec => ({
  ...sharedOptions({ ...input, chrome: false, skills: false }),
  cwd: input.config.repo,
  mcpServers: {},
  persistSession: false,
})

/** The built-in tools an interview's session has (§ 4.10): the whole set, so there's nothing to deny. */
export const interviewBuiltins: ReadonlyArray<string> = [
  "Read",
  "Grep",
  "Glob",
  "Agent",
  "AskUserQuestion",
]

/**
 * The interview's PreToolUse hook that allows its own tools without asking: they read Beads, or file
 * what the user agreed to. A hook rather than allowedTools, whose bare names make the SDK warn on
 * stderr, under the renderer, that canUseTool is shadowed for them.
 */
export const allowOwnTools: HookCallbackMatcher = {
  matcher: qualifiedToolNames.join("|"),
  hooks: [
    async () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "one of tutti's own interview tools",
      },
    }),
  ],
}

/** What an interview's options are made from. */
export interface InterviewOptionsInput {
  readonly config: Pick<AppConfigValue, "repo" | "settings">
  readonly setup: InterviewSetup
  /** Whether workers.mcp_servers chose Claude in Chrome: the interview gets it as workers do. */
  readonly chrome: boolean
  /** The interview's callbacks, as a worker's (workerCallbacks): AskUserQuestion goes to Attention. */
  readonly callbacks: WorkerCallbacks
  readonly session: SessionStart
}

/**
 * The feature interview's SDK options (§ 4.10): the workers' shared options, in the main checkout,
 * its settings loaded. Its tools are enforced: interviewBuiltins is the whole built-in set (a
 * subagent inherits it), and tutti's in-process server is its one MCP server, its three tools
 * allowed without asking (allowOwnTools), and Chrome when the project chose it. The interview's instructions are appended to the claude_code preset.
 */
export const interviewOptions = (input: InterviewOptionsInput): SessionSpec => {
  const { callbacks } = input
  // The workers' denied tools are theirs: the interview's are its whole set, and it always has
  // AskUserQuestion.
  const { disallowedTools: _, ...shared } = sharedOptions({
    config: input.config,
    chrome: input.chrome,
    skills: false,
  })
  return {
    ...shared,
    cwd: input.config.repo,
    tools: [...interviewBuiltins],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: input.setup.prompt,
      snapshot: true,
    },
    ...(input.session._tag === "New"
      ? { sessionId: input.session.sessionId }
      : { resume: input.session.sessionId }),
    mcpServers: { [serverName]: input.setup.server },
    canUseTool: callbacks.canUseTool,
    onElicitation: callbacks.onElicitation,
    hooks: {
      ...callbacks.hooks,
      PreToolUse: [...(callbacks.hooks.PreToolUse ?? []), allowOwnTools],
    },
    forwardSubagentText: true,
    includePartialMessages: true,
  }
}

/**
 * The callbacks of `ticket`'s worker, from Attention and Transcripts, its hooks recording to
 * `recorder`, each call a fiber of the session's `fibers`.
 */
export const workerCallbacks = (ticket: string, recorder: Recorder, fibers: SessionFibers) =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const transcripts = yield* Transcripts
    return {
      canUseTool: yield* attention.request(ticket, fibers),
      onElicitation: yield* attention.elicitation(ticket, fibers),
      hooks: yield* activityHooks(ticket, recorder, fibers),
      stderr: transcripts.stderr(ticket),
    } satisfies WorkerCallbacks
  })
