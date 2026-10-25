import { describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Console, Effect, Exit, Fiber, Layer, Result, Stream } from "effect"
import { Command } from "effect/cli"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { Attention, type AttentionRequest, denialMessage } from "../src/agent/Attention.ts"
import {
  type AnswerFile,
  answerFile,
  answerWords,
  attentionFolder,
  encodeFile,
  fit,
  parseAnswerFile,
  parseRequestFile,
  type RequestFile,
  refusedFile,
  requestFile,
  serve,
  toRequestFile,
  writeExclusive,
} from "../src/agent/attentionFiles.ts"
import {
  AnswerRefused,
  AnswerWaiting,
  answer,
  type Given,
  howToAnswer,
  list,
  lookEvery,
  NoSuchRequest,
  NotTaken,
  show,
  showJson,
} from "../src/answer/answer.ts"
import { CommandFailed, planServices, tuttiWith } from "../src/cli/commands.ts"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { openFibers } from "./fibers.ts"

type Env = Attention | Log | EventStream | Captured | TestClock.TestClock

const tempRepo = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-attention-files-")))

const me = process.getuid?.() ?? 0

/**
 * The poll the tests serve with, which only TestClock moves: tutti answer's look, so that one step
 * of the clock wakes both the run's scan and the command waiting for it.
 */
const poll = lookEvery

/**
 * Runs `effect` in the repo at `repo`, with the Attention test layer (every request waits for an
 * answer) over captured logs and events, and the run's side of the attention files serving it,
 * under TestClock.
 */
const run = <A, E>(
  repo: string,
  effect: Effect.Effect<A, E, Env>,
  options: { readonly uid?: number; readonly serving?: boolean } = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        if (options.serving !== false) {
          yield* serve({
            repo,
            poll,
            ...(options.uid === undefined ? {} : { uid: options.uid }),
          })
        }
        return yield* effect
      }),
    ).pipe(
      Effect.provide(
        attentionLayer().pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer(), BunFileSystem.layer)),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

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

const bashRule = (command: string): PermissionUpdate => ({
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: command }],
  behavior: "allow",
  destination: "localSettings",
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
    const canUseTool = yield* attention.request(ticket, openFibers())
    const result = canUseTool(tool, input, options)
    const open = yield* attention.open.pipe(
      Stream.filter((all) => all.length > before),
      Stream.runHead,
    )
    const all = open._tag === "Some" ? open.value : []
    return { result, request: all[all.length - 1] as AttentionRequest }
  })

const settled = (result: Promise<PermissionResult | null>) => Effect.promise(() => result)

const tenMillis = Effect.promise(() => Bun.sleep(10))

/** Looks for `check` to hold up to 500 times, doing `between` between looks. */
const waitFor = (what: string, check: () => boolean, between: Effect.Effect<void, never, Env>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      if (check()) return
      yield* between
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`))
  })

/**
 * Waits up to 5 seconds of real time for `check` to hold, looking every 10 ms: for what follows the
 * Attention streams, which no clock drives.
 */
const until = (what: string, check: () => boolean) => waitFor(what, check, tenMillis)

/**
 * Waits for `check` to hold, moving the poll on by TestClock at each look, with 10 ms of real time
 * after it: for what the run's scan of the folder does, which the poll wakes whatever the watch
 * sees.
 */
const polled = (what: string, check: () => boolean) =>
  waitFor(what, check, Effect.andThen(TestClock.adjust(poll), tenMillis))

/** The call's result, once the run's scan has taken an answer to it. */
const taken = (result: Promise<PermissionResult | null>) =>
  Effect.gen(function* () {
    let settledTo: { readonly value: PermissionResult | null } | undefined
    result.then((value) => {
      settledTo = { value }
    })
    yield* polled("the answer to be taken", () => settledTo !== undefined)
    return (settledTo as { readonly value: PermissionResult | null }).value
  })

/** Runs `effect`, which waits for the run to take an answer, moving the poll and its look on. */
const answering = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    yield* polled("tutti answer to end", () => fiber.pollUnsafe() !== undefined)
    return yield* Fiber.join(fiber)
  })

const present = (repo: string, path: string) => () => existsSync(join(repo, path))
const absent = (repo: string, path: string) => () => !existsSync(join(repo, path))

/** Writes an answer file as `tutti answer` would, without waiting for the run. */
const writeAnswer = (
  repo: string,
  id: string,
  file: Omit<AnswerFile, "v" | "request"> & { readonly request?: string },
) => Effect.orDie(writeExclusive(repo, answerFile(id), encodeFile({ v: 1, request: id, ...file })))

/** What the run said about its refusal of `id`'s answer, once it has. */
const refusal = (repo: string, id: string) =>
  Effect.gen(function* () {
    yield* polled(`${id}'s refusal`, present(repo, refusedFile(id)))
    yield* polled(`${id}'s answer to go`, absent(repo, answerFile(id)))
    return JSON.parse(readFileSync(join(repo, refusedFile(id)), "utf8")).reason as string
  })

