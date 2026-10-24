// The Account test layer reads what its probe session says through the live layer's assess, under
// the run's AppConfig and tutti's environment, as the live probe does (§ 4.13).
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, type Layer } from "effect"
import {
  Account,
  type AccountError,
  type AccountProbe,
  AccountProbeFailed,
  NotLoggedIn,
  SettingsUnreadable,
  UntrustedCheckout,
} from "../src/agent/Account.ts"
import type { AppConfig, AppConfigValue } from "../src/cli/AppConfig.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"

const key = "sk-ant-test"

/** The probe through `layer`, under `config`. */
const run = (
  layer: Layer.Layer<Account, never, AppConfig>,
  config: AppConfigValue = TestAppConfig.appConfig(),
) =>
  Effect.runSync(
    Effect.exit(
      Effect.flatMap(Account, (account) => account.probe).pipe(
        Effect.provide(layer),
        Effect.provide(TestAppConfig.layer(config)),
      ),
    ),
  )

const success = (exit: Exit.Exit<AccountProbe, AccountError>): AccountProbe => {
  if (Exit.isFailure(exit)) throw new Error(`the probe failed: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const failures = (exit: Exit.Exit<AccountProbe, AccountError>): Array<AccountError> => {
  if (Exit.isSuccess(exit)) throw new Error("the probe succeeded")
  return exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))
}

/** A configuration whose workers ask for `mode`. */
const asking = (mode: AppConfigValue["settings"]["workers"]["permission_mode"]) => {
  const config = TestAppConfig.appConfig()
  return {
    ...config,
    settings: {
      ...config.settings,
      workers: { ...config.settings.workers, permission_mode: mode },
    },
  }
}

describe("the Account test layer", () => {
  test("finds a subscription login in auto mode by default", () => {
    expect(success(run(TestAccount.layer()))).toEqual({
      account: TestAccount.initialization().account,
      billing: { _tag: "Subscription", keyUnused: false },
      subscription: true,
      permissionMode: { requested: "auto", inEffect: "auto" },
    })
    expect(TestAccount.accountProbe()).toEqual(success(run(TestAccount.layer())))
  })

  test("asks for the permission mode the configuration's workers ask for", () => {
    const found = success(run(TestAccount.layer(), asking("acceptEdits")))
    expect(found.permissionMode).toEqual({ requested: "acceptEdits", inEffect: "auto" })
    const unsaid = TestAccount.initialization({ permissionMode: null })
    expect(success(run(TestAccount.layer(unsaid), asking("default"))).permissionMode).toEqual({
      requested: "default",
      inEffect: "default",
    })
  })

  test("bills the key only when it is set, and --billing api or no subscription asks for it", () => {
    const env = { ANTHROPIC_API_KEY: key }
    const api = TestAppConfig.appConfig({ billing: "api" })
    expect(success(run(TestAccount.layer(), api)).billing).toEqual({
      _tag: "Subscription",
      keyUnused: false,
    })
    expect(success(run(TestAccount.layer(TestAccount.initialization(), env))).billing).toEqual({
      _tag: "Subscription",
      keyUnused: true,
    })
    expect(success(run(TestAccount.layer(TestAccount.initialization(), env), api))).toMatchObject({
      billing: { _tag: "ApiKey" },
      subscription: true,
    })
    expect(success(run(TestAccount.layer(TestAccount.loggedOut, env)))).toMatchObject({
      billing: { _tag: "ApiKey" },
      subscription: false,
    })
  })

  test("fails with every problem its session's answer shows, side by side", () => {
    const errors = [{ file: ".claude/settings.json", path: "", message: "Invalid JSON" }]
    const found = TestAccount.initialization({
      ...TestAccount.loggedOut,
      settingsErrors: errors,
      untrustedFiles: [".claude/settings.json"],
    })
    const config = TestAppConfig.appConfig({}, "/work/elsewhere")
    expect(failures(run(TestAccount.layer(found), config))).toEqual([
      new NotLoggedIn(),
      new SettingsUnreadable({ errors }),
      new UntrustedCheckout({ checkout: "/work/elsewhere", files: [".claude/settings.json"] }),
    ])
  })

  test("fails with a session that doesn't start", () => {
    const failed = new AccountProbeFailed({ reason: "no binary" })
    expect(failures(run(TestAccount.layer(failed)))).toEqual([failed])
  })

  test("accountProbe throws where the probe would fail", () => {
    expect(() =>
      TestAccount.accountProbe(TestAppConfig.appConfig(), TestAccount.loggedOut),
    ).toThrow()
  })
})
