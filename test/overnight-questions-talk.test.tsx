// Talk it through in the overnight pre-flight's answer form (tutti-i0sz, § 4.11): the choice offered
// only where a talk can be shown, Enter on it replying Talk; putQuestions talking the question
// through, recording the talk's answer as the form's, and putting the question again when the talk
// ends without one (warning, unless it was left).
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { TalkEnd, talkLeftWhy } from "../src/agent/answerTalk.ts"
import { makePrinter } from "../src/print/organLine.ts"
import {
  openQuestions,
  type Put,
  putQuestions,
  talkEndedText,
} from "../src/run/overnightQuestions.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { OpenQuestionForm } from "../src/ui/OpenQuestion.tsx"
import { choicesOf, FormCancelled, type OpenQuestion, type Reply } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { idleFrame, withRender } from "./render.ts"

const theme = makeTheme(orchestra, {
  appearance: "dark",
  depth: "256",
  noColor: true,
  styled: false,
})

const backlog: ReadonlyArray<TestBeads.Seed> = [
  { id: "tut-1", title: "Waits", blockedBy: ["q-1"] },
  {
    id: "q-1",
    title: "Which flag name?",
    labels: ["human"],
    metadata: {
      options: [
        { label: "--flag", description: "short to type" },
        { label: "--long-flag", description: "says what it does" },
      ],
      recommended: 1,
    },
  },
]

/** Puts the questions with `replies`, talking with `talks` in turn (undefined: none offered). */
const putAll = (replies: ReadonlyArray<Reply>, talks: ReadonlyArray<TalkEnd> | undefined) => {
  const printed: Array<string> = []
  const putTo: Array<string> = []
  const talked: Array<string> = []
  const left = [...replies]
  const ends = [...(talks ?? [])]
  const put: Put = (question) =>
    Effect.suspend(() => {
      putTo.push(question.id)
      const reply = left.shift()
      return reply === undefined ? Effect.fail(new FormCancelled()) : Effect.succeed(reply)
    })
  const printer = makePrinter(
    { write: (text) => printed.push(text), columns: () => 400, tty: false },
    theme,
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const questions = yield* openQuestions(null)
      const putting = yield* putQuestions({
        questions,
        put: Option.some(put),
        ...(talks === undefined
          ? {}
          : {
              talk: (question: OpenQuestion) =>
                Effect.sync(() => {
                  talked.push(question.id)
                  return ends.shift() ?? TalkEnd.Ended({ why: "no more talks" })
                }),
            }),
        say: { ...printer, theme },
      })
      const backlogNow = yield* TestBeads.Backlog
      return {
        putting,
        q1: yield* backlogNow.comments("q-1"),
        design: (yield* backlogNow.issues).find((issue) => issue.id === "tut-1")?.design,
        logged: yield* texts,
      }
    }).pipe(Effect.provide(Layer.mergeAll(TestBeads.layer(backlog), logLayer()))),
  ).then((value) => ({ ...value, putTo, talked, printed: printed.join("") }))
}