const records = Effect.flatMap(Captured, (captured) => captured.records)

const answeredRecords = (all: ReadonlyArray<EventRecord>) =>
  all.filter(
    (r): r is Extract<EventRecord, { kind: "attention_answered" }> =>
      r.kind === "attention_answered",
  )

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

const rm = { command: "rm -rf build" }

/** The request a safety-check hold makes: defaultToNo and suppressAlwaysAllowRule. */
const held = () =>
  sdkOptions({
    defaultToNo: true,
    suppressAlwaysAllowRule: true,
    title: "Claude wants to run rm -rf build",
    decisionReason: "held by the safety check",
  })

const askQuestions = {
  questions: [
    {
      question: "Which database?",
      header: "DB",
      options: [{ label: "Postgres", description: "the usual" }, { label: "SQLite" }],
    },
    {
      question: "Which extras?",
      options: [{ label: "Cache" }, { label: "Search" }, { label: "Queue" }],
      multiSelect: true,
    },
  ],
}

describe("attention files: the request files", () => {
  test("an open request is a 0600 file in a 0700 folder, holding what answering it needs", async () => {
    const repo = tempRepo()
    const file = await run(
      repo,
      Effect.gen(function* () {
        const { request } = yield* ask("tut-1", "Bash", rm, held())
        yield* until("the request file", present(repo, requestFile(request.id)))
        const path = join(repo, requestFile(request.id))
        expect(lstatSync(path).mode & 0o777).toBe(0o600)
        expect(lstatSync(join(repo, attentionFolder)).mode & 0o777).toBe(0o700)
        return JSON.parse(readFileSync(path, "utf8"))
      }),
    )
    expect(file).toEqual({
      v: 1,
      id: "r1",
      ticket: "tut-1",
      kind: "permission",
      tool: "Bash",
      summary: "rm -rf build",
      title: "Claude wants to run rm -rf build",
      decision_reason: "held by the safety check",
      answers: ["allow", "deny"],
      default_to_no: true,
      suppress_always_allow_rule: true,
      created_at: expect.any(String),
    })
    expect(Result.isSuccess(parseRequestFile(JSON.stringify(file)))).toBe(true)
  })

  test("a question's file holds its questions and options; allow-run is offered only with rules", async () => {
    const repo = tempRepo()
    const [question, permission] = await run(
      repo,
      Effect.gen(function* () {
        const q = yield* ask("tut-1", "AskUserQuestion", askQuestions)
        const p = yield* ask(
          "tut-2",
          "Bash",
          rm,
          sdkOptions({ suggestions: [bashRule("rm -rf build")] }),
        )
        yield* until(
          "both files",
          () =>
            present(repo, requestFile(q.request.id))() &&
            present(repo, requestFile(p.request.id))(),
        )
        return [q, p].map((each) =>
          JSON.parse(readFileSync(join(repo, requestFile(each.request.id)), "utf8")),
        )
      }),
    )
    expect(question.kind).toBe("question")
    expect(question.answers).toEqual(["allow", "deny"])
    expect(question.questions).toEqual([
      {
        question: "Which database?",
        header: "DB",
        options: [{ label: "Postgres", description: "the usual" }, { label: "SQLite" }],
        multi_select: false,
      },
      {
        question: "Which extras?",
        options: [{ label: "Cache" }, { label: "Search" }, { label: "Queue" }],
        multi_select: true,
      },
    ])
    expect(permission.answers).toEqual(["allow", "allow-run", "deny"])
  })

  test("display fields are sanitised in the file", async () => {
    const repo = tempRepo()
    const file = await run(
      repo,
      Effect.gen(function* () {
        const { request } = yield* ask(
          "tut-1",
          "Bash",
          { command: "echo \u001b[31mred\u001b[0m" },
          sdkOptions({ title: "Claude wants \u001b]0;pwned\u0007to run\u202e it" }),
        )
        yield* until("the request file", present(repo, requestFile(request.id)))
        return readFileSync(join(repo, requestFile(request.id)), "utf8")
      }),
    )
    expect(file).not.toContain("\\u001b")
    expect(file).not.toContain("\u202e")
    expect(JSON.parse(file).title).toBe("Claude wants to run it")
    expect(JSON.parse(file).summary).toBe("echo red")
  })

  test("the file goes once the request is answered on screen", async () => {
    const repo = tempRepo()
    await run(
      repo,
      Effect.gen(function* () {
        const attention = yield* Attention
        const { request, result } = yield* ask("tut-1", "Bash", rm)
        yield* until("the request file", present(repo, requestFile(request.id)))
        yield* attention.answer(request.id, { _tag: "Deny" }, "screen")
        yield* settled(result)
        yield* until("the file to go", absent(repo, requestFile(request.id)))
      }),
    )
  })

  test("the file goes once the SDK withdraws the request", async () => {
    const repo = tempRepo()
    await run(
      repo,
      Effect.gen(function* () {
        const options = sdkOptions()
        const { request, result } = yield* ask("tut-1", "Bash", rm, options)
        yield* until("the request file", present(repo, requestFile(request.id)))
        options.controller.abort()
        yield* settled(result)
        yield* until("the file to go", absent(repo, requestFile(request.id)))
      }),
    )
  })

  test("what an earlier run left in the folder is cleared when the run starts", async () => {
    const repo = tempRepo()
    mkdirSync(join(repo, attentionFolder), { recursive: true })
    writeFileSync(join(repo, requestFile("old1")), "{}")
    writeFileSync(join(repo, answerFile("old1")), "{}")
    writeFileSync(join(repo, attentionFolder, "notes.txt"), "kept")
    writeFileSync(join(repo, attentionFolder, ".old1.answer.json.abc.part"), "{")
    await run(repo, Effect.void)
    expect(readdirSync(join(repo, attentionFolder))).toEqual(["notes.txt"])
  })

  test("a symbolic link for the folder is not written through", async () => {
    const repo = tempRepo()
    const elsewhere = tempRepo()
    mkdirSync(join(repo, ".tutti", "run"), { recursive: true })
    symlinkSync(elsewhere, join(repo, attentionFolder))
    const lines = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask("tut-1", "Bash", rm)
        yield* Effect.flatMap(Attention, (a) => a.answer(request.id, { _tag: "Deny" }, "screen"))
        yield* settled(result)
        return yield* texts
      }),
    )
    expect(readdirSync(elsewhere)).toEqual([])
    expect(lines.some((l) => l.startsWith("WARN: .tutti/run/attention can't be used"))).toBe(true)
  })
})

