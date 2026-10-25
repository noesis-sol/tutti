// --overnight's open questions put before the first ticket (src/run/overnightQuestions.ts;
// tutti-kkb.51): those in the run's scope, with --ticket and without; each put one by one in the
// answer form in the renderer (src/ui/OpenQuestion.tsx) or as lines (src/ui/plain/forms.ts),
// answered with an option, the recommended one first, or with Other, or left open; a question
// without options, and a maintainer_only one; those left open listed, without a terminal every one;
// a cancel keeping the answers given; and the tickets an answer frees ready for the run.
import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect, Exit, Layer, Option } from "effect"
import fc from "fast-check"
import { makePrinter } from "../src/print/organLine.ts"
import type { Log } from "../src/run/log.ts"
import {
  openQuestions,
  type Put,
  type Putting,
  putQuestions,
  questionsCancelledMessage,
} from "../src/run/overnightQuestions.ts"
import { ready } from "../src/run/scope.ts"
import { Beads } from "../src/services/Beads.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { OpenQuestionForm } from "../src/ui/OpenQuestion.tsx"
import { type LineIO, openQuestion, streamInput } from "../src/ui/plain/forms.ts"
import { choicesOf, FormCancelled, type OpenQuestion, type Reply } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { idleFrame, pressEscape, withRender } from "./render.ts"

const theme = makeTheme(orchestra, {
  appearance: "dark",
  depth: "256",
  noColor: true,
  styled: false,
})

/** A question ticket's metadata: its options, `recommended` the index of one. */
const metadata = (recommended: number, extra: Record<string, unknown> = {}) => ({
  options: [
    { label: "--flag", description: "short to type" },
    { label: "--long-flag", description: "says what it does" },
    { label: "none", description: "leave it out" },
  ],
  recommended,
  ...extra,
})

/**
 * A backlog of two questions, each blocking a ticket, one of them under the epic tut-e; bd human list
 * gives them by priority.
 */
const backlog: ReadonlyArray<TestBeads.Seed> = [
  { id: "tut-e", title: "Epic", type: "epic" },
  { id: "tut-1", title: "Under the epic", parent: "tut-e", blockedBy: ["q-1"] },
  { id: "tut-2", title: "Outside it", blockedBy: ["q-2"] },
  {
    id: "q-1",
    title: "Which flag name?",
    description: "The flag\nneeds a name.",
    priority: 1,
    labels: ["human"],
    metadata: metadata(1),
  },
  { id: "q-2", title: "Which colour?", priority: 2, labels: ["human"] },
  { id: "q-3", title: "Answered already", labels: ["human"], status: "closed" },
]

/** `effect` on the test layers over `seeds`, and the log's lines after it. */
const onBacklog = <A, E>(
  seeds: ReadonlyArray<TestBeads.Seed>,
  effect: Effect.Effect<A, E, Beads | TestBeads.Backlog | Log>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const value = yield* effect
      return { value, logged: yield* texts }
    }).pipe(Effect.provide(Layer.mergeAll(TestBeads.layer(seeds), logLayer()))),
  )

/** Puts the questions in scope `scope` with `replies` (undefined cancels; none: no terminal). */
const putAll = (
  seeds: ReadonlyArray<TestBeads.Seed>,
  scope: string | null,
  replies: ReadonlyArray<Reply | undefined> | undefined,
) => {
  const printed: Array<string> = []
  const putTo: Array<OpenQuestion> = []
  const left = [...(replies ?? [])]
  const put: Put = (question) =>
    Effect.suspend(() => {
      putTo.push(question)
      const reply = left.shift()
      return reply === undefined ? Effect.fail(new FormCancelled()) : Effect.succeed(reply)
    })
  const printer = makePrinter(
    { write: (text) => printed.push(text), columns: () => 400, tty: false },
    theme,
  )
  return onBacklog(
    seeds,
    Effect.gen(function* () {
      const questions = yield* openQuestions(scope as never)
      const putting: Putting = yield* putQuestions({
        questions,
        put: replies === undefined ? Option.none() : Option.some(put),
        say: { ...printer, theme },
      })
      const beads = yield* Beads
      const backlogNow = yield* TestBeads.Backlog
      const readyNow = (yield* ready(beads, scope as never, { excludeTypes: [] })).map((issue) =>
        String(issue.id),
      )
      return {
        putting,
        readyNow,
        q1: yield* backlogNow.comments("q-1"),
        q2: yield* backlogNow.comments("q-2"),
      }
    }),
  ).then(({ value, logged }) => ({
    ...value,
    logged,
    putTo,
    printed: printed.join("").split("\n"),
  }))
}

