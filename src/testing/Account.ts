// The Account test layer: the live layer, Account.layerWith, over a probe session that says
// `initialization` of itself, so the findings are read against the run's AppConfig and environment
// as a run's are. `initialization` builds a subscription login in auto mode, with `overrides` laid
// over it; `accountProbe` is what the probe finds from one, under a configuration and environment.
import { Effect } from "effect"
import {
  Account,
  type AccountProbe,
  type AccountProbeFailed,
  type Initialization,
} from "../agent/Account.ts"
import type { AppConfigValue } from "../cli/AppConfig.ts"
import * as TestAppConfig from "./AppConfig.ts"

/** What a session logged in to a subscription says, in auto mode, with `overrides`. */
export const initialization = (overrides: Partial<Initialization> = {}): Initialization => ({
  account: {
    email: "maintainer@example.com",
    organization: "Example",
    subscriptionType: "Claude Max",
    apiKeySource: null,
    apiProvider: "firstParty",
  },
  permissionMode: "auto",
  settingsErrors: [],
  untrustedFiles: [],
  ...overrides,
})

/** What a session logged in to nothing says: the probe fails with NotLoggedIn, without a key. */
export const loggedOut: Initialization = initialization({
  account: {
    email: null,
    organization: null,
    subscriptionType: null,
    apiKeySource: null,
    apiProvider: null,
  },
})

/**
 * The test layer: the probe's session says `found` of itself, or fails to start with it, and
 * `env` is tutti's environment. It needs AppConfig, as the live layer does.
 */
export const layer = (
  found: Initialization | AccountProbeFailed = initialization(),
  env: Readonly<Record<string, string | undefined>> = {},
) => Account.layerWith(() => ("_tag" in found ? Effect.fail(found) : Effect.succeed(found)), env)

/**
 * What the probe finds from `found` under `config` and `env`, through the test layer; it throws
 * where the probe would fail.
 */
export const accountProbe = (
  config: AppConfigValue = TestAppConfig.appConfig(),
  found: Initialization = initialization(),
  env: Readonly<Record<string, string | undefined>> = {},
): AccountProbe =>
  Effect.runSync(
    Effect.flatMap(Account, (account) => account.probe).pipe(
      Effect.provide(layer(found, env)),
      Effect.provide(TestAppConfig.layer(config)),
    ),
  )