describe("attention files: answers the run takes", () => {
  test("an answer file resolves its request as one given on screen, via tutti answer", async () => {
    const repo = tempRepo()
    const { result, lines, answered } = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask("tut-1", "Bash", rm)
        yield* writeAnswer(repo, request.id, { answer: "allow" })
        const settledResult = yield* taken(result)
        yield* until("the answer file to go", absent(repo, answerFile(request.id)))
        yield* until("the request file to go", absent(repo, requestFile(request.id)))
        return {
          result: settledResult,
          lines: yield* texts,
          answered: answeredRecords(yield* records),
        }
      }),
    )
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: rm,
      decisionClassification: "user_temporary",
    })
    expect(lines).toContain(
      "  PERMISSION: tut-1's worker: Bash(rm -rf build) allowed, via tutti answer",
    )
    expect(answered).toEqual([
      expect.objectContaining({ request: "r1", answer: "allow", via: "answer_command" }),
    ])
  })

  test('a question\'s choices, a multiSelect one joined by ", ", answer it', async () => {
    const repo = tempRepo()
    const result = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask("tut-1", "AskUserQuestion", askQuestions)
        yield* writeAnswer(repo, request.id, {
          answer: "allow",
          choices: ["SQLite", "Cache, Queue"],
        })
        return yield* taken(result)
      }),
    )
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: askQuestions.questions,
        answers: { "Which database?": "SQLite", "Which extras?": "Cache, Queue" },
      },
    })
  })

  test("a deny's reason reaches the worker", async () => {
    const repo = tempRepo()
    const result = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask("tut-1", "Bash", rm)
        yield* writeAnswer(repo, request.id, { answer: "deny", reason: "build is needed" })
        return yield* taken(result)
      }),
    )
    expect(result).toEqual({
      behavior: "deny",
      message: `${denialMessage}: build is needed`,
      decisionClassification: "user_reject",
    })
  })

  test("a defaultToNo request is allowed with confirm", async () => {
    const repo = tempRepo()
    const result = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask("tut-1", "Bash", rm, held())
        yield* writeAnswer(repo, request.id, { answer: "allow", confirm: true })
        return yield* taken(result)
      }),
    )
    expect(result).toMatchObject({ behavior: "allow" })
  })
})

