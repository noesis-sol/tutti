import { describe, expect, test } from "bun:test"
import type {
  CanUseTool,
  ElicitationRequest,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import {
  type Answer,
  Attention,
  type AttentionRequest,
  allowsForRun,
  blockedAfter,
  DoesNotFit,
  denialMessage,
  NotOpen,
  overdue,
  type Policy,
  questionsOf,
  summarize,
  summaryLength,
} from "../src/agent/Attention.ts"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import { allowAll, layer as attentionLayer, denyAll } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"

type Env = Attention | Log | EventStream | Captured

/** Runs `effect` with the Attention test layer answering by `policy`, over captured logs and events. */
const run = <A, E>(effect: Effect.Effect<A, E, Env>, policy?: Policy): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        attentionLayer(policy).pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** The SDK's options for a call, with a signal the test can abort. */
const sdkOptions = (
  over: Partial<Parameters<CanUseTool>[2]> = {},
): Parameters<CanUseTool>[2] & { readonly controller: AbortController } => {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
    requestId: "req",
    controller,
    ...over,
  }
}

/** A Bash rule suggestion as the CLI makes one: the exact command, in local settings. */
const bashRule = (command: string): PermissionUpdate => ({
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: command }],
  behavior: "allow",
  destination: "localSettings",
})

const setMode: PermissionUpdate = { type: "setMode", mode: "acceptEdits", destination: "session" }
const addDirectories: PermissionUpdate = {
  type: "addDirectories",
  directories: ["/work"],
  destination: "session",
}

/** Waits until `n` requests are open, every worker's, and gives them, oldest first. */
const openRequests = (n: number) =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const seen = yield* attention.open.pipe(
      Stream.filter((all) => all.length >= n),
      Stream.runHead,
    )
    return seen._tag === "Some" ? seen.value : []
  })

/** Asks `ticket`'s canUseTool for `tool` with `input`, and waits until the request is open. */
const ask = (
  ticket: string,
  tool: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2] = sdkOptions(),
) =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const before = (yield* attention.current).length
    const canUseTool = yield* attention.request(ticket)
    const result = canUseTool(tool, input, options)
    const open = yield* openRequests(before + 1)
    return { result, request: open[open.length - 1] as AttentionRequest }
  })

const answer = (
  request: AttentionRequest,
  given: Answer,
  via: "screen" | "answer_command" = "screen",
) => Effect.flatMap(Attention, (attention) => attention.answer(request.id, given, via))

const settled = (result: Promise<PermissionResult | null>) => Effect.promise(() => result)

const records = Effect.flatMap(Captured, (captured) => captured.records)

const ofKind = <K extends EventRecord["kind"]>(all: ReadonlyArray<EventRecord>, kind: K) =>
  all.filter((r): r is Extract<EventRecord, { kind: K }> => r.kind === kind)

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

const bash = { command: "touch made-by-bash.txt", description: "Create a file" }

