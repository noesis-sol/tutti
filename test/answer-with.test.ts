// How to answer a request (§ 7.6): the log's PERMISSION and QUESTION lines and tutti answer's
// listing say it with one builder, and following what they say gets the answer taken, not refused.
import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { type AttentionRequest, answersOf } from "../src/agent/Attention.ts"
import {
  type AnswerFile,
  type AnswerWord,
  fit,
  type RequestFile,
  toRequestFile,
} from "../src/agent/attentionFiles.ts"
import { howToAnswer } from "../src/answer/answer.ts"
import { answerWith } from "../src/answer/answerWith.ts"
import * as log from "../src/run/log.ts"

const base = {
  ticket: "tut-1",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: Date.UTC(2026, 9, 22, 10),
}

const permission = (
  id: string,
  { rules = true, ...over }: Partial<AttentionRequest> & { readonly rules?: boolean } = {},
): AttentionRequest => ({
  ...base,
  id,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "make" },
    suggestions: !rules
      ? []
      : [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "make:*" }],
            behavior: "allow",
            destination: "session",
          },
        ],
    summary: "make",
  },
  ...over,
})

const twoQuestions = (id: string, over: Partial<AttentionRequest> = {}): AttentionRequest => ({
  ...base,
  id,
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "Which store?",
        options: [{ label: "SQLite" }, { label: "Dolt" }],
        multiSelect: false,
      },
      {
        question: "Which extras?",
        options: [{ label: "Cache" }, { label: "Search index" }],
        multiSelect: true,
      },
    ],
    input: {},
  },
  ...over,
})

const elicitation = (id: string, mode: "form" | "url"): AttentionRequest => ({
  ...base,
  id,
  kind: {
    _tag: "Elicitation",
    server: "linear",
    message: "Log in to Linear",
    mode,
    ...(mode === "url" ? { url: "https://linear.app/login" } : {}),
  },
})

/** The log line the run writes for the request, as Attention's `asked` builds it. */
const logLine = (request: AttentionRequest): string => {
  const answering = {
    id: request.ticket,
    requestId: request.id,
    answers: answersOf(request),
    defaultToNo: request.defaultToNo,
  }
  const kind = request.kind
  switch (kind._tag) {
    case "Permission":
      return log.permission({ ...answering, what: `${kind.tool}(${kind.summary})` }).line
    case "Question":
      return log.question({
        ...answering,
        questions: kind.questions.map((q) => ({
          question: q.question,
          options: q.options.map((o) => o.label),
        })),
      }).line
    case "Elicitation":
      return log.elicitation({
        ...answering,
        server: kind.server,
        message: kind.message,
        ...(kind.url === undefined ? {} : { url: kind.url }),
      }).line
  }
}

/** The command the line names after `answer with: `. */
const commandOf = (line: string): string => {
  const at = line.indexOf("answer with: ")
  expect(at).toBeGreaterThan(-1)
  return line.slice(at + "answer with: ".length)
}

/**
 * Each answer the command offers, as the answer file `tutti answer` writes for it: each
 * `"<option>"` filled in with its question's first option, in order.
 */
const following = (command: string, file: RequestFile): ReadonlyArray<AnswerFile> => {
  const prefix = `tutti answer ${file.id} `
  expect(command.startsWith(prefix)).toBe(true)
  return command
    .slice(prefix.length)
    .split(" | ")
    .map((alternative) => {
      const [word, ...flags] = alternative.split(" ")
      const choices: Array<string> = []
      let confirm = false
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === "--confirm") confirm = true
        else if (flags[i] === "--choice") {
          expect(flags[++i]).toBe('"<option>"')
          const question = file.questions?.[choices.length]
          choices.push(question?.options[0]?.label ?? "")
        } else throw new Error(`an unknown flag in ${alternative}`)
      }
      return {
        v: 1,
        request: file.id,
        answer: word as AnswerWord,
        ...(choices.length === 0 ? {} : { choices }),
        ...(confirm ? { confirm } : {}),
      }
    })
}

const kinds: ReadonlyArray<readonly [string, AttentionRequest]> = [
  ["a permission with a rule to keep", permission("p1")],
  ["a permission with none", permission("p2", { rules: false })],
  ["a safety-check hold", permission("p3", { defaultToNo: true, suppressAlwaysAllowRule: true })],
  ["a two-question AskUserQuestion", twoQuestions("q1")],
  ["a question that defaults to no", twoQuestions("q2", { defaultToNo: true })],
  ["a URL login", elicitation("e1", "url")],
  ["a form", elicitation("e2", "form")],
]

describe("how to answer a request", () => {
  for (const [name, request] of kinds) {
    test(`${name}: the log line and tutti answer say the same, and each answer it offers fits`, () => {
      const file = toRequestFile(request)
      const command = commandOf(logLine(request))
      expect(command).toBe(howToAnswer(file))
      const offered = following(command, file)
      expect(offered.map((answer) => answer.answer)).toEqual([...file.answers])
      for (const answer of offered) {
        const fitted = fit(file, answer)
        expect({ answer, fits: Result.isSuccess(fitted) }).toEqual({ answer, fits: true })
      }
    })
  }

  test("a two-question AskUserQuestion gives one --choice per question, and deny", () => {
    expect<unknown>(logLine(twoQuestions("5be01c7a"))).toBe(
      `  QUESTION: tut-1's worker asks: Which store? (SQLite | Dolt); Which extras? (Cache | Search index); answer with: tutti answer 5be01c7a allow --choice "<option>" --choice "<option>" | deny`,
    )
  })

  test("a permission offers allow-run where it takes it, and --confirm where allowing needs it", () => {
    expect(commandOf(logLine(permission("a3f9")))).toBe(
      "tutti answer a3f9 allow | allow-run | deny",
    )
    expect(
      commandOf(logLine(permission("a3f9", { defaultToNo: true, suppressAlwaysAllowRule: true }))),
    ).toBe("tutti answer a3f9 allow --confirm | deny")
  })

  test("a URL login is answered allow or deny, a form only declined", () => {
    expect<unknown>(logLine(elicitation("r1", "url"))).toBe(
      "  QUESTION: tut-1's worker asks: MCP server linear: Log in to Linear (open https://linear.app/login); answer with: tutti answer r1 allow | deny",
    )
    expect<unknown>(logLine(elicitation("r2", "form"))).toBe(
      "  QUESTION: tut-1's worker asks: MCP server linear: Log in to Linear (a form, which only the dashboard fills in); answer with: tutti answer r2 deny",
    )
  })

  test("the builder puts --confirm after a question's choices", () => {
    expect(
      answerWith({ requestId: "q", answers: ["allow", "deny"], defaultToNo: true, questions: 1 }),
    ).toBe('tutti answer q allow --choice "<option>" --confirm | deny')
  })
})