describe("attention files: answers the run refuses", () => {
  /** Opens a request, lets `write` answer it, and gives the refusal; the request stays open. */
  const refused = (
    write: (repo: string, request: AttentionRequest) => Effect.Effect<void>,
    options: {
      readonly uid?: number
      readonly sdk?: Parameters<CanUseTool>[2]
      readonly input?: Record<string, unknown>
      readonly tool?: string
    } = {},
  ) => {
    const repo = tempRepo()
    return run(
      repo,
      Effect.gen(function* () {
        const attention = yield* Attention
        const { request } = yield* ask(
          "tut-1",
          options.tool ?? "Bash",
          options.input ?? rm,
          options.sdk ?? sdkOptions(),
        )
        yield* write(repo, request)
        const reason = yield* refusal(repo, request.id)
        const stillOpen = (yield* attention.current).some((r) => r.id === request.id)
        return { reason, stillOpen, lines: yield* texts, repo }
      }),
      options.uid === undefined ? {} : { uid: options.uid },
    )
  }

  test("a symbolic link", async () => {
    const outside = join(tempRepo(), "answer.json")
    writeFileSync(outside, encodeFile({ v: 1, request: "r1", answer: "allow" }))
    const { reason, stillOpen, lines } = await refused((repo, request) =>
      Effect.sync(() => symlinkSync(outside, join(repo, answerFile(request.id)))),
    )
    expect(reason).toBe("it is a symbolic link")
    expect(stillOpen).toBe(true)
    expect(existsSync(outside)).toBe(true)
    expect(lines).toContain(
      "  ANSWER_REFUSED: tut-1's worker: tutti answer for request r1: it is a symbolic link",
    )
  })

  test("a file of another user (simulated: the run's user is another)", async () => {
    const { reason, stillOpen } = await refused(
      (repo, request) => writeAnswer(repo, request.id, { answer: "allow" }),
      { uid: me + 1 },
    )
    expect(reason).toBe(`it belongs to user ${me}, not the run's (${me + 1})`)
    expect(stillOpen).toBe(true)
  })

  test("an answer to a request that is no longer open", async () => {
    const repo = tempRepo()
    const reason = await run(
      repo,
      Effect.gen(function* () {
        yield* until("the folder", present(repo, attentionFolder))
        yield* writeAnswer(repo, "r9", { answer: "allow" })
        return yield* refusal(repo, "r9")
      }),
    )
    expect(reason).toBe("request r9 is no longer open")
  })

  test("an answer that doesn't fit the request's kind", async () => {
    const { reason, stillOpen } = await refused((repo, request) =>
      writeAnswer(repo, request.id, { answer: "allow", choices: ["Postgres"] }),
    )
    expect(reason).toBe("choices answer a question's allow only")
    expect(stillOpen).toBe(true)
  })

  test("allow-run on a request with no rules to keep", async () => {
    const { reason } = await refused((repo, request) =>
      writeAnswer(repo, request.id, { answer: "allow-run" }),
    )
    expect(reason).toBe("request r1 can't be answered allow-run; it takes allow, deny")
  })

  test("a choice that isn't one of the question's options", async () => {
    const { reason } = await refused(
      (repo, request) =>
        writeAnswer(repo, request.id, { answer: "allow", choices: ["MySQL", "Cache"] }),
      { tool: "AskUserQuestion", input: askQuestions },
    )
    expect(reason).toBe(
      `"MySQL" isn't an option of question 1; its options are "Postgres", "SQLite"`,
    )
  })

  test("allowing a defaultToNo request without confirm", async () => {
    const { reason, stillOpen } = await refused(
      (repo, request) => writeAnswer(repo, request.id, { answer: "allow" }),
      { sdk: held() },
    )
    expect(reason).toBe("allowing request r1 needs --confirm")
    expect(stillOpen).toBe(true)
  })

  test("a file that isn't an answer", async () => {
    const { reason } = await refused((repo, request) =>
      Effect.sync(() =>
        writeFileSync(join(repo, answerFile(request.id)), "not json", { mode: 0o600 }),
      ),
    )
    expect(reason).toStartWith("it isn't JSON")
  })

  test("an answer naming another request", async () => {
    const { reason } = await refused((repo, request) =>
      writeAnswer(repo, request.id, { answer: "deny", request: "r7" }),
    )
    expect(reason).toBe("it answers request r7, not r1")
  })
})

