// What the live AgentHost reads of a starting session and of the messages it sends (§ 4.1, § 4.6,
// § 4.13); the scripted host is the live one over scripted sessions, so scenarios read them so.
//
// A session is checked before it is sent anything (before), from its initialize answer and its
// mcpServerStatus(): the API key source of its account, and the MCP servers the status lists
// (checkStatus). Its first system/init is checked again (first): the permission mode in effect,
// logged once when it isn't the one asked for; the MCP servers, where any the worker wasn't given
// ends it as a setup problem (checkInit); and the API key source, where a key billed beside the
// subscription login ends it likewise. Those fields are decoded with a Schema, not trusted to the
// SDK's types: a system/init without the permission mode or the API key source skips that check,
// logged once in the run (uncheckedLine).
//
// Beside the worker's state, a message tells its host, as it was read (src/agent/reading.ts), the
// CLI's capabilities a system/init lists, as the initialize answer does (capabilitiesOf), and a
// result's startup_failure_reason, which ends the worker. A start that fails says why as
// startFailure words it.
import { type Cause, Effect, Exit, Option, Ref, Result, Schema } from "effect"
import type { SetupProblem } from "../cli/AppConfig.ts"
import { detail, type Line, type Log, line } from "../run/log.ts"
import type { TicketId } from "../services/Beads.ts"
import { type Billing, type PermissionModeInEffect, permissionModeLine } from "./Account.ts"
import { type ChosenServers, checkInit, checkStatus } from "./mcp.ts"
import { withStderr } from "./sessionProcess.ts"

/** The capability system/init advertises when an interrupt can cancel the queued messages. */
export const cancelQueuedCapability = "interrupt_cancel_queued_v1"

/** The API key source system/init gives a session billed to the subscription login. */
const noKey = "none"

// The fields `first` reads of a session's first system/init beside its MCP servers (checkInit),
// each decoded on its own, so that one missing skips only its own check.
const decodePermissionMode = Schema.decodeUnknownResult(
  Schema.Struct({ permissionMode: Schema.String }),
)
const decodeApiKeySource = Schema.decodeUnknownResult(
  Schema.Struct({ apiKeySource: Schema.String }),
)
// The API key source of a session's initialize answer, which `before` reads.
const decodeAccountKey = Schema.decodeUnknownResult(
  Schema.Struct({ account: Schema.Struct({ apiKeySource: Schema.String }) }),
)

/** The problems a check of the MCP servers failed with, as one. */
const problemsIn = (cause: Cause.Cause<SetupProblem>): string =>
  cause.reasons
    .flatMap((reason) => (reason._tag === "Fail" ? reason.error.problems : []))
    .join("; ")

/** The log line when the first system/init lacks `field`, so tutti doesn't check `what`. */
export const uncheckedLine = (field: string, what: string): string =>
  `system/init gives no ${field} tutti can read, so it doesn't check ${what}`

/** The problem when a worker would bill an API key while billing is the subscription login. */
export const apiKeyProblem = (source: string): string =>
  `workers would bill an API key (${source}), not the subscription login: Claude Code finds it in its own settings or login; remove it there, or run with --billing api`

/** Whether a session with `source` as its API key source bills a key though `billing` says not. */
export const billedKey = (billing: Billing, source: string | undefined): boolean =>
  billing._tag === "Subscription" && source !== undefined && source !== noKey

/** The log line when `ticket`'s worker ends over a setup problem, before it does anything. */
export const setupLine = (ticket: TicketId, problem: string): Line => detail`${ticket}: ${problem}`

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The log line for a message tutti died taking in, a CLI of another version sending a shape it
 * didn't expect: the message is skipped, and the session reads on.
 */
export const skippedLine = (ticket: TicketId, defect: unknown): Line =>
  detail`${ticket}: a message tutti couldn't take in, skipped: ${messageOf(defect)}`

/** Why a worker is gone, and its start failed, when Claude Code couldn't be spawned (§ 4.8). */
export const launchFailed = "Claude Code couldn't be launched"

// The SDK reports any spawn that fails as a libc mismatch (docs/spikes/02-sdk-lifecycle.md § 3).
/** Whether `message`, from the SDK, is a spawn that failed. */
export const isLaunchFailure = (message: string): boolean => message.includes("failed to launch")

