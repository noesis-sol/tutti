// tutti login (§ 4.13, § 8.1): Claude Code's own claude.ai login, `<claude> auth login`, run with
// the terminal's stdin, stdout and stderr (docs/spikes/07-compile.md, § 5). It opens the browser,
// prints the URL in case it didn't open, and waits for a code to be pasted. The Claude Code is the
// one workers run, as resolveClaude (src/agent/claudeBinary.ts) resolves it for a run: --claude's
// (TUTTI_CLAUDE), else a compiled build's embedded one, extracted; from source, where it resolves
// none, the SDK's platform package's. Once it has exited, the login probe, run with that Claude
// Code, says which account the workers will use, and how they are billed.
//
// The login runs in tutti's process group, not one of its own as other commands do: it reads the
// terminal, which only its foreground group may.
import { createRequire } from "node:module"
import { Console, Effect, Exit, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Account, type AccountInfo, type AccountProbe, billingLine } from "../agent/Account.ts"
import type { Claude } from "../agent/claudeBinary.ts"
import { onMusl } from "../native/musl.ts"
import { failures } from "../run/startup.ts"
import { AppConfig } from "./AppConfig.ts"

/** A command and its arguments. */
export interface CommandLine {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/** The SDK's package; the platform packages, each with its Claude Code, are named after it. */
const sdkPackage = "@anthropic-ai/claude-agent-sdk"

/**
 * The platform packages' Claude Code for `platform` and `arch`, in the order the SDK tries them:
 * on Linux, the libc's own first, then the other.
 */
export const sdkClaudes = (platform: string, arch: string, musl: boolean): Array<string> => {
  const packages =
    platform === "android"
      ? [`${sdkPackage}-linux-${arch}-android`]
      : platform === "linux"
        ? musl
          ? [`${sdkPackage}-linux-${arch}-musl`, `${sdkPackage}-linux-${arch}`]
          : [`${sdkPackage}-linux-${arch}`, `${sdkPackage}-linux-${arch}-musl`]
        : [`${sdkPackage}-${platform}-${arch}`]
  const exe = platform === "win32" ? ".exe" : ""
  return packages.map((name) => `${name}/claude${exe}`)
}

/**
 * The embedded Claude Code, the one the SDK runs when it isn't given another: its platform
 * package's, resolved from the SDK's own folder. Null when none is installed.
 */
export const embeddedClaude = (): string | null => {
  let resolve: (id: string) => string
  try {
    resolve = createRequire(import.meta.resolve(sdkPackage)).resolve
  } catch {
    return null
  }
  for (const id of sdkClaudes(process.platform, process.arch, onMusl())) {
    try {
      return resolve(id)
    } catch {
      // Not this one.
    }
  }
  return null
}

/**
 * The login's command line: `<claude> auth login`, with `claude` the path resolveClaude resolved,
 * else the `embedded` one; null when there is neither.
 */
export const loginCommandLine = (
  claude: string | null,
  embedded: () => string | null,
): CommandLine | null => {
  const path = claude ?? embedded()
  return path === null ? null : { command: path, args: ["auth", "login"] }
}

/** The login didn't run, didn't succeed, or the probe after it found problems: each a sentence. */
export class LoginFailed extends Schema.TaggedError<LoginFailed>()("LoginFailed", {
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return this.problems.join("\n")
  }
}

/** The live RunInTerminal: effect/process, with stdin, stdout and stderr inherited. */
export const runInTerminal = (line: CommandLine) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const code = yield* spawner.exitCode(
      ChildProcess.make(line.command, line.args, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false,
      }),
    )
    return Number(code)
  }).pipe(
    Effect.mapError(
      (error) => new LoginFailed({ problems: [`couldn't run ${line.command}: ${error.message}`] }),
    ),
  )

/** The account's line: `account: <email>, <organization>, <plan>`, each where Claude Code says it. */
export const accountLine = (account: AccountInfo): string => {
  const known = [account.email, account.organization, account.subscriptionType].filter(
    (part) => part !== null,
  )
  return `account: ${known.length === 0 ? "no claude.ai account" : known.join(", ")}`
}

/** What tutti login prints once the probe has run: the account and its billing. */
export const loginReport = (probe: AccountProbe): ReadonlyArray<string> => [
  accountLine(probe.account),
  billingLine(probe.billing),
]

/**
 * tutti login: runs Claude Code's login with `run`, with the Claude Code that `claude`
 * (resolveClaude, from the folder tutti was started in) resolves from the configuration's --claude,
 * `embedded` when it resolves none; then the probe, `account`, with that Claude Code, and prints the
 * account and its billing. The resolution's warnings go to stderr; its problems stop the login
 * before it runs.
 */
export const login = <R, RA, RC>(
  run: (line: CommandLine) => Effect.Effect<number, LoginFailed, R>,
  account: Layer.Layer<Account, never, AppConfig | RA>,
  claude: (given: string | null) => Effect.Effect<Claude, never, RC>,
  embedded: () => string | null = embeddedClaude,
) =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const resolved = yield* claude(config.claude)
    for (const warning of resolved.warnings) yield* Console.error(`tutti login: ${warning}`)
    if (resolved.problems.length > 0) {
      return yield* new LoginFailed({ problems: resolved.problems })
    }
    const line = loginCommandLine(resolved.path, embedded)
    if (line === null) {
      return yield* new LoginFailed({
        problems: ["no embedded Claude Code was found: run tutti login --claude <path>"],
      })
    }
    const code = yield* run(line)
    if (code !== 0) {
      return yield* new LoginFailed({
        problems: [`Claude Code's login exited with status ${code}`],
      })
    }
    const probed = yield* Effect.exit(
      Effect.flatMap(Account, (probe) => probe.probe).pipe(
        Effect.provide(
          Layer.provide(account, Layer.succeed(AppConfig, { ...config, claude: resolved.path })),
        ),
      ),
    )
    if (Exit.isFailure(probed)) {
      const problems = failures(probed.cause)
      if (problems.length === 0) return yield* Effect.failCause(probed.cause)
      return yield* new LoginFailed({ problems })
    }
    for (const reported of loginReport(probed.value)) yield* Console.log(reported)
  })
