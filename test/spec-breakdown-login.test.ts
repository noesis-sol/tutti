// A spec's breakdown whose turn is refused for Claude's login (§ 4.14, § 4.13): its worker is
// LoginRefused, which never settles, so the breakdown ends at once with the login's reason rather
// than wait on a turn that can't come, exit 2.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { breakdownWorker } from "../src/agent/breakdown.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { exitCodes } from "../src/run/holds.ts"
import { SpecOutcome, specRun } from "../src/run/specRun.ts"
import { assistantText, emit, sessionState, wait } from "../src/testing/AgentHost.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { breakdownInit, specLayers, specOf } from "./specScenario.ts"

const refusal = "Failed to authenticate: OAuth session expired and could not be refreshed"

/** The breakdown's first turn, refused for the login as tutti-djtt's was on 2026-10-28. */
const refusedTurn = [
  wait,
  breakdownInit,
  sessionState("running"),
  assistantText(refusal, { error: "authentication_failed" }),
  emit({
    type: "result",
    subtype: "success",
    is_error: true,
    result: refusal,
    api_error_status: null,
    num_turns: 1,
  }),
  sessionState("idle"),
]

describe("a breakdown whose turn is refused for the login", () => {
  test("ends at once with the login's reason, exit 2", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-login-")))
    const spec = specOf()
    const errors: Array<string> = []
    const stdout: Out = { write: () => {}, columns: () => 100, tty: false }
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          specRun(
            { spec, repo, refine: false, timeLimit: Duration.minutes(30), effort: "high" },
            {
              printer: makePrinter(stdout, theme),
              error: (text) => Effect.sync(() => void errors.push(text)),
              refine: Option.none(),
            },
          ),
        )
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          specLayers({
            repo,
            scripts: { [breakdownWorker]: [refusedTurn] },
            files: { "README.md": "# shop\n", [spec.path]: spec.text },
          }).pipe(Layer.provideMerge(TestClock.layer())),
        ),
      ),
    )
    expect(outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.setup }))
    expect(errors[0]).toBe(
      `tutti couldn't break the spec down: Claude's login was refused (${refusal}): run claude /login, or tutti login`,
    )
  })
})
