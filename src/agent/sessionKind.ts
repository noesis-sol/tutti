// What a session AgentHost opens is for (§ 4.1, § 4.9, § 4.10, § 4.14): a ticket's worker, the
// environment probe, or a session of the Interview kind: a feature's or a spec's breakdown, or a
// question's talk. Each kind decides the session's prompt, its MCP servers and its
// options; serversOf is the one rule for its servers that both of AgentHost's layers read, and the
// live one plans the rest by kind (AgentHostLive's planOf).
import { Data } from "effect"
import type { InterviewSetup, Session } from "./AgentHost.ts"
import { type ChosenServers, inProcess, noServers } from "./mcp.ts"
import { serverName } from "./ticketTools.ts"

/** What a session is for, which decides its prompt, its MCP servers and its options. */
export type SessionKind = Data.TaggedEnum<{
  /** A ticket's worker, in its worktree: the worker prompt and the workers' MCP servers. */
  Worker: Record<never, never>
  /**
   * A session with no ticket, the environment probe's (§ 4.9): no MCP servers and no worker
   * prompt, in the main checkout.
   */
  Probe: Record<never, never>
  /**
   * A breakdown's session (§ 4.10, § 4.14), a feature's or a spec's, or a question's talk (§ 4.11),
   * in the main checkout: its instructions, its built-in tools and tutti's own MCP server in place
   * of the worker prompt and the workers' servers.
   */
  Interview: InterviewSetup
}>

export const SessionKind = Data.taggedEnum<SessionKind>()

/** What `session` is for: a worker's when it doesn't say. */
export const kindOf = (session: Session): SessionKind => session.kind ?? SessionKind.Worker()

/**
 * The MCP servers a session of `kind` is given, `workers` being the workers': none for the probe,
 * tutti's own and Chrome as workers have it for the Interview kind. The live host adds a worker's own
 * server (withOwn) to the workers'.
 */
export const serversOf = (kind: SessionKind, workers: ChosenServers): ChosenServers =>
  SessionKind.$match(kind, {
    Worker: () => workers,
    Probe: () => noServers,
    Interview: (setup) => inProcess(serverName, setup.server, workers.chrome === true),
  })
