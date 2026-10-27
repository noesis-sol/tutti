// Answering questions inside tutti (tutti-kkb.35): the worker prompt's rule that a decision about
// another ticket is a question blocking it; recording an answer (src/run/answerQuestion.ts), the
// decision in each blocked ticket's design and then bd human respond, from the overnight
// pre-flight too; `tutti answer`'s questions (src/answer/questions.ts): the listing, an answer by
// an option's number or label or in your own words; and the dashboard's commands for them
// (src/run/questionNews.ts).
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Result, SubscriptionRef } from "effect"
import fc from "fast-check"
import {
  answeredLine,
  answerQuestion as answerOnCommandLine,
  chosenAnswer,
  listQuestions,
  questionsSection,
  showQuestions,
} from "../src/answer/questions.ts"
import { latestVersion, promptChanges } from "../src/init/templates.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { decisionSection, recordAnswer, withDecision } from "../src/run/answerQuestion.ts"
import { resolve, UiCommand } from "../src/run/commands.ts"
import { emptyState } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { putQuestions } from "../src/run/overnightQuestions.ts"
import { answerQuestion, type QuestionNews, readQuestions } from "../src/run/questionNews.ts"
import type { Beads, TicketId } from "../src/services/Beads.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, {
  appearance: "dark",
  depth: "256",
  noColor: true,
  styled: false,
})

/** q-1 blocks tut-1, which has a design, and tut-2, closed; q-2 has no options and blocks nothing. */
const backlog: ReadonlyArray<TestBeads.Seed> = [
  { id: "tut-1", title: "Add the flag", design: "Parse it in flags.ts.\n", blockedBy: ["q-1"] },
  { id: "tut-2", title: "Done already", status: "closed", blockedBy: ["q-1"] },
  {
    id: "q-1",
    title: "Which flag name?",
    labels: ["human"],
    priority: 1,
    metadata: {
      options: [
        { label: "--flag", description: "short to type" },
        { label: "--long-flag", description: "says what it does" },
      ],
      recommended: 1,
    },
  },
  { id: "q-2", title: "Which colour?", labels: ["human"], priority: 2 },
  { id: "q-3", title: "Answered", labels: ["human"], status: "closed" },
  { id: "tut-3", title: "Not a question" },
]

/** `effect` on the test layers over `seeds`: its exit, the backlog after it, and the log's lines. */
const onBacklog = <A, E>(
  effect: Effect.Effect<A, E, Beads | TestBeads.Backlog | Log>,
  seeds: ReadonlyArray<TestBeads.Seed> = backlog,
  before: Effect.Effect<void, never, TestBeads.Backlog> = Effect.void,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* before
      const result = yield* Effect.result(effect)
      const store = yield* TestBeads.Backlog
      return {
        result,
        issue: (id: string) => Effect.runSync(store.get(id)),
        comments: (id: string) => Effect.runSync(store.comments(id)),
        logged: yield* texts,
      }
    }).pipe(Effect.provide(Layer.mergeAll(TestBeads.layer(seeds), logLayer()))),
  )

/** An open question as it is put, with `labels` as its options. */
const questionWith = (labels: ReadonlyArray<string>): OpenQuestion => ({
  id: "q-9" as TicketId,
  title: "Which?",
  description: "",
  options: labels.length === 0 ? undefined : labels.map((label) => ({ label, description: "" })),
  maintainerOnly: false,
  waiting: [],
})

describe("the worker prompt's rule", () => {
  test("a decision about another ticket is a question blocking it, asked from yours", () => {
    expect(builtInWorkerPrompt).toContain(
      "- A decision only the maintainer can make about another ticket, a follow-up you file or one you\n  name, is a question too: file it the same way, blocking that ticket and asked from yours\n  (`--deps 'blocks:<that ticket>,discovered-from:TICKET_ID'`), and go on with yours.",
    )
    expect(builtInWorkerPrompt).toContain(
      "Never leave it only in your final message: nobody reads that, and that ticket's worker would\n  decide it instead. Your final message carries nothing for the maintainer.",
    )
  })

  test("is the template's version 9, in its Close section", () => {
    const change = promptChanges.find((each) => each.version === 9)
    expect(change?.section).toBe("Close")
    expect(builtInWorkerPrompt).toContain(change?.marker ?? "no marker")
    expect(latestVersion(promptChanges)).toBeGreaterThanOrEqual(9)
    const close = builtInWorkerPrompt.slice(builtInWorkerPrompt.indexOf("## Close"))
    expect(close).toContain(change?.marker ?? "no marker")
  })
})