/**
 * The reason a session didn't start, from its startup_failure_reason, if it sent one, and what
 * failed its initialize.
 */
export const startFailure = (
  refused: string | undefined,
  message: string,
  stderr: string,
): string => {
  if (refused !== undefined) return `Claude Code refused to start: ${refused}`
  return withStderr(isLaunchFailure(message) ? launchFailed : message, stderr)
}

/** A run's checks of its sessions' starts; each logs what it skips once in the run. */
export interface SessionChecks {
  /** Checks a session's first system/init, `init`, given `servers`: the setup problem it shows. */
  readonly first: (
    init: unknown,
    servers: ChosenServers,
    /** The mode this session asked for, where it isn't the workers': a headless breakdown's. */
    own?: string,
  ) => Effect.Effect<string | undefined>
  /**
   * Checks a session before it is sent anything, from its initialize answer, `initialized`, and
   * its mcpServerStatus() answer, `status`, when it gave one: the setup problem they show. What
   * either doesn't say, or says in a shape tutti can't read, is left to `first`.
   */
  readonly before: (
    initialized: unknown,
    status: Option.Option<unknown>,
    servers: ChosenServers,
  ) => Effect.Effect<string | undefined>
}

/** The checks of a run whose workers ask for `permissionMode` and are billed as `billing` says. */
export const makeChecks = (input: {
  readonly log: Log["Service"]
  readonly permissionMode: PermissionModeInEffect["requested"]
  readonly billing: Billing
}): Effect.Effect<SessionChecks> =>
  Effect.gen(function* () {
    const { log, permissionMode: requested, billing } = input
    // Whether a session's permission mode in effect, not the one asked for, has been logged.
    const modeSaid = yield* Ref.make(false)
    // The fields of the first system/init whose check was skipped, logged once each (unchecked).
    const uncheckedFields = yield* Ref.make<ReadonlySet<string>>(new Set())

    /** Logs, once in the run, that the first system/init lacks `field`, so `what` isn't checked. */
    const unchecked = (field: string, what: string) =>
      Effect.gen(function* () {
        const first = yield* Ref.modify(uncheckedFields, (fields) =>
          fields.has(field) ? [false, fields] : [true, new Set([...fields, field])],
        )
        if (first) yield* log.write(line`${uncheckedLine(field, what)}`)
      })

    const first = (init: unknown, servers: ChosenServers, own?: string) =>
      Effect.gen(function* () {
        const mode = decodePermissionMode(init)
        // A session of its own mode, a headless breakdown's, says nothing of the workers'.
        if (own === undefined && Result.isFailure(mode)) {
          yield* unchecked("permissionMode", `the permission mode in effect is ${requested}`)
        } else if (
          own === undefined &&
          Result.isSuccess(mode) &&
          mode.success.permissionMode !== requested
        ) {
          const inEffect = mode.success.permissionMode
          if (!(yield* Ref.getAndSet(modeSaid, true))) {
            yield* log.write(line`${permissionModeLine({ requested, inEffect })}`)
          }
        }
        const mcp = yield* Effect.exit(checkInit(init, servers))
        if (Exit.isFailure(mcp)) return problemsIn(mcp.cause)
        if (billing._tag !== "Subscription") return undefined
        const key = decodeApiKeySource(init)
        if (Result.isFailure(key)) {
          yield* unchecked(
            "apiKeySource",
            "that workers bill the subscription login, not an API key",
          )
          return undefined
        }
        if (billedKey(billing, key.success.apiKeySource)) {
          return apiKeyProblem(key.success.apiKeySource)
        }
        return undefined
      })

    const before = (initialized: unknown, status: Option.Option<unknown>, servers: ChosenServers) =>
      Effect.gen(function* () {
        if (Option.isSome(status)) {
          const mcp = yield* Effect.exit(checkStatus(status.value, servers))
          if (Exit.isFailure(mcp)) return problemsIn(mcp.cause)
        }
        const key = decodeAccountKey(initialized)
        if (Result.isSuccess(key)) {
          const source = key.success.account.apiKeySource
          if (billedKey(billing, source)) return apiKeyProblem(source)
        }
        return undefined
      })

    return { first, before }
  })
