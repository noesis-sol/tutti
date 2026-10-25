// Attention's test layer (§ 3.3): the live service, with a policy that answers requests as they
// open, and IDs drawn in order (`r1`, `r2`, …) so a test can name them. A request the policy leaves
// unanswered waits, as in the live layer, for the test to answer it, or for --auto-answer's.
import { Effect, Layer, Ref } from "effect"
import {
  type Answer,
  Attention,
  type AutoAnswerOptions,
  make,
  type Policy,
} from "../agent/Attention.ts"
import type { EventStream } from "../run/eventstream.ts"
import type { Log } from "../run/log.ts"

/** Leaves every request open, for the test to answer. */
export const waitForTest: Policy = () => undefined

/** Allows every permission, picks each question's first option, accepts every elicitation. */
export const allowAll: Policy = (request) => {
  switch (request.kind._tag) {
    case "Permission":
      return { _tag: "Allow" }
    case "Question":
      return {
        _tag: "Choose",
        answers: request.kind.questions.map((q) => q.options[0]?.label ?? ""),
      }
    case "Elicitation":
      return { _tag: "Accept" }
  }
}

/** Denies every permission and question and declines every elicitation. */
export const denyAll: Policy = (request): Answer =>
  request.kind._tag === "Elicitation" ? { _tag: "Decline" } : { _tag: "Deny" }

/**
 * The test layer, answering by `policy`; by default every request waits for the test. With
 * `autoAnswer`, a question the policy leaves open is answered as --auto-answer does.
 */
export const layer = (
  policy: Policy = waitForTest,
  autoAnswer?: AutoAnswerOptions,
): Layer.Layer<Attention, never, Log | EventStream> =>
  Layer.effect(
    Attention,
    Effect.gen(function* () {
      const drawn = yield* Ref.make(0)
      return yield* make({
        policy,
        ...(autoAnswer === undefined ? {} : { autoAnswer }),
        ids: Effect.map(
          Ref.updateAndGet(drawn, (n) => n + 1),
          (n) => `r${n}`,
        ),
      })
    }),
  )
