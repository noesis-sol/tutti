// A question's talk, the session side (§ 4.11, tutti-i0sz): Talk it through, in the answer form,
// talks one question ticket through with Claude in an SDK session in the main checkout before it is
// answered, as orchestra's answer talk does when the maintainer asks. AgentHost knows the session as
// interviewWorker, as it knows a spec's refinement, for the Interview view shows it. Its
// instructions are templates/answer-talk-prompt.md (orchestra's answer-prompt.md, adapted to one
// question), appended to the claude_code preset; its built-in tools are the interview's, read-only,
// and its one MCP server is tutti's own, with tickets_list and ticket_show (interviewTools.ts) and
// give_answer, which hands tutti the answer the maintainer settled on.
//
// The first message brings the question in, between pasted_content tags carrying a fresh ID, as the
// interview's description is (a worker wrote it): its ID, title and description, its options from
// the metadata, the recommended one first, or a note that the session drafts them, the open tickets
// it blocks with their description, design and notes, and the tickets it was asked from.
//
// The session records nothing: once give_answer has taken the answer and the turn is over, tutti
// closes the session and gives the answer back to the form, which records it as every other
// (src/run/answerQuestion.ts). A talk left, or whose session ends, before an answer gives none, and
// the question is put again.
import { randomUUID } from "node:crypto"
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk"
import { Data, Effect, Option, Ref, type Scope, Stream, SubscriptionRef } from "effect"
import { z } from "zod"
import { AppConfig } from "../cli/AppConfig.ts"
import template from "../project/templates/answer-talk-prompt.md" with { type: "text" }
import {
  Beads,
  beadsWhy,
  HumanLabel,
  type Issue,
  questionOptions,
  type TicketId,
} from "../services/Beads.ts"
import { type AgentGone, AgentHost, AgentStartFailed, type MessageUuid } from "./AgentHost.ts"
import {
  type SessionFibers,
  sessionFibers,
  toolAnswer,
  toolHandler,
  toolRefusal,
} from "./callbacks.ts"
import { interviewWorker, leadAndPasted } from "./interview.ts"
import { readTools, serverName } from "./interviewTools.ts"
import { interviewBuiltins } from "./options.ts"
import { SessionKind } from "./sessionKind.ts"

/** The talk's instructions, appended to the claude_code preset; its leading comment left out. */
export const answerTalkPrompt: string = template.replace(/^<!--[\s\S]*?-->\n/, "")

/** The names of the talk's own tools. */
export const talkToolNames = ["tickets_list", "ticket_show", "give_answer"] as const

/** The talk's own tools as Claude Code names them, allowed without asking. */
export const qualifiedTalkTools: ReadonlyArray<string> = talkToolNames.map(
  (name) => `mcp__${serverName}__${name}`,
)

/** What opens the first message, before the question. */
export const talkLead = "Here is the question I'd like to talk through before I answer it:"

/** The talk's tools, its server over them, and the answer give_answer took. */
export interface TalkTools {
  // biome-ignore lint/suspicious/noExplicitAny: createSdkMcpServer's own type, for tools of any shape
  readonly tools: ReadonlyArray<SdkMcpToolDefinition<any>>
  /** The in-process MCP server the talk's session is given, named serverName. */
  readonly server: McpSdkServerConfigWithInstance
  /** The answer give_answer took, once it has. */
  readonly answer: SubscriptionRef.SubscriptionRef<string | null>
  /** Whether give_answer has taken it: leaving the talk then asks nothing. */
  readonly given: SubscriptionRef.SubscriptionRef<boolean>
}

/** What give_answer says once it has taken the answer. */
export const takenText =
  "tutti records this answer once your turn is over. Say in one line what was decided, and end your turn."

/**
 * The talk's tools, their handlers run in the talk's `fibers` (toolHandler) with the Beads they
 * were made with. give_answer takes one answer: an empty one, or a second, is refused.
 */
