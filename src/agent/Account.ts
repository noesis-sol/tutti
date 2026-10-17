// Account (§ 3.3, § 4.13): the login probe. It starts one Claude Code session with the workers'
// options and sends it nothing, so it costs no model turn, and reads what the session says of
// itself: the account it is logged in to, the permission mode in effect, and the settings files it
// skipped for errors. It runs without ANTHROPIC_API_KEY, to find a subscription login the key
// would otherwise hide.
//
// From these and the run's billing choice it says how workers are billed: a subscription login,
// with the key removed from their environment, or the key. No login, and settings files Claude Code
// skipped (and with them your deny rules), are setup problems, and so is an untrusted main
// checkout, whose project allow rules Claude Code ignores. The probe fails with every one it finds,
// side by side in its cause, so a startup check can report every problem at once.
//
// Claude Code 2.1.301 doesn't put the skipped settings files in its initialization result, as the
// SDK's docs suggest: the session's settings (getSettings(), not in the SDK's types) list them. The
// probe reads both. Only its stderr says the main checkout isn't trusted, so the probe reads every
// line of it until the session's process has exited.
import type { ChildProcess } from "node:child_process"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { Cause, Context, Duration, Effect, Layer, Schema } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import type { billings } from "../cli/flags.ts"
import type { efforts, permissionModes } from "../project/settings.ts"
import { apiKeySet, apiKeyVariable, probeEnv } from "./env.ts"
import { spawnInOwnProcessGroup } from "./options.ts"

/** Not logged in to Claude, and no API key to use instead. */
export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()("NotLoggedIn", {}) {
  override get message(): string {
    return "Not logged in to Claude: run claude /login, or tutti login"
  }
}

/** A settings file Claude Code skipped for an error, and the error. */
export const SettingsFileError = Schema.Struct({
  /** The file, when Claude Code names it. */
  file: Schema.NullOr(Schema.String),
  /** The key path of the field in error, empty for the whole file. */
  path: Schema.String,
  message: Schema.String,
})
export type SettingsFileError = typeof SettingsFileError.Type

/** A settings file's error as a sentence: `<file>: <key path>: <message>`. */
export const showSettingsFileError = (error: SettingsFileError): string =>
  [error.file ?? "a settings file", ...(error.path === "" ? [] : [error.path]), error.message].join(
    ": ",
  )

/**
 * Settings files Claude Code skipped for errors. It applies none of the rules in them, permission
 * allow and deny lists included, and workers must not run without your deny rules.
 */
export class SettingsUnreadable extends Schema.TaggedError<SettingsUnreadable>()(
  "SettingsUnreadable",
  { errors: Schema.Array(SettingsFileError) },
) {
  override get message(): string {
    return this.errors
      .map(
        (error) =>
          `Claude Code skips a settings file it can't read, and the permission rules in it: ${showSettingsFileError(error)}`,
      )
      .join("\n")
  }
}

/**
 * The main checkout hasn't been trusted in Claude Code, which then ignores the permissions.allow
 * rules in its project settings: workers would ask, or leave to auto mode, what the project allows.
 */
export class UntrustedCheckout extends Schema.TaggedError<UntrustedCheckout>()(
  "UntrustedCheckout",
  {
    /** The main checkout. */
    checkout: Schema.String,
    /** The settings files whose allow rules are ignored, as Claude Code names them; null where it doesn't. */
    files: Schema.Array(Schema.NullOr(Schema.String)),
  },
) {
  override get message(): string {
    const files = this.files.map((file) => file ?? "the project's settings").join(", ")
    return `Claude Code ignores the permissions.allow rules in ${files}: ${this.checkout} isn't trusted. Run claude once in ${this.checkout} and accept the trust dialog, or run tutti init to mark it trusted.`
  }
}

/** The probe session didn't start, or didn't say what it is, in time. */
export class AccountProbeFailed extends Schema.TaggedError<AccountProbeFailed>()(
  "AccountProbeFailed",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The account probe couldn't start Claude Code: ${this.reason}`
  }
}

export type AccountError = NotLoggedIn | SettingsUnreadable | UntrustedCheckout | AccountProbeFailed