describe("Attention: each answer's SDK result", () => {
  test("Allow sends the input back as updatedInput, user_temporary", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { result, request } = yield* ask("tut-1", "Bash", bash)
        yield* answer(request, { _tag: "Allow" })
        return yield* settled(result)
      }),
    )
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: bash,
      decisionClassification: "user_temporary",
    })
  })

  test("Allow for this run passes only addRules, in session, user_permanent", async () => {
    const options = sdkOptions({ suggestions: [bashRule(bash.command), addDirectories, setMode] })
    const result = await run(
      Effect.gen(function* () {
        const { result, request } = yield* ask("tut-1", "Bash", bash, options)
        expect(allowsForRun(request)).toBe(true)
        yield* answer(request, { _tag: "AllowForRun" })
        return yield* settled(result)
      }),
    )
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: bash,
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: bash.command }],
          behavior: "allow",
          destination: "session",
        },
      ],
      decisionClassification: "user_permanent",
    })
  })

  test("Deny sends tutti's message, user_reject, never interrupt", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { result, request } = yield* ask("tut-1", "Bash", bash)
        yield* answer(request, { _tag: "Deny" })
        return yield* settled(result)
      }),
    )
    expect(result).toEqual({
      behavior: "deny",
      message: denialMessage,
      decisionClassification: "user_reject",
    })
  })

  test("Deny with a reason adds the reason to the message", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { result, request } = yield* ask("tut-1", "Bash", bash)
        yield* answer(request, { _tag: "Deny", reason: "use the build script" })
        return yield* settled(result)
      }),
    )
    expect(result).toEqual({
      behavior: "deny",
      message: `${denialMessage}: use the build script`,
      decisionClassification: "user_reject",
    })
  })

  test("a question's answers map each question's text to the choice", async () => {
    const questions = [
      {
        question: "Which colour?",
        header: "Colour",
        options: [
          { label: "Blue", description: "cool" },
          { label: "Red", description: "warm" },
        ],
        multiSelect: false,
      },
      {
        question: "Which size?",
        header: "Size",
        options: [{ label: "S" }, { label: "L" }],
        multiSelect: false,
      },
    ]
    const result = await run(
      Effect.gen(function* () {
        const { result, request } = yield* ask("tut-1", "AskUserQuestion", { questions })
        expect(request.kind._tag).toBe("Question")
        yield* answer(request, { _tag: "Choose", answers: ["Blue", "an extra large"] })
        return yield* settled(result)
      }),
    )
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions,
        answers: { "Which colour?": "Blue", "Which size?": "an extra large" },
      },
    })
  })

  test("an answer that doesn't fit the request is refused and leaves it open", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const plain = yield* ask("tut-1", "Write", { file_path: "notes.txt" })
        const suppressed = yield* ask(
          "tut-1",
          "Bash",
          bash,
          sdkOptions({ suggestions: [bashRule(bash.command)], suppressAlwaysAllowRule: true }),
        )
        const question = yield* ask("tut-1", "AskUserQuestion", {
          questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }],
        })
        const exits = [
          yield* Effect.exit(answer(plain.request, { _tag: "AllowForRun" })),
          yield* Effect.exit(answer(suppressed.request, { _tag: "AllowForRun" })),
          yield* Effect.exit(answer(question.request, { _tag: "Allow" })),
          yield* Effect.exit(answer(question.request, { _tag: "Choose", answers: ["A", "B"] })),
        ]
        return { exits, open: (yield* attention.current).length }
      }),
    )
    for (const exit of outcome.exits) expect(failure(exit)).toBeInstanceOf(DoesNotFit)
    expect(outcome.open).toBe(3)
  })
})

