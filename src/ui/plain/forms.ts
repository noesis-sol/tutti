// The line forms (§ 7.1): the start question, an open question, and a select, a confirm and a text
// for init, for TERM=dumb and no TTY. Each asks one question per line:
// a select lists its options numbered and reads a
// number, a confirm reads y or n, a text reads a line. An answer that doesn't do is said in the
// error style and asked again. The end of input (Ctrl+D) cancels the form, as Esc does in the
// renderer; huh took it for each remaining field's default answer.
//
// They are written without OpenTUI, in the theme's ANSI styles, and read their answers a line at
// a time, taking from the input no more than the lines they ask for.
//
// A question asked before an overnight run has a time limit (src/run/answerLimit.ts): its
// countdown is the line above its prompt, `No answer in 4:59 takes yes.`, drawn again each second
// where the terminal moves its cursor, the answer being typed left as it is.
import { Clock, Duration, Effect, Option, type Scope } from "effect"
import {
  countdownText,
  countdownTick,
  leavesOpen,
  type Taken,
  takesAnswer,
} from "../../run/answerLimit.ts"
import {
  choicesOf,
  confirmHint,
  describeDescription,
  describeTitle,
  FormCancelled,
  fetchingLine,
  leaveOpen,
  noAnswerTyped,
  noDescription,
  noSpecPath,
  type OpenQuestion,
  optionAt,
  otherChoice,
  type QuestionAt,
  questionHeading,
  type Reply,
  type SpecAsk,
  specDescription,
  specTitle,
  startDescription,
  startOptions,
  startTitle,
  type TicketCount,
  Work,
} from "../questions.ts"
import { exists, fileProblem } from "../specFiles.ts"
import { readTyped, unquoted } from "../specPath.ts"
import type { Theme } from "../theme.ts"

/** Lines read from the terminal: the next, or none once input has ended. */
export interface LineInput {
  readonly readLine: Effect.Effect<Option.Option<string>>
}

/** Where a line form asks: its input, its output, and the theme it is drawn in. */
export interface LineIO {
  readonly input: LineInput
  readonly write: (text: string) => void
  readonly theme: Theme
  /**
   * Where the output is a terminal that moves its cursor (not TERM=dumb): its width, for a
   * countdown drawn again above the prompt. Without it, a countdown is said once.
   */
  readonly live?: { readonly columns: () => number }
}

/** A question's time limit, as its countdown says it: when it runs out (Clock's), and what no answer takes. */
export interface Countdown {
  readonly deadline: number
  readonly taken: Taken
}

/** The countdown of a question asked now that waits `limit` for its answer, `taken` without one. */
const countdownOf = (limit: Duration.Duration, taken: Taken): Effect.Effect<Countdown> =>
  Effect.map(Clock.currentTimeMillis, (now) => ({
    deadline: now + Duration.toMillis(limit),
    taken,
  }))

/**
 * The lines of `stream` (stdin), for the rest of the scope. The stream flows only while a line is
 * asked for; a line ends at a newline (a carriage return before it dropped), or at the end of
 * input with what came before it.
 */
export const streamInput = (
  stream: NodeJS.ReadableStream,
): Effect.Effect<LineInput, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const decoder = new TextDecoder()
      let buffered = ""
      let ended = false
      const waiting = new Set<() => void>()
      const wake = () => {
        for (const waiter of [...waiting]) waiter()
      }
      const onData = (chunk: Buffer | string) => {
        buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
        wake()
      }
      const onEnd = () => {
        if (ended) return
        ended = true
        buffered += decoder.decode()
        wake()
      }
      stream.on("data", onData)
      stream.on("end", onEnd)
      stream.on("close", onEnd)
      stream.on("error", onEnd)
      stream.pause()
      /** The next line, none at the end of input, or undefined while it hasn't come. */
      const take = (): Option.Option<string> | undefined => {
        const at = buffered.indexOf("\n")
        if (at >= 0) {
          const line = buffered.slice(0, at).replace(/\r$/, "")
          buffered = buffered.slice(at + 1)
          return Option.some(line)
        }
        if (!ended) return undefined
        if (buffered === "") return Option.none()
        const line = buffered
        buffered = ""
        return Option.some(line)
      }
      const readLine = Effect.callback<Option.Option<string>>((resume) => {
        const attempt = () => {
          const line = take()
          if (line === undefined) {
            waiting.add(attempt)
            stream.resume()
            return
          }
          waiting.delete(attempt)
          if (waiting.size === 0) stream.pause()
          resume(Effect.succeed(line))
        }
        attempt()
        return Effect.sync(() => {
          waiting.delete(attempt)
          if (waiting.size === 0) stream.pause()
        })
      })
      const release = () => {
        stream.off("data", onData)
        stream.off("end", onEnd)
        stream.off("close", onEnd)
        stream.off("error", onEnd)
        stream.pause()
      }
      return { input: { readLine } satisfies LineInput, release }
    }),
    ({ release }) => Effect.sync(release),
  ).pipe(Effect.map(({ input }) => input))