/** The account a session is logged in to, as Claude Code reports it; null where it says nothing. */
export interface AccountInfo {
  readonly email: string | null
  readonly organization: string | null
  /** The claude.ai plan of a subscription login: `Claude Max`, say. */
  readonly subscriptionType: string | null
  /** Where an API key comes from, when one is used: `apiKeyHelper`, `/login managed key`, … */
  readonly apiKeySource: string | null
  /** The API backend: `firstParty` for Anthropic's, else a cloud provider or a gateway. */
  readonly apiProvider: string | null
}

/** What a probe session says of itself. */
export interface Initialization {
  readonly account: AccountInfo
  /** The permission mode in effect; null when Claude Code doesn't say. */
  readonly permissionMode: string | null
  /** The settings files it skipped, each once. */
  readonly settingsErrors: ReadonlyArray<SettingsFileError>
  /** The settings files whose allow rules it ignores in an untrusted workspace, each once. */
  readonly untrustedFiles: ReadonlyArray<string | null>
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null

const settingsErrorsIn = (value: unknown): Array<SettingsFileError> =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const error = record(entry)
        return typeof error.message === "string"
          ? [
              {
                file: text(error.file),
                path: typeof error.path === "string" ? error.path : "",
                message: error.message,
              },
            ]
          : []
      })
    : []

/**
 * Whether a line of Claude Code's stderr says it ignores permissions.allow rules because the
 * workspace hasn't been trusted: `permissions.allow` and `not been trusted` in it, whatever the
 * count, file or punctuation (§ 4.13).
 */
export const ignoresAllowRules = (line: string): boolean =>
  line.includes("permissions.allow") && line.includes("not been trusted")

/** The settings file such a line names (`… entry from <file>: …`), or null when it names none. */
export const ignoredAllowFile = (line: string): string | null => {
  const named = /\bfrom (.+?):\s/.exec(line.slice(line.indexOf("permissions.allow")))
  return text(named?.[1]?.trim())
}

/** The files whose allow rules Claude Code's stderr, `stderr`, says it ignores, each once. */
export const untrustedFilesIn = (stderr: string): Array<string | null> => [
  ...new Set(stderr.split(/\r?\n/).filter(ignoresAllowRules).map(ignoredAllowFile)),
]

/**
 * Reads a session's initialization result, its settings (`getSettings()`'s answer) and its stderr,
 * each as Claude Code sent it. A field it leaves out, or sends with another type, reads as nothing.
 */
