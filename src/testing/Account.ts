// The Account test layer: a literal probe result. `accountProbe` builds a subscription login in
// auto mode, with `overrides` laid over it; a failure plays the probe failing with it.
import { Effect, Layer } from "effect"
import { Account, type AccountError, type AccountProbe } from "../agent/Account.ts"

/** A subscription login with no API key set, its workers in auto mode, with `overrides`. */
export const accountProbe = (overrides: Partial<AccountProbe> = {}): AccountProbe => ({
  account: {
    email: "maintainer@example.com",
    organization: "Example",
    subscriptionType: "Claude Max",
    apiKeySource: null,
    apiProvider: "firstParty",
  },
  billing: { _tag: "Subscription", keyUnused: false },
  subscription: true,
  permissionMode: { requested: "auto", inEffect: "auto" },
  ...overrides,
})

/** The test layer: the probe finds `result`, or fails with it. */
export const layer = (result: AccountProbe | AccountError = accountProbe()) =>
  Layer.succeed(
    Account,
    Account.of({
      probe: "_tag" in result ? Effect.fail(result) : Effect.succeed(result),
    }),
  )
