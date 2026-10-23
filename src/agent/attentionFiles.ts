// Attention files (§ 4.5 "Answering without a dashboard", D20): each open request is also a file in
// .tutti/run/attention/ in the main checkout, and `tutti answer` answers one by writing an answer
// file beside it. The run's side is here: `serve` keeps one `<request-id>.json` per open request,
// created exclusively with mode 0600 and removed once the request is answered or withdrawn, and
// watches the folder (fs.watch, plus a poll in case events are missed) for
// `<request-id>.answer.json`.
//
// An answer file is taken only when it isn't a symbolic link, belongs to the run's user, answers a
// request that is still open, and fits the request's kind and options; allowing a defaultToNo
// request also needs `confirm`. A taken answer resolves the request as one given on screen, logged
// and recorded `via` answer_command. A refused one is logged, and `<request-id>.refused.json` says
// why, for the command waiting on it; the answer file is removed either way.
//
// The formats and `fit`, which says whether an answer file fits a request, are shared with the
// command (src/answer/answer.ts), so it refuses locally what the run would refuse.

import { randomBytes } from "node:crypto"
import {
  fstatSync,
  watch as fsWatch,
  linkSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { constants as osConstants } from "node:os"
import { join } from "node:path"
import {
  Context,
  Duration,
  Effect,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import {
  close,
  LibcError,
  makeFoldersUnder,
  NotAFileRefused,
  O,
  openUnder,
  type PathRefused,
  SymlinkRefused,
} from "../native/libc.ts"
import { timestamp } from "../run/localTime.ts"
import * as log from "../run/log.ts"
import { Log } from "../run/log.ts"
import { sanitize } from "../ui/sanitize.ts"
import { type Answer, Attention, type AttentionRequest, answersOf } from "./Attention.ts"

/** The folder of the open requests and their answers, relative to the main checkout (§ 9.1). */
export const attentionFolder = ".tutti/run/attention"

/** An open request's file, relative to the main checkout. */
export const requestFile = (id: string): string => `${attentionFolder}/${id}.json`

/** The answer `tutti answer` writes for the request, relative to the main checkout. */
export const answerFile = (id: string): string => `${attentionFolder}/${id}.answer.json`

/** Why the run refused the request's last answer, relative to the main checkout. */
export const refusedFile = (id: string): string => `${attentionFolder}/${id}.refused.json`

/** What a request ID may be: tutti draws 8 hex digits; anything else can't name a file here. */
export const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/

const answerName = /^([A-Za-z0-9_-]{1,64})\.answer\.json$/

/** The largest answer file read, in bytes: a reason and a few choices fit many times over. */
export const maxAnswerBytes = 64 * 1024

/** How often the run reads the folder besides fs.watch's events (§ 4.5). */
export const pollEvery: Duration.Duration = Duration.seconds(2)

/**
 * The poll `serve` uses when its options name none: `pollEvery` by default. The scenarios set it
 * past any advance of TestClock, which would otherwise wake the poll 1800 times an hour.
 */
export const AttentionPoll = Context.Reference<Duration.Duration>(
  "tutti/agent/attentionFiles/AttentionPoll",
  { defaultValue: () => pollEvery },
)

/** The version of the files' format this tutti writes and reads. */
export const fileVersion = 1

/** The answers `tutti answer` gives, as it spells them. */
export const answerWords = ["allow", "allow-run", "deny"] as const
export type AnswerWord = (typeof answerWords)[number]

const optional = Schema.optionalKey

const QuestionSchema = Schema.Struct({
  question: Schema.String,
  header: optional(Schema.String),
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: optional(Schema.String) }),
  ),
  multi_select: Schema.Boolean,
})

