// The line forms (§ 7.1): the start question, the plan confirmation and the generic select,
// confirm and text, asked one question per line for TERM=dumb and no TTY. The end of input
// (Ctrl+D) cancels, as Esc does in the renderer.
import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect, Exit, Option } from "effect"
import fc from "fast-check"
import {
  confirm,
  type LineIO,
  planConfirmation,
  select,
  startQuestion,
  streamInput,
  text,
} from "../src/ui/plain/forms.ts"
import {
  fileQuestion,
  type Plan,
  paintLine,
  planLines,
  TicketCount,
  type Work,
} from "../src/ui/questions.ts"
import { makeTheme, orchestra, type Theme } from "../src/ui/theme.ts"

const plainTheme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
const colourTheme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/** Bold and faint, which NO_COLOR keeps, left out, to read the output as text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the output's escape sequences
const unstyled = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "")

/**
 * Runs `form` over `input`, a terminal's typing: the stream ends after it, as Ctrl+D ends it.
 * Its exit, and what it wrote.
 */
const answer = async <A, E>(
  input: string,
  form: (io: LineIO) => Effect.Effect<A, E>,
  options: { readonly theme?: Theme; readonly end?: boolean } = {},
) => {
  const stream = new PassThrough()
  stream.write(input)
  if (options.end ?? true) stream.end()
  let output = ""
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const io: LineIO = {
          input: yield* streamInput(stream),
          write: (text) => {
            output += text
          },
          theme: options.theme ?? plainTheme,
        }
        return yield* form(io)
      }),
    ),
  )
  return { exit, output: unstyled(output), raw: output }
}

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`the form failed: ${exit.cause}`)
  return exit.value
}

const cancelled = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && String(exit.cause).includes("FormCancelled")

const colours = { title: "\x1b[38;2;117;113;249m", error: "\x1b[38;2;237;86;122m" }

describe("a select", () => {
  const options = { title: "Pick one", description: "or not", options: ["first", "second"] }

  test("lists its options numbered, then reads the number of the one chosen", async () => {
    const { exit, output } = await answer("2\n", (io) => select(io, options))
    expect(value(exit)).toBe(1)
    expect(output).toBe(
      "Pick one\nor not\n1. first\n2. second\nEnter a number between 1 and 2 > \n",
    )
  })

  test("nothing chooses the first, or the one given", async () => {
    expect(value((await answer("\n", (io) => select(io, options))).exit)).toBe(0)
    expect(value((await answer("\n", (io) => select(io, { ...options, initial: 1 }))).exit)).toBe(1)
  })

  test("asks again after an answer that doesn't do, saying why", async () => {
    const { exit, output } = await answer("9\nfirst\n 1 \n", (io) => select(io, options))
    expect(value(exit)).toBe(0)
    expect(output.split("Invalid: must be a number between 1 and 2\n")).toHaveLength(3)
  })

  test("the end of input cancels it", async () => {
    const { exit, output } = await answer("", (io) => select(io, options))
    expect(cancelled(exit)).toBe(true)
    expect(output.endsWith("> \n")).toBe(true)
  })

  test("is drawn in the form roles", async () => {
    const { raw } = await answer("x\n1\n", (io) => select(io, options), { theme: colourTheme })
    expect(raw).toContain(`${colours.title}Pick one`)
    expect(raw).toContain(`${colours.error}Invalid`)
  })
})

describe("a confirm", () => {
  test.each([
    ["y", true],
    ["yes", true],
    ["Y", true],
    ["n", false],
    ["no", false],
    ["", false],
  ])("%p answers %p", async (typed, expected) => {
    const { exit, output } = await answer(`${typed}\n`, (io) => confirm(io, { question: "Go?" }))
    expect(value(exit)).toBe(expected)
    expect(output).toBe("Go? [y/N] \n")
  })

  test("asks again after an answer that is neither", async () => {
    const { exit, output } = await answer("maybe\ny\n", (io) => confirm(io, { question: "Go?" }))
    expect(value(exit)).toBe(true)
    expect(output).toBe("Go? [y/N] Answer y or n.\nGo? [y/N] \n")
  })

  test("[Y/n] when yes is the default", async () => {
    const { exit, output } = await answer("\n", (io) =>
      confirm(io, { question: "Go?", initial: true }),
    )
    expect(value(exit)).toBe(true)
    expect(output).toBe("Go? [Y/n] \n")
  })

  test("the end of input cancels it, even after part of a line", async () => {
    expect(cancelled((await answer("", (io) => confirm(io, { question: "Go?" }))).exit)).toBe(true)
    // Ctrl+D after `y` sends the y; a second Ctrl+D ends the input. The y was the answer.
    expect(value((await answer("y", (io) => confirm(io, { question: "Go?" }))).exit)).toBe(true)
  })
})

describe("a text", () => {
  test("reads a line, asked again while it isn't valid", async () => {
    const { exit, output } = await answer("\n  a name  \n", (io) =>
      text(io, {
        title: "Name",
        validate: (typed) => (typed.trim() === "" ? "say a name" : null),
      }),
    )
    expect(value(exit)).toBe("a name")
    expect(output).toBe("Name\n> say a name\n> \n")
  })

  test("the end of input cancels it", async () => {
    expect(cancelled((await answer("", (io) => text(io, { title: "Name" }))).exit)).toBe(true)
  })
})