describe("attention files: parsing and fitting", () => {
  const permission: RequestFile = {
    v: 1,
    id: "r1",
    ticket: "tut-1",
    kind: "permission",
    tool: "Bash",
    summary: "rm -rf build",
    answers: ["allow", "deny"],
    default_to_no: true,
    suppress_always_allow_rule: true,
    created_at: "2026-10-17T10:00:00Z",
  }

  test("allowing a defaultToNo request needs confirm; denying doesn't", () => {
    const answer = (file: Partial<AnswerFile>) =>
      fit(permission, { v: 1, request: "r1", answer: "allow", ...file })
    expect(answer({})).toEqual(Result.fail("allowing request r1 needs --confirm"))
    expect(answer({ confirm: false })).toEqual(Result.fail("allowing request r1 needs --confirm"))
    expect(answer({ confirm: true })).toEqual(Result.succeed({ _tag: "Allow" }))
    expect(answer({ answer: "deny" })).toEqual(Result.succeed({ _tag: "Deny" }))
  })

  test("a reason goes with deny only, and is sanitised", () => {
    expect(
      fit(permission, { v: 1, request: "r1", answer: "allow", confirm: true, reason: "x" }),
    ).toEqual(Result.fail("a reason goes with deny only"))
    expect(fit(permission, { v: 1, request: "r1", answer: "deny", reason: "no\u001b[2J" })).toEqual(
      Result.succeed({ _tag: "Deny", reason: "no" }),
    )
  })

  const answerish = fc.record(
    {
      v: fc.oneof(fc.constant(1), fc.integer()),
      request: fc.oneof(fc.constant("r1"), fc.string()),
      answer: fc.oneof(fc.constantFrom(...answerWords), fc.string()),
      reason: fc.string(),
      choices: fc.array(
        fc.oneof(fc.constantFrom("Postgres", "SQLite", "Cache", "Cache, Queue"), fc.string()),
      ),
      confirm: fc.oneof(fc.boolean(), fc.anything()),
    },
    { requiredKeys: [] },
  )

  test("parsing any text never throws", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          answerish.map((a) => JSON.stringify(a)),
        ),
        (text) => {
          const parsed = parseAnswerFile(text)
          expect(Result.isSuccess(parsed) || typeof parsed.failure === "string").toBe(true)
          expect(() => parseRequestFile(text)).not.toThrow()
        },
      ),
    )
  })

  test("fitting any parsed answer to any kind of request never throws, and refuses what it must", () => {
    const question: RequestFile = {
      ...permission,
      kind: "question",
      default_to_no: false,
      questions: [
        {
          question: "Which database?",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
          multi_select: false,
        },
        {
          question: "Which extras?",
          options: [{ label: "Cache" }, { label: "Queue" }],
          multi_select: true,
        },
      ],
    }
    const elicitation: RequestFile = {
      ...permission,
      kind: "elicitation",
      mode: "form",
      answers: ["deny"],
      default_to_no: false,
    }
    fc.assert(
      fc.property(answerish, fc.constantFrom(permission, question, elicitation), (raw, request) => {
        const parsed = parseAnswerFile(JSON.stringify(raw))
        if (Result.isFailure(parsed)) return
        const fitted = fit(request, parsed.success)
        if (Result.isFailure(fitted)) return
        expect(parsed.success.request).toBe(request.id)
        expect(request.answers).toContain(parsed.success.answer)
        if (request.default_to_no && parsed.success.answer !== "deny")
          expect(parsed.success.confirm).toBe(true)
      }),
    )
  })
})

