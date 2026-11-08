// A setup problem found as a breakdown's or a question talk's session starts (§ 4.1): the start
// fails with the problem, marked `setup`, and sends the session nothing, rather than fail on its
// first message with "it has no open session"; a spec's breakdown and a feature's interview stopped
// so exit 2, a setup problem's code, and say the problem.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Option, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { type AgentHost, AgentStartFailed } from "../src/agent/AgentHost.ts"
import { startAnswerTalk } from "../src/agent/answerTalk.ts"
import { breakdownWorker, startFeature } from "../src/agent/breakdown.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { interviewWorker } from "../src/agent/inView.ts"
import { apiKeyProblem } from "../src/agent/sessionChecks.ts"
import type { AppConfig } from "../src/cli/AppConfig.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { exitCodes } from "../src/run/holds.ts"
import { InterviewOutcome, interviewEnding } from "../src/run/interview.ts"
import type { Log } from "../src/run/log.ts"
import { SpecOutcome, specRun } from "../src/run/specRun.ts"
import type { Beads, TicketId } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import { initialize, Recording, layer as scriptedHost } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { specLayers, specOf } from "./specScenario.ts"

/** A session whose initialize gives an API key while billing is the subscription login. */
const keyed = [[initialize({ account: { apiKeySource: "ANTHROPIC_API_KEY" } })]]

const problem = apiKeyProblem("ANTHROPIC_API_KEY")

/** Runs `effect` in a fresh main checkout, the interview worker's session `keyed`. */
const scenario = <A, E>(
  effect: Effect.Effect<A, E, AgentHost | Recording | Beads | AppConfig | Git | Log | Scope.Scope>,
) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-setup-breakdown-")))
  return Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        scriptedHost({ [interviewWorker]: keyed }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              logLayer(),
              eventsLayer(),
              configLayer(appConfig({}, repo)),
              beadsLayer([{ id: "q-1", title: "Which flag name?", labels: ["human"] }]),
              memoryGit({ dir: repo, files: { "README.md": "# demo\n" } }),
            ),
          ),
        ),
      ),
    ),
  )
}

/** How `start` failed, and the messages the interview worker was sent. */
const failed = <A, E, R>(start: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(start)
    if (!(error instanceof AgentStartFailed)) return yield* Effect.die(error)
    const recording = yield* Recording
    return {
      reason: error.reason,
      setup: error.setup,
      sent: (yield* recording.messages(interviewWorker)).length,
    }
  })

describe("a setup problem as a breakdown's or a talk's session starts", () => {
  test("fails a feature's breakdown with the problem, sending nothing", async () => {
    const found = await scenario(
      failed(startFeature({ description: "Add a --json flag to list.\n", effort: null })),
    )
    expect(found).toEqual({ reason: problem, setup: true, sent: 0 })
  })

  test("fails a question's talk with the problem, sending nothing", async () => {
    const found = await scenario(failed(startAnswerTalk("q-1" as TicketId)))
    expect(found).toEqual({ reason: problem, setup: true, sent: 0 })
  })

  test("ends a feature's interview with the problem, exit 2", () => {
    expect(interviewEnding(InterviewOutcome.NotStarted({ why: problem, setup: true }))).toEqual({
      out: [],
      error: [`tutti: the interview couldn't start: ${problem}; nothing was filed.`],
      exitCode: exitCodes.setup,
    })
    expect(interviewEnding(InterviewOutcome.NotStarted({ why: "spawn failed" })).exitCode).toBe(
      exitCodes.tool,
    )
  })

  test("stops a spec's breakdown with the problem, exit 2", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-setup-spec-")))
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
            scripts: { [breakdownWorker]: keyed },
            files: { "README.md": "# shop\n", [spec.path]: spec.text },
          }).pipe(Layer.provideMerge(TestClock.layer())),
        ),
      ),
    )
    expect(outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.setup }))
    expect(errors).toEqual([`tutti couldn't break the spec down: ${problem}`])
  })
})
