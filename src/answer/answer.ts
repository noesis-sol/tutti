// `tutti answer` (§ 4.5 "Answering without a dashboard", § 8.1, D20): lists the run's open
// attention requests from .tutti/run/attention/ in the main checkout, or answers one. An answer is
// checked against the request's file first, so what the run would refuse (an allow of a defaultToNo
// request without --confirm, a choice that isn't an option) is refused here, before anything is
// written. It is then written as `<request-id>.answer.json`, created exclusively with mode 0600, and
// the command waits up to 10 seconds for the run to take it: the run removes the file once it has
// read it, leaving `<request-id>.refused.json` beside it when it refused it.
import { Duration, Effect, Result, Schema } from "effect"
import {
  type AnswerFile,
  type AnswerWord,
  answerFile,
  describeFile,
  encodeFile,
  fileVersion,
  fit,
  type RequestFile,
  readFileUnder,
  readRequestFile,
  readRequestFiles,
  refusedFile,
  removeUnder,
  requestIdPattern,
  takeRefusal,
  writeExclusive,
} from "../agent/attentionFiles.ts"
import { terminalSafe } from "../run/events.ts"
import { sanitize, sanitizeLine } from "../ui/sanitize.ts"
import { answerWith } from "./answerWith.ts"

/** How long `tutti answer` waits for the run to take an answer (§ 4.5). */
export const takeWithin: Duration.Duration = Duration.seconds(10)

/** How often it looks whether the run has. */
export const lookEvery: Duration.Duration = Duration.millis(100)

/** There is no open request with that ID. */
export class NoSuchRequest extends Schema.TaggedError<NoSuchRequest>()("NoSuchRequest", {
  request: Schema.String,
}) {
  override get message(): string {
    return `there is no open request ${this.request}; tutti answer lists them`
  }
}

/** The answer doesn't fit the request, by tutti answer's check or the run's. */
export class AnswerRefused extends Schema.TaggedError<AnswerRefused>()("AnswerRefused", {
  request: Schema.String,
  reason: Schema.String,
  /** The run refused it, rather than tutti answer. */
  byRun: Schema.Boolean,
}) {
  override get message(): string {
    return `${this.byRun ? "the run refused the answer" : "not answered"}: ${this.reason}`
  }
}

/** Another answer to the request is already waiting for the run. */
export class AnswerWaiting extends Schema.TaggedError<AnswerWaiting>()("AnswerWaiting", {
  request: Schema.String,
}) {
  override get message(): string {
    return `an answer to request ${this.request} is already waiting for the run to take it`
  }
}

/** The run didn't take the answer in time; the answer was withdrawn. */
export class NotTaken extends Schema.TaggedError<NotTaken>()("NotTaken", {
  request: Schema.String,
  seconds: Schema.Number,
}) {
  override get message(): string {
    return `the run didn't take the answer to request ${this.request} within ${this.seconds} s, so it was withdrawn; is tutti running in this repository?`
  }
}

/** The answer file couldn't be written. */
export class AnswerNotWritten extends Schema.TaggedError<AnswerNotWritten>()("AnswerNotWritten", {
  request: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `the answer to request ${this.request} couldn't be written: ${this.reason}`
  }
}

export type AnswerError =
  | NoSuchRequest
  | AnswerRefused
  | AnswerWaiting
  | NotTaken
  | AnswerNotWritten

/** An answer as the command line gives it. */
export interface Given {
  readonly request: string
  readonly answer: AnswerWord
  readonly reason?: string
  readonly choices?: ReadonlyArray<string>
  readonly confirm?: boolean
}

/** The open requests, oldest first. */
export const list = (repo: string): Effect.Effect<ReadonlyArray<RequestFile>> =>
  readRequestFiles(repo)

/** The answer file `given` makes. */
export const answerFileOf = (given: Given): AnswerFile => ({
  v: fileVersion,
  request: given.request,
  answer: given.answer,
  ...(given.reason === undefined ? {} : { reason: given.reason }),
  ...(given.choices === undefined || given.choices.length === 0
    ? {}
    : { choices: [...given.choices] }),
  ...(given.confirm === true ? { confirm: true } : {}),
})

/**
 * Answers the open request `given.request` in the run at `repo`: checks the answer against the
 * request, writes it, and waits up to `within` for the run to take it.
 */