/** An open request's file: what the person needs to answer it, every text sanitised (§ 7.10). */
export const RequestFile = Schema.Struct({
  v: Schema.Literal(fileVersion),
  id: Schema.String,
  ticket: Schema.String,
  kind: Schema.Literals(["permission", "question", "elicitation"]),
  /** A permission's tool and a one-line summary of its input. */
  tool: optional(Schema.String),
  summary: optional(Schema.String),
  /** A question's questions, each with its options. */
  questions: optional(Schema.Array(QuestionSchema)),
  /** An elicitation's MCP server, its message, and the URL to open for a URL login. */
  server: optional(Schema.String),
  message: optional(Schema.String),
  mode: optional(Schema.Literals(["form", "url"])),
  url: optional(Schema.String),
  title: optional(Schema.String),
  display_name: optional(Schema.String),
  description: optional(Schema.String),
  decision_reason: optional(Schema.String),
  blocked_path: optional(Schema.String),
  /** The answers the request takes, as `tutti answer` spells them. */
  answers: Schema.Array(Schema.Literals(answerWords)),
  /** Allowing needs `--confirm`. */
  default_to_no: Schema.Boolean,
  /** No allow-run. */
  suppress_always_allow_rule: Schema.Boolean,
  /** When it was made, RFC 3339. */
  created_at: Schema.String,
})
export type RequestFile = typeof RequestFile.Type

/** An answer file, as `tutti answer` writes it. */
export const AnswerFile = Schema.Struct({
  v: Schema.Literal(fileVersion),
  /** The request it answers: the one its file name names. */
  request: Schema.String,
  answer: Schema.Literals(answerWords),
  /** The reason given with a denial. */
  reason: optional(Schema.String),
  /** A question's answers, one per question in order: an option's label. */
  choices: optional(Schema.Array(Schema.String)),
  /** Allowing a defaultToNo request was confirmed. */
  confirm: optional(Schema.Boolean),
})
export type AnswerFile = typeof AnswerFile.Type

/** Why the run refused an answer file. */
export const RefusedFile = Schema.Struct({
  v: Schema.Literal(fileVersion),
  request: Schema.String,
  reason: Schema.String,
})

const decodeRequestFile = Schema.decodeUnknownResult(RequestFile)
const decodeAnswerFile = Schema.decodeUnknownResult(AnswerFile)
const decodeRefusedFile = Schema.decodeUnknownOption(RefusedFile)

const parseJson = (text: string): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(text))
  } catch (error) {
    return Result.fail(`it isn't JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** An answer file's text as an AnswerFile, or what is wrong with it. It never throws. */
export const parseAnswerFile = (text: string): Result.Result<AnswerFile, string> =>
  Result.flatMap(parseJson(text), (json) =>
    Result.mapError(decodeAnswerFile(json), (error) => `it isn't an answer: ${error.message}`),
  )

/** A request file's text as a RequestFile, or what is wrong with it. It never throws. */
export const parseRequestFile = (text: string): Result.Result<RequestFile, string> =>
  Result.flatMap(parseJson(text), (json) =>
    Result.mapError(decodeRequestFile(json), (error) => `it isn't a request: ${error.message}`),
  )

/** A refused file's reason, or undefined when the text isn't one. */
export const parseRefusedFile = (text: string): string | undefined => {
  const json = parseJson(text)
  if (Result.isFailure(json)) return undefined
  const decoded = decodeRefusedFile(json.success)
  return decoded._tag === "Some" ? decoded.value.reason : undefined
}

/** The request as its file holds it. */
export const toRequestFile = (request: AttentionRequest): RequestFile => {
  const kind = request.kind
  const shown = {
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.displayName === undefined ? {} : { display_name: request.displayName }),
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.decisionReason === undefined ? {} : { decision_reason: request.decisionReason }),
    ...(request.blockedPath === undefined ? {} : { blocked_path: request.blockedPath }),
  }
  const ofKind = (() => {
    switch (kind._tag) {
      case "Permission":
        return { kind: "permission" as const, tool: kind.tool, summary: kind.summary }
      case "Question":
        return {
          kind: "question" as const,
          questions: kind.questions.map((q) => ({
            question: q.question,
            ...(q.header === undefined ? {} : { header: q.header }),
            options: q.options.map((o) => ({
              label: o.label,
              ...(o.description === undefined ? {} : { description: o.description }),
            })),
            multi_select: q.multiSelect,
          })),
        }
      case "Elicitation":
        return {
          kind: "elicitation" as const,
          server: kind.server,
          message: kind.message,
          mode: kind.mode,
          ...(kind.url === undefined ? {} : { url: kind.url }),
        }
    }
  })()
  return {
    v: fileVersion,
    id: request.id,
    ticket: request.ticket,
    ...ofKind,
    ...shown,
    answers: answersOf(request),
    default_to_no: request.defaultToNo,
    suppress_always_allow_rule: request.suppressAlwaysAllowRule,
    created_at: timestamp(new Date(request.createdAt)),
  }
}