describe("tutti answer", () => {
  test("lists the open requests, oldest first, with how to answer each", async () => {
    const repo = tempRepo()
    const [listed, text, json] = await run(
      repo,
      Effect.gen(function* () {
        yield* ask("tut-1", "Bash", rm, held())
        yield* ask("tut-2", "AskUserQuestion", askQuestions)
        yield* until(
          "both files",
          () => present(repo, requestFile("r1"))() && present(repo, requestFile("r2"))(),
        )
        const listed = yield* list(repo)
        return [listed, show(listed), showJson(listed)] as const
      }),
    )
    expect(listed.map((r) => [r.id, r.ticket])).toEqual([
      ["r1", "tut-1"],
      ["r2", "tut-2"],
    ])
    expect(text).toContain("r1  tut-1  permission: Claude wants to run rm -rf build")
    expect(text).toContain("answer with: tutti answer r1 allow --confirm | deny")
    expect(text).toContain("r2  tut-2  question: Which database?; Which extras?")
    expect(text).toContain(
      'answer with: tutti answer r2 allow --choice "<option>" --choice "<option>" | deny',
    )
    expect(JSON.parse(json)).toEqual(listed)
  })

  test("with nothing open, says so", async () => {
    expect(show(await Effect.runPromise(list(tempRepo())))).toBe("No open requests.")
  })

  test("answers a request and reports the run took it", async () => {
    const repo = tempRepo()
    const result = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask("tut-1", "Bash", rm, held())
        yield* until("the request file", present(repo, requestFile(request.id)))
        yield* answering(answer(repo, { request: request.id, answer: "allow", confirm: true }))
        expect(existsSync(join(repo, answerFile(request.id)))).toBe(false)
        return yield* settled(result)
      }),
    )
    expect(result).toMatchObject({ behavior: "allow" })
  })

  test("refuses, before writing anything, what the run would refuse", async () => {
    const repo = tempRepo()
    const exits = await run(
      repo,
      Effect.gen(function* () {
        const { request } = yield* ask("tut-1", "Bash", rm, held())
        yield* until("the request file", present(repo, requestFile(request.id)))
        const attempt = (given: Given) => Effect.exit(answer(repo, given))
        const unconfirmed = yield* attempt({ request: request.id, answer: "allow" })
        const allowRun = yield* attempt({ request: request.id, answer: "allow-run", confirm: true })
        const missing = yield* attempt({ request: "r5", answer: "deny" })
        const badId = yield* attempt({ request: "../r1", answer: "deny" })
        expect(existsSync(join(repo, answerFile(request.id)))).toBe(false)
        return { unconfirmed, allowRun, missing, badId }
      }),
    )
    expect(failure(exits.unconfirmed)).toEqual(
      new AnswerRefused({
        request: "r1",
        reason: "allowing request r1 needs --confirm",
        byRun: false,
      }),
    )
    expect(failure(exits.allowRun)).toBeInstanceOf(AnswerRefused)
    expect(failure(exits.missing)).toEqual(new NoSuchRequest({ request: "r5" }))
    expect(failure(exits.badId)).toEqual(new NoSuchRequest({ request: "../r1" }))
  })

  test("reports a refusal by the run", async () => {
    const repo = tempRepo()
    const exit = await run(
      repo,
      Effect.gen(function* () {
        const { request } = yield* ask("tut-1", "Bash", rm)
        yield* until("the request file", present(repo, requestFile(request.id)))
        return yield* Effect.exit(answering(answer(repo, { request: request.id, answer: "deny" })))
      }),
      { uid: me + 1 },
    )
    expect(failure(exit)).toEqual(
      new AnswerRefused({
        request: "r1",
        reason: `it belongs to user ${me}, not the run's (${me + 1})`,
        byRun: true,
      }),
    )
  })

  test("withdraws its answer and says so when no run takes it", async () => {
    const repo = tempRepo()
    const exit = await run(
      repo,
      Effect.gen(function* () {
        const { request } = yield* ask("tut-1", "Bash", rm)
        // No run serves the folder: the request file is written by hand.
        mkdirSync(join(repo, attentionFolder), { recursive: true })
        writeFileSync(join(repo, requestFile(request.id)), encodeFile(toRequestFile(request)))
        return yield* Effect.exit(
          answering(
            answer(repo, { request: request.id, answer: "deny" }, { within: "300 millis" }),
          ),
        )
      }),
      { serving: false },
    )
    expect(failure(exit)).toEqual(new NotTaken({ request: "r1", seconds: 0.3 }))
    expect(existsSync(join(repo, answerFile("r1")))).toBe(false)
  })

  test("refuses to write over an answer already waiting", async () => {
    const repo = tempRepo()
    const exit = await run(
      repo,
      Effect.gen(function* () {
        const { request } = yield* ask("tut-1", "Bash", rm)
        mkdirSync(join(repo, attentionFolder), { recursive: true })
        writeFileSync(join(repo, requestFile(request.id)), encodeFile(toRequestFile(request)))
        writeFileSync(join(repo, answerFile(request.id)), "waiting")
        const exit = yield* Effect.exit(answer(repo, { request: request.id, answer: "deny" }))
        expect(readFileSync(join(repo, answerFile(request.id)), "utf8")).toBe("waiting")
        expect(readdirSync(join(repo, attentionFolder)).sort()).toEqual([
          "r1.answer.json",
          "r1.json",
        ])
        return exit
      }),
      { serving: false },
    )
    expect(failure(exit)).toEqual(new AnswerWaiting({ request: "r1" }))
  })

  test("howToAnswer offers allow-run only where the request takes it", () => {
    const base: RequestFile = {
      v: 1,
      id: "a3f9",
      ticket: "tut-1",
      kind: "permission",
      answers: ["allow", "allow-run", "deny"],
      default_to_no: false,
      suppress_always_allow_rule: false,
      created_at: "2026-10-17T10:00:00Z",
    }
    expect(howToAnswer(base)).toBe("tutti answer a3f9 allow | allow-run | deny")
    expect(howToAnswer({ ...base, answers: ["allow", "deny"], default_to_no: true })).toBe(
      "tutti answer a3f9 allow --confirm | deny",
    )
  })

  describe("on the command line", () => {
    const capturing = () => {
      const printed: Array<string> = []
      const errors: Array<string> = []
      const console: Console.Console = Object.assign(Object.create(globalThis.console), {
        log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
        error: (...args: ReadonlyArray<unknown>) => errors.push(args.join(" ")),
      })
      return { printed, errors, console }
    }

    const cli = (repo: string, args: ReadonlyArray<string>, console: Console.Console) =>
      Command.runWith(tuttiWith(Effect.succeed(repo), planServices), {
        version: "test",
        renderErrors: false,
      })(["answer", ...args]).pipe(
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
      )

    test("lists, as JSON too, and answers with --choice and --reason", async () => {
      const repo = tempRepo()
      const out = capturing()
      const { results, listed } = await run(
        repo,
        Effect.gen(function* () {
          const question = yield* ask("tut-1", "AskUserQuestion", askQuestions)
          const permission = yield* ask("tut-2", "Bash", rm)
          yield* until(
            "both files",
            () => present(repo, requestFile("r1"))() && present(repo, requestFile("r2"))(),
          )
          yield* cli(repo, ["--json"], out.console)
          const listed = JSON.parse(out.printed.join("\n"))
          yield* answering(
            cli(repo, ["r1", "allow", "--choice", "Postgres", "--choice", "Search"], out.console),
          )
          yield* answering(cli(repo, ["r2", "deny", "--reason", "not now"], out.console))
          return {
            results: [yield* settled(question.result), yield* settled(permission.result)],
            listed,
          }
        }),
      )
      expect(listed.map((r: RequestFile) => r.id)).toEqual(["r1", "r2"])
      expect(results[0]).toMatchObject({
        updatedInput: { answers: { "Which database?": "Postgres", "Which extras?": "Search" } },
      })
      expect(results[1]).toMatchObject({ behavior: "deny", message: `${denialMessage}: not now` })
      expect(out.printed.slice(1)).toEqual([
        "The run took the answer to request r1: allow.",
        "The run took the answer to request r2: deny.",
      ])
      expect(out.errors).toEqual([])
    })

    test("a defaultToNo allow without --confirm fails, saying why on stderr", async () => {
      const repo = tempRepo()
      const out = capturing()
      const exit = await run(
        repo,
        Effect.gen(function* () {
          yield* ask("tut-1", "Bash", rm, held())
          yield* until("the request file", present(repo, requestFile("r1")))
          return yield* Effect.exit(cli(repo, ["r1", "allow"], out.console))
        }),
      )
      expect(failure(exit)).toEqual(new CommandFailed({ command: "answer" }))
      expect(out.errors).toEqual([
        "tutti answer: not answered: allowing request r1 needs --confirm",
      ])
      expect(existsSync(join(repo, answerFile("r1")))).toBe(false)
    })
  })
})
