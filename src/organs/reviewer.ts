// The reviewer (§ 5 item 13, § 6.2): the organ that writes the run report at the end of a run, as
// orchestra v0.7.7's report organ does. Its prompt (prompts/reviewer.md) is orchestra's, adapted:
// tutti's workers are sessions, not tabs, and the hooks' tallies are tutti's own, of attention
// requests, answers, denials and your messages, with whether a person steered each ticket. Its
// answer is the report's Markdown, in a structured `report` field, since organs answer through
// structured output (§ 6.1). An empty report is a failure: you would read nothing as though it were
// all. What it is given, and what becomes of its answer, is run/report.ts's.
import { Effect, Schema } from "effect"
import type { InputPart } from "./evidence.ts"
import { make, type OrganError, OrganFailed, Organs } from "./Organs.ts"
import prompt from "./prompts/reviewer.md" with { type: "text" }

/** The reviewer's answer: the report, Markdown with no title. */
export const ReviewerAnswer = Schema.Struct({ report: Schema.String })

export const reviewer = make("reviewer", { prompt, answer: ReviewerAnswer })

/** The reviewer's report from `input`, trimmed; an empty one fails OrganFailed. */
export const review = (
  input: ReadonlyArray<InputPart>,
): Effect.Effect<string, OrganError, Organs> =>
  Effect.gen(function* () {
    const { report } = yield* (yield* Organs).ask(reviewer, input)
    const trimmed = report.trim()
    if (trimmed === "") {
      return yield* new OrganFailed({
        organ: reviewer.name,
        subtype: null,
        reason: "the reviewer wrote an empty report",
      })
    }
    return trimmed
  })
