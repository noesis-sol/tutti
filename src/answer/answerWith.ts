// How to answer a request with `tutti answer` (§ 7.6): the one text the log's PERMISSION and
// QUESTION lines and `tutti answer`'s listing give, so each says what `fit` takes.
import type { AnswerWord } from "../agent/attentionFiles.ts"

/** What says how a request is answered. */
export interface Answerable {
  readonly requestId: string
  /** The answers the request takes, as `tutti answer` spells them. */
  readonly answers: ReadonlyArray<AnswerWord>
  /** Allowing needs `--confirm`. */
  readonly defaultToNo: boolean
  /** A question's number of questions: its allow gives one `--choice` for each, in order. */
  readonly questions?: number
}

/**
 * The command that answers the request, its answers joined by ` | `: as in
 * `tutti answer a3f9 allow --choice "<option>" --choice "<option>" | deny`.
 */
export const answerWith = (request: Answerable): string => {
  const confirm = request.defaultToNo ? " --confirm" : ""
  const choices = ' --choice "<option>"'.repeat(request.questions ?? 0)
  const words = request.answers.map((word) => {
    if (word === "deny") return word
    return word === "allow" ? `${word}${choices}${confirm}` : `${word}${confirm}`
  })
  return `tutti answer ${request.requestId} ${words.join(" | ")}`
}
