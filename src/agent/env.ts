// The environment of the Claude Code processes tutti starts (§ 4.1, § 4.13). The SDK's `env`
// replaces the subprocess's environment rather than merging with it, so workerEnv starts from the
// whole of tutti's own, adds tutti's variables, and then keeps or removes ANTHROPIC_API_KEY: the
// key outranks a subscription login and would bill the API without a word. It leaves out the
// variables naming the terminal pane tutti runs in, which its sessions don't own.
import { Duration } from "effect"
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
 * - tutti and its version, as the client app;
 * - given the merge check's time limit, Bash's timeouts (bashTimeouts).
 */
export const workerVariables = (
  version: string = pkg.version,
  checkTimeout?: Duration.Duration,
): Record<string, string> => ({
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
  CLAUDE_CODE_FORK_SUBAGENT: "0",
  CLAUDE_AGENT_SDK_CLIENT_APP: `tutti/${version}`,
  ...(checkTimeout === undefined ? {} : bashTimeouts(checkTimeout)),
})

/** The variable that gives a worker its share of the machine's cores, for its checks to keep to. */
export const coresVariable = "TUTTI_CORES"

/** orchestra's name for it (orchestra 0.9.0), set too, for check scripts written for orchestra. */
export const orchestraCoresVariable = "ORCHESTRA_CORES"

/**
 * A worker's share of the machine's `cores`: divided among the run's `concurrent` workers and
 * `others`, those running in the machine's other runs, no more workers than `limit`, the cap on
 * them across the machine (0 for none); at least 1. Workers' checks share the cores: a test
 * runner, a linter or Go left alone runs as many things at once as there are cores, so several
 * workers' checks crowd the machine, every check takes two or three times as long, and tests time
 * out in code no ticket touched (tutti-0ye, tutti-kkb.24). As orchestra's coreShare.
 */
export const coreShare = (cores: number, concurrent: number, others = 0, limit = 0): number => {
  const all = Math.max(concurrent, 1) + Math.max(others, 0)
  const workers = limit > 0 ? Math.min(all, limit) : all
  return Math.max(Math.floor(cores / workers), 1)
}

/** Whether the go command's flags, `GOFLAGS`'s words, set -p, as the maintainer may. */
export const setsParallel = (flags: ReadonlyArray<string>): boolean =>
  flags.some((flag) => /^-+p(=|$)/.test(flag))

/**
 * A worker's share of the cores (coreShare) in its environment: TUTTI_CORES and ORCHESTRA_CORES,
 * for a project's check scripts, and `-p=<share>` after the GOFLAGS `goflags` has, unless those
 * set -p already, so that `go test ./...` runs no more packages at once than that.
 */
export const coreVariables = (share: number, goflags = ""): Record<string, string> => {
  const flags = goflags.split(/\s+/).filter((flag) => flag !== "")
  return {
    [coresVariable]: String(share),
    [orchestraCoresVariable]: String(share),
    ...(setsParallel(flags) ? {} : { GOFLAGS: [...flags, `-p=${share}`].join(" ") }),
  }
}

/** Bash's own maximum timeout, 10 minutes, which BASH_MAX_TIMEOUT_MS raises. */
export const bashMaxTimeout: Duration.Duration = Duration.minutes(10)

/**
 * Bash's timeouts for a worker whose merge check may take `checkTimeout` (checks.fast.timeout):
 * Claude Code's Bash moves a command to the background after 2 minutes unless given a longer
 * timeout, and a worker waiting on a check in the background looks idle (tutti-kkb.11). The
 * default is the check's limit, so a check run with no timeout of its own has its time; the
 * maximum is that or Bash's own 10 minutes, whichever is longer.
 */
export const bashTimeouts = (checkTimeout: Duration.Duration): Record<string, string> => {
  const check = Math.ceil(Duration.toMillis(checkTimeout))
  return {
    BASH_DEFAULT_TIMEOUT_MS: String(check),
    BASH_MAX_TIMEOUT_MS: String(Math.max(check, Duration.toMillis(bashMaxTimeout))),
  }
}

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
  /** The merge check's time limit (checks.fast.timeout), for Bash's timeouts; workers only. */
  readonly checkTimeout?: Duration.Duration
  /** The worker's share of the machine's cores (coreShare), for its checks; workers only. */
  readonly cores?: number
}

/**
 * A worker's (or an organ's) environment: `env` with tutti's variables laid over it, without
 * ANTHROPIC_API_KEY when there is a subscription login and billing isn't api, and given its share
 * of the cores, coreVariables (after the environment's GOFLAGS). Unset variables and the terminal
 * pane's (paneVariable) are left out.
 */
export const workerEnv = (options: WorkerEnvOptions): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined && !paneVariable(name)) result[name] = value
  }
  Object.assign(result, workerVariables(options.version, options.checkTimeout))
  if (options.cores !== undefined)
    Object.assign(result, coreVariables(options.cores, result.GOFLAGS))
  if (options.subscription && options.billing !== "api") delete result[apiKeyVariable]
  return result
}

/** The account probe's environment: a worker's, always without the key, to find the login (§ 4.13). */
export const probeEnv = (
  options: Omit<WorkerEnvOptions, "subscription" | "billing" | "checkTimeout" | "cores">,
): Record<string, string> => workerEnv({ ...options, subscription: true, billing: "subscription" })
