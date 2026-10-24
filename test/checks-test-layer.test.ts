import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Layer } from "effect"
import { CheckFailed, Checks } from "../src/services/Checks.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestChecks from "../src/testing/Checks.ts"

interface Commands {
  readonly setup?: string | null
  readonly fast?: string | null
  readonly full?: string | null
}

const wt = { cwd: "/wt", outputFile: "/wt/.tutti/run/check.log" }

/** The test layer playing `script`, with the settings naming these commands. */
const run = <A>(
  commands: Commands,
  script: TestChecks.Script,
  effect: (checks: Checks["Service"]) => Effect.Effect<A, unknown>,
) => {
  const { settings } = TestAppConfig.appConfig()
  const { checks } = settings
  const config = TestAppConfig.appConfig({
    settings: {
      ...settings,
      checks: {
        ...checks,
        setup: { ...checks.setup, command: commands.setup ?? null },
        fast: { command: commands.fast ?? null, timeout: Duration.minutes(5) },
        full: { command: commands.full ?? null, timeout: Duration.minutes(50) },
      },
    },
  })
  const runs: Array<TestChecks.CheckRun> = []
  const layer = TestChecks.layer(script, runs).pipe(Layer.provide(TestAppConfig.layer(config)))
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* effect(yield* Checks)
      }),
      layer,
    ),
  ).then((value) => ({ value, runs }))
}

describe("the Checks test layer, as the live one chooses", () => {
  test("a check the settings name no command for runs nothing: NoCheckCommand", async () => {
    const ran = await run({}, { fast: [TestChecks.passed("fast")] }, (checks) =>
      Effect.all([
        Effect.exit(checks.setup({ ...wt, before: "fast" })),
        Effect.exit(checks.fast(wt)),
        Effect.exit(checks.full(wt)),
      ]),
    )
    expect(ran.value).toEqual([
      Exit.succeed({ _tag: "NoCheckCommand", check: "setup" }),
      Exit.succeed({ _tag: "NoCheckCommand", check: "fast" }),
      Exit.succeed({ _tag: "NoCheckCommand", check: "full" }),
    ])
    expect(ran.runs).toEqual([])
  })

  test("a setup given a null command runs nothing, though the settings name one", async () => {
    const ran = await run({ setup: "bun i" }, {}, (checks) =>
      Effect.exit(checks.setup({ ...wt, before: "full", command: null })),
    )
    expect(ran.value).toEqual(Exit.succeed({ _tag: "NoCheckCommand", check: "setup" }))
    expect(ran.runs).toEqual([])
  })

  test("each run records its command and time limit, a setup's within its check's", async () => {
    const ran = await run({ setup: "bun i", fast: "./fast.sh", full: "./full.sh" }, {}, (checks) =>
      Effect.all([
        checks.setup({ ...wt, before: "full" }),
        checks.setup({ ...wt, before: "fast", command: "make deps" }),
        checks.fast(wt),
        checks.full(wt),
      ]),
    )
    expect(ran.runs.map(({ check, command, timeLimit }) => [check, command, timeLimit])).toEqual([
      ["setup", "bun i", Duration.minutes(50)],
      ["setup", "make deps", Duration.minutes(5)],
      ["fast", "./fast.sh", Duration.minutes(5)],
      ["full", "./full.sh", Duration.minutes(50)],
    ])
  })

  test("an exit code and output are read as the live layer reads them", async () => {
    const ran = await run(
      { fast: "./fast.sh" },
      {
        fast: [
          { exitCode: 0, output: "ok\nFLAKY: test/x.test.ts retries\n" },
          { exitCode: 2, output: "SUITE: unit\n(fail) adds > one\nall done" },
        ],
      },
      (checks) => Effect.all([Effect.exit(checks.fast(wt)), Effect.exit(checks.fast(wt))]),
    )
    expect(ran.value[0]).toEqual(
      Exit.succeed({
        ...TestChecks.passed("fast", {
          lastLines: ["ok", "FLAKY: test/x.test.ts retries"],
          flaky: ["test/x.test.ts retries"],
          flakyCount: 1,
        }),
        command: "./fast.sh",
      }),
    )
    expect(ran.value[1]).toEqual(
      Exit.fail(
        new CheckFailed({
          check: "fast",
          command: "./fast.sh",
          exitCode: 2,
          outputFile: wt.outputFile,
          failingLines: ["(fail) adds > one"],
          lastLines: ["SUITE: unit", "(fail) adds > one", "all done"],
          suites: ["unit"],
          suite: "unit",
          flaky: [],
          flakyCount: 0,
        }),
      ),
    )
  })
})
