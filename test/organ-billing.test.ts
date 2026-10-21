// What organs bill (§ 4.13, § 6.1): with TUTTI_ORGAN_PROVIDER=anthropic, organs bill ANTHROPIC_API_KEY
// over the Messages API whatever bills workers, and the START block's billing line says so; the
// variable's setup problems stop the run through the startup checks.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit } from "effect"
import { type Billing, billingLine } from "../src/agent/Account.ts"
import { check, type Started, type StartupFailed, startBlock } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"

const key = "sk-ant-test"

/** A project `tutti init` has set up, with Beads. */
const project = () => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-organ-billing-"))), "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  mkdirSync(join(repo, ".beads"))
  writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
  writeFileSync(join(repo, ".tutti", "worker-prompt.md"), "Work on TICKET_ID.\n")
  return repo
}

/** The startup checks in a project set up, with `env` as tutti's environment and `billing`. */
const run = (env: Record<string, string>, billing: Billing) => {
  const repo = project()
  return Effect.runPromise(
    Effect.exit(
      check({
        cwd: repo,
        env,
        config: (top) => Effect.succeed(TestAppConfig.appConfig({}, top)),
        beads: () => TestBeads.layer(),
        claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
        account: TestAccount.layer(TestAccount.accountProbe({ billing })),
      }),
    ).pipe(
      Effect.provide(TestGit.layer({ dir: repo })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..", "home") } })),
      ),
      Effect.provide(BunServices.layer),
    ),
  )
}

const passed = (exit: Exit.Exit<Started, StartupFailed>): Started => {
  if (Exit.isFailure(exit)) throw new Error(`the checks failed: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

const failed = (exit: Exit.Exit<Started, StartupFailed>): StartupFailed => {
  if (Exit.isSuccess(exit)) throw new Error("the checks passed")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
  return reason.error
}

/** The billing line of the START block of `started`. */
const billingOf = (started: Started): string | undefined =>
  startBlock(started, "0.1.0")
    .map(String)
    .find((line) => line.startsWith("  billing: "))

const subscription: Billing = { _tag: "Subscription", keyUnused: true }

describe("the billing line when organs bill ANTHROPIC_API_KEY", () => {
  test("names what bills workers, and the key for organs", () => {
    const lines: Array<[Billing, string]> = [
      [
        subscription,
        "billing: subscription for workers, ANTHROPIC_API_KEY for organs (TUTTI_ORGAN_PROVIDER=anthropic)",
      ],
      [
        { _tag: "Subscription", keyUnused: false },
        "billing: subscription for workers, ANTHROPIC_API_KEY for organs (TUTTI_ORGAN_PROVIDER=anthropic)",
      ],
      [
        { _tag: "ApiKey" },
        "billing: API key, for workers and organs (TUTTI_ORGAN_PROVIDER=anthropic)",
      ],
      [
        { _tag: "Other", source: "bedrock" },
        "billing: bedrock for workers, ANTHROPIC_API_KEY for organs (TUTTI_ORGAN_PROVIDER=anthropic)",
      ],
    ]
    for (const [billing, line] of lines) expect(billingLine(billing, true)).toBe(line)
  })

  test("is the workers' line when organs use the Agent SDK", () => {
    expect(billingLine(subscription, false)).toBe(billingLine(subscription))
    expect(billingLine(subscription)).toBe(
      "billing: subscription (ANTHROPIC_API_KEY is set but not used; --billing api uses it)",
    )
  })
})

describe("the startup checks of organs' provider", () => {
  test("TUTTI_ORGAN_PROVIDER=anthropic with no key can't start", async () => {
    const failure = failed(await run({ TUTTI_ORGAN_PROVIDER: "anthropic" }, subscription))
    expect(failure.problems).toEqual([
      "TUTTI_ORGAN_PROVIDER=anthropic needs ANTHROPIC_API_KEY, the API key organs are billed to",
    ])
    expect(failure.notSetUp).toBe(false)
  })

  test("TUTTI_ORGAN_PROVIDER set to another provider can't start", async () => {
    const failure = failed(await run({ TUTTI_ORGAN_PROVIDER: "openai" }, subscription))
    expect(failure.problems).toEqual([
      'TUTTI_ORGAN_PROVIDER is "openai"; it must be agent-sdk or anthropic',
    ])
  })

  test("TUTTI_ORGAN_PROVIDER=anthropic with the key: START says organs bill it", async () => {
    const started = passed(
      await run({ TUTTI_ORGAN_PROVIDER: "anthropic", ANTHROPIC_API_KEY: key }, subscription),
    )
    expect(started.organs).toBe("Anthropic")
    expect(billingOf(started)).toBe(
      "  billing: subscription for workers, ANTHROPIC_API_KEY for organs (TUTTI_ORGAN_PROVIDER=anthropic)",
    )
  })

  test("unset, organs use the Agent SDK and START says the key isn't used", async () => {
    const started = passed(await run({ ANTHROPIC_API_KEY: key }, subscription))
    expect(started.organs).toBe("AgentSdk")
    expect(billingOf(started)).toBe(
      "  billing: subscription (ANTHROPIC_API_KEY is set but not used; --billing api uses it)",
    )
  })
})