describe("recording an answer", () => {
  test("the decision goes below each open blocked ticket's design, then the question closes", async () => {
    const { result, issue, comments } = await onBacklog(recordAnswer("q-1" as TicketId, "--flag"))
    expect((Result.isSuccess(result) && result.success) as unknown).toEqual({
      title: "Which flag name?",
      decided: ["tut-1"],
    })
    expect(issue("tut-1")?.design).toBe(
      "Parse it in flags.ts.\n\nDecided (q-1): Which flag name?\n--flag",
    )
    expect(issue("tut-2")?.design).toBe("")
    expect(issue("q-1")?.status).toBe("closed")
    expect(comments("q-1")).toEqual(["--flag"])
  })

  test("an empty design takes the decision alone", () => {
    const q1 = "q-1" as TicketId
    expect(withDecision("", "Decided (q-1): Which?\nyes", q1)).toBe("Decided (q-1): Which?\nyes")
    expect(withDecision("  \n", "x", q1)).toBe("x")
    expect(decisionSection("q-1" as TicketId, " Which? ", " yes \n")).toBe(
      "Decided (q-1): Which?\nyes",
    )
  })

  test("a closed question, or an issue not labelled human, isn't answered", async () => {
    for (const [id, why] of [
      ["q-3", "closed"],
      ["tut-3", "not labelled human"],
    ] as const) {
      const { result, issue } = await onBacklog(recordAnswer(id as TicketId, "yes"))
      expect(Result.isFailure(result) && result.failure._tag === "QuestionNotOpen").toBe(true)
      expect(Result.isFailure(result) ? result.failure.message : "").toBe(
        `${id} is ${why}: it isn't an open question`,
      )
      expect(issue(id)?.status).toBe(id === "q-3" ? "closed" : "open")
    }
  })

  test("answering again after a partial failure replaces the earlier decision", () => {
    const q1 = "q-1" as TicketId
    const once = withDecision("Plan.", decisionSection(q1, "Which?", "--flag"), q1)
    const twice = withDecision(once, decisionSection(q1, "Which?", "--long-flag"), q1)
    expect(twice).toBe("Plan.\n\nDecided (q-1): Which?\n--long-flag")
    const paragraphs = withDecision(
      withDecision("Plan.", decisionSection(q1, "Which?", "first\n\n  \nsecond"), q1),
      decisionSection(q1, "Which?", "--flag"),
      q1,
    )
    expect(paragraphs).toBe("Plan.\n\nDecided (q-1): Which?\n--flag")
    const other = withDecision(
      twice,
      decisionSection("q-2" as TicketId, "Colour?", "teal"),
      "q-2" as TicketId,
    )
    expect(other).toBe(
      "Plan.\n\nDecided (q-1): Which?\n--long-flag\n\nDecided (q-2): Colour?\nteal",
    )
  })

  test("a design bd can't write leaves the question open, to answer again", async () => {
    const { result, issue } = await onBacklog(
      recordAnswer("q-1" as TicketId, "--flag"),
      backlog,
      Effect.flatMap(TestBeads.Backlog, (store) =>
        store.fail("update", { id: "tut-1", stderr: "Error: database is locked\n" }),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(issue("q-1")?.status).toBe("open")
  })

  test("the overnight pre-flight records its answers the same way", async () => {
    const printer = { print: () => Effect.void, say: () => Effect.void, warn: () => Effect.void }
    const { result, issue } = await onBacklog(
      putQuestions({
        questions: [
          {
            id: "q-1" as TicketId,
            title: "Which flag name?",
            description: "",
            options: undefined,
            maintainerOnly: false,
            waiting: ["tut-1" as TicketId],
          },
        ],
        put: Option.some(() => Effect.succeed({ _tag: "Answer", answer: "--long-flag" } as const)),
        say: { ...printer, theme },
      }),
    )
    expect((Result.isSuccess(result) && result.success) as unknown).toEqual({
      _tag: "Done",
      answered: 1,
      left: 0,
    })
    expect(issue("tut-1")?.design).toContain("Decided (q-1): Which flag name?\n--long-flag")
    expect(issue("q-1")?.status).toBe("closed")
  })
})

describe("tutti answer's questions", () => {
  test("lists the open questions: what waits on each, its options numbered, the recommended first", async () => {
    const { result } = await onBacklog(listQuestions)
    const questions = Result.isSuccess(result) ? result.success : []
    expect(showQuestions(questions)).toBe(
      [
        "q-1  Which flag name?  (tut-1 waits on it)",
        "    1. --long-flag (recommended) - says what it does",
        "    2. --flag - short to type",
        "    answer with: tutti answer q-1 -- <an option's number or label, or your own answer in quotes>",
        "",
        "q-2  Which colour?  (no ticket waits on it)",
        "    answer with: tutti answer q-2 -- <an option's number or label, or your own answer in quotes>",
      ].join("\n"),
    )
    expect(questionsSection(questions).startsWith("\n\nOpen questions:\nq-1  ")).toBe(true)
    expect(questionsSection([])).toBe("")
  })

  test("says a question only the maintainer answers", () => {
    expect(showQuestions([{ ...questionWith([]), maintainerOnly: true }])).toContain(
      "\n    only the maintainer answers it\n",
    )
  })

  test("answers by an option's number, its label in any case, or your own words", () => {
    const question = questionWith(["--long-flag", "--flag"])
    expect(chosenAnswer(question, "1")).toBe("--long-flag")
    expect(chosenAnswer(question, " 2 ")).toBe("--flag")
    expect(chosenAnswer(question, "3")).toBe("3")
    expect(chosenAnswer(question, "--FLAG")).toBe("--flag")
    expect(chosenAnswer(question, "  neither: use -f  ")).toBe("neither: use -f")
    expect(chosenAnswer(questionWith([]), "1")).toBe("1")
  })

  test("any answer to any options: an option's label, or the text trimmed", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 4 }),
        fc.string(),
        (labels, given) => {
          const question = questionWith(labels)
          const chosen = chosenAnswer(question, given)
          expect(labels.includes(chosen) || chosen === given.trim()).toBe(true)
          const n = Number(given.trim())
          if (/^[1-9]$/.test(given.trim()) && n <= labels.length) {
            expect(chosen).toBe(labels[n - 1] ?? "")
          }
        },
      ),
    )
  })

  test("records the answer, and says where the decision went", async () => {
    const { result, issue } = await onBacklog(answerOnCommandLine("q-1", "1"))
    expect(result).toEqual(
      Result.succeed(
        "Answered q-1 (Which flag name?): --long-flag. The decision is in the design of tut-1.",
      ),
    )
    expect(issue("q-1")?.status).toBe("closed")
    expect(issue("tut-1")?.design).toContain("Decided (q-1): Which flag name?\n--long-flag")
    expect(answeredLine("q-2" as TicketId, "Which colour?", "blue", [])).toBe(
      "Answered q-2 (Which colour?): blue.",
    )
  })

  test("an ID bd has no issue for, a closed question and an empty answer: not answered", async () => {
    const missing = await onBacklog(
      answerOnCommandLine("q-404", "yes"),
      backlog,
      Effect.flatMap(TestBeads.Backlog, (store) =>
        store.fail("show", { stdout: TestBeads.noSuchIssueStdout }),
      ),
    )
    expect(Result.isFailure(missing.result) ? missing.result.failure.message : "").toBe(
      "there is no open request or question q-404; tutti answer lists them",
    )
    const closed = await onBacklog(answerOnCommandLine("q-3", "yes"))
    expect(Result.isFailure(closed.result) ? closed.result.failure.message : "").toBe(
      "the answer to q-3 wasn't recorded: q-3 is closed: it isn't an open question",
    )
    const empty = await onBacklog(answerOnCommandLine("q-2", "   "))
    expect(Result.isFailure(empty.result) ? empty.result.failure.message : "").toContain(
      "the answer is empty",
    )
    expect(empty.issue("q-2")?.status).toBe("open")
  })
})

