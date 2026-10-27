// A question's talk (tutti-i0sz, § 4.11): the session's tools (give_answer takes one answer), the
// first message that brings the question in (its options, the tickets it blocks with their design
// and notes, those it was asked from, pasted under an ID it doesn't hold), the session started read
// only in the main checkout with tutti's server, its end (the answer once the turn is over; none
// when it goes or is left), and the run's side, shown in the Interview view under its own name.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Layer, Queue, type Scope, Stream, SubscriptionRef } from "effect"
import fc from "fast-check"
import { AgentHost, type Session } from "../src/agent/AgentHost.ts"
import {
  type AnswerTalk,
  answerTalkPrompt,
  makeTalkTools,
  qualifiedTalkTools,
  questionText,
  readQuestion,
  startAnswerTalk,
  TalkEnd,
  type TalkTools,
  takenText,
  talkLead,
  talkLeftWhy,
} from "../src/agent/answerTalk.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { interviewWorker, leadAndPasted } from "../src/agent/interview.ts"
import { serverName } from "../src/agent/interviewTools.ts"
import { interviewBuiltins } from "../src/agent/options.ts"
import type { AppConfig } from "../src/cli/AppConfig.ts"
import { talkLeaveAbout, talkLeaveQuestion, talkName, talkQuestion } from "../src/run/answerTalk.ts"
import { UiCommand } from "../src/run/commands.ts"
import type { InterviewInputs } from "../src/run/interview.ts"
import { openQuestionOf } from "../src/run/overnightQuestions.ts"
import { QuestionNews, talkingAlready, talkThrough } from "../src/run/questionNews.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import {
  gone as goneStep,
  init,
  Recording,
  result,
  type Script,
  layer as scriptedHost,
  sessionState,
  tool,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { openFibers } from "./fibers.ts"

type Answer = Awaited<ReturnType<TalkTools["tools"][number]["handler"]>>

/** The text of a tool's answer. */
const textOf = (answer: Answer): string =>
  answer.content.map((part) => (part.type === "text" ? part.text : "")).join("")

/** Calls the talk's tool `name` with `input`, as the session would. */
const call = (tools: TalkTools, name: string, input: Record<string, unknown>) => {
  const found = tools.tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return Effect.promise(() => found.handler(input as never, {}))
}

/** A question q-1 blocking tut-1 (open) and tut-2 (closed), asked from tut-0, with options. */
const backlog: ReadonlyArray<Seed> = [
  { id: "tut-0", title: "Where it was asked" },
  {
    id: "tut-1",
    title: "Add the flag",
    description: "list takes a flag.",
    design: "Parse it in cli.ts.",
    notes: "Waiting on q-1.",
    blockedBy: ["q-1"],
  },
  { id: "tut-2", title: "Done already", status: "closed", blockedBy: ["q-1"] },
  {
    id: "q-1",
    title: "Which flag name?",
    description: "The flag needs a name.",
    labels: ["human"],
    dependencies: [{ id: "tut-0", type: "discovered-from" }],
    metadata: {
      options: [
        { label: "--flag", description: "short to type" },
        { label: "--long-flag", description: "says what it does" },
      ],
      recommended: 1,
    },
  },
  { id: "q-2", title: "Answered", labels: ["human"], status: "closed" },
  { id: "tut-9", title: "Not a question" },
]

const onBacklog = <A, E>(effect: Effect.Effect<A, E, Beads>) =>
  Effect.runPromise(Effect.provide(effect, beadsLayer(backlog)))