/** The key that cancels a line form. */
export const cancelKey = "Ctrl+D"

/**
 * The line `prompt` was written after, `text` now, drawn again over it, the cursor left where it
 * was in what is being typed: the prompt is taken to be on lines of its own, as wide as it is.
 */
const redrawAbove = (io: LineIO, columns: number, prompt: string, text: string) => {
  const rows = Math.max(1, Math.ceil(Bun.stringWidth(prompt) / Math.max(columns, 1)))
  io.write(`\x1b7\x1b[${rows}A\r\x1b[2K${text}\x1b8`)
}

/**
 * Asks with `prompt` until `parse` takes the answer, saying each of its errors, then leaves a
 * blank line, as huh's accessible form does after each field. Fails with FormCancelled at the end
 * of input. With `countdown`, the line above each prompt says how long is left and what no answer
 * takes, drawn again each second in a live terminal; the caller ends the question when it runs out.
 */
const ask = <A>(
  io: LineIO,
  prompt: string,
  parse: (answer: string) => { readonly ok: A } | { readonly error: string },
  countdown?: Countdown,
): Effect.Effect<A, FormCancelled> =>
  Effect.gen(function* () {
    const said = Effect.map(Clock.currentTimeMillis, (now) =>
      countdown === undefined
        ? ""
        : io.theme.form.description.paint(countdownText(countdown.deadline - now, countdown.taken)),
    )
    while (true) {
      if (countdown !== undefined) io.write(`${yield* said}\n`)
      io.write(prompt)
      const live = io.live
      const read =
        countdown === undefined || live === undefined
          ? io.input.readLine
          : Effect.raceFirst(
              io.input.readLine,
              Effect.forever(
                Effect.andThen(
                  Effect.sleep(countdownTick),
                  Effect.flatMap(said, (text) =>
                    Effect.sync(() => redrawAbove(io, live.columns(), prompt, text)),
                  ),
                ),
              ),
            )
      // Its time run out, the question ends its prompt's line, for what is said after it.
      const line = yield* Effect.onInterrupt(read, () => Effect.sync(() => io.write("\n")))
      if (Option.isNone(line)) {
        io.write("\n")
        return yield* new FormCancelled()
      }
      const parsed = parse(line.value)
      if ("ok" in parsed) {
        io.write("\n")
        return parsed.ok
      }
      io.write(`${io.theme.form.error.paint(parsed.error)}\n`)
    }
  })

/** A field's title, and its description under it. */
const heading = (io: LineIO, title: string, description: string | undefined) => {
  io.write(`${io.theme.form.fieldTitle.paint(title)}\n`)
  if (description !== undefined) io.write(`${io.theme.form.description.paint(description)}\n`)
}

/** The prompt at the end of a question: `>`, in the accent. */
const prompt = (io: LineIO, text: string) => `${text}${io.theme.form.selector.paint(">")} `

/**
 * A select: `title`, `description`, then each of `options` numbered from 1; reads the number of
 * the one chosen, or nothing for `initial`'s (the first's by default). Its index. With
 * `countdown`, the line above its prompt counts down to it.
 */
export const select = (
  io: LineIO,
  field: {
    readonly title: string
    readonly description?: string
    readonly options: ReadonlyArray<string>
    readonly initial?: number
    readonly countdown?: Countdown
  },
): Effect.Effect<number, FormCancelled> => {
  const { options } = field
  const initial = field.initial ?? 0
  heading(io, field.title, field.description)
  options.forEach((option, at) => {
    io.write(`${at + 1}. ${io.theme.form.option.paint(option)}\n`)
  })
  const range =
    options.length === 1
      ? "There is only one option; enter 1"
      : `Enter a number between 1 and ${options.length}`
  return ask(
    io,
    prompt(io, `${range} `),
    (answer) => {
      const text = answer.trim()
      if (text === "") return { ok: initial }
      const n = /^\d+$/.test(text) ? Number(text) : Number.NaN
      return n >= 1 && n <= options.length
        ? { ok: n - 1 }
        : {
            error:
              options.length === 1
                ? "Invalid: must be 1"
                : `Invalid: must be a number between 1 and ${options.length}`,
          }
    },
    field.countdown,
  )
}

/**
 * A confirm: `question` and `[y/N]`; y or yes is true, n, no or nothing `initial` (false). With
 * `limit`, its countdown says that no answer within it takes `initial`.
 */
export const confirm = (
  io: LineIO,
  field: {
    readonly question: string
    readonly description?: string
    readonly initial?: boolean
    readonly limit?: Duration.Duration
  },
): Effect.Effect<boolean, FormCancelled> => {
  const initial = field.initial ?? false
  if (field.description !== undefined) {
    io.write(`${io.theme.form.description.paint(field.description)}\n`)
  }
  const hint = initial ? "[Y/n]" : confirmHint
  const question = `${io.theme.form.fieldTitle.paint(field.question)} ${io.theme.form.description.paint(hint)} `
  const countdown =
    field.limit === undefined
      ? Effect.succeed(undefined)
      : countdownOf(field.limit, takesAnswer(initial))
  return Effect.flatMap(countdown, (counting) =>
    ask(
      io,
      question,
      (answer) => {
        const text = answer.trim().toLowerCase()
        if (text === "") return { ok: initial }
        if (text === "y" || text === "yes") return { ok: true }
        if (text === "n" || text === "no") return { ok: false }
        return { error: "Answer y or n." }
      },
      counting,
    ),
  )
}