describe("the dashboard's questions", () => {
  /** `effect` given a fresh news ref, and the news it left. */
  const withNews = (
    effect: (
      news: SubscriptionRef.SubscriptionRef<ReadonlyArray<QuestionNews>>,
    ) => Effect.Effect<void, never, Beads | Log>,
    before?: Effect.Effect<void, never, TestBeads.Backlog>,
  ) =>
    onBacklog(
      Effect.gen(function* () {
        const news = yield* SubscriptionRef.make<ReadonlyArray<QuestionNews>>([])
        yield* effect(news)
        return yield* SubscriptionRef.get(news)
      }),
      backlog,
      before,
    )

  test("ReadQuestions reads those in the run's scope under the box's uuid", async () => {
    const all = await withNews((news) => readQuestions("u-1", null, news))
    const read = Result.isSuccess(all.result) ? all.result.success : []
    expect(read.map((each) => each._tag)).toEqual(["Read"])
    const first = read[0]
    expect(
      first?._tag === "Read" ? first.questions.map((question) => question.id as string) : [],
    ).toEqual(["q-1", "q-2"])
    expect(first?.uuid).toBe("u-1")

    const scoped = await withNews((news) => readQuestions("u-2", "tut-1" as TicketId, news))
    const inScope = Result.isSuccess(scoped.result) ? scoped.result.success[0] : undefined
    expect(
      inScope?._tag === "Read" ? inScope.questions.map((question) => question.id as string) : [],
    ).toEqual(["q-1"])
  })

  test("a read bd fails says why", async () => {
    const failed = await withNews(
      (news) => readQuestions("u-1", null, news),
      Effect.flatMap(TestBeads.Backlog, (store) =>
        store.fail("human list", { stderr: "Error: database is locked\n" }),
      ),
    )
    const news = Result.isSuccess(failed.result) ? failed.result.success : []
    expect(news.map((each) => each._tag)).toEqual(["NotRead"])
  })

  test("AnswerQuestion records the answer, says so, and logs it", async () => {
    const answered = await withNews((news) =>
      answerQuestion({ question: "q-1" as TicketId, answer: "--flag", uuid: "u-3" }, news),
    )
    expect((Result.isSuccess(answered.result) && answered.result.success) as unknown).toEqual([
      {
        _tag: "Answered",
        uuid: "u-3",
        question: "q-1",
        title: "Which flag name?",
        decided: ["tut-1"],
      },
    ])
    expect(answered.issue("tut-1")?.design).toContain("Decided (q-1)")
    expect(answered.logged).toContain("answered q-1 (Which flag name?) on the dashboard: --flag")

    const late = await withNews((news) =>
      answerQuestion({ question: "q-3" as TicketId, answer: "yes", uuid: "u-4" }, news),
    )
    const said = Result.isSuccess(late.result) ? late.result.success[0] : undefined
    expect(said?._tag).toBe("NotAnswered")
    expect(
      late.logged.some((line) => line.startsWith("couldn't record the dashboard's answer to q-3")),
    ).toBe(true)
  })

  test("its commands resolve, after the run's end too", () => {
    const current = { ledger: emptyState, requests: [] }
    expect(resolve(UiCommand.ReadQuestions({ uuid: "u" }), current)).toEqual(
      Result.succeed({ command: UiCommand.ReadQuestions({ uuid: "u" }), ticket: null }),
    )
    const answer = UiCommand.AnswerQuestion({ question: "q-1" as TicketId, answer: "a", uuid: "u" })
    expect(resolve(answer, current) as unknown).toEqual(
      Result.succeed({ command: answer, ticket: "q-1" }),
    )
  })
})