export const makeTalkTools = (fibers: SessionFibers): Effect.Effect<TalkTools, never, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const answer = yield* SubscriptionRef.make<string | null>(null)
    const given = yield* SubscriptionRef.make(false)
    const run = yield* toolHandler<Beads>(fibers)
    const [ticketsList, ticketShow] = readTools(beads, run)

    const take = (text: string) =>
      Effect.gen(function* () {
        const trimmed = text.trim()
        if (trimmed === "") {
          return toolRefusal(
            "The answer is empty: give the option's label, or the user's own words.",
          )
        }
        const before = yield* SubscriptionRef.modify(
          answer,
          (now): readonly [string | null, string | null] => [now, now ?? trimmed],
        )
        if (before !== null) {
          return toolRefusal(
            `The answer is already given: ${before}. tutti records it once your turn is over.`,
          )
        }
        yield* SubscriptionRef.set(given, true)
        return toolAnswer(takenText)
      })

    const giveAnswer = tool(
      "give_answer",
      "Hands tutti the answer the user settled on and agreed to: the option's label, or the user's own words. tutti records it once your turn is over. Call it once.",
      {
        answer: z
          .string()
          .describe("The option's label, or the user's own words, with what they added to it"),
      },
      (args, extra) => run(take(args.answer), extra),
    )

    const tools = [ticketsList, ticketShow, giveAnswer]
    return {
      tools,
      server: createSdkMcpServer({ name: serverName, version: "1.0.0", tools, alwaysLoad: true }),
      answer,
      given,
    }
  })

/** A ticket's texts that aren't empty, each under its name. */
const texts = (issue: Issue): ReadonlyArray<string> =>
  (
    [
      ["Description", issue.description],
      ["Design", issue.design],
      ["Notes", issue.notes],
    ] as const
  ).flatMap(([name, value]) => (value.trim() === "" ? [] : [`${name}:\n${value.trim()}`]))

/**
 * The question as the first message brings it in: its ID, title and description; its options, the
 * recommended one first and marked, or that the session drafts them; the tickets it blocks, with
 * their texts; and the tickets it was asked from.
 */
export const questionText = (
  question: Issue,
  blocked: ReadonlyArray<Issue>,
  askedFrom: ReadonlyArray<TicketId>,
): string => {
  const options = questionOptions(question.metadata)
  return [
    `# ${question.id}: ${question.title.trim()}`,
    ...(question.description.trim() === "" ? [] : ["", question.description.trim()]),
    "",
    "## Options",
    "",
    ...(options === undefined
      ? ["The question carries no options: draft 2 to 4."]
      : options.map(
          (option, at) =>
            `${at + 1}. ${option.label}${at === 0 ? " (recommended)" : ""}${option.description === "" ? "" : ` - ${option.description}`}`,
        )),
    "",
    "## The tickets it blocks",
    ...(blocked.length === 0
      ? ["", "None is open."]
      : blocked.flatMap((issue) => [
          "",
          `### ${issue.id}: ${issue.title.trim()}`,
          ...texts(issue),
        ])),
    ...(askedFrom.length === 0 ? [] : ["", "## Asked from", "", askedFrom.join(", ")]),
  ].join("\n")
}

/** The links a question was asked from: discovered-from and related, either way. */
const askedFromTypes: ReadonlyArray<string> = ["discovered-from", "related"]

/**
 * The open question `id`, as the first message brings it in: fails, saying why, where bd can't
 * show it or one of the tickets it blocks, or it isn't an open question.
 */
export const readQuestion = (id: TicketId): Effect.Effect<string, string, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const why = (error: Parameters<typeof beadsWhy>[0]) => beadsWhy(error)
    const question = yield* beads.show(id, { dependents: true }).pipe(Effect.mapError(why))
    if (!question.labels.includes(HumanLabel) || question.status === "closed") {
      return yield* Effect.fail(`${id} isn't an open question`)
    }
    const dependents = question.dependents ?? []
    const blockedIds = [
      ...new Set(
        dependents
          .filter((each) => each.type === "blocks" && each.issue?.status !== "closed")
          .map((each) => each.id),
      ),
    ]
    const blocked: Array<Issue> = []
    for (const each of blockedIds) {
      blocked.push(yield* beads.show(each).pipe(Effect.mapError(why)))
    }
    const askedFrom = [
      ...new Set(
        [...question.dependencies, ...dependents]
          .filter((each) => askedFromTypes.includes(each.type))
          .map((each) => each.id),
      ),
    ]
    return questionText(question, blocked, askedFrom)
  })

