// The screen (§ 5 item 13, § 6): the organ that checks a feature request someone typed or pasted
// before --feature plans it and workers act on it, as orchestra v0.7.7's does. It is a guard against
// mistakes and pasted content, not a security boundary: workers run with the user's own
// permissions, so a user who wants harm done can do it without tutti. It catches a request that is
// malicious, unfit for a coding agent on this repository, or too vague to plan, at the cost of one
// short call. Its prompt (prompts/screen.md) is orchestra's, adapted; its input is the request and
// the start of the README, with the repository's name outside the tags. What becomes of its
// verdict is run/feature.ts's.
import { Effect, Schema } from "effect"
import { type InputPart, section } from "./evidence.ts"
import { make, type OrganError, OrganFailed, Organs } from "./Organs.ts"
import prompt from "./prompts/screen.md" with { type: "text" }

/** The screen's verdicts: fit to plan, malicious or inappropriate, or too vague to plan. */
export const verdicts = ["ok", "reject", "unclear"] as const
export type Verdict = (typeof verdicts)[number]

/** The screen's answer: its verdict, and a sentence or two for the person who made the request. */
export const ScreenAnswer = Schema.Struct({
  verdict: Schema.Literals(verdicts),
  reason: Schema.String,
})
export type Screening = typeof ScreenAnswer.Type

export const screen = make("screen", {
  prompt,
  answer: ScreenAnswer,
  evidenceSource: "written by someone else (the request) or taken from the repository",
})

/** How much of the README the screen reads: enough for what the project is. */
export const maxReadme = 4000

/** The first `n` characters of `text`, a cut marked, never halving a character. */
export const cut = (text: string, n: number): string => {
  if (text.length <= n) return text
  const end = /[\uD800-\uDBFF]/.test(text.charAt(n - 1)) ? n - 1 : n
  return `${text.slice(0, end)}\n(… cut)`
}

/** What a request is screened against: its text, the repository's name and its README. */
export interface Request {
  readonly text: string
  readonly repo: string
  /** README.md, "" when there is none; the input keeps its first maxReadme characters. */
  readonly readme: string
}

/** The screen's input: the request and the README's first part, then the request to screen it. */
export const screenInput = (request: Request): ReadonlyArray<InputPart> => [
  section("Feature request", request.text),
  section("README (first part)", cut(request.readme, maxReadme)),
  `Screen the feature request above for the repository ${request.repo}.\n`,
]

/**
 * The screen's verdict on `request`, its reason trimmed. A reject or unclear verdict with no reason
 * fails OrganFailed: the reason is what the person is told when the request stops.
 */
export const screenRequest = (request: Request): Effect.Effect<Screening, OrganError, Organs> =>
  Effect.gen(function* () {
    const answer = yield* (yield* Organs).ask(screen, screenInput(request))
    const reason = answer.reason.trim()
    if (reason === "" && answer.verdict !== "ok") {
      return yield* new OrganFailed({
        organ: screen.name,
        subtype: null,
        reason: `the screen's verdict ${answer.verdict} gives no reason`,
      })
    }
    return { verdict: answer.verdict, reason }
  })