describe("the talk's first message", () => {
  test("the question, its options recommended first, the open tickets it blocks, where it was asked", async () => {
    const text = await onBacklog(readQuestion("q-1" as TicketId))
    expect(text).toBe(
      [
        "# q-1: Which flag name?",
        "",
        "The flag needs a name.",
        "",
        "## Options",
        "",
        "1. --long-flag (recommended) - says what it does",
        "2. --flag - short to type",
        "",
        "## The tickets it blocks",
        "",
        "### tut-1: Add the flag",
        "Description:\nlist takes a flag.",
        "Design:\nParse it in cli.ts.",
        "Notes:\nWaiting on q-1.",
        "",
        "## Asked from",
        "",
        "tut-0",
      ].join("\n"),
    )
  })

  test("a question without options asks for them drafted; one blocking nothing says so", () => {
    const question = { id: "q-5", title: "Why?", description: "", metadata: {} } as unknown as Issue
    expect(questionText(question, [], [])).toBe(
      [
        "# q-5: Why?",
        "",
        "## Options",
        "",
        "The question carries no options: draft 2 to 4.",
        "",
        "## The tickets it blocks",
        "",
        "None is open.",
      ].join("\n"),
    )
  })

  test("a closed question, or an issue that isn't one, isn't read", async () => {
    for (const id of ["q-2", "tut-9"]) {
      const read = await Effect.runPromise(
        Effect.provide(Effect.flip(readQuestion(id as TicketId)), beadsLayer(backlog)),
      )
      expect(read).toBe(`${id} isn't an open question`)
    }
  })

  test("whatever a worker wrote, its pasted block closes only at its end", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (written) => {
        const message = await Effect.runPromise(leadAndPasted(talkLead, written))
        const id = /<pasted_content id="([^"]+)">/.exec(message)?.[1] ?? ""
        expect(id).not.toBe("")
        expect(message.startsWith(`${talkLead}\n\n<pasted_content id="${id}">\n`)).toBe(true)
        expect(message.endsWith(`\n</pasted_content id="${id}">`)).toBe(true)
        expect(message.split(id).length).toBe(3)
      }),
      { numRuns: 50 },
    )
  })
})

describe("give_answer", () => {
  const withTools = <A>(effect: (tools: TalkTools) => Effect.Effect<A>) =>
    onBacklog(Effect.flatMap(makeTalkTools(openFibers()), effect))

  test("takes one answer, trimmed; an empty one, or a second, is refused", async () => {
    const value = await withTools((tools) =>
      Effect.gen(function* () {
        const empty = yield* call(tools, "give_answer", { answer: "   " })
        const givenAfterEmpty = yield* SubscriptionRef.get(tools.given)
        const first = yield* call(tools, "give_answer", { answer: "  --long-flag, as agreed \n" })
        const second = yield* call(tools, "give_answer", { answer: "--flag" })
        return {
          empty,
          givenAfterEmpty,
          first,
          second,
          answer: yield* SubscriptionRef.get(tools.answer),
          given: yield* SubscriptionRef.get(tools.given),
        }
      }),
    )
    expect(value.empty.isError).toBe(true)
    expect(value.givenAfterEmpty).toBe(false)
    expect(value.first.isError).toBeUndefined()
    expect(textOf(value.first)).toBe(takenText)
    expect(value.second.isError).toBe(true)
    expect(textOf(value.second)).toContain("already given: --long-flag, as agreed")
    expect(value.answer).toBe("--long-flag, as agreed")
    expect(value.given).toBe(true)
  })

  test("the talk reads tickets, and records nothing itself", async () => {
    const value = await withTools((tools) =>
      Effect.gen(function* () {
        const shown = yield* call(tools, "ticket_show", { id: "tut-1" })
        return { names: tools.tools.map((t) => t.name), shown: textOf(shown) }
      }),
    )
    expect(value.names).toEqual(["tickets_list", "ticket_show", "give_answer"])
    expect(value.shown).toContain("Parse it in cli.ts.")
    expect(qualifiedTalkTools).toEqual([
      "mcp__tutti__tickets_list",
      "mcp__tutti__ticket_show",
      "mcp__tutti__give_answer",
    ])
  })
})