describe("the open questions in the run's scope", () => {
  test("without --ticket, every open question, with the tickets each keeps waiting", async () => {
    const { value } = await onBacklog(backlog, openQuestions(null))
    expect(value.map((question) => [String(question.id), question.waiting.map(String)])).toEqual([
      ["q-1", ["tut-1"]],
      ["q-2", ["tut-2"]],
    ])
    const [q1] = value
    expect(q1?.title).toBe("Which flag name?")
    expect(q1?.description).toBe("The flag\nneeds a name.")
    // The recommended option first.
    expect(q1?.options?.map((option) => option.label)).toEqual(["--long-flag", "--flag", "none"])
  })

  test("with --ticket, those that block it or a ticket under it, or are under it", async () => {
    const under = await onBacklog(
      [
        ...backlog,
        {
          id: "q-4",
          title: "Under the epic itself",
          priority: 3,
          labels: ["human"],
          parent: "tut-e",
        },
      ],
      openQuestions("tut-e" as never),
    )
    expect(under.value.map((question) => String(question.id))).toEqual(["q-1", "q-4"])
    const alone = await onBacklog(backlog, openQuestions("tut-2" as never))
    expect(alone.value.map((question) => String(question.id))).toEqual(["q-2"])
  })
})

describe("putting the open questions", () => {
  test("an option answers, the recommended one first, freeing the ticket it blocked", async () => {
    const result = await putAll(backlog, null, [
      { _tag: "Answer", answer: "--long-flag" },
      { _tag: "LeaveOpen" },
    ])
    expect(result.putting).toEqual({ _tag: "Done", answered: 1, left: 1 })
    expect(result.q1).toEqual(["--long-flag"])
    expect(result.readyNow).toContain("tut-1")
    expect(result.readyNow).not.toContain("tut-2")
    expect(result.printed).toContain("◆ Answered 1 question")
    expect(result.printed).toContain("◆ Overnight pre-flight: 1 question left open")
    expect(result.printed).toContain(
      '  ! q-2 (Which colour?): tut-2 waits on it. Answer it with bd human respond q-2 "<answer>"',
    )
    expect(result.logged).toContain(
      "overnight pre-flight: answered q-1 (Which flag name?): --long-flag",
    )
    expect(result.logged).toContain(
      "overnight pre-flight: left open: q-2 (Which colour?): tut-2 waits on it",
    )
  })

  test("Other records the text typed", async () => {
    const result = await putAll(backlog, null, [
      { _tag: "Answer", answer: "--name, after the old tool" },
      { _tag: "Answer", answer: "blue" },
    ])
    expect(result.putting).toEqual({ _tag: "Done", answered: 2, left: 0 })
    expect(result.q1).toEqual(["--name, after the old tool"])
    expect(result.q2).toEqual(["blue"])
    expect(result.readyNow).toEqual(expect.arrayContaining(["tut-1", "tut-2"]))
    expect(result.printed).toContain("◆ Answered 2 questions")
    expect(result.printed.some((line) => line.includes("left open"))).toBe(false)
  })

  test("a maintainer_only question is put as any other", async () => {
    const seeds = [
      { id: "tut-1", title: "Waits", blockedBy: ["q-1"] },
      {
        id: "q-1",
        title: "Make a key",
        labels: ["human"],
        metadata: metadata(0, { maintainer_only: true }),
      },
    ]
    const result = await putAll(seeds, null, [{ _tag: "Answer", answer: "--flag" }])
    expect(result.putTo.map((question) => question.maintainerOnly)).toEqual([true])
    expect(result.q1).toEqual(["--flag"])
    expect(result.readyNow).toEqual(["tut-1"])
  })

  test("without a terminal, every one is listed, nothing asked or answered", async () => {
    const result = await putAll(backlog, null, undefined)
    expect(result.putting).toEqual({ _tag: "Done", answered: 0, left: 2 })
    expect(result.putTo).toEqual([])
    expect(result.printed).toContain("◆ Overnight pre-flight: 2 questions left open")
    expect(result.printed).toContain(
      '  ! q-1 (Which flag name?): tut-1 waits on it. Answer it with bd human respond q-1 "<answer>"',
    )
    expect(result.printed.some((line) => line.includes("Answered"))).toBe(false)
    expect(result.q1).toEqual([])
  })

  test("a cancel stops there, keeping the answers given", async () => {
    const result = await putAll(backlog, null, [{ _tag: "Answer", answer: "--flag" }, undefined])
    expect(result.putting).toEqual({ _tag: "Cancelled", answered: 1 })
    expect(result.q1).toEqual(["--flag"])
    expect(result.q2).toEqual([])
    expect(result.readyNow).toContain("tut-1")
    expect(result.printed).toContain("◆ Answered 1 question")
    expect(result.logged).toContain(
      "overnight pre-flight: the questions were cancelled, 1 question answered: the run doesn't start",
    )
    expect(questionsCancelledMessage(1)).toBe(
      "tutti: stopped before the run started; the answer given is kept.",
    )
    expect(questionsCancelledMessage(0)).toBe(
      "tutti: stopped before the run started; no question was answered.",
    )
  })

  test("an answer bd can't record leaves its question open, saying why", async () => {
    const printed: Array<string> = []
    const printer = makePrinter(
      { write: (text) => printed.push(text), columns: () => 400, tty: false },
      theme,
    )
    const { value } = await onBacklog(
      backlog,
      Effect.gen(function* () {
        const questions = yield* openQuestions(null)
        const backlogNow = yield* TestBeads.Backlog
        yield* backlogNow.fail("human respond", { stderr: "database locked" })
        return yield* putQuestions({
          questions: questions.slice(0, 1),
          put: Option.some(() => Effect.succeed({ _tag: "Answer", answer: "--flag" } as const)),
          say: { ...printer, theme },
        })
      }),
    )
    expect(value).toEqual({ _tag: "Done", answered: 0, left: 1 })
    const lines = printed.join("").split("\n")
    expect(lines).toContain(
      "◆ overnight pre-flight: couldn't record the answer to q-1 (Which flag name?): database locked",
    )
  })
})