describe("Attention: several requests per worker", () => {
  test("each worker's requests queue oldest first; answering one leaves the rest in order", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const a = yield* ask("tut-1", "Bash", { command: "one" })
        const b = yield* ask("tut-1", "Bash", { command: "two" })
        const other = yield* ask("tut-2", "Bash", { command: "elsewhere" })
        const c = yield* ask("tut-1", "Bash", { command: "three" })
        const first = yield* attention.openFor("tut-1").pipe(Stream.runHead)
        yield* answer(b.request, { _tag: "Allow" })
        const after = yield* attention.openFor("tut-1").pipe(Stream.runHead)
        const all = yield* attention.current
        yield* answer(a.request, { _tag: "Deny" })
        yield* answer(c.request, { _tag: "Deny" })
        yield* answer(other.request, { _tag: "Deny" })
        const results = yield* Effect.all([a, b, c, other].map((x) => settled(x.result)))
        const summary = (o: { _tag: string; value?: ReadonlyArray<AttentionRequest> }) =>
          (o.value ?? []).map((r) => (r.kind._tag === "Permission" ? r.kind.summary : ""))
        return {
          first: summary(first),
          after: summary(after),
          all: all.map((r) => r.ticket),
          behaviours: results.map((r) => r?.behavior),
          left: (yield* attention.current).length,
        }
      }),
    )
    expect(seen.first).toEqual(["one", "two", "three"])
    expect(seen.after).toEqual(["one", "three"])
    expect(seen.all).toEqual(["tut-1", "tut-2", "tut-1"])
    expect(seen.behaviours).toEqual(["deny", "allow", "deny", "deny"])
    expect(seen.left).toBe(0)
  })

  test("the request keeps the SDK's IDs, flags and sanitised display fields", async () => {
    const request = await run(
      Effect.gen(function* () {
        const { request } = yield* ask(
          "tut-1",
          "Bash",
          { command: "rm -rf $T/*\u001b]52;c;aGk=\u0007" },
          sdkOptions({
            toolUseID: "toolu_1",
            agentID: "agent-7",
            title: "Claude wants to \u001b[31mremove\u001b[0m files",
            displayName: "Bash",
            description: "Remove the‮ target",
            decisionReason: "Dangerous rm operation",
            blockedPath: "/work/a\tb",
            defaultToNo: true,
            suppressAlwaysAllowRule: true,
            mcpServer: { name: "evil\u001b[2J", source: "project" },
          }),
        )
        return request
      }),
    )
    expect(request).toMatchObject({
      id: "r1",
      ticket: "tut-1",
      toolUseID: "toolu_1",
      agentID: "agent-7",
      title: "Claude wants to remove files",
      displayName: "Bash",
      description: "Remove the target",
      decisionReason: "Dangerous rm operation",
      blockedPath: "/work/a b",
      mcpServer: { name: "evil", source: "project" },
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    })
    expect(request.kind).toMatchObject({ _tag: "Permission", tool: "Bash", summary: "rm -rf $T/*" })
    expect(allowsForRun(request)).toBe(false)
  })
})

describe("Attention: rules allowed for this run", () => {
  test("a later request from any worker suggesting the same rule is allowed without asking", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const first = yield* ask(
          "tut-1",
          "Bash",
          bash,
          sdkOptions({ suggestions: [bashRule(bash.command), setMode] }),
        )
        yield* answer(first.request, { _tag: "AllowForRun" })
        yield* settled(first.result)
        const canUseTool = yield* attention.request("tut-2")
        const later = yield* settled(
          canUseTool("Bash", bash, sdkOptions({ suggestions: [bashRule(bash.command)] })),
        )
        const sibling = yield* ask(
          "tut-2",
          "Bash",
          { command: "touch another-file.txt" },
          sdkOptions({ suggestions: [bashRule("touch another-file.txt")] }),
        )
        const open = (yield* attention.current).map((r) => r.id)
        yield* answer(sibling.request, { _tag: "Deny" })
        return {
          later,
          open,
          siblingId: sibling.request.id,
          log: yield* texts,
          tally: yield* attention.tally("tut-2"),
        }
      }),
    )
    expect(seen.later).toEqual({
      behavior: "allow",
      updatedInput: bash,
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: bash.command }],
          behavior: "allow",
          destination: "session",
        },
      ],
      decisionClassification: "user_permanent",
    })
    expect(seen.open).toEqual([seen.siblingId])
    expect(seen.log).toContain(
      "  ALLOWED: tut-2's worker: Bash(touch made-by-bash.txt), by a rule you allowed for this run",
    )
    expect(seen.tally.allowedByRule).toBe(1)
    expect(seen.tally.permissions).toBe(1)
  })

  test("persistent destinations are never passed, and a defaultToNo request is still asked", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const project: PermissionUpdate = { ...bashRule("make"), destination: "projectSettings" }
        const first = yield* ask(
          "tut-1",
          "Bash",
          { command: "make" },
          sdkOptions({ suggestions: [project] }),
        )
        yield* answer(first.request, { _tag: "AllowForRun" })
        const result = yield* settled(first.result)
        const held = yield* ask(
          "tut-3",
          "Bash",
          { command: "make" },
          sdkOptions({ suggestions: [bashRule("make")], defaultToNo: true }),
        )
        const open = (yield* attention.current).length
        yield* answer(held.request, { _tag: "Deny" })
        return { result, open }
      }),
    )
    const destinations =
      seen.result?.behavior === "allow"
        ? (seen.result.updatedPermissions ?? []).map((u) => u.destination)
        : []
    expect(destinations).toEqual(["session"])
    expect(seen.open).toBe(1)
  })
})

