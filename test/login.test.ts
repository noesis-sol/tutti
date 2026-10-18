// tutti login (§ 4.13, § 8.1): `<claude> auth login` with the embedded Claude Code or --claude's,
// then the probe's account and billing; run with a recorded command and the Account test layer.
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Console, Effect, Exit, Layer } from "effect"
import { Account, NotLoggedIn, SettingsUnreadable } from "../src/agent/Account.ts"
import type { Claude } from "../src/agent/claudeBinary.ts"
import { AppConfig } from "../src/cli/AppConfig.ts"
import {
  accountLine,
  type CommandLine,
  embeddedClaude,
  type LoginFailed,
  login,
  loginCommandLine,
  loginReport,
  sdkClaudes,
} from "../src/cli/login.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"

const embedded = "/cache/tutti/claude-2.1.301/claude"

describe("loginCommandLine", () => {
  test("runs the embedded Claude Code's auth login", () => {
    expect(loginCommandLine(null, () => embedded)).toEqual({
      command: embedded,
      args: ["auth", "login"],
    })
  })

  test("runs --claude's Claude Code instead, without looking for the embedded one", () => {
    let looked = false
    const line = loginCommandLine("/opt/claude/bin/claude", () => {
      looked = true
      return embedded
    })
    expect(line).toEqual({ command: "/opt/claude/bin/claude", args: ["auth", "login"] })
    expect(looked).toBe(false)
  })

  test("is none without --claude and without an embedded Claude Code", () => {
    expect(loginCommandLine(null, () => null)).toBeNull()
  })
})

describe("the embedded Claude Code", () => {
  test("is the SDK's platform package's, as the SDK tries them", () => {
    const sdk = "@anthropic-ai/claude-agent-sdk"
    expect(sdkClaudes("darwin", "arm64", false)).toEqual([`${sdk}-darwin-arm64/claude`])
    expect(sdkClaudes("linux", "x64", false)).toEqual([
      `${sdk}-linux-x64/claude`,
      `${sdk}-linux-x64-musl/claude`,
    ])
    expect(sdkClaudes("linux", "arm64", true)).toEqual([
      `${sdk}-linux-arm64-musl/claude`,
      `${sdk}-linux-arm64/claude`,
    ])
    expect(sdkClaudes("win32", "x64", false)).toEqual([`${sdk}-win32-x64/claude.exe`])
  })

  test("is found from source, where the SDK's optional platform package is installed", () => {
    const path = embeddedClaude()
    expect(path).not.toBeNull()
    expect(existsSync(path ?? "")).toBe(true)
  })
})

describe("the report", () => {
  test("names the account and its billing", () => {
    expect(loginReport(TestAccount.accountProbe())).toEqual([
      "account: maintainer@example.com, Example, Claude Max",
      "billing: subscription",
    ])
  })

  test("leaves out what Claude Code doesn't say, and says when it says nothing", () => {
    const none = {
      email: null,
      organization: null,
      subscriptionType: null,
      apiKeySource: null,
      apiProvider: "bedrock",
    }
    expect(accountLine(none)).toBe("account: no claude.ai account")
    expect(accountLine({ ...none, email: "me@example.com" })).toBe("account: me@example.com")
  })
})