/** An open question as it is put, its options `options` (the recommended one first). */
const shown = (
  options: OpenQuestion["options"],
  extra: Partial<OpenQuestion> = {},
): OpenQuestion => ({
  id: "q-1" as never,
  title: "Which flag name?",
  description: "The flag needs a name.",
  options,
  maintainerOnly: false,
  waiting: ["tut-1" as never],
  ...extra,
})

const twoOptions = [
  { label: "--long-flag", description: "says what it does" },
  { label: "--flag", description: "short to type" },
]

describe("the choices a question is put with", () => {
  test("its options, the recommended one first and marked, then Other and Leave open", () => {
    expect(choicesOf(shown(twoOptions))).toEqual([
      {
        _tag: "Option",
        label: "--long-flag (recommended)",
        description: "says what it does",
        answer: "--long-flag",
      },
      { _tag: "Option", label: "--flag", description: "short to type", answer: "--flag" },
      { _tag: "Other" },
      { _tag: "LeaveOpen" },
    ])
  })

  test("without options, Other and Leave open alone", () => {
    expect(choicesOf(shown(undefined))).toEqual([{ _tag: "Other" }, { _tag: "LeaveOpen" }])
  })

  test("whatever its options, each answer is one of their labels", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ label: fc.string({ minLength: 1 }), description: fc.string() }), {
          maxLength: 4,
        }),
        (options) => {
          const choices = choicesOf(shown(options))
          expect(choices.length).toBe(options.length + 2)
          expect(
            choices.flatMap((choice) => (choice._tag === "Option" ? [choice.answer] : [])),
          ).toEqual(options.map((option) => option.label))
        },
      ),
    )
  })
})

/** What a form said: its replies, and how often it was cancelled. */
const recorder = () => {
  const replies: Array<Reply> = []
  let cancelled = 0
  return {
    replies,
    cancelled: () => cancelled,
    props: {
      answer: (reply: Reply) => {
        replies.push(reply)
      },
      cancel: () => {
        cancelled++
      },
    },
  }
}

const size = { width: 100, height: 24 }
const at = { index: 0, of: 2 }

