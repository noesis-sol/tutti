// The environment of the Claude Code processes tutti starts (§ 4.1, § 4.13). The SDK's `env`
// replaces the subprocess's environment rather than merging with it, so workerEnv starts from the
// whole of tutti's own, adds tutti's variables, and then keeps or removes ANTHROPIC_API_KEY: the
// key outranks a subscription login and would bill the API without a word. It leaves out the
// variables naming the terminal pane tutti runs in, which its sessions don't own.
import pkg from "../../package.json" with { type: "json" }
import type { billings } from "../cli/flags.ts"

/** The variable that holds an Anthropic API key. */
export const apiKeyVariable = "ANTHROPIC_API_KEY"

/**
 * Whether `name` names the terminal pane tutti runs in: Herdr's HERDR_*, cmux's CMUX_*, and tmux's
 * TMUX and TMUX_PANE. A Claude Code session that has them, with the user's settings loaded, reports
 * itself as that pane's agent through the terminal's hooks: Herdr then takes the pane's agent as
 * replaced and drops its name, which orchestra finds its workers by (tutti-y0e).
 */
export const paneVariable = (name: string): boolean =>
  name.startsWith("HERDR_") || name.startsWith("CMUX_") || name === "TMUX" || name === "TMUX_PANE"

/**
 * What tutti adds to every worker's environment:
 *
 * - session_state_changed messages (§ 4.2);
 * - a startup failure as a result with its reason, not just stderr;
 * - no `fork` subagent type. The M0 report (docs/spikes/03-sdk-mcp-subagents.md) found this doesn't
 *   keep the verifier in the foreground, a hook does (§ 4.1, tutti-nrg.13); it keeps forks, which
 *   always run in the background, away from workers;
 * - tutti and its version, as the client app.
 */
export const workerVariables = (version: string = pkg.version): Record<string, string> => ({
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
  CLAUDE_CODE_FORK_SUBAGENT: "0",
  CLAUDE_AGENT_SDK_CLIENT_APP: `tutti/${version}`,
})

/** Whether `env` sets an API key: an empty value is unset. */
export const apiKeySet = (env: Readonly<Record<string, string | undefined>>): boolean =>
  (env[apiKeyVariable] ?? "") !== ""

export interface WorkerEnvOptions {
  /** Whether the account probe found a subscription login (§ 4.13). */
  readonly subscription: boolean
  /** The run's billing choice: api keeps the key beside a subscription login. */
  readonly billing: (typeof billings)[number]
  /** The environment to start from; tutti's own by default. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** tutti's version, for the client app; package.json's by default. */
  readonly version?: string
}

/**
 * A worker's (or an organ's) environment: `env` with tutti's variables laid over it, without
 * ANTHROPIC_API_KEY when there is a subscription login and billing isn't api. Unset variables and
 * the terminal pane's (paneVariable) are left out.
 */
export const workerEnv = (options: WorkerEnvOptions): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined && !paneVariable(name)) result[name] = value
  }
  Object.assign(result, workerVariables(options.version))
  if (options.subscription && options.billing !== "api") delete result[apiKeyVariable]
  return result
}

/** The account probe's environment: a worker's, always without the key, to find the login (§ 4.13). */
export const probeEnv = (
  options: Omit<WorkerEnvOptions, "subscription" | "billing">,
): Record<string, string> => workerEnv({ ...options, subscription: true, billing: "subscription" })
