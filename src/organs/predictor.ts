// The predictor (§ 5 items 5 and 13, Appendix A): the organ that guesses the files a ticket naming
// nothing will change, as orchestra v0.7.7's does. Its prompt (prompts/predictor.md) is orchestra's,
// adapted to tutti's sessions and to the answer's `files` field. Its input is the ticket, as bd show
// gives it, and the repository's files (git ls-files), at most `maxListed` of them, the ticket named
// by its ID alone outside the tags, its title inside them. Of its answer, only the repository's files
// are kept, without repeats, at most `maxPredicted`. When it is asked, and what becomes of its
// answer, is run/predict.ts's.
import { Effect, Schema } from "effect"
import type { Issue } from "../services/Beads.ts"
import { type InputPart, section } from "./evidence.ts"
import { make, type OrganError, Organs } from "./Organs.ts"
import template from "./prompts/predictor.md" with { type: "text" }

/** The most files a prediction keeps. */
export const maxPredicted = 8

/** The most repository files the input lists: enough for most projects, a few hundred KB at most. */
export const maxListed = 5000

/** The predictor's answer: the files, most likely first. */
export const PredictorAnswer = Schema.Struct({ files: Schema.Array(Schema.String) })

export const predictor = make("predictor", {
  prompt: template.replaceAll("{{maxPredicted}}", String(maxPredicted)),
  answer: PredictorAnswer,
})

/** The ticket as a person reads bd show: its ID and title, then each of its texts that has words. */
export const ticketText = (issue: Issue): string => {
  const about = [
    `Status: ${issue.status}`,
    ...(issue.priority === undefined ? [] : [`Priority: P${issue.priority}`]),
    `Type: ${issue.type}`,
  ].join(" · ")
  const texts: ReadonlyArray<readonly [string, string]> = [
    ["Description", issue.description],
    ["Design", issue.design],
    ["Acceptance criteria", issue.acceptance],
    ["Notes", issue.notes],
  ]
  return [
    `${issue.id}: ${issue.title}`,
    about,
    ...(issue.labels.length === 0 ? [] : [`Labels: ${issue.labels.join(", ")}`]),
    ...texts.flatMap(([title, text]) =>
      text.trim() === "" ? [] : [`\n${title}:\n${text.trim()}`],
    ),
  ].join("\n")
}

/** The predictor's input: the ticket, the repository's files, then the request. */
export const predictorInput = (
  issue: Issue,
  tracked: ReadonlyArray<string>,
): ReadonlyArray<InputPart> => {
  const listed = tracked.slice(0, maxListed).join("\n")
  const more = tracked.length > maxListed ? `\n(… and ${tracked.length - maxListed} more)` : ""
  return [
    section("Ticket (bd show)", ticketText(issue)),
    section("Repository files (git ls-files)", listed + more),
    `Predict the files ticket ${issue.id} will change.\n`,
  ]
}

/** The answer's files that the repository has, as git lists them, without repeats, up to maxPredicted. */
export const keptFiles = (
  answer: ReadonlyArray<string>,
  tracked: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const known = new Set(tracked)
  const files: Array<string> = []
  for (const raw of answer) {
    const trimmed = raw.trim()
    const f = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed
    if (known.has(f) && !files.includes(f) && files.length < maxPredicted) files.push(f)
  }
  return files
}

/** The repository files the ticket will likely change; none when it gives no clue. */
export const predictFiles = (
  issue: Issue,
  tracked: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, OrganError, Organs> =>
  Effect.gen(function* () {
    const { files } = yield* (yield* Organs).ask(predictor, predictorInput(issue, tracked))
    return keptFiles(files, tracked)
  })