describe("startAnswerTalk, with the scripted host", () => {
  const talkInit = init({
    mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }],
  })

  /** Runs `effect` in a fresh main checkout with the scripted host playing `script`. */
  const scenario = <A, E>(
    script: (ready: Deferred.Deferred<AnswerTalk>) => Script,
    effect: (
      ready: Deferred.Deferred<AnswerTalk>,
    ) => Effect.Effect<A, E, AgentHost | Recording | Beads | AppConfig | Scope.Scope>,
  ) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-talk-")))
    return Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<AnswerTalk>()
        return yield* effect(ready).pipe(
          Effect.scoped,
          Effect.provide(
            scriptedHost({ [interviewWorker]: script(ready) }).pipe(
              Layer.provideMerge(
                Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
              ),
              Layer.provideMerge(
                Layer.mergeAll(
                  logLayer(),
                  eventsLayer(),
                  configLayer(appConfig({}, repo)),
                  beadsLayer(backlog),
                  memoryGit({ dir: repo, files: { "README.md": "# demo\n" } }),
                ),
              ),
            ),
          ),
        )
      }),
    ).then((value) => ({ repo, value }))
  }

  /** A turn that gives `answer` once the talk has started. */
  const answering = (ready: Deferred.Deferred<AnswerTalk>, answer: string): Script => [
    [
      wait,
      talkInit,
      sessionState("running"),
      ...tool(
        "mcp__tutti__give_answer",
        { answer },
        Effect.flatMap(Deferred.await(ready), (talk) =>
          Effect.asVoid(call(talk.tools, "give_answer", { answer })),
        ),
      ),
      result("Decided: --long-flag."),
      sessionState("idle"),
    ],
  ]

  test("it starts read-only in the main checkout; its answer comes back once the turn is over", async () => {
    const { repo, value } = await scenario(
      (ready) => answering(ready, "--long-flag"),
      (ready) =>
        Effect.gen(function* () {
          const talk = yield* startAnswerTalk("q-1" as TicketId)
          yield* Deferred.succeed(ready, talk)
          const ended = yield* talk.ended
          const recording = yield* Recording
          return { ended, sent: yield* recording.sentTo(interviewWorker), talk }
        }),
    )
    const { ended, sent, talk } = value
    expect(ended).toEqual(TalkEnd.Answered({ answer: "--long-flag" }))
    const started = sent.find((s) => s._tag === "Started")
    const session = (started?._tag === "Started" ? started.session : undefined) as Session
    expect(session.sessionId).toBe(talk.sessionId)
    expect(session.cwd).toBe(repo)
    const kind = session.kind
    if (kind?._tag !== "Interview") throw new Error(`not an interview's session: ${kind?._tag}`)
    expect(kind.prompt).toBe(answerTalkPrompt)
    expect(kind.prompt).not.toContain("<!--")
    expect(kind.server).toBe(talk.tools.server)
    expect(kind.breakdown?.builtins).toEqual(interviewBuiltins)
    expect(kind.breakdown?.allowed).toEqual(qualifiedTalkTools)
    expect(kind.breakdown?.headless).toBe(false)

    // The question, sent wrapped as the first message, composed by tutti.
    const message = sent.find((s) => s._tag === "Message")
    const first = message?._tag === "Message" ? message.message : undefined
    expect(first?.client_composed).toBe(true)
    const content = String(first?.message.content)
    expect(content).toStartWith(`${talkLead}\n\n<pasted_content id="`)
    expect(content).toContain("# q-1: Which flag name?")
    expect(content).toContain("Design:\nParse it in cli.ts.")
    // The session is closed once the answer is given and the turn is over.
    expect(sent.at(-1)?._tag).toBe("Ended")
  })

  test("a session that goes before an answer gives none, saying why", async () => {
    const { value } = await scenario(
      () => [[wait, talkInit, goneStep("Claude Code exited")]],
      () => Effect.flatMap(startAnswerTalk("q-1" as TicketId), (talk) => talk.ended),
    )
    expect(value).toEqual(TalkEnd.Ended({ why: "its session ended: Claude Code exited" }))
  })

  test("a talk left before an answer gives none; one left after it gives the answer", async () => {
    const left = await scenario(
      () => [
        [wait, talkInit, sessionState("running"), result("Which?"), sessionState("idle"), wait],
      ],
      () =>
        Effect.gen(function* () {
          const talk = yield* startAnswerTalk("q-1" as TicketId)
          yield* waitIdle
          yield* talk.leave
          return yield* talk.ended
        }),
    )
    expect(left.value).toEqual(TalkEnd.Ended({ why: talkLeftWhy }))

    const answered = await scenario(
      () => [
        [wait, talkInit, sessionState("running"), result("Which?"), sessionState("idle"), wait],
      ],
      () =>
        Effect.gen(function* () {
          const talk = yield* startAnswerTalk("q-1" as TicketId)
          yield* waitIdle
          yield* call(talk.tools, "give_answer", { answer: "--flag" })
          yield* talk.leave
          return yield* talk.ended
        }),
    )
    expect(answered.value).toEqual(TalkEnd.Answered({ answer: "--flag" }))
  })

  test("a question no longer open doesn't start a session", async () => {
    const { value } = await scenario(
      () => [],
      () => Effect.flip(startAnswerTalk("q-2" as TicketId)),
    )
    expect(value._tag).toBe("AgentStartFailed")
    expect(value.reason).toBe("q-2 couldn't be read: q-2 isn't an open question")
  })
})

