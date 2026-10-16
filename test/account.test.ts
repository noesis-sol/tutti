import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import {
  Account,
  type AccountError,
  type AccountProbe,
  AccountProbeFailed,
  type Billing,
  billingLine,
  NotLoggedIn,
  type ProbeOptions,
  permissionModeLine,
  readInitialization,
  SettingsUnreadable,
} from "../src/agent/Account.ts"
import { apiKeySet, probeEnv, workerEnv, workerVariables } from "../src/agent/env.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { live } from "./gates.ts"

const key = "sk-ant-test"

const tuttiVariables = {
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
  CLAUDE_CODE_FORK_SUBAGENT: "0",
  CLAUDE_AGENT_SDK_CLIENT_APP: "tutti/1.2.3",
}

describe("workerEnv", () => {
  const env = { PATH: "/usr/bin", HOME: "/home/me", UNSET: undefined }

  test("keeps the environment and adds tutti's four variables", () => {
    expect(
      workerEnv({ env, subscription: true, billing: "subscription", version: "1.2.3" }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/me", ...tuttiVariables })
  })

  test("tutti's variables win over the environment's", () => {
    const result = workerEnv({
      env: { ...env, CLAUDE_CODE_FORK_SUBAGENT: "1", CLAUDE_AGENT_SDK_CLIENT_APP: "other" },
      subscription: false,
      billing: "subscription",
      version: "1.2.3",
    })
    expect(result.CLAUDE_CODE_FORK_SUBAGENT).toBe("0")
    expect(result.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("tutti/1.2.3")
  })

  test("names package.json's version as the client app by default", () => {
    expect(workerVariables().CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^tutti\/\d+\.\d+\.\d+/)
  })

  test("starts from process.env by default", () => {
    const result = workerEnv({ subscription: false, billing: "subscription" })
    expect(result.PATH).toBe(process.env.PATH as string)
  })

  test("removes the key beside a subscription login", () => {
    const result = workerEnv({
      env: { ...env, ANTHROPIC_API_KEY: key },
      subscription: true,
      billing: "subscription",
    })
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(result.PATH).toBe("/usr/bin")
  })

  test("keeps the key beside a subscription login with billing api", () => {
    const result = workerEnv({
      env: { ...env, ANTHROPIC_API_KEY: key },
      subscription: true,
      billing: "api",
    })
    expect(result.ANTHROPIC_API_KEY).toBe(key)
  })

  test("keeps the key without a subscription login", () => {
    for (const billing of ["subscription", "api"] as const) {
      const result = workerEnv({
        env: { ...env, ANTHROPIC_API_KEY: key },
        subscription: false,
        billing,
      })
      expect(result.ANTHROPIC_API_KEY).toBe(key)
    }
  })

  test("without the key, sets none", () => {
    for (const subscription of [true, false]) {
      for (const billing of ["subscription", "api"] as const) {
        expect(workerEnv({ env, subscription, billing })).not.toHaveProperty("ANTHROPIC_API_KEY")
      }
    }
  })

  test("the probe's environment never has the key", () => {
    const result = probeEnv({ env: { ...env, ANTHROPIC_API_KEY: key }, version: "1.2.3" })
    expect(result).toEqual({ PATH: "/usr/bin", HOME: "/home/me", ...tuttiVariables })
  })

  test("an empty key is unset", () => {
    expect(apiKeySet({ ANTHROPIC_API_KEY: "" })).toBe(false)
    expect(apiKeySet({})).toBe(false)
    expect(apiKeySet({ ANTHROPIC_API_KEY: key })).toBe(true)
  })
})

describe("the START block's lines", () => {
  test("billing", () => {
    const lines: Array<[Billing, string]> = [
      [{ _tag: "Subscription", keyUnused: false }, "billing: subscription"],
      [
        { _tag: "Subscription", keyUnused: true },
        "billing: subscription (ANTHROPIC_API_KEY is set but not used; --billing api uses it)",
      ],
      [{ _tag: "ApiKey" }, "billing: API key"],
      [{ _tag: "Other", source: "bedrock" }, "billing: bedrock"],
    ]
    for (const [billing, line] of lines) expect(billingLine(billing)).toBe(line)
  })

  test("permission mode", () => {
    expect(permissionModeLine({ requested: "auto", inEffect: "auto" })).toBe(
      "permission mode: auto",
    )
    expect(permissionModeLine({ requested: "auto", inEffect: "default" })).toBe(
      "permission mode: default (auto mode isn't available here)",
    )
  })
})

/** What Claude Code 2.1.301 says of a subscription login (docs/spikes/01-sdk-session.md). */
const subscriptionInit = {
  output_style: "default",
  account: {
    email: "maintainer@example.com",
    organization: "Example",
    subscriptionType: "Claude Max",
    apiProvider: "firstParty",
  },
  claude_code_version: "2.1.301",
  current_permission_mode: "auto",
}

/** What it says without a login. */
const noLoginInit = {
  account: { tokenSource: "none", apiProvider: "firstParty" },
  current_permission_mode: "auto",
}

const brokenSettings = {
  effective: {},
  errors: [
    { file: "/work/project/.claude/settings.json", path: "", message: "Invalid or malformed JSON" },
    {
      file: "/work/project/.claude/settings.local.json",
      path: "permissions.defaultMode",
      message: 'Invalid value. Expected one of: "acceptEdits", "auto"',
    },
  ],
}

describe("readInitialization", () => {
  test("reads the account, the permission mode and the skipped settings files", () => {
    expect(readInitialization(subscriptionInit, brokenSettings)).toEqual({
      account: {
        email: "maintainer@example.com",
        organization: "Example",
        subscriptionType: "Claude Max",
        apiKeySource: null,
        apiProvider: "firstParty",
      },
      permissionMode: "auto",
      settingsErrors: [
        {
          file: "/work/project/.claude/settings.json",
          path: "",
          message: "Invalid or malformed JSON",
        },
        {
          file: "/work/project/.claude/settings.local.json",
          path: "permissions.defaultMode",
          message: 'Invalid value. Expected one of: "acceptEdits", "auto"',
        },
      ],
    })
  })

  test("takes settings errors from the initialization result too, each once", () => {
    const init = readInitialization(
      { ...subscriptionInit, errors: brokenSettings.errors },
      brokenSettings,
    )
    expect(init.settingsErrors).toHaveLength(2)
  })

  test("reads a missing or mistyped field as nothing", () => {
    expect(
      readInitialization(
        {
          account: { email: 7, subscriptionType: "" },
          current_permission_mode: null,
          errors: [1, { path: "x" }, { message: "m" }],
        },
        undefined,
      ),
    ).toEqual({
      account: {
        email: null,
        organization: null,
        subscriptionType: null,
        apiKeySource: null,
        apiProvider: null,
      },
      permissionMode: null,
      settingsErrors: [{ file: null, path: "", message: "m" }],
    })
  })

  test("never throws, whatever it is given", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (init, settings) => {
        readInitialization(init, settings)
      }),
    )
  })
})