// Whether `choice` is one of the question's options, or, for a multiSelect question, several of
// them joined by ", " as the screen joins them.
const fitsQuestion = (question: (typeof QuestionSchema)["Type"], choice: string): boolean => {
  const labels = new Set(question.options.map((o) => o.label))
  if (labels.has(choice)) return true
  return question.multi_select && choice.split(", ").every((part) => labels.has(part))
}

/**
 * The answer `file` gives `request`, or why it doesn't fit: it names another request, gives an
 * answer the request doesn't take, allows a defaultToNo request without `confirm`, gives choices
 * that aren't one option per question, or a reason without a denial.
 */
export const fit = (request: RequestFile, file: AnswerFile): Result.Result<Answer, string> => {
  const refuse = (reason: string) => Result.fail(reason)
  if (file.request !== request.id) {
    return refuse(`it answers request ${file.request}, not ${request.id}`)
  }
  if (!request.answers.includes(file.answer)) {
    return refuse(
      `request ${request.id} can't be answered ${file.answer}; it takes ${request.answers.join(", ")}`,
    )
  }
  const allowing = file.answer !== "deny"
  if (allowing && request.default_to_no && file.confirm !== true) {
    return refuse(`allowing request ${request.id} needs --confirm`)
  }
  if (file.reason !== undefined && file.answer !== "deny") {
    return refuse("a reason goes with deny only")
  }
  const choices = file.choices ?? []
  const choosing = request.kind === "question" && file.answer === "allow"
  if (choices.length > 0 && !choosing) return refuse("choices answer a question's allow only")
  const reason = file.reason === undefined ? {} : { reason: sanitize(file.reason) }
  switch (request.kind) {
    case "permission":
      return Result.succeed(
        file.answer === "allow"
          ? { _tag: "Allow" }
          : file.answer === "allow-run"
            ? { _tag: "AllowForRun" }
            : { _tag: "Deny", ...reason },
      )
    case "question": {
      if (file.answer === "deny") return Result.succeed({ _tag: "Deny", ...reason })
      const questions = request.questions ?? []
      if (choices.length !== questions.length) {
        return refuse(
          `request ${request.id} asks ${questions.length} question${questions.length === 1 ? "" : "s"}: give one choice for each, in order (got ${choices.length})`,
        )
      }
      for (const [i, question] of questions.entries()) {
        const choice = choices[i] ?? ""
        if (!fitsQuestion(question, choice)) {
          return refuse(
            `${JSON.stringify(choice)} isn't an option of question ${i + 1}; its options are ${question.options.map((o) => JSON.stringify(o.label)).join(", ")}`,
          )
        }
      }
      return Result.succeed({ _tag: "Choose", answers: [...choices] })
    }
    case "elicitation":
      return Result.succeed(file.answer === "allow" ? { _tag: "Accept" } : { _tag: "Decline" })
  }
}

