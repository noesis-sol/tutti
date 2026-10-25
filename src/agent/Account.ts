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
// SDK's docs suggest: the session's settings (ClaudeSession's settings) list them. The probe reads
// both. Only its stderr says the main checkout isn't trusted, which Claude Code writes as it loads
// its settings, before it answers initialize: the probe reads what came until then. Closed, Claude
// Code takes about 0.75 s to exit, flushing its telemetry: the probe answers without waiting for
// that, and the exit is awaited in the background, in the probe's Scope.
import { Cause, Context, Duration, Effect, Exit, Layer, Predicate, Schema, Scope } from "effect"
import { AppConfig, type AppConfigValue } from "../cli/AppConfig.ts"
import type { billings } from "../cli/flags.ts"
import type { permissionModes } from "../project/settings.ts"
import { BilledAs, ClaudeCode } from "./ClaudeCode.ts"
import { apiKeySet, apiKeyVariable } from "./env.ts"
import { probeOptions } from "./options.ts"
import { stderrQuoted } from "./sessionProcess.ts"

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

const record = (value: unknown): Record<string, unknown> => (Predicate.isObject(value) ? value : {})

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

/**
 * The `START` block's billing line. `organsOnKey` when organs bill ANTHROPIC_API_KEY over the
 * Messages API (TUTTI_ORGAN_PROVIDER=anthropic), whatever bills workers.
 */
export const billingLine = (billing: Billing, organsOnKey = false): string => {
  if (organsOnKey) {
    const organs = `${apiKeyVariable} for organs (TUTTI_ORGAN_PROVIDER=anthropic)`
    switch (billing._tag) {
      case "Subscription":
        return `billing: subscription for workers, ${organs}`
      case "ApiKey":
        return "billing: API key, for workers and organs (TUTTI_ORGAN_PROVIDER=anthropic)"
      case "Other":
        return `billing: ${billing.source} for workers, ${organs}`
    }
  }
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
  /** The run's configuration, whose workers' settings the probe's session is started with. */
  readonly config: Pick<AppConfigValue, "repo" | "settings">
  /** tutti's environment, the probe's is made from: the workers' without ANTHROPIC_API_KEY. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Starts a probe session and reads what it says of itself; R may hold the Scope its close is in. */
export type StartProbe<R = never> = (
  options: ProbeOptions,
) => Effect.Effect<Initialization, AccountProbeFailed, R>

/** How long the probe session has to start and answer. */
export const probeTimeout = Duration.minutes(1)

/** A prompt that sends nothing until `signal` aborts, and then ends. */
async function* nothing(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
}

/** How long the probe's Claude Code has to exit once closed, before tutti kills its process group. */
export const probeCloseLimit = Duration.seconds(10)

/** The probe's time limits: the live probe's are probeTimeout and probeCloseLimit. */
export interface ProbeLimits {
  /** How long the session has to start and answer. */
  readonly timeout: Duration.Duration
  /** How long its Claude Code has to exit once closed, before its process group is killed. */
  readonly closeLimit: Duration.Duration
}

/**
 * The probe over ClaudeCode: one session, closed once it has answered, with what it wrote to stderr
 * until then. Its Claude Code's exit is awaited in a fiber of the Scope, whose close waits for it,
 * so the probe answers without waiting out Claude Code's exit flush. A session that can't be
 * launched, as when there is no Claude Code, fails it.
 */
export const startProbeWith =
  (
    limits: ProbeLimits = { timeout: probeTimeout, closeLimit: probeCloseLimit },
  ): StartProbe<ClaudeCode | Scope.Scope> =>
  (options) =>
    Effect.gen(function* () {
      const claudeCode = yield* ClaudeCode
      const outer = yield* Effect.scope
      const sessionScope = yield* Scope.make()
      const stderr: Array<string> = []
      const answers = yield* Effect.gen(function* () {
        const ended = new AbortController()
        const session = yield* claudeCode
          .open({
            options: probeOptions({ config: options.config }),
            prompt: nothing(ended.signal),
            billedAs: BilledAs.LoginProbe(),
            env: options.env,
            onStderr: (data) => stderr.push(data),
            closeLimit: limits.closeLimit,
          })
          .pipe(Effect.mapError((error) => new AccountProbeFailed({ reason: error.reason })))
        // Its prompt ends once the session is closed.
        yield* Effect.addFinalizer(() => Effect.sync(() => ended.abort()))
        const answered = yield* Effect.all({
          init: session.initialization,
          settings: session.settings,
        }).pipe(
          // What Claude Code last wrote to stderr says why, where the SDK says only its exit code.
          Effect.mapError(
            (error) => new AccountProbeFailed({ reason: error.quoted(stderrQuoted) }),
          ),
          Effect.timeoutOrElse({
            duration: limits.timeout,
            orElse: () =>
              Effect.fail(
                new AccountProbeFailed({
                  reason: `no answer within ${Duration.format(limits.timeout)}`,
                }),
              ),
          }),
        )
        // The untrusted-checkout line comes before initialize's answer (the live contract test).
        return { ...answered, stderr: stderr.join("") }
      }).pipe(
        Scope.provide(sessionScope),
        // Closed now, its exit awaited in the background: uninterruptible, so that `outer`'s close
        // waits for it, and kills its process group after the close limit.
        Effect.ensuring(
          Effect.forkIn(Scope.close(sessionScope, Exit.void), outer, { uninterruptible: true }),
        ),
      )
      return readInitialization(answers.init, answers.settings, answers.stderr)
    })

/** The live probe, over Claude Code. */
export const startProbe: StartProbe<ClaudeCode | Scope.Scope> = startProbeWith()

export class Account extends Context.Service<
  Account,
  {
    /** Runs the probe: the account, billing and permission mode, or every setup problem found. */
    readonly probe: Effect.Effect<AccountProbe, AccountError>
  }
>()("tutti/agent/Account") {
  /**
   * The layer with `start` for the probe session, and `env` as tutti's environment: the live
   * layer's are startProbe, over ClaudeCode, and process.env.
   */
  static readonly layerWith = <R = never>(
    start: StartProbe<R>,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) =>
    Layer.effect(
      Account,
      Effect.gen(function* () {
        const config = yield* AppConfig
        const { workers } = config.settings
        const services = yield* Effect.context<R>()
        const probe = Effect.gen(function* () {
          const init = yield* Effect.provideContext(start({ config, env }), services)
          return yield* assess(init, {
            keySet: apiKeySet(env),
            billing: config.billing,
            requestedMode: workers.permission_mode,
            checkout: config.repo,
          })
        })
        return Account.of({ probe: probe.pipe(Effect.withSpan("Account.probe")) })
      }),
    )

  /** The live layer, over the Agent SDK. */
  static readonly layer = Account.layerWith(startProbe).pipe(Layer.provide(ClaudeCode.layer))
}