describe("login", () => {
  const run = (options: {
    claude?: string | null
    resolved?: Partial<Claude>
    exitCode?: number
    probe?: Parameters<typeof TestAccount.layer>[0]
  }) => {
    const ran: Array<CommandLine> = []
    const printed: Array<string> = []
    const errors: Array<string> = []
    const given: Array<string | null> = []
    const probedWith: Array<string | null> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
      error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
    })
    // The probe's layer, recording the Claude Code its configuration names.
    const account = Layer.effect(
      Account,
      Effect.gen(function* () {
        probedWith.push((yield* AppConfig).claude)
        return yield* Account
      }).pipe(Effect.provide(TestAccount.layer(options.probe))),
    )
    const exit = Effect.runSync(
      login(
        (line) =>
          Effect.sync(() => {
            ran.push(line)
            return options.exitCode ?? 0
          }),
        account,
        (claude) =>
          Effect.sync(() => {
            given.push(claude)
            return { path: claude, warnings: [], problems: [], ...options.resolved }
          }),
        () => embedded,
      ).pipe(
        Effect.provide(
          TestAppConfig.layer(TestAppConfig.appConfig({ claude: options.claude ?? null })),
        ),
        Effect.provideService(Console.Console, console),
        Effect.exit,
      ),
    )
    return { ran, printed, errors, given, probedWith, exit }
  }

  const problems = (exit: Exit.Exit<void, unknown>) =>
    Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
      ? (exit.cause.reasons[0].error as LoginFailed).problems
      : []

  test("runs the embedded Claude Code's login, then prints the account and billing", () => {
    const { ran, printed, exit } = run({})
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(ran).toEqual([{ command: embedded, args: ["auth", "login"] }])
    expect(printed).toEqual([
      "account: maintainer@example.com, Example, Claude Max",
      "billing: subscription",
    ])
  })

  test("runs --claude's login when the configuration names one", () => {
    const { ran } = run({ claude: "/opt/claude/bin/claude" })
    expect(ran).toEqual([{ command: "/opt/claude/bin/claude", args: ["auth", "login"] }])
  })

  test("runs the Claude Code resolveClaude resolves, and the probe with it", () => {
    const extracted = "/tmp/claude-code-4f2a/claude"
    const { ran, given, probedWith } = run({ resolved: { path: extracted } })
    expect(given).toEqual([null])
    expect(ran).toEqual([{ command: extracted, args: ["auth", "login"] }])
    expect(probedWith).toEqual([extracted])
  })

  test("hands resolveClaude --claude as given, and runs the path it resolves", () => {
    const { ran, given, probedWith } = run({
      claude: "bin/claude",
      resolved: { path: "/work/project/bin/claude" },
    })
    expect(given).toEqual(["bin/claude"])
    expect(ran).toEqual([{ command: "/work/project/bin/claude", args: ["auth", "login"] }])
    expect(probedWith).toEqual(["/work/project/bin/claude"])
  })

  test("from source, where resolveClaude resolves none, runs the embedded one; the probe the SDK's", () => {
    const { ran, probedWith } = run({ resolved: { path: null } })
    expect(ran).toEqual([{ command: embedded, args: ["auth", "login"] }])
    expect(probedWith).toEqual([null])
  })

  test("prints resolveClaude's warnings to stderr, and logs in all the same", () => {
    const warning = "the Claude Code at /opt/claude (--claude) is 3.0.0, outside the range"
    const { ran, errors, exit } = run({ claude: "/opt/claude", resolved: { warnings: [warning] } })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(errors).toEqual([`tutti login: ${warning}`])
    expect(ran).toEqual([{ command: "/opt/claude", args: ["auth", "login"] }])
  })

  test("fails with resolveClaude's problems, and runs neither the login nor the probe", () => {
    const problem = "There is no claude-dev on PATH, for --claude claude-dev."
    const { ran, probedWith, exit } = run({
      claude: "claude-dev",
      resolved: { problems: [problem] },
    })
    expect(problems(exit)).toEqual([problem])
    expect(ran).toEqual([])
    expect(probedWith).toEqual([])
  })

  test("fails with the login's exit status, and runs no probe", () => {
    const { printed, exit } = run({ exitCode: 130 })
    expect(problems(exit)).toEqual(["Claude Code's login exited with status 130"])
    expect(printed).toEqual([])
  })

  test("fails with the probe's problems when it finds no login after all", () => {
    const { exit } = run({ probe: new NotLoggedIn() })
    expect(problems(exit)).toEqual(["Not logged in to Claude: run claude /login, or tutti login"])
  })

  test("fails with the settings files the probe found Claude Code skips", () => {
    const error = new SettingsUnreadable({
      errors: [{ file: ".claude/settings.json", path: "", message: "Invalid JSON" }],
    })
    const { exit } = run({ probe: error })
    expect(problems(exit)).toEqual([error.message])
  })
})