describe("an open question in the renderer", () => {
  test("shows it, the recommended option first and marked; Enter answers with it", async () => {
    const said = recorder()
    const node = (
      <OpenQuestionForm theme={theme} question={shown(twoOptions)} at={at} {...said.props} />
    )
    await withRender(node, size, async (rendered) => {
      const frame = await idleFrame(rendered.setup)
      expect(frame).toContain("Open question 1 of 2 · q-1")
      expect(frame).toContain("Which flag name?")
      expect(frame).toContain("The flag needs a name.")
      expect(frame).toContain("> --long-flag (recommended) — says what it does")
      expect(frame).toContain("  --flag — short to type")
      expect(frame).toContain("  Other:")
      expect(frame).toContain("  Leave open")
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(said.replies).toEqual([{ _tag: "Answer", answer: "--long-flag" }])
    })
  })

  test("Other sends the text typed; with nothing typed, it says so", async () => {
    const said = recorder()
    const node = (
      <OpenQuestionForm theme={theme} question={shown(twoOptions)} at={at} {...said.props} />
    )
    await withRender(node, size, async (rendered) => {
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(said.replies).toEqual([])
      expect(await idleFrame(rendered.setup)).toContain("type your answer first, or press Esc")
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("  --name  ")
      })
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(said.replies).toEqual([{ _tag: "Answer", answer: "--name" }])
    })
  })

  test("Leave open leaves it open", async () => {
    const said = recorder()
    const node = (
      <OpenQuestionForm theme={theme} question={shown(twoOptions)} at={at} {...said.props} />
    )
    await withRender(node, size, async (rendered) => {
      for (const _ of [1, 2, 3, 4]) {
        await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      }
      expect(await idleFrame(rendered.setup)).toContain("> Leave open")
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(said.replies).toEqual([{ _tag: "LeaveOpen" }])
    })
  })

  test("without options, Other and Leave open alone, under its description", async () => {
    const said = recorder()
    const node = (
      <OpenQuestionForm
        theme={theme}
        question={shown(undefined, { maintainerOnly: true })}
        at={at}
        {...said.props}
      />
    )
    await withRender(node, size, async (rendered) => {
      const frame = await idleFrame(rendered.setup)
      expect(frame).toContain("Open question 1 of 2 · q-1 · only you can answer it")
      expect(frame).toContain("> Other:")
      expect(frame).not.toContain("(recommended)")
      // Other's line is focused from the start: what is typed goes into it.
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("do it by hand")
      })
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(said.replies).toEqual([{ _tag: "Answer", answer: "do it by hand" }])
    })
  })

  test("Esc cancels", async () => {
    const said = recorder()
    const node = (
      <OpenQuestionForm theme={theme} question={shown(twoOptions)} at={at} {...said.props} />
    )
    await withRender(node, size, async (rendered) => {
      await rendered.input((setup) => pressEscape(setup))
      expect(said.cancelled()).toBe(1)
      expect(said.replies).toEqual([])
    })
  })
})

/** Runs the line form over `input`, a terminal's typing, the stream ending after it. */
const asLines = async (input: string, question: OpenQuestion) => {
  const stream = new PassThrough()
  stream.write(input)
  stream.end()
  let output = ""
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const io: LineIO = {
          input: yield* streamInput(stream),
          write: (text) => {
            output += text
          },
          theme,
        }
        return yield* openQuestion(io, question, at)
      }),
    ),
  )
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the output's escape sequences
  return { exit, output: output.replace(/\x1b\[[0-9;]*m/g, "") }
}

describe("an open question as lines", () => {
  test("lists its choices numbered; nothing typed takes the recommended one", async () => {
    const { exit, output } = await asLines("\n", shown(twoOptions))
    expect(output).toContain(
      "Open question 1 of 2 · q-1\nWhich flag name?\nThe flag needs a name.\n",
    )
    expect(output).toContain("1. --long-flag (recommended) — says what it does\n")
    expect(output).toContain("2. --flag — short to type\n")
    expect(output).toContain("3. Other: type your own\n")
    expect(output).toContain("4. Leave open\n")
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ _tag: "Answer", answer: "--long-flag" })
  })

  test("Other reads your own answer on the next line, asking again for an empty one", async () => {
    const { exit, output } = await asLines("3\n\nblue\n", shown(twoOptions))
    expect(output).toContain("Your answer to q-1")
    expect(output).toContain("type your answer first, or press Ctrl+D")
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ _tag: "Answer", answer: "blue" })
  })

  test("Leave open, and the end of input cancelling", async () => {
    const left = await asLines("2\n", shown(undefined))
    expect(Exit.isSuccess(left.exit) && left.exit.value).toEqual({ _tag: "LeaveOpen" })
    const ended = await asLines("", shown(twoOptions))
    expect(Exit.isFailure(ended.exit) && String(ended.exit.cause)).toContain("FormCancelled")
  })
})