export const answer = (
  repo: string,
  given: Given,
  options: { readonly within?: Duration.Input; readonly every?: Duration.Input } = {},
): Effect.Effect<void, AnswerError> =>
  Effect.gen(function* () {
    const id = given.request
    if (!requestIdPattern.test(id)) return yield* new NoSuchRequest({ request: id })
    const request = yield* readRequestFile(repo, id)
    if (request === undefined) return yield* new NoSuchRequest({ request: id })
    if (Result.isFailure(request)) {
      return yield* new AnswerRefused({
        request: id,
        reason: `its file can't be read: ${request.failure}`,
        byRun: false,
      })
    }
    const file = answerFileOf(given)
    const fitted = fit(request.success, file)
    if (Result.isFailure(fitted)) {
      return yield* new AnswerRefused({ request: id, reason: fitted.failure, byRun: false })
    }
    // A refusal of an earlier answer would be read as this one's.
    removeUnder(repo, refusedFile(id))
    yield* writeExclusive(repo, answerFile(id), encodeFile(file)).pipe(
      Effect.catch(
        (error): Effect.Effect<never, AnswerWaiting | AnswerNotWritten> =>
          error._tag === "LibcError" && error.code === "EEXIST"
            ? Effect.fail(new AnswerWaiting({ request: id }))
            : Effect.fail(new AnswerNotWritten({ request: id, reason: error.message })),
      ),
    )

    const within = Duration.fromInputUnsafe(options.within ?? takeWithin)
    const every = options.every ?? lookEvery
    const gone = Effect.map(readFileUnder(repo, answerFile(id)), (read) => read._tag === "Missing")
    const taken = yield* Effect.gen(function* () {
      for (;;) {
        if (yield* gone) return true
        yield* Effect.sleep(every)
      }
    }).pipe(Effect.timeoutOption(within))
    if (taken._tag === "None") {
      // Withdrawn, unless the run took it just now.
      if (removeUnder(repo, answerFile(id))) {
        return yield* new NotTaken({ request: id, seconds: Duration.toSeconds(within) })
      }
    }
    const refusal = yield* takeRefusal(repo, id)
    if (refusal !== undefined) {
      return yield* new AnswerRefused({ request: id, reason: refusal, byRun: true })
    }
  })

/** How to answer a request, as the log's PERMISSION and QUESTION lines say it (§ 7.6). */
export const howToAnswer = (request: RequestFile): string =>
  answerWith({
    requestId: request.id,
    answers: request.answers,
    defaultToNo: request.default_to_no,
    ...(request.kind === "question" ? { questions: (request.questions ?? []).length } : {}),
  })

/** The open requests for people: each request's ticket, what it asks, and how to answer it. */
export const show = (requests: ReadonlyArray<RequestFile>): string => {
  if (requests.length === 0) return "No open requests."
  const blocks = requests.map((request) => {
    const head = `${sanitizeLine(request.id)}  ${sanitizeLine(request.ticket)}  ${request.kind}: ${sanitizeLine(describeFile(request))}`
    const lines = [head]
    if (request.decision_reason !== undefined) {
      lines.push(`    why: ${sanitizeLine(request.decision_reason)}`)
    }
    if (request.kind === "question") {
      for (const [i, q] of (request.questions ?? []).entries()) {
        const multi = q.multi_select ? ' (any of, joined by ", ")' : ""
        lines.push(`    ${i + 1}. ${sanitizeLine(q.question)}${multi}`)
        for (const o of q.options) {
          const about = o.description === undefined ? "" : ` - ${sanitizeLine(o.description)}`
          lines.push(`       - ${sanitizeLine(o.label)}${about}`)
        }
      }
    }
    if (request.kind === "elicitation" && request.url !== undefined) {
      lines.push(`    open: ${sanitizeLine(request.url)}`)
    }
    if (request.default_to_no) lines.push("    allowing it needs --confirm")
    lines.push(`    answer with: ${sanitizeLine(howToAnswer(request))}`)
    return lines.join("\n")
  })
  return blocks.join("\n\n")
}

/**
 * The open requests for scripts and agents: the files' contents, as one JSON array, with what a
 * terminal may act on or reorder (C1 controls, bidi overrides) escaped, as events.jsonl has it.
 */
export const showJson = (requests: ReadonlyArray<RequestFile>): string =>
  terminalSafe(JSON.stringify(requests, null, 2))

/** What the command prints once the run has taken an answer. */
export const takenLine = (given: Given): string =>
  sanitize(`The run took the answer to request ${given.request}: ${given.answer}.`)