/** Waits for the talk's session to be idle: its turn over. */
const waitIdle = Effect.gen(function* () {
  const host = yield* AgentHost
  yield* host.state(interviewWorker).pipe(
    Stream.filter((state) => state._tag === "Idle"),
    Stream.runHead,
  )
})

describe("talkQuestion, the run's side", () => {
  test("shows the talk in the Interview view under its name; leaving it gives no answer", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-talk-")))
    const shown: Array<InterviewInputs> = []
    const question = await onBacklog(
      Effect.gen(function* () {
        const beads = yield* Beads
        return yield* beads.show("q-1" as TicketId)
      }),
    )
    const ended = await Effect.runPromise(
      talkQuestion(openQuestionOf(question, ["tut-1" as TicketId]), (inputs) =>
        Effect.gen(function* () {
          shown.push(inputs)
          // Leaving the view, as Esc and y do.
          yield* Queue.offer(inputs.commands, UiCommand.CloseWorker())
        }),
      ).pipe(
        Effect.provide(
          scriptedHost({
            [interviewWorker]: [
              [
                wait,
                init({ mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }] }),
                wait,
              ],
            ],
          }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
            ),
            Layer.provideMerge(
              Layer.mergeAll(
                logLayer(),
                eventsLayer(),
                configLayer(appConfig({}, repo)),
                beadsLayer(backlog),
                memoryGit({ dir: repo, files: {} }),
              ),
            ),
          ),
        ),
      ),
    )
    expect(ended).toEqual(TalkEnd.Ended({ why: talkLeftWhy }))
    const inputs = shown[0]
    expect(inputs?.description).toBe("q-1: Which flag name?")
    expect(inputs?.name).toBe(talkName)
    expect(inputs?.leaveQuestion).toBe(talkLeaveQuestion)
    expect(inputs?.leaveAbout).toBe(talkLeaveAbout)
    // Leaving asks first until give_answer has taken an answer.
    expect(
      inputs?.filed === undefined ? null : Effect.runSync(SubscriptionRef.get(inputs.filed)),
    ).toBe(false)
  })

  test("a question that can't be read gives no answer, saying why", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-talk-")))
    const question = {
      id: "q-2" as TicketId,
      title: "Answered",
      description: "",
      options: undefined,
      maintainerOnly: false,
      waiting: [],
    }
    const ended = await Effect.runPromise(
      talkQuestion(question, () => Effect.die("not shown")).pipe(
        Effect.provide(
          scriptedHost({}).pipe(
            Layer.provideMerge(
              Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
            ),
            Layer.provideMerge(
              Layer.mergeAll(
                logLayer(),
                eventsLayer(),
                configLayer(appConfig({}, repo)),
                beadsLayer(backlog),
                memoryGit({ dir: repo, files: {} }),
              ),
            ),
          ),
        ),
      ),
    )
    expect(ended).toEqual(
      TalkEnd.Ended({ why: "couldn't start: q-2 couldn't be read: q-2 isn't an open question" }),
    )
  })
})