export const readInitialization = (
  init: unknown,
  settings: unknown,
  stderr = "",
): Initialization => {
  const result = record(init)
  const account = record(result.account)
  const seen = new Set<string>()
  const settingsErrors = [
    ...settingsErrorsIn(result.errors),
    ...settingsErrorsIn(record(settings).errors),
  ].filter((error) => {
    const key = JSON.stringify([error.file, error.path, error.message])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    account: {
      email: text(account.email),
      organization: text(account.organization),
      subscriptionType: text(account.subscriptionType),
      apiKeySource: text(account.apiKeySource),
      apiProvider: text(account.apiProvider),
    },
    permissionMode: text(result.current_permission_mode),
    settingsErrors,
    untrustedFiles: untrustedFilesIn(stderr),
  }
}

/** How workers are billed (§ 4.13). */
export type Billing =
  /** The subscription login; `keyUnused` when ANTHROPIC_API_KEY is set and removed from workers. */
  | { readonly _tag: "Subscription"; readonly keyUnused: boolean }
  /** ANTHROPIC_API_KEY, kept in workers' environment. */
  | { readonly _tag: "ApiKey" }
  /** Another login Claude Code finds itself: a key from apiKeyHelper or /login, a cloud provider. */
  | { readonly _tag: "Other"; readonly source: string }

/** The `START` block's billing line. */
export const billingLine = (billing: Billing): string => {
  switch (billing._tag) {
    case "Subscription":
      return billing.keyUnused
        ? `billing: subscription (${apiKeyVariable} is set but not used; --billing api uses it)`
        : "billing: subscription"
    case "ApiKey":
      return "billing: API key"
    case "Other":
      return `billing: ${billing.source}`
  }
}

/** The permission mode workers asked for, and the one in effect. */
export interface PermissionModeInEffect {
  readonly requested: (typeof permissionModes)[number]
  readonly inEffect: string
}

/** The `START` block's permission-mode line (§ 4.1). */
export const permissionModeLine = (mode: PermissionModeInEffect): string =>
  mode.inEffect === mode.requested
    ? `permission mode: ${mode.inEffect}`
    : `permission mode: ${mode.inEffect} (${mode.requested} mode isn't available here)`

/** What the probe found. */
export interface AccountProbe {
  readonly account: AccountInfo
  readonly billing: Billing
  /** Whether there is a subscription login; workerEnv takes it. */
  readonly subscription: boolean
  readonly permissionMode: PermissionModeInEffect
}

/** What the probe's findings are read against. */
export interface Assessing {
  /** Whether ANTHROPIC_API_KEY is set in tutti's environment. */
  readonly keySet: boolean
  readonly billing: (typeof billings)[number]
  readonly requestedMode: (typeof permissionModes)[number]
  /** The main checkout, the probe session's folder. */
  readonly checkout: string
}

/** The login a probe run without the key found. */
const loginOf = (account: AccountInfo): Billing | null => {
  if (account.apiProvider !== null && account.apiProvider !== "firstParty") {
    return { _tag: "Other", source: account.apiProvider }
  }
  if (account.apiKeySource !== null && account.apiKeySource !== "none") {
    return { _tag: "Other", source: account.apiKeySource }
  }
  if (account.subscriptionType !== null || account.email !== null) {
    return { _tag: "Subscription", keyUnused: false }
  }
  return null
}

/**
 * The probe's findings from what a session run without the key said: its account, how workers are
 * billed, and the permission mode in effect; or every setup problem it found: no login, skipped
 * settings files, an untrusted main checkout.
 */
export const assess = (
  init: Initialization,
  against: Assessing,
): Effect.Effect<AccountProbe, NotLoggedIn | SettingsUnreadable | UntrustedCheckout> => {
  const login = loginOf(init.account)
  const billing: Billing | null =
    login?._tag === "Subscription"
      ? against.keySet && against.billing === "api"
        ? { _tag: "ApiKey" }
        : { _tag: "Subscription", keyUnused: against.keySet }
      : against.keySet
        ? { _tag: "ApiKey" }
        : login
  const failures: Array<NotLoggedIn | SettingsUnreadable | UntrustedCheckout> = []
  if (billing === null) failures.push(new NotLoggedIn())
  if (init.settingsErrors.length > 0) {
    failures.push(new SettingsUnreadable({ errors: init.settingsErrors }))
  }
  if (init.untrustedFiles.length > 0) {
    failures.push(new UntrustedCheckout({ checkout: against.checkout, files: init.untrustedFiles }))
  }
  if (failures.length > 0 || billing === null) {
    return Effect.failCause(Cause.fromReasons(failures.map(Cause.makeFailReason)))
  }
  return Effect.succeed({
    account: init.account,
    billing,
    subscription: login?._tag === "Subscription",
    permissionMode: {
      requested: against.requestedMode,
      inEffect: init.permissionMode ?? against.requestedMode,
    },
  })
}

/** The options of the probe session: the workers', with no MCP server and no key. */
export interface ProbeOptions {
  /** The main checkout, as the session's folder and its project settings' root. */
  readonly repo: string
  readonly permissionMode: (typeof permissionModes)[number]
  readonly model: string | null
  readonly effort: (typeof efforts)[number] | null
  /** The Claude Code to run; null for the SDK's. */
  readonly claude: string | null
  readonly env: Record<string, string>
}

/** Starts a probe session and reads what it says of itself. */
export type StartProbe = (
  options: ProbeOptions,
) => Effect.Effect<Initialization, AccountProbeFailed>

/** How long the probe session has to start and answer. */
export const probeTimeout = Duration.minutes(1)

/** A prompt that sends nothing until `signal` aborts, and then ends. */
async function* nothing(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
}

/** How long the probe's Claude Code has to exit once closed, before tutti kills its process group. */
export const probeCloseLimit = Duration.seconds(10)

/** The probe's Claude Code, once the SDK has spawned it, and when its stderr has closed. */
interface Spawned {
  child: ChildProcess | undefined
  closed: Promise<void> | undefined
}

/** Kills `child`'s process group (it leads one); never a missing or bad PID. */
const killGroup = (child: ChildProcess) =>
  Effect.sync(() => {
    const pid = child.pid
    if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  })

/**
 * The live probe: one Agent SDK session, closed once it has answered, its stderr read until its
 * process has exited, since the stderr and the answers arrive on different pipes.
 */
export const startProbe: StartProbe = (options) =>
  Effect.gen(function* () {
    const stderr: Array<string> = []
    const answers = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const abortController = new AbortController()
        const spawned: Spawned = { child: undefined, closed: undefined }
        const spawn = spawnInOwnProcessGroup((data) => stderr.push(data))
        const session = query({
          prompt: nothing(abortController.signal),
          options: {
            cwd: options.repo,
            projectConfigRoot: options.repo,
            settingSources: ["user", "project", "local"],
            permissionMode: options.permissionMode,
            ...(options.model === null ? {} : { model: options.model }),
            ...(options.effort === null ? {} : { effort: options.effort }),
            mcpServers: {},
            strictMcpConfig: true,
            persistSession: false,
            env: options.env,
            ...(options.claude === null ? {} : { pathToClaudeCodeExecutable: options.claude }),
            spawnClaudeCodeProcess: (spawnOptions) => {
              const child = spawn(spawnOptions)
              spawned.child = child
              // "close" comes once the process has exited and its stdio has closed.
              spawned.closed = new Promise((resolve) => child.once("close", () => resolve()))
              return child
            },
            abortController,
          },
        })
        return { session, abortController, spawned }
      }),
      ({ session }) =>
        Effect.tryPromise({
          try: async () => {
            const init = await session.initializationResult()
            // Not in the SDK's types: the session's settings, with the files it skipped.
            const getSettings = (session as { getSettings?: () => Promise<unknown> }).getSettings
            const settings = getSettings === undefined ? undefined : await getSettings.call(session)
            return { init, settings }
          },
          catch: (cause) =>
            new AccountProbeFailed({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: probeTimeout,
            orElse: () =>
              Effect.fail(
                new AccountProbeFailed({
                  reason: `no answer within ${Duration.format(probeTimeout)}`,
                }),
              ),
          }),
        ),
      ({ session, abortController, spawned }) =>
        Effect.gen(function* () {
          session.close()
          const { child, closed } = spawned
          if (child !== undefined && closed !== undefined) {
            yield* Effect.promise(() => closed).pipe(
              Effect.timeoutOrElse({ duration: probeCloseLimit, orElse: () => killGroup(child) }),
            )
          }
          abortController.abort()
        }),
    )
    return readInitialization(answers.init, answers.settings, stderr.join(""))
  })

export class Account extends Context.Service<
  Account,
  {
    /** Runs the probe: the account, billing and permission mode, or every setup problem found. */
    readonly probe: Effect.Effect<AccountProbe, AccountError>
  }
>()("tutti/agent/Account") {
  /**
   * The layer with `start` for the probe session, and `env` as tutti's environment: the live
   * layer's are the Agent SDK and process.env.
   */
  static readonly layerWith = (
    start: StartProbe,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) =>
    Layer.effect(
      Account,
      Effect.gen(function* () {
        const config = yield* AppConfig
        const { workers } = config.settings
        const probe = Effect.gen(function* () {
          const init = yield* start({
            repo: config.repo,
            permissionMode: workers.permission_mode,
            model: workers.model,
            effort: workers.effort,
            claude: config.claude,
            env: probeEnv({ env }),
          })
          return yield* assess(init, {
            keySet: apiKeySet(env),
            billing: config.billing,
            requestedMode: workers.permission_mode,
            checkout: config.repo,
          })
        })
        return Account.of({ probe })
      }),
    )

  static readonly layer = Account.layerWith(startProbe)
}