/** The probe's result under the config `overrides`, its session saying `init` and `settings`. */
const probe = (
  init: unknown,
  options: {
    readonly settings?: unknown
    readonly config?: Partial<AppConfigValue>
    readonly env?: Record<string, string>
    readonly started?: Array<ProbeOptions>
  } = {},
) =>
  Effect.runPromise(
    Effect.exit(
      Effect.gen(function* () {
        return yield* (yield* Account).probe
      }).pipe(
        Effect.provide(
          Account.layerWith(
            (probeOptions) =>
              Effect.sync(() => {
                options.started?.push(probeOptions)
                return readInitialization(init, options.settings)
              }),
            options.env ?? { PATH: "/usr/bin" },
          ).pipe(Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig(options.config)))),
        ),
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

describe("the probe", () => {
  test("finds a subscription login", async () => {
    const found = success(await probe(subscriptionInit))
    expect(found.billing).toEqual({ _tag: "Subscription", keyUnused: false })
    expect(found.subscription).toBe(true)
    expect(found.account.email).toBe("maintainer@example.com")
    expect(found.account.subscriptionType).toBe("Claude Max")
    expect(found.permissionMode).toEqual({ requested: "auto", inEffect: "auto" })
  })

  test("a subscription login with the key set leaves the key unused", async () => {
    const found = success(await probe(subscriptionInit, { env: { ANTHROPIC_API_KEY: key } }))
    expect(found.billing).toEqual({ _tag: "Subscription", keyUnused: true })
    expect(found.subscription).toBe(true)
    expect(billingLine(found.billing)).toBe(
      "billing: subscription (ANTHROPIC_API_KEY is set but not used; --billing api uses it)",
    )
  })

  test("billing api uses the key beside a subscription login", async () => {
    const found = success(
      await probe(subscriptionInit, {
        env: { ANTHROPIC_API_KEY: key },
        config: { billing: "api" },
      }),
    )
    expect(found.billing).toEqual({ _tag: "ApiKey" })
    expect(found.subscription).toBe(true)
    expect(
      workerEnv({
        env: { ANTHROPIC_API_KEY: key },
        subscription: found.subscription,
        billing: "api",
      }).ANTHROPIC_API_KEY,
    ).toBe(key)
  })

  test("billing api without the key is the subscription", async () => {
    const found = success(await probe(subscriptionInit, { config: { billing: "api" } }))
    expect(found.billing).toEqual({ _tag: "Subscription", keyUnused: false })
  })

  test("the key without a login is used", async () => {
    const found = success(await probe(noLoginInit, { env: { ANTHROPIC_API_KEY: key } }))
    expect(found.billing).toEqual({ _tag: "ApiKey" })
    expect(found.subscription).toBe(false)
    expect(billingLine(found.billing)).toBe("billing: API key")
  })

  test("a key Claude Code finds itself, or a cloud provider, is another login", async () => {
    const helper = { account: { apiKeySource: "apiKeyHelper", apiProvider: "firstParty" } }
    expect(success(await probe(helper)).billing).toEqual({ _tag: "Other", source: "apiKeyHelper" })
    const bedrock = { account: { apiProvider: "bedrock" } }
    expect(success(await probe(bedrock)).billing).toEqual({ _tag: "Other", source: "bedrock" })
  })

  test("no login and no key is NotLoggedIn", async () => {
    const [error, ...rest] = failures(await probe(noLoginInit))
    expect(rest).toEqual([])
    expect(error).toBeInstanceOf(NotLoggedIn)
    expect(error?.message).toBe("Not logged in to Claude: run claude /login, or tutti login")
  })

  test("skipped settings files are SettingsUnreadable, naming each file and its error", async () => {
    const [error, ...rest] = failures(await probe(subscriptionInit, { settings: brokenSettings }))
    expect(rest).toEqual([])
    expect(error).toBeInstanceOf(SettingsUnreadable)
    expect((error as SettingsUnreadable).errors).toHaveLength(2)
    expect(error?.message.split("\n")).toEqual([
      "Claude Code skips a settings file it can't read, and the permission rules in it: /work/project/.claude/settings.json: Invalid or malformed JSON",
      'Claude Code skips a settings file it can\'t read, and the permission rules in it: /work/project/.claude/settings.local.json: permissions.defaultMode: Invalid value. Expected one of: "acceptEdits", "auto"',
    ])
  })

  test("no login and skipped settings files fail with both", async () => {
    const errors = failures(await probe(noLoginInit, { settings: brokenSettings }))
    expect(errors.map((error) => error._tag)).toEqual(["NotLoggedIn", "SettingsUnreadable"])
  })

  test("says the permission mode in effect when it isn't the one asked for", async () => {
    const found = success(await probe({ ...subscriptionInit, current_permission_mode: "default" }))
    expect(found.permissionMode).toEqual({ requested: "auto", inEffect: "default" })
  })

  test("takes the mode asked for when Claude Code doesn't say", async () => {
    const { current_permission_mode: _, ...init } = subscriptionInit
    const settings = {
      ...defaultSettings,
      workers: { ...defaultSettings.workers, permission_mode: "acceptEdits" as const },
    }
    const found = success(await probe(init, { config: { settings } }))
    expect(found.permissionMode).toEqual({ requested: "acceptEdits", inEffect: "acceptEdits" })
  })

  test("starts its session with the workers' settings and without the key", async () => {
    const started: Array<ProbeOptions> = []
    const settings = {
      ...defaultSettings,
      workers: { ...defaultSettings.workers, model: "haiku", effort: "low" as const },
    }
    success(
      await probe(subscriptionInit, {
        config: { settings, claude: "/opt/claude" },
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: key },
        started,
      }),
    )
    expect(started).toHaveLength(1)
    const [options] = started
    expect(options?.repo).toBe("/work/project")
    expect(options?.permissionMode).toBe("auto")
    expect(options?.model).toBe("haiku")
    expect(options?.effort).toBe("low")
    expect(options?.claude).toBe("/opt/claude")
    expect(options?.env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(options?.env.PATH).toBe("/usr/bin")
    expect(options?.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1")
  })

  test("a session that doesn't start fails the probe", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          return yield* (yield* Account).probe
        }).pipe(
          Effect.provide(
            Account.layerWith(() =>
              Effect.fail(new AccountProbeFailed({ reason: "no binary" })),
            ).pipe(Layer.provide(TestAppConfig.layer())),
          ),
        ),
      ),
    )
    const [error] = failures(exit)
    expect(error?.message).toBe("The account probe couldn't start Claude Code: no binary")
  })
})