describe("the start question as lines", () => {
  const ask = (input: string, count: TicketCount = TicketCount.Ready({ n: 3 })) =>
    answer(input, (io) => startQuestion(io, count))

  test("1 is the current tickets, with their count", async () => {
    const { exit, output } = await ask("1\n")
    expect(value(exit)).toEqual({ _tag: "Tickets" } as Work)
    expect(output).toContain("What should this run work on?\n")
    expect(output).toContain("1. Current tickets: 3 ready\n")
    expect(output).toContain("2. New feature: describe it, talk it through, run its tickets\n")
    expect(output).not.toContain("Describe the feature")
  })

  test("2 is a new feature, whose description it then reads", async () => {
    const { exit, output } = await ask("2\n  an undo stack  \n")
    expect(value(exit)).toEqual({ _tag: "Feature", description: "an undo stack" } as Work)
    expect(output).toContain("Describe the feature\n")
    // One line: no new-line keys to name.
    expect(output).not.toContain("Ctrl+J")
  })

  test("an empty description is refused until one is typed", async () => {
    const { exit, output } = await ask("2\n\n \nx\n")
    expect(value(exit)).toEqual({ _tag: "Feature", description: "x" } as Work)
    expect(output.split("describe the feature first, or press Ctrl+D to cancel\n")).toHaveLength(3)
  })

  test("the end of input cancels it, at the select or at the description", async () => {
    expect(cancelled((await ask("")).exit)).toBe(true)
    expect(cancelled((await ask("2\n")).exit)).toBe(true)
  })

  test("says why there is nothing to run", async () => {
    const { output } = await ask("1\n", TicketCount.NoneReady({ open: 2 }))
    expect(output).toContain("1. Current tickets: none ready (2 open)\n")
  })
})

const plan: Plan = {
  epic: { title: "Undo stack", description: "Record edits." },
  tickets: [
    { key: "undo", type: "feature", priority: 1, title: "Add it", files: ["a.ts"], after: [] },
    { key: "keys", type: "task", priority: 2, title: "Bind it", files: [], after: ["undo"] },
  ],
  notes: [],
}

describe("the plan confirmation as lines", () => {
  test("prints the plan, then asks", async () => {
    const { exit, output } = await answer("y\n", (io) =>
      planConfirmation(io, plan, fileQuestion(plan)),
    )
    expect(value(exit)).toBe(true)
    expect(output).toBe(
      [
        "",
        "Epic: Undo stack",
        "  Record edits.",
        "",
        "2 tickets:",
        "  undo  feature P1  Add it",
        "        files: a.ts",
        "  keys  task    P2  Bind it",
        "        after: undo",
        "",
        "File these 2 tickets and start the run? [y/N] ",
        "",
      ].join("\n"),
    )
  })

  test("Enter says no; the end of input cancels", async () => {
    const no = await answer("\n", (io) => planConfirmation(io, plan, fileQuestion(plan)))
    expect(value(no.exit)).toBe(false)
    const ended = await answer("", (io) => planConfirmation(io, plan, fileQuestion(plan)))
    expect(cancelled(ended.exit)).toBe(true)
  })

  test("a plan's text never reaches the terminal as what it would act on", () => {
    const words = fc.string({ unit: "binary", maxLength: 40 })
    fc.assert(
      fc.property(
        words,
        words,
        fc.array(fc.record({ key: words, type: words, title: words, file: words }), {
          maxLength: 3,
        }),
        (title, description, tickets) => {
          const lines = planLines(
            {
              epic: { title, description },
              tickets: tickets.map((t) => ({
                key: t.key,
                type: t.type,
                priority: 2,
                title: t.title,
                files: [t.file],
                after: [t.key],
              })),
              notes: [description],
            },
            plainTheme,
          ).map((line) => unstyled(paintLine(line)))
          for (const line of lines) {
            // biome-ignore lint/suspicious/noControlCharactersInRegex: what must not be there
            expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/)
          }
        },
      ),
    )
  })
})

describe("the lines of a stream", () => {
  test("are read one at a time, only as they are asked for", async () => {
    const stream = new PassThrough()
    stream.write("first\r\nsec")
    const lines = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* streamInput(stream)
          const first = yield* input.readLine
          setTimeout(() => {
            stream.write(Buffer.from("ond é".slice(0, 4)))
            stream.write(Buffer.from([0xc3]))
            stream.write(Buffer.from([0xa9, 0x0a]))
            stream.end("third")
          }, 5)
          const second = yield* input.readLine
          const third = yield* input.readLine
          const after = yield* input.readLine
          return [first, second, third, after]
        }),
      ),
    )
    expect(lines).toEqual([
      Option.some("first"),
      Option.some("second é"),
      Option.some("third"),
      Option.none(),
    ])
  })

  test("are left in the stream once the scope closes", async () => {
    const stream = new PassThrough()
    await Effect.runPromise(Effect.scoped(streamInput(stream)))
    expect(stream.listenerCount("data")).toBe(0)
    expect(stream.listenerCount("end")).toBe(0)
  })
})