describe("talkThrough, the dashboard's talk", () => {
  const talkInit = init({ mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }] })

  /** The tools the talk's session was started with, once it has been. */
  const startedTools = Effect.gen(function* () {
    const recording = yield* Recording
    for (;;) {
      const started = (yield* recording.sentTo(interviewWorker)).find((s) => s._tag === "Started")
      const kind = started?._tag === "Started" ? started.session.kind : undefined
      if (kind?._tag === "Interview" && kind.breakdown !== undefined) return kind.breakdown.tools
      yield* Effect.sleep("5 millis")
    }
  })

  /**
   * Talks q-1 through from the dashboard, its session playing `script` (`tools`: the session's,
   * for a turn that calls give_answer), with `slot` busy when `busy`.
   */
  const dashboardTalk = (
    script: (tools: Deferred.Deferred<TalkTools["tools"]>) => Script,
    busy = false,
  ) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-talk-")))
    const tools = Effect.runSync(Deferred.make<TalkTools["tools"]>())
    return Effect.runPromise(
      Effect.gen(function* () {
        const news = yield* SubscriptionRef.make<ReadonlyArray<QuestionNews>>([])
        const slot = yield* SubscriptionRef.make<InterviewInputs | null>(
          busy ? ({} as InterviewInputs) : null,
        )
        const shown: Array<InterviewInputs | null> = []
        yield* SubscriptionRef.changes(slot).pipe(
          Stream.runForEach((inputs) => Effect.sync(() => shown.push(inputs))),
          Effect.forkScoped,
        )
        yield* startedTools.pipe(
          Effect.flatMap((found) => Deferred.succeed(tools, found)),
          Effect.forkScoped,
        )
        yield* Effect.yieldNow
        yield* talkThrough(
          { question: "q-1" as TicketId, title: "Which flag name?", next: null, uuid: "u-1" },
          news,
          slot,
        )
        const backlogNow = yield* Backlog
        return {
          news: yield* SubscriptionRef.get(news),
          shown,
          slot: yield* SubscriptionRef.get(slot),
          design: (yield* backlogNow.issues).find((issue) => issue.id === "tut-1")?.design,
          logged: yield* texts,
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          scriptedHost({ [interviewWorker]: script(tools) }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
            ),
            Layer.provideMerge(
              Layer.mergeAll(
                logLayer(),
                eventsLayer(),
                configLayer(appConfig({}, repo)),
                beadsLayer(backlog),
                memoryGit({ dir: repo, files: {} }),
              ),
            ),
          ),
        ),
      ),
    )
  }

  test("shown in the slot while it goes; its answer recorded, then Talked", async () => {
    const answer = { answer: "--long-flag" }
    const value = await dashboardTalk((tools) => [
      [
        wait,
        talkInit,
        sessionState("running"),
        ...tool(
          "mcp__tutti__give_answer",
          answer,
          Effect.flatMap(Deferred.await(tools), (found) => {
            const give = found.find((t) => t.name === "give_answer")
            if (give === undefined) return Effect.die("no give_answer")
            return Effect.asVoid(Effect.promise(() => give.handler(answer as never, {})))
          }),
        ),
        result("Decided."),
        sessionState("idle"),
      ],
    ])
    // The view was put in the slot, then let go of.
    expect(value.shown.at(1)?.name).toBe(talkName)
    expect(value.shown.at(1)?.description).toBe("q-1: Which flag name?")
    expect(value.shown.at(-1)).toBeNull()
    expect(value.slot).toBeNull()
    // Recorded as AnswerQuestion is, before the box hears the talk is over.
    expect(value.design).toContain("Decided (q-1): Which flag name?\n--long-flag")
    expect(value.news).toEqual([
      QuestionNews.Answered({
        uuid: "u-1",
        question: "q-1" as TicketId,
        title: "Which flag name?",
        decided: ["tut-1" as TicketId],
      }),
      QuestionNews.Talked({
        uuid: "u-1",
        question: "q-1" as TicketId,
        answered: true,
        why: null,
        next: null,
      }),
    ])
  })

  test("a session that goes without an answer says why, the question open", async () => {
    const value = await dashboardTalk(() => [[wait, talkInit, goneStep("Claude Code exited")]])
    expect(value.design).not.toContain("Decided")
    expect(value.news).toEqual([
      QuestionNews.Talked({
        uuid: "u-1",
        question: "q-1" as TicketId,
        answered: false,
        why: "its session ended: Claude Code exited",
        next: null,
      }),
    ])
    expect(value.logged).toContain(
      "the talk about q-1 on the dashboard ended without an answer: its session ended: Claude Code exited",
    )
  })

  test("while another talk is shown, none starts", async () => {
    const value = await dashboardTalk(() => [], true)
    expect(value.news).toEqual([
      QuestionNews.Talked({
        uuid: "u-1",
        question: "q-1" as TicketId,
        answered: false,
        why: talkingAlready,
        next: null,
      }),
    ])
  })
})