/**
 * A text: `title`, `description`, then a line; asked again while `validate` says what is wrong
 * with it. The line, trimmed. With `countdown`, the line above its prompt counts down to it.
 */
export const text = (
  io: LineIO,
  field: {
    readonly title: string
    readonly description?: string
    readonly validate?: (answer: string) => string | null
    readonly countdown?: Countdown
  },
): Effect.Effect<string, FormCancelled> => {
  heading(io, field.title, field.description)
  return ask(
    io,
    prompt(io, ""),
    (answer) => {
      const error = field.validate?.(answer) ?? null
      return error === null ? { ok: answer.trim() } : { error }
    },
    field.countdown,
  )
}

/**
 * The spec's file or URL, a line at a time, as the renderer's field checks it (SpecField.tsx),
 * without its completion or browser: asked again while the path names no file of text with
 * something in it, or the URL can't be fetched (`spec.checkUrl`). The spec, its path absolute.
 */
export const specFile = (io: LineIO, spec: SpecAsk): Effect.Effect<string, FormCancelled> =>
  Effect.gen(function* () {
    heading(io, specTitle, specDescription)
    while (true) {
      io.write(prompt(io, ""))
      const line = yield* io.input.readLine
      if (Option.isNone(line)) {
        io.write("\n")
        return yield* new FormCancelled()
      }
      const read = readTyped(line.value, spec.where, exists)
      const problem =
        read._tag === "Empty"
          ? noSpecPath(false)
          : read._tag === "Url"
            ? yield* Effect.andThen(
                Effect.sync(() =>
                  io.write(`${io.theme.form.description.paint(fetchingLine(read.url))}\n`),
                ),
                spec.checkUrl(read.url),
              )
            : fileProblem(read.path, unquoted(line.value))
      if (problem === null) {
        io.write("\n")
        return read._tag === "Url" ? read.url : read._tag === "Path" ? read.path : ""
      }
      io.write(`${io.theme.form.error.paint(problem)}\n`)
    }
  })

/**
 * The start question, a line at a time: the current tickets, as `count` says of them, a spec,
 * whose file or URL it then reads (specFile), run as it is, as refining it needs the renderer; or a
 * new feature, whose description it then reads.
 */
export const startQuestion = (
  io: LineIO,
  count: TicketCount,
  spec: SpecAsk,
): Effect.Effect<Work, FormCancelled> =>
  Effect.gen(function* () {
    const chosen = yield* select(io, {
      title: startTitle,
      description: startDescription,
      options: startOptions(count),
    })
    if (chosen === optionAt.tickets) return Work.Tickets()
    if (chosen === optionAt.spec) {
      return Work.Spec({ given: yield* specFile(io, spec), refine: false })
    }
    const description = yield* text(io, {
      title: describeTitle,
      description: describeDescription,
      validate: (answer) => (answer.trim() === "" ? noDescription(cancelKey) : null),
    })
    return Work.Feature({ description })
  })

/**
 * An open question put before an overnight run (src/run/overnightQuestions.ts), a line at a time:
 * its heading, title and description, then its options numbered, the recommended one first, Other
 * and Leave open; Other reads your own answer on the next line. With `limit`, a countdown says
 * that no answer within it leaves the question open.
 */
export const openQuestion = (
  io: LineIO,
  question: OpenQuestion,
  at: QuestionAt,
  limit?: Duration.Duration,
): Effect.Effect<Reply, FormCancelled> =>
  Effect.gen(function* () {
    const countdown = limit === undefined ? undefined : yield* countdownOf(limit, leavesOpen)
    const counting = countdown === undefined ? {} : { countdown }
    io.write(`${io.theme.form.description.paint(questionHeading(question, at))}\n`)
    const choices = choicesOf(question)
    const chosen = yield* select(io, {
      ...counting,
      title: question.title,
      ...(question.description === "" ? {} : { description: question.description }),
      options: choices.map((choice) =>
        choice._tag === "Option"
          ? `${choice.label}${choice.description === "" ? "" : ` — ${choice.description}`}`
          : choice._tag === "Other"
            ? `${otherChoice}: type your own`
            : leaveOpen,
      ),
    })
    const choice = choices[chosen]
    if (choice === undefined || choice._tag === "LeaveOpen") return { _tag: "LeaveOpen" } as const
    if (choice._tag === "Option") return { _tag: "Answer", answer: choice.answer } as const
    const answer = yield* text(io, {
      ...counting,
      title: `Your answer to ${question.id}`,
      validate: (typed) => (typed.trim() === "" ? noAnswerTyped(cancelKey) : null),
    })
    return { _tag: "Answer", answer } as const
  })