/** The bytes of a file the formats here describe: one JSON object and a newline. */
export const encodeFile = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`)

/** Whether a name in the folder is a file writeExclusive is still writing. */
const partName = /^\..*\.part$/

/**
 * Writes `bytes` to `relativePath` below `repo`, created exclusively with mode 0600 (§ 9.1), and
 * whole: the bytes go to a hidden `.part` file beside it, created through openUnder, which is then
 * linked to the name. link(2) fails with EEXIST when the name is taken, as O_EXCL does, and a reader
 * never sees the file half written.
 */
export const writeExclusive = (
  repo: string,
  relativePath: string,
  bytes: Buffer,
): Effect.Effect<void, LibcError | SymlinkRefused | PathRefused | NotAFileRefused> => {
  const slash = relativePath.lastIndexOf("/")
  const part = `${relativePath.slice(0, slash + 1)}.${relativePath.slice(slash + 1)}.${randomBytes(6).toString("hex")}.part`
  return Effect.acquireUseRelease(
    openUnder(repo, part, O.WRONLY | O.CREAT | O.EXCL, 0o600),
    (fd) =>
      Effect.suspend(() => {
        let written = 0
        while (written < bytes.length) written += writeSync(fd, bytes, written)
        try {
          linkSync(join(repo, part), join(repo, relativePath))
          return Effect.void
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? "EIO"
          const errno = (osConstants.errno as Record<string, number>)[code] ?? 0
          return Effect.fail(new LibcError({ call: "link", path: relativePath, errno, code }))
        }
      }),
    (fd) =>
      Effect.andThen(
        Effect.ignore(close(fd)),
        Effect.sync(() => removeUnder(repo, part)),
      ),
  )
}

/** What reading a file below the repository found: its text, or why it wasn't read. */
export type Read =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Refused"; readonly reason: string }

/**
 * Reads `relativePath` below `repo` without following a link at any component, and only if it is
 * a regular file of at most `maxBytes`, owned by `uid` when given.
 */
export const readFileUnder = (
  repo: string,
  relativePath: string,
  options: { readonly uid?: number; readonly maxBytes?: number } = {},
): Effect.Effect<Read> =>
  openUnder(repo, relativePath, O.RDONLY).pipe(
    Effect.matchEffect({
      onFailure: (error): Effect.Effect<Read> =>
        Effect.succeed(
          error instanceof LibcError && error.code === "ENOENT"
            ? { _tag: "Missing" }
            : error instanceof SymlinkRefused
              ? { _tag: "Refused", reason: "it is a symbolic link" }
              : error instanceof NotAFileRefused
                ? { _tag: "Refused", reason: `it is ${error.kind}, not a regular file` }
                : { _tag: "Refused", reason: error.message },
        ),
      onSuccess: (fd) =>
        Effect.sync((): Read => {
          try {
            const stat = fstatSync(fd)
            if (!stat.isFile()) return { _tag: "Refused", reason: "it isn't a regular file" }
            if (options.uid !== undefined && stat.uid !== options.uid) {
              return {
                _tag: "Refused",
                reason: `it belongs to user ${stat.uid}, not the run's (${options.uid})`,
              }
            }
            const max = options.maxBytes ?? maxAnswerBytes
            if (stat.size > max) return { _tag: "Refused", reason: `it is over ${max} bytes` }
            const buffer = Buffer.alloc(max + 1)
            let size = 0
            for (;;) {
              const n = readSync(fd, buffer, size, buffer.length - size, null)
              if (n === 0) break
              size += n
              if (size > max) return { _tag: "Refused", reason: `it is over ${max} bytes` }
            }
            return { _tag: "Text", text: buffer.subarray(0, size).toString("utf8") }
          } catch (error) {
            return {
              _tag: "Refused",
              reason: error instanceof Error ? error.message : String(error),
            }
          } finally {
            Effect.runSync(Effect.ignore(close(fd)))
          }
        }),
    }),
  )

/** Removes `relativePath` below `repo`, the link itself if it is one; true when it was there. */
export const removeUnder = (repo: string, relativePath: string): boolean => {
  try {
    unlinkSync(join(repo, relativePath))
    return true
  } catch {
    return false
  }
}

/**
 * Makes .tutti/run/attention below `repo` where it is missing (mode 0700), and returns its absolute
 * path. A component that is a symbolic link, or not a folder, is refused with an error: nothing is
 * made, listed or removed through one.
 */
export const makeAttentionFolder = (repo: string): string => {
  const why = makeFoldersUnder(repo, attentionFolder, { mode: 0o700 })
  if (why !== undefined) throw new Error(why)
  return join(repo, attentionFolder)
}