describe("Attention: stale answers and withdrawn requests", () => {
  test("an answer to a request no longer open fails NotOpen and changes nothing", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const { result, request } = yield* ask("tut-1", "Bash", bash)
        yield* answer(request, { _tag: "Allow" })
        const again = yield* Effect.exit(answer(request, { _tag: "Deny" }))
        const unknown = yield* Effect.exit(
          Effect.flatMap(Attention, (a) => a.answer("nope", { _tag: "Allow" }, "answer_command")),
        )
        return { result: yield* settled(result), again, unknown }
      }),
    )
    expect(seen.result?.behavior).toBe("allow")
    for (const exit of [seen.again, seen.unknown]) expect(failure(exit)).toBeInstanceOf(NotOpen)
  })

  test("a request whose signal aborts is removed, recorded as cancelled", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const options = sdkOptions()
        const { result, request } = yield* ask("tut-1", "Bash", bash, options)
        options.controller.abort()
        const outcome = yield* settled(result)
        const late = yield* Effect.exit(answer(request, { _tag: "Allow" }))
        return {
          outcome,
          open: (yield* attention.current).length,
          late,
          events: ofKind(yield* records, "attention_answered"),
          log: yield* texts,
          tally: yield* attention.tally("tut-1"),
        }
      }),
    )
    expect(seen.outcome?.behavior).toBe("deny")
    expect(seen.open).toBe(0)
    expect(failure(seen.late)).toBeInstanceOf(NotOpen)
    expect(seen.events).toHaveLength(1)
    expect(seen.events[0]).toMatchObject({ ticket: "tut-1", request: "r1", cancelled: true })
    expect(seen.events[0]?.answer).toBeUndefined()
    expect(seen.log.at(-1)).toBe(
      "  PERMISSION: tut-1's worker: Bash(touch made-by-bash.txt) withdrawn",
    )
    expect(seen.tally.cancelled).toBe(1)
  })

  test("a signal aborted before the call is withdrawn at once", async () => {
    const options = sdkOptions()
    options.controller.abort()
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const canUseTool = yield* attention.request("tut-1")
        const outcome = yield* settled(canUseTool("Bash", bash, options))
        return { outcome, open: (yield* attention.current).length }
      }),
    )
    expect(seen.outcome?.behavior).toBe("deny")
    expect(seen.open).toBe(0)
  })
})

