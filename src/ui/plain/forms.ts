// The line forms (§ 7.1): the start question, the plan confirmation, and a select, a confirm and a
// text for init, for TERM=dumb and no TTY. Each asks one question per line, as orchestra's
// accessible mode (huh's, with TERM=dumb) does: a select lists its options numbered and reads a
// number, a confirm reads y or n, a text reads a line. An answer that doesn't do is said in the
// error style and asked again. The end of input (Ctrl+D) cancels the form, as Esc does in the
// renderer; huh took it for each remaining field's default answer.
//
// They are written without OpenTUI, in the theme's ANSI styles, and read their answers a line at
// a time, taking from the input no more than the lines they ask for.
import { Effect, Option, type Scope } from "effect"
import { paint } from "../line.tsx"
import {
  choicesOf,
  confirmHint,
  describeDescription,
  describeTitle,
  FormCancelled,
  leaveOpen,
  noAnswerTyped,
  noDescription,
  type OpenQuestion,
  otherChoice,
  type Plan,
  planLines,
  type QuestionAt,
  questionHeading,
  type Reply,
  startDescription,
  startOptions,
  startTitle,
  type TicketCount,
  Work,
} from "../questions.ts"
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
}

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
 * Asks with `prompt` until `parse` takes the answer, saying each of its errors, then leaves a
 * blank line, as huh's accessible form does after each field. Fails with FormCancelled at the end
 * of input.
 */
const ask = <A>(
  io: LineIO,
  prompt: string,
  parse: (answer: string) => { readonly ok: A } | { readonly error: string },
): Effect.Effect<A, FormCancelled> =>
  Effect.gen(function* () {
    while (true) {
      io.write(prompt)
      const line = yield* io.input.readLine
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
 * the one chosen, or nothing for `initial`'s (the first's by default). Its index.
 */
export const select = (
  io: LineIO,
  field: {
    readonly title: string
    readonly description?: string
    readonly options: ReadonlyArray<string>
    readonly initial?: number
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
  return ask(io, prompt(io, `${range} `), (answer) => {
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
  })
}

/** A confirm: `question` and `[y/N]`; y or yes is true, n, no or nothing `initial` (false). */
export const confirm = (
  io: LineIO,
  field: { readonly question: string; readonly description?: string; readonly initial?: boolean },
): Effect.Effect<boolean, FormCancelled> => {
  const initial = field.initial ?? false
  if (field.description !== undefined) {
    io.write(`${io.theme.form.description.paint(field.description)}\n`)
  }
  const hint = initial ? "[Y/n]" : confirmHint
  const question = `${io.theme.form.fieldTitle.paint(field.question)} ${io.theme.form.description.paint(hint)} `
  return ask(io, question, (answer) => {
    const text = answer.trim().toLowerCase()
    if (text === "") return { ok: initial }
    if (text === "y" || text === "yes") return { ok: true }
    if (text === "n" || text === "no") return { ok: false }
    return { error: "Answer y or n." }
  })
}

/**
 * A text: `title`, `description`, then a line; asked again while `validate` says what is wrong
 * with it. The line, trimmed.
 */
export const text = (
  io: LineIO,
  field: {
    readonly title: string
    readonly description?: string
    readonly validate?: (answer: string) => string | null
  },
): Effect.Effect<string, FormCancelled> => {
  heading(io, field.title, field.description)
  return ask(io, prompt(io, ""), (answer) => {
    const error = field.validate?.(answer) ?? null
    return error === null ? { ok: answer.trim() } : { error }
  })
}

/**
 * The start question, a line at a time: the current tickets, as `count` says of them, or a new
 * feature, whose description it then reads.
 */
export const startQuestion = (io: LineIO, count: TicketCount): Effect.Effect<Work, FormCancelled> =>
  Effect.gen(function* () {
    const chosen = yield* select(io, {
      title: startTitle,
      description: startDescription,
      options: startOptions(count),
    })
    if (chosen === 0) return Work.Tickets()
    const description = yield* text(io, {
      title: describeTitle,
      description: describeDescription,
      validate: (answer) => (answer.trim() === "" ? noDescription(cancelKey) : null),
    })
    return Work.Feature({ description })
  })

/** The plan confirmation, a line at a time: the plan, then `question` with `[y/N]`. */
export const planConfirmation = (
  io: LineIO,
  plan: Plan,
  question: string,
): Effect.Effect<boolean, FormCancelled> =>
  Effect.gen(function* () {
    io.write("\n")
    for (const line of planLines(plan, io.theme)) io.write(`${paint(line)}\n`)
    io.write("\n")
    return yield* confirm(io, { question })
  })

/**
 * An open question put before an overnight run (src/run/overnightQuestions.ts), a line at a time:
 * its heading, title and description, then its options numbered, the recommended one first, Other
 * and Leave open; Other reads your own answer on the next line.
 */
export const openQuestion = (
  io: LineIO,
  question: OpenQuestion,
  at: QuestionAt,
): Effect.Effect<Reply, FormCancelled> =>
  Effect.gen(function* () {
    io.write(`${io.theme.form.description.paint(questionHeading(question, at))}\n`)
    const choices = choicesOf(question)
    const chosen = yield* select(io, {
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
      title: `Your answer to ${question.id}`,
      validate: (typed) => (typed.trim() === "" ? noAnswerTyped(cancelKey) : null),
    })
    return { _tag: "Answer", answer } as const
  })