/** What `serve` takes. */
export interface ServeOptions {
  /** The main checkout's top level. */
  readonly repo: string
  /** The run's user, whose answer files alone are taken; the process's by default. */
  readonly uid?: number
  /** How often the folder is read besides fs.watch's events; `AttentionPoll` by default. */
  readonly poll?: Duration.Input
}

/** A line for an answer file the run refused. */
const refusedLine = (request: string, reason: string, ticket?: string): log.Line =>
  ticket === undefined
    ? log.tagged("ANSWER_REFUSED")`tutti answer for request ${request}: ${reason}`
    : log.ticketLine(
        "ANSWER_REFUSED",
      )`${ticket}'s worker: tutti answer for request ${request}: ${reason}`

/** A line for an attention folder the run can't use. */
const unusableLine = (reason: string): log.Line =>
  log.tagged("WARN")`${attentionFolder} can't be used (${reason}); tutti answer won't work this run`

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error)

/**
 * The run's side of the attention files, for the scope: clears what an earlier run left in the
 * folder, keeps a file for each open request, and takes the answer files `tutti answer` writes.
 * Nothing here fails: a folder that can't be used is logged, and requests are still answered on
 * screen.
 */
export const serve = (
  options: ServeOptions,
): Effect.Effect<void, never, Attention | Log | Scope.Scope> =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const logs = yield* Log
    const repo = options.repo
    const uid = options.uid ?? process.getuid?.() ?? 0
    const poll = options.poll ?? (yield* AttentionPoll)

    const folder = yield* Effect.try({
      try: () => {
        const made = makeAttentionFolder(repo)
        // What an earlier run left: its requests are gone with it.
        for (const name of readdirSync(made)) {
          if (name.endsWith(".json") || partName.test(name)) {
            removeUnder(repo, `${attentionFolder}/${name}`)
          }
        }
        return made
      },
      catch: reasonOf,
    }).pipe(Effect.catch((reason) => Effect.as(logs.write(unusableLine(reason)), undefined)))
    if (folder === undefined) return

    // The requests whose files were written, by ID.
    const written = yield* Ref.make<ReadonlySet<string>>(new Set())
    const warned = yield* Ref.make(false)
    const warnOnce = (reason: string) =>
      Effect.flatMap(Ref.getAndSet(warned, true), (was) =>
        was ? Effect.void : logs.write(unusableLine(reason)),
      )

    const sync = (requests: ReadonlyArray<AttentionRequest>) =>
      Effect.gen(function* () {
        const before = yield* Ref.get(written)
        const now = new Set(requests.map((r) => r.id))
        const kept = new Set<string>()
        for (const request of requests) {
          if (before.has(request.id)) {
            kept.add(request.id)
            continue
          }
          if (!requestIdPattern.test(request.id)) continue
          const result = yield* Effect.result(
            writeExclusive(repo, requestFile(request.id), encodeFile(toRequestFile(request))),
          )
          if (Result.isSuccess(result)) kept.add(request.id)
          else yield* warnOnce(`writing ${requestFile(request.id)}: ${result.failure.message}`)
        }
        for (const id of before) if (!now.has(id)) removeUnder(repo, requestFile(id))
        yield* Ref.set(written, kept)
      })

    // Refuses the answer to `id`: says why, for the command and the log, and removes it.
    const refuse = (id: string, reason: string, ticket?: string) =>
      Effect.gen(function* () {
        removeUnder(repo, refusedFile(id))
        yield* Effect.ignore(
          writeExclusive(
            repo,
            refusedFile(id),
            encodeFile({ v: fileVersion, request: id, reason }),
          ),
        )
        removeUnder(repo, answerFile(id))
        yield* logs.write(refusedLine(id, reason, ticket))
      })

    const take = (id: string) =>
      Effect.gen(function* () {
        const request = (yield* attention.current).find((r) => r.id === id)
        const read = yield* readFileUnder(repo, answerFile(id), { uid })
        if (read._tag === "Missing") return
        if (read._tag === "Refused") return yield* refuse(id, read.reason, request?.ticket)
        if (request === undefined) return yield* refuse(id, `request ${id} is no longer open`)
        const fitted = Result.flatMap(parseAnswerFile(read.text), (file) =>
          fit(toRequestFile(request), file),
        )
        if (Result.isFailure(fitted)) return yield* refuse(id, fitted.failure, request.ticket)
        const answered = yield* Effect.result(
          attention.answer(id, fitted.success, "answer_command"),
        )
        if (Result.isFailure(answered)) {
          return yield* refuse(id, answered.failure.message, request.ticket)
        }
        removeUnder(repo, answerFile(id))
      })

    const one = yield* Semaphore.make(1)
    const scan = Effect.gen(function* () {
      let names: ReadonlyArray<string>
      try {
        names = readdirSync(folder)
      } catch (error) {
        return yield* warnOnce(`reading ${attentionFolder}: ${reasonOf(error)}`)
      }
      for (const name of names) {
        const id = answerName.exec(name)?.[1]
        if (id !== undefined) yield* take(id)
      }
    }).pipe(one.withPermit)

    yield* Stream.runForEach(attention.open, (requests) =>
      sync(requests).pipe(one.withPermit),
    ).pipe(Effect.forkScoped)

    // fs.watch's events wake the scan; the poll catches what they miss.
    const kicks = yield* Queue.sliding<void>(1)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        try {
          const watcher = fsWatch(folder, () => {
            Queue.offerUnsafe(kicks, undefined)
          })
          watcher.on("error", () => {})
          return watcher
        } catch {
          return undefined
        }
      }),
      (watcher) => Effect.sync(() => watcher?.close()),
    )
    yield* scan.pipe(
      Effect.andThen(Effect.raceFirst(Queue.take(kicks), Effect.sleep(poll))),
      Effect.forever,
      Effect.forkScoped,
    )
  })