describe("the test layer", () => {
  const run = (layer: Layer.Layer<Account>) =>
    Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          return yield* (yield* Account).probe
        }).pipe(Effect.provide(layer)),
      ),
    )

  test("gives a literal account", async () => {
    expect(success(await run(TestAccount.layer()))).toEqual(TestAccount.accountProbe())
    const keyed = TestAccount.accountProbe({ billing: { _tag: "ApiKey" } })
    expect(success(await run(TestAccount.layer(keyed))).billing).toEqual({ _tag: "ApiKey" })
  })

  test("fails with an error it is given", async () => {
    const [error] = failures(await run(TestAccount.layer(new NotLoggedIn())))
    expect(error).toBeInstanceOf(NotLoggedIn)
  })
})

live.describe("the live probe", () => {
  /** A git repository with `settings` as its .claude/settings.json, when given. */
  const project = (settings?: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-account-")))
    Bun.spawnSync(["git", "init", "-q", dir])
    if (settings !== undefined) {
      mkdirSync(join(dir, ".claude"))
      writeFileSync(join(dir, ".claude", "settings.json"), settings)
    }
    return dir
  }

  const liveProbe = (repo: string) =>
    Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          return yield* (yield* Account).probe
        }).pipe(
          Effect.provide(
            Account.layer.pipe(
              Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({}, repo))),
            ),
          ),
        ),
      ),
    )

  test(
    "reports this machine's login, or that there is none",
    async () => {
      const exit = await liveProbe(project())
      if (Exit.isSuccess(exit)) {
        expect(exit.value.permissionMode.requested).toBe("auto")
        expect(typeof exit.value.permissionMode.inEffect).toBe("string")
      } else {
        expect(failures(exit).map((error) => error._tag)).toEqual(["NotLoggedIn"])
      }
    },
    { timeout: 90_000 },
  )

  test(
    "names a settings file Claude Code skips",
    async () => {
      const repo = project("{ not json")
      const unreadable = failures(await liveProbe(repo)).find(
        (error): error is SettingsUnreadable => error instanceof SettingsUnreadable,
      )
      expect(unreadable?.errors.map((error) => error.file)).toEqual([
        join(repo, ".claude", "settings.json"),
      ])
    },
    { timeout: 90_000 },
  )
})