describe("Talk it through, in putQuestions", () => {
  test("the talk's answer is recorded as the form's, the decision in the blocked ticket's design", async () => {
    const result = await putAll(
      [{ _tag: "Talk" }],
      [TalkEnd.Answered({ answer: "--long-flag, aliased -l" })],
    )
    expect(result.talked).toEqual(["q-1"])
    expect(result.putTo).toEqual(["q-1"])
    expect(result.putting).toEqual({ _tag: "Done", answered: 1, left: 0 })
    expect(result.q1).toEqual(["--long-flag, aliased -l"])
    expect(result.design).toContain("Decided (q-1): Which flag name?\n--long-flag, aliased -l")
    expect(result.logged).toContain(
      "overnight pre-flight: answered q-1 (Which flag name?) after talking it through: --long-flag, aliased -l",
    )
  })

  test("a talk that ends without an answer puts the question again, warning why", async () => {
    const why = "its session ended: Claude Code exited"
    const result = await putAll(
      [{ _tag: "Talk" }, { _tag: "Answer", answer: "--flag" }],
      [TalkEnd.Ended({ why })],
    )
    expect(result.putTo).toEqual(["q-1", "q-1"])
    expect(result.putting).toEqual({ _tag: "Done", answered: 1, left: 0 })
    expect(result.q1).toEqual(["--flag"])
    const text =
      "overnight pre-flight: the talk about q-1 (Which flag name?) ended without an answer: its session ended: Claude Code exited"
    expect(talkEndedText({ id: "q-1", title: "Which flag name?" } as OpenQuestion, why)).toBe(text)
    expect(result.printed).toContain(text)
    expect(result.logged).toContain(text)
  })

  test("a talk left puts the question again without a warning; it may then be left open", async () => {
    const result = await putAll(
      [{ _tag: "Talk" }, { _tag: "LeaveOpen" }],
      [TalkEnd.Ended({ why: talkLeftWhy })],
    )
    expect(result.putTo).toEqual(["q-1", "q-1"])
    expect(result.putting).toEqual({ _tag: "Done", answered: 0, left: 1 })
    expect(result.printed).not.toContain("ended without an answer")
    expect(result.logged.some((line) => line.includes("ended without an answer"))).toBe(true)
  })

  test("a cancel after a talk stops there", async () => {
    const result = await putAll([{ _tag: "Talk" }], [TalkEnd.Ended({ why: talkLeftWhy })])
    expect(result.putting).toEqual({ _tag: "Cancelled", answered: 0 })
  })
})

/** The question as the form puts it. */
const question: OpenQuestion = {
  id: "q-1" as OpenQuestion["id"],
  title: "Which flag name?",
  description: "",
  options: [
    { label: "--long-flag", description: "says what it does" },
    { label: "--flag", description: "short to type" },
  ],
  maintainerOnly: false,
  waiting: [],
}

describe("Talk it through, in the answer form", () => {
  test("offered only where a talk can be shown, before Leave open", () => {
    expect(choicesOf(question).map((choice) => choice._tag)).toEqual([
      "Option",
      "Option",
      "Other",
      "LeaveOpen",
    ])
    expect(choicesOf(question, true).map((choice) => choice._tag)).toEqual([
      "Option",
      "Option",
      "Other",
      "Talk",
      "LeaveOpen",
    ])
  })

  const render = (talk: boolean) => {
    const replies: Array<Reply> = []
    const node = (
      <OpenQuestionForm
        theme={theme}
        question={question}
        at={{ index: 0, of: 1 }}
        talk={talk}
        answer={(reply) => {
          replies.push(reply)
        }}
        cancel={() => {}}
      />
    )
    return { replies, node }
  }

  test("Enter on it replies Talk; Leave open stays below it", async () => {
    const { replies, node } = render(true)
    await withRender(node, { width: 100, height: 24 }, async (rendered) => {
      const frame = await idleFrame(rendered.setup)
      expect(frame).toContain(
        "  Talk it through — in a session that reads the code, before answering",
      )
      expect(frame.indexOf("Talk it through")).toBeLessThan(frame.indexOf("Leave open"))
      for (const _ of [1, 2, 3]) {
        await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      }
      expect(await idleFrame(rendered.setup)).toContain("> Talk it through")
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(replies).toEqual([{ _tag: "Talk" }])
    })
  })

  test("without a talk to show, the form has no such choice, and Leave open follows Other", async () => {
    const { replies, node } = render(false)
    await withRender(node, { width: 100, height: 24 }, async (rendered) => {
      expect(await idleFrame(rendered.setup)).not.toContain("Talk it through")
      for (const _ of [1, 2, 3]) {
        await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      }
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(replies).toEqual([{ _tag: "LeaveOpen" }])
    })
  })
})