/** `serve` for the run's scope, as a layer. */
export const layer = (options: ServeOptions): Layer.Layer<never, never, Attention | Log> =>
  Layer.effectDiscard(serve(options))

/** What the run said about its refusal of the request's answer, if it did; the file is removed. */
export const takeRefusal = (repo: string, id: string): Effect.Effect<string | undefined> =>
  Effect.map(readFileUnder(repo, refusedFile(id)), (read) => {
    if (read._tag === "Missing") return undefined
    removeUnder(repo, refusedFile(id))
    return read._tag === "Text"
      ? (parseRefusedFile(read.text) ?? "the run refused it")
      : read.reason
  })

/** The request file of `id`, or why it can't be read: Missing when the request isn't open. */
export const readRequestFile = (
  repo: string,
  id: string,
): Effect.Effect<Result.Result<RequestFile, string> | undefined> =>
  Effect.map(readFileUnder(repo, requestFile(id)), (read) =>
    read._tag === "Missing"
      ? undefined
      : read._tag === "Refused"
        ? Result.fail(read.reason)
        : parseRequestFile(read.text),
  )

/** The open requests' files, oldest first; a file that can't be read or parsed is left out. */
export const readRequestFiles = (repo: string): Effect.Effect<ReadonlyArray<RequestFile>> =>
  Effect.gen(function* () {
    let names: ReadonlyArray<string>
    try {
      names = readdirSync(join(repo, attentionFolder))
    } catch {
      return []
    }
    const files: Array<RequestFile> = []
    for (const name of names) {
      const id = /^([A-Za-z0-9_-]{1,64})\.json$/.exec(name)?.[1]
      if (id === undefined) continue
      const read = yield* readRequestFile(repo, id)
      if (read !== undefined && Result.isSuccess(read) && read.success.id === id) {
        files.push(read.success)
      }
    }
    return files.sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id),
    )
  })

/** The request as a line names it, from its file: its title, else `Bash(rm -rf build)`. */
export const describeFile = (request: RequestFile): string => {
  switch (request.kind) {
    case "permission":
      return request.title ?? `${request.tool ?? "?"}(${request.summary ?? ""})`
    case "question":
      return (request.questions ?? []).map((q) => q.question).join("; ")
    case "elicitation":
      return `MCP server ${request.server ?? "?"}: ${request.message ?? ""}`
  }
}
