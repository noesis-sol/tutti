// A spec's breakdown whose turn fails as Claude's API is unavailable (§ 4.14, § 4.2): its worker is
// ApiUnavailable, which never settles, and no hold runs before the run to tell it to carry on, so
// the breakdown ends at once with the API's error, as on a failed turn, rather than wait out its
// time limit.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { breakdownWorker } from "../src/agent/breakdown.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { specRun } from "../src/run/specRun.ts"
import { apiErrorResult, apiRetry, sessionState, wait } from "../src/testing/AgentHost.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { breakdownInit, specLayers, specOf } from "./specScenario.ts"

const overloaded = "API Error: 529 Overloaded"

/** The breakdown's first turn, failing with a 529 after Claude Code's retries. */
const overloadedTurn = [
  wait,
  breakdownInit,
  sessionState("running"),
  apiRetry(1, 529),
  apiErrorResult(overloaded, 529),
  sessionState("idle"),
]

describe("a breakdown whose turn fails as Claude's API is unavailable", () => {
  test("ends at once with the API's error, not at its time limit", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-outage-")))
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
            scripts: { [breakdownWorker]: [overloadedTurn] },
            files: { "README.md": "# shop\n", [spec.path]: spec.text },
          }).pipe(Layer.provideMerge(TestClock.layer())),
        ),
      ),
    )
    expect(outcome._tag).toBe("Stopped")
    expect(errors[0]).toBe(
      `tutti couldn't break the spec down: its turn ended on an error: ${overloaded}`,
    )
  })
})