describe("Attention: elicitations", () => {
  const urlLogin: ElicitationRequest = {
    serverName: "linear\u001b[2J",
    message: "Log in to Linear",
    mode: "url",
    url: "https://linear.app/login",
    elicitationId: "e1",
  }

  const elicit = (request: ElicitationRequest, controller = new AbortController()) =>
    Effect.gen(function* () {
      const attention = yield* Attention
      const onElicitation = yield* attention.elicitation("tut-1")
      const result = onElicitation(request, { signal: controller.signal, requestId: "x" })
      const open = yield* openRequests(1)
      return { result, request: open[0] as AttentionRequest, controller }
    })

  test("declined, accepted with the form's content, or cancelled when aborted", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const login = yield* elicit(urlLogin)
        yield* answer(login.request, { _tag: "Decline" })
        const declined = yield* Effect.promise(() => login.result)
        const form = yield* elicit({
          serverName: "forms",
          message: "Your name?",
          mode: "form",
          requestedSchema: { type: "object", properties: { name: { type: "string" } } },
        })
        yield* answer(form.request, { _tag: "Accept", content: { name: "Ada" } })
        const accepted = yield* Effect.promise(() => form.result)
        const gone = yield* elicit(urlLogin)
        gone.controller.abort()
        const cancelled = yield* Effect.promise(() => gone.result)
        return {
          login: login.request,
          declined,
          accepted,
          cancelled,
          events: yield* records,
          log: yield* texts,
        }
      }),
    )
    expect(seen.login.kind).toEqual({
      _tag: "Elicitation",
      server: "linear",
      message: "Log in to Linear",
      mode: "url",
      url: "https://linear.app/login",
    })
    expect(seen.declined).toEqual({ action: "decline" })
    expect(seen.accepted).toEqual({ action: "accept", content: { name: "Ada" } })
    expect(seen.cancelled).toEqual({ action: "cancel" })
    expect(seen.log.slice(0, 2)).toEqual([
      "  QUESTION: tut-1's worker asks: MCP server linear: Log in to Linear (open https://linear.app/login); answer in tutti, request r1",
      "  QUESTION: tut-1's worker: MCP server linear: Log in to Linear declined",
    ])
    expect(ofKind(seen.events, "attention")[0]).toMatchObject({
      type: "elicitation",
      tool: "linear",
      summary: "Log in to Linear",
    })
    expect(ofKind(seen.events, "attention_answered").map((e) => e.answer)).toEqual([
      "deny",
      "allow",
      undefined,
    ])
  })

  test("a permission answer doesn't fit an elicitation", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const login = yield* elicit(urlLogin)
        const exit = yield* Effect.exit(answer(login.request, { _tag: "Allow" }))
        yield* answer(login.request, { _tag: "Decline" })
        return exit
      }),
    )
    expect(failure(exit)).toBeInstanceOf(DoesNotFit)
  })
})

describe("Attention: the record", () => {
  test("requests and answers are logged and written as events, with via and after_ms", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const permission = yield* ask(
          "tut-1",
          "Bash",
          { command: "rm -rf build" },
          sdkOptions({ decisionReason: "held", defaultToNo: true }),
        )
        yield* TestClock.adjust("90 seconds")
        yield* answer(permission.request, { _tag: "Deny", reason: "not yet" }, "answer_command")
        const question = yield* ask("tut-1", "AskUserQuestion", {
          questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
        })
        yield* answer(question.request, { _tag: "Choose", answers: ["B"] })
        return {
          log: yield* texts,
          events: yield* records,
          tally: yield* attention.tally("tut-1"),
        }
      }),
    )
    expect(seen.log).toEqual([
      "  PERMISSION: tut-1's worker asks: Bash(rm -rf build) (held); answer with: tutti answer r1 allow --confirm | deny",
      "  PERMISSION: tut-1's worker: Bash(rm -rf build) denied (not yet), via tutti answer",
      "  QUESTION: tut-1's worker asks: Which? (A | B); answer with: tutti answer r2 allow --choice <option>",
      "  QUESTION: tut-1's worker: Which? answered (B)",
    ])
    const asked = ofKind(seen.events, "attention")
    expect(asked[0]).toMatchObject({
      ticket: "tut-1",
      request: "r1",
      type: "permission",
      tool: "Bash",
      summary: "rm -rf build",
      default_to_no: true,
    })
    expect(asked[1]).toMatchObject({
      request: "r2",
      type: "question",
      questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
      default_to_no: false,
    })
    const answers = ofKind(seen.events, "attention_answered")
    expect(answers[0]).toMatchObject({
      request: "r1",
      answer: "deny",
      via: "answer_command",
      after_ms: 90_000,
    })
    expect(answers[1]).toMatchObject({ request: "r2", answer: ["B"], via: "screen", after_ms: 0 })
    expect(seen.tally).toMatchObject({ permissions: 1, questions: 1, denied: 1, answered: 1 })
  })

  test("overdue gives the requests open for blockedAfter or longer", () => {
    const at = (createdAt: number) => ({ createdAt }) as AttentionRequest
    const limit = 4 * 60_000
    expect(blockedAfter).toBeDefined()
    expect(overdue([at(0), at(1), at(limit)], limit).map((r) => r.createdAt)).toEqual([0])
  })
})