/** How a talk ended. */
export type TalkEnd = Data.TaggedEnum<{
  /** give_answer took `answer`: the session is closed, and the answer goes back to the form. */
  Answered: { readonly answer: string }
  /** The session ended, or was left, before an answer: the question stays open. */
  Ended: { readonly why: string }
}>

export const TalkEnd = Data.taggedEnum<TalkEnd>()

/** Why a talk ended when it was left. */
export const talkLeftWhy = "the talk was left"

/** A talk under way. */
export interface AnswerTalk {
  readonly sessionId: string
  readonly tools: TalkTools
  /** Sends what you typed in the composer, with the uuid the composer drew, if it drew one. */
  send(text: string, uuid?: MessageUuid): Effect.Effect<MessageUuid, AgentGone>
  /**
   * Waits for the talk's end: once give_answer has taken the answer and the turn is over, closes
   * the session and gives the answer; else the session's end without one. An answer taken before
   * the session ended, or was left, is given all the same: the maintainer agreed to it.
   */
  readonly ended: Effect.Effect<TalkEnd>
  /** Leaves the talk: closes its session. */
  readonly leave: Effect.Effect<void>
}

/**
 * Starts the talk on the open question `question`: reads it and the tickets it blocks, starts the
 * session in the main checkout and sends it the first message. A question bd can't read, or one
 * no longer open, fails the start, as a session that doesn't start does. Its tools' calls are fibers
 * of the caller's scope, the talk's, which outlasts the session.
 */
export const startAnswerTalk = (
  question: TicketId,
): Effect.Effect<AnswerTalk, AgentStartFailed, AgentHost | AppConfig | Beads | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const host = yield* AgentHost
    const text = yield* readQuestion(question).pipe(
      Effect.mapError(
        (why) =>
          new AgentStartFailed({
            ticket: interviewWorker,
            reason: `${question} couldn't be read: ${why}`,
          }),
      ),
    )
    const tools = yield* makeTalkTools(yield* sessionFibers)
    const sessionId = randomUUID()
    yield* host.start(interviewWorker, {
      sessionId,
      cwd: config.repo,
      kind: SessionKind.Interview({
        prompt: answerTalkPrompt,
        server: tools.server,
        breakdown: {
          builtins: interviewBuiltins,
          allowed: qualifiedTalkTools,
          headless: false,
          effort: null,
          tools: tools.tools,
        },
      }),
    })
    const first = yield* leadAndPasted(talkLead, text)
    yield* host
      .send(interviewWorker, { text: first, from: "clientComposed" })
      .pipe(
        Effect.mapError(
          (gone) => new AgentStartFailed({ ticket: interviewWorker, reason: gone.why }),
        ),
      )

    // Whether the talk was left: its session's end, or its worker forgotten, is no news.
    const left = yield* Ref.make(false)
    const end = (why: string) =>
      Effect.gen(function* () {
        const answer = yield* SubscriptionRef.get(tools.answer)
        if (answer !== null) return TalkEnd.Answered({ answer })
        return TalkEnd.Ended({ why: (yield* Ref.get(left)) ? talkLeftWhy : why })
      })

    const ended = host.state(interviewWorker).pipe(
      Stream.mapEffect((state) =>
        Effect.map(SubscriptionRef.get(tools.answer), (answer) => ({ state, answer })),
      ),
      Stream.filter(
        ({ state, answer }) =>
          state._tag === "Gone" ||
          state._tag === "Closed" ||
          (answer !== null && (state._tag === "Idle" || state._tag === "Failed")),
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => end(talkLeftWhy),
          onSome: ({ state }) =>
            Effect.gen(function* () {
              if (state._tag !== "Gone" && state._tag !== "Closed") yield* host.end(interviewWorker)
              return yield* end(state._tag === "Gone" ? state.why : talkLeftWhy)
            }),
        }),
      ),
      Effect.catchTag("AgentGone", (gone) => end(gone.why)),
    )

    return {
      sessionId,
      tools,
      send: (message, uuid) => host.send(interviewWorker, { text: message, from: "human", uuid }),
      ended,
      leave: Effect.andThen(Ref.set(left, true), host.end(interviewWorker)),
    } satisfies AnswerTalk
  })