describe("Attention's test layer", () => {
  test("allowAll answers as requests open", async () => {
    const results = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const canUseTool = yield* attention.request("tut-1")
        const allowed = yield* settled(canUseTool("Bash", bash, sdkOptions()))
        const chosen = yield* settled(
          canUseTool(
            "AskUserQuestion",
            { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
            sdkOptions(),
          ),
        )
        return { allowed, chosen, open: (yield* attention.current).length }
      }),
      allowAll,
    )
    expect(results.allowed).toMatchObject({
      behavior: "allow",
      decisionClassification: "user_temporary",
    })
    expect(results.chosen).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Q?": "A" } },
    })
    expect(results.open).toBe(0)
  })

  test("denyAll denies and declines", async () => {
    const results = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const canUseTool = yield* attention.request("tut-1")
        const onElicitation = yield* attention.elicitation("tut-1")
        return {
          denied: yield* settled(canUseTool("Bash", bash, sdkOptions())),
          declined: yield* Effect.promise(() =>
            onElicitation(
              { serverName: "s", message: "m" },
              { signal: new AbortController().signal, requestId: "x" },
            ),
          ),
        }
      }),
      denyAll,
    )
    expect(results.denied?.behavior).toBe("deny")
    expect(results.declined).toEqual({ action: "decline" })
  })
})

describe("Attention: reading what the worker wrote", () => {
  // Text holds what a terminal would act on rather than show: a C0 control but newline and tab,
  // DEL, a C1 control, a bidi override or isolate.
  const unsafe = (text: string): boolean =>
    [...text].some((ch) => {
      const c = ch.codePointAt(0) ?? 0
      return (
        (c < 0x20 && c !== 0x0a && c !== 0x09) ||
        (c >= 0x7f && c <= 0x9f) ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069)
      )
    })
  const text = fc.string({ unit: "binary" })

  test("summarize is one safe line, at most summaryLength characters", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), text, (input, command) => {
        for (const each of [input, { ...input, command }]) {
          const summary = summarize(each)
          expect(unsafe(summary)).toBe(false)
          expect(summary).not.toContain("\n")
          expect([...summary].length).toBeLessThanOrEqual(summaryLength)
        }
      }),
    )
  })

  test("questionsOf reads AskUserQuestion's questions, sanitised, and nothing else", () => {
    const option = fc.record({ label: text, description: text })
    const question = fc.record({
      question: text,
      header: text,
      options: fc.array(option, { minLength: 1, maxLength: 4 }),
      multiSelect: fc.boolean(),
    })
    fc.assert(
      fc.property(fc.array(question, { minLength: 1, maxLength: 4 }), (questions) => {
        const read = questionsOf({ questions }) ?? []
        expect(read).toHaveLength(questions.length)
        for (const q of read) {
          expect(unsafe(q.question)).toBe(false)
          expect(q.header ?? "").not.toMatch(/[\n\t]/)
          for (const o of q.options) expect(unsafe(o.label)).toBe(false)
        }
      }),
    )
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        const read = questionsOf(input)
        if (read !== undefined) expect(read.length).toBeGreaterThan(0)
      }),
    )
    expect(questionsOf({ questions: [] })).toBeUndefined()
    expect(questionsOf({ command: "ls" })).toBeUndefined()
  })

  test("AskUserQuestion without readable questions is asked as a permission", async () => {
    const kind = await run(
      Effect.gen(function* () {
        const { request } = yield* ask("tut-1", "AskUserQuestion", { questions: "which?" })
        yield* answer(request, { _tag: "Deny" })
        return request.kind._tag
      }),
    )
    expect(kind).toBe("Permission")
  })
})
