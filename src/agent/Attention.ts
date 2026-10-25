// The Attention service (§ 4.5): where a worker waits on a person. `request(ticket, fibers)` gives a
// session's canUseTool callback and `elicitation(ticket, fibers)` its onElicitation, their calls
// fibers of the session's FiberSet (callbacks.ts), which closing it interrupts. Each call becomes an
// AttentionRequest in its worker's queue, oldest first, and the callback awaits a Deferred that an
// answer, from the screen or `tutti answer`, resolves. Answers map to the SDK's results exactly as
// § 4.5's table says; a request whose signal aborts is removed, and an answer to a request that is
// no longer open is refused with NotOpen, for the caller's toast. So is one to a request of a session
// whose ticket the run's end has stopped (`refuse`): its fiber no longer watches its worker.
//
// Allow for this run passes the request's `addRules` suggestions with their destination rewritten
// to `session`, and keeps their rules for the run: a later request from any worker whose suggested
// rules are all among them is allowed without asking. `setMode` and `addDirectories` suggestions
// are never passed (one switched the session to acceptEdits in the spike), and neither are the
// suggested destinations, `localSettings` and `projectSettings`, which resolve in the worktree.
//
// With --auto-answer (Options.autoAnswer), an AskUserQuestion call is answered with each question's
// recommended option, at once or once it has waited that long with the machine awake: one waiting
// past blockedAfter holds the run with BLOCKED first, and the answer lifts the hold. A permission
// request is never answered so, the safety check's holds included.
//
// Every request and answer is a PERMISSION or QUESTION log line and an `attention` or
// `attention_answered` event, and is tallied per ticket. So is each call Claude Code denied without
// asking (`permission_denied`): a DENIED line and a `denied` event, tallied by what denied it.
import { randomBytes } from "node:crypto"
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  OnElicitation,
  PermissionResult,
  PermissionUpdate,
  SDKPermissionDeniedMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Ref,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import type { AttentionQuestion, Event } from "../run/events.ts"
import { EventStream } from "../run/eventstream.ts"
import * as log from "../run/log.ts"
import { Log } from "../run/log.ts"
import type { TicketId } from "../services/Beads.ts"
import { sleepAwake } from "../services/Wake.ts"
import { sanitize, sanitizeLine } from "../ui/sanitize.ts"
import type { AnswerWord } from "./attentionFiles.ts"
import type { SessionFibers } from "./callbacks.ts"
import { aboutOf } from "./tools.ts"

/** The tool whose calls are questions rather than permission requests. */
export const askUserQuestion = "AskUserQuestion"

/** How long a request may wait before the run holds with BLOCKED (§ 4.3). */
export const blockedAfter = Duration.minutes(4)

/** A question of AskUserQuestion's, its text sanitised for showing. */
export interface Question {
  readonly question: string
  readonly header?: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  readonly multiSelect: boolean
}

/** A tool call waiting for a person's permission. */
export interface Permission {
  readonly _tag: "Permission"
  readonly tool: string
  /** The tool's input as the worker gave it: what an allow sends back as `updatedInput`. */
  readonly input: Readonly<Record<string, unknown>>
  /** The SDK's suggestions, as they came. */
  readonly suggestions: ReadonlyArray<PermissionUpdate>
  /** A one-line summary of the input, sanitised: `rm -rf build`. */
  readonly summary: string
}

/** An AskUserQuestion call: 1 to 4 questions, each with its options. */
export interface Questions {
  readonly _tag: "Question"
  readonly questions: ReadonlyArray<Question>
  /** The questions as the worker asked them, sent back with the answers. */
  readonly input: Readonly<Record<string, unknown>>
}

/** An MCP server asking for input or a URL login. */
export interface Elicitation {
  readonly _tag: "Elicitation"
  /** The server's name, sanitised: untrusted text, per the SDK. */
  readonly server: string
  readonly message: string
  readonly mode: "form" | "url"
  readonly url?: string
  /** The form's JSON Schema. */
  readonly requestedSchema?: Readonly<Record<string, unknown>>
}

export type RequestKind = Permission | Questions | Elicitation

/** A request for a person's attention (§ 4.5). Every text field shown is sanitised (§ 7.10). */
export interface AttentionRequest {
  /** tutti's ID for it, as `tutti answer` takes it. */
  readonly id: string
  readonly ticket: TicketId
  /** The SDK's ID of the tool call; an elicitation has none. */
  readonly toolUseID?: string
  /** The subagent that asked, if one did. */
  readonly agentID?: string
  readonly kind: RequestKind
  /** "Claude wants to read foo.txt". */
  readonly title?: string
  /** The tool's name, or a short phrase for the action. */
  readonly displayName?: string
  readonly description?: string
  readonly decisionReason?: string
  readonly blockedPath?: string
  /** The MCP server serving the tool, for `mcp__*` tools. */
  readonly mcpServer?: { readonly name: string; readonly source: string }
  /** No one-key approve: the request opens on Deny. */
  readonly defaultToNo: boolean
  /** No persistent "don't ask again": no Allow for this run. */
  readonly suppressAlwaysAllowRule: boolean
  /** When it was made, in epoch milliseconds. */
  readonly createdAt: number
}

/** An answer to a request (§ 4.5). */
export type Answer =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "AllowForRun" }
  /** A denial: `byTutti` when tutti denies it itself, nobody being there (an overnight run's). */
  | { readonly _tag: "Deny"; readonly reason?: string; readonly byTutti?: true }
  /** A question's answers, one per question in order: the chosen label or the person's own text. */
  | { readonly _tag: "Choose"; readonly answers: ReadonlyArray<string> }
  /** An elicitation answered: the URL opened, or the form's content. */
  | {
      readonly _tag: "Accept"
      readonly content?: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>
    }
  | { readonly _tag: "Decline" }

/**
 * Where an answer came from (§ 10's `via`): `auto_answer` is tutti's, by --auto-answer; `overnight`
 * tutti's denial as an overnight run sets the request's ticket aside (overnightAside.ts).
 */
export type Via = "screen" | "answer_command" | "auto_answer" | "overnight"

/**
 * The answer was for a request that is no longer open: answered, withdrawn by the SDK, or of a
 * ticket the run's end has stopped (`why` says so).
 */
export class NotOpen extends Schema.TaggedError<NotOpen>()("NotOpen", {
  request: Schema.String,
  why: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return `request ${this.request} is no longer open${this.why === undefined ? "" : `: ${this.why}`}`
  }
}

/** Why an answer to a request of a ticket the run's end has stopped is refused. */
export const runEnding = "the run is ending, and its ticket has stopped"

/** The answer doesn't fit the request: an Allow for this run without rules to keep, say. */
export class DoesNotFit extends Schema.TaggedError<DoesNotFit>()("DoesNotFit", {
  request: Schema.String,
  answer: Schema.String,
}) {
  override get message(): string {
    return `request ${this.request} can't be answered ${this.answer}`
  }
}

/** A ticket's requests and their answers, for triage and the reviewer. */
export interface Tally {
  readonly permissions: number
  readonly questions: number
  readonly elicitations: number
  readonly allowed: number
  readonly allowedForRun: number
  /** Allowed without asking, by a rule allowed for this run. */
  readonly allowedByRule: number
  readonly denied: number
  /** Questions answered and elicitations accepted, by a person. */
  readonly answered: number
  /** Questions tutti answered with their recommended options, by --auto-answer. */
  readonly autoAnswered: number
  readonly declined: number
  /** Withdrawn by the SDK before an answer. */
  readonly cancelled: number
  /**
   * Calls Claude Code denied without asking, by the SDK's `decision_reason_type`: `classifier`,
   * `safetyCheck`, `mode`, `rule`, or another as given.
   */
  readonly deniedBy: Readonly<Record<string, number>>
}

/** The tallies counted one request or answer at a time. */
type Counted = Exclude<keyof Tally, "deniedBy">

export const emptyTally: Tally = {
  permissions: 0,
  questions: 0,
  elicitations: 0,
  allowed: 0,
  allowedForRun: 0,
  allowedByRule: 0,
  denied: 0,
  answered: 0,
  autoAnswered: 0,
  declined: 0,
  cancelled: 0,
  deniedBy: {},
}

/** The message a denial sends the worker, before the reason typed with it. */
export const denialMessage = "Denied by the maintainer in tutti"

/** The message of a denial tutti makes itself, in nobody's name (an overnight run's). */
export const tuttiDenialMessage = "Denied by tutti, nobody being there to answer"

/** The text an answer is described by, in a DoesNotFit and the log. */
const answerName: Record<Answer["_tag"], string> = {
  Allow: "allow",
  AllowForRun: "allow for this run",
  Deny: "deny",
  Choose: "with choices",
  Accept: "accept",
  Decline: "decline",
}

// A key for a rule, by tool name and rule content.
const ruleKey = (rule: { readonly toolName: string; readonly ruleContent?: string }): string =>
  `${rule.toolName}\0${rule.ruleContent ?? ""}`

/** The request's suggestions that allow by rule, as Allow for this run passes them: in session. */
export const runRules = (request: AttentionRequest): ReadonlyArray<PermissionUpdate> =>
  request.kind._tag === "Permission"
    ? request.kind.suggestions.flatMap((update) =>
        update.type === "addRules" && update.behavior === "allow" && update.rules.length > 0
          ? [{ ...update, rules: [...update.rules], destination: "session" as const }]
          : [],
      )
    : []

/** Whether the request offers Allow for this run: a permission with rules to keep, not suppressed. */
export const allowsForRun = (request: AttentionRequest): boolean =>
  !request.suppressAlwaysAllowRule && runRules(request).length > 0

/** The answers a request takes, as `tutti answer` spells them (its file's `answers`). */
export const answersOf = (request: AttentionRequest): ReadonlyArray<AnswerWord> => {
  switch (request.kind._tag) {
    case "Permission":
      return allowsForRun(request) ? ["allow", "allow-run", "deny"] : ["allow", "deny"]
    case "Question":
      return ["allow", "deny"]
    case "Elicitation":
      // A form's fields can't be given there: only a URL login can be accepted (§ 7.6).
      return request.kind.mode === "url" ? ["allow", "deny"] : ["deny"]
  }
}

/** Whether `answer` is one `request` can take. */
export const fits = (request: AttentionRequest, answer: Answer): boolean => {
  switch (request.kind._tag) {
    case "Permission":
      return (
        answer._tag === "Allow" ||
        answer._tag === "Deny" ||
        (answer._tag === "AllowForRun" && allowsForRun(request))
      )
    case "Question":
      return (
        answer._tag === "Deny" ||
        (answer._tag === "Choose" && answer.answers.length === request.kind.questions.length)
      )
    case "Elicitation":
      return answer._tag === "Accept" || answer._tag === "Decline"
  }
}

const deny = (reason?: string, byTutti?: true): PermissionResult => {
  const said = byTutti === true ? tuttiDenialMessage : denialMessage
  return {
    behavior: "deny",
    message: reason === undefined || reason.trim() === "" ? said : `${said}: ${reason}`,
    decisionClassification: "user_reject",
  }
}

/** What the request was withdrawn with: nobody reads it, since the SDK stopped waiting. */
const withdrawn: PermissionResult = {
  behavior: "deny",
  message: "The request was withdrawn",
}

/**
 * The SDK's result for a permission or question answered `answer` (§ 4.5's table). A request that
 * isn't one, or an answer that doesn't fit it, is a denial.
 */
export const permissionResult = (request: AttentionRequest, answer: Answer): PermissionResult => {
  const kind = request.kind
  if (kind._tag === "Elicitation" || !fits(request, answer)) return deny()
  switch (answer._tag) {
    case "Allow":
      return {
        behavior: "allow",
        updatedInput: { ...kind.input },
        decisionClassification: "user_temporary",
      }
    case "AllowForRun":
      return {
        behavior: "allow",
        updatedInput: { ...kind.input },
        updatedPermissions: [...runRules(request)],
        decisionClassification: "user_permanent",
      }
    case "Choose": {
      if (kind._tag !== "Question") return deny()
      const asked = questionTexts(kind.input)
      const answers = Object.fromEntries(
        answer.answers.map((chosen, i) => [asked[i] ?? kind.questions[i]?.question ?? "", chosen]),
      )
      return { behavior: "allow", updatedInput: { questions: kind.input.questions, answers } }
    }
    case "Deny":
      return deny(answer.reason, answer.byTutti)
    default:
      return deny()
  }
}

/** The SDK's result for an elicitation answered `answer`; anything else declines. */
export const elicitationResult = (answer: Answer): ElicitationResult =>
  answer._tag === "Accept"
    ? answer.content === undefined
      ? { action: "accept" }
      : {
          action: "accept",
          content: Object.fromEntries(
            Object.entries(answer.content).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
          ) as Record<string, string | number | boolean | Array<string>>,
        }
    : { action: "decline" }

// AskUserQuestion's input, as far as tutti reads it. Anything else in it is kept as it came.
const QuestionsInput = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.optionalKey(Schema.String),
      options: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          description: Schema.optionalKey(Schema.String),
        }),
      ),
      multiSelect: Schema.optionalKey(Schema.Boolean),
    }),
  ).check(Schema.isMinLength(1)),
})

const decodeQuestions = Schema.decodeUnknownOption(QuestionsInput)

// The question texts as the worker wrote them: the keys of the answers map.
const questionTexts = (input: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
  const decoded = decodeQuestions(input)
  return decoded._tag === "Some" ? decoded.value.questions.map((q) => q.question) : []
}

/**
 * AskUserQuestion's questions, sanitised for showing, or undefined when `input` doesn't hold any.
 * Questions and labels keep their line breaks; headers are one line.
 */
export const questionsOf = (input: unknown): ReadonlyArray<Question> | undefined => {
  const decoded = decodeQuestions(input)
  if (decoded._tag === "None") return undefined
  return decoded.value.questions.map((q) => ({
    question: sanitize(q.question),
    ...(q.header === undefined ? {} : { header: sanitizeLine(q.header) }),
    options: q.options.map((o) => ({
      label: sanitizeLine(o.label),
      ...(o.description === undefined ? {} : { description: sanitize(o.description) }),
    })),
    multiSelect: q.multiSelect ?? false,
  }))
}

/** The longest summary of a tool's input, in characters. */
export const summaryLength = 120

const clip = (text: string): string => {
  const chars = [...text]
  return chars.length <= summaryLength ? text : `${chars.slice(0, summaryLength - 1).join("")}…`
}

/**
 * A one-line summary of a call of `tool`, sanitised and at most `summaryLength` characters: what
 * the call is about (tools.ts's aboutOf), else its input as JSON.
 */
export const summarize = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  const about = aboutOf(tool, input)
  if (about !== undefined) return clip(sanitizeLine(about).trim())
  let json: string | undefined
  try {
    json = JSON.stringify(input)
  } catch {
    json = undefined
  }
  return clip(sanitizeLine(json ?? "").trim())
}

/** The request as the log names it: its title, else `Bash(rm -rf build)`. */
export const describe = (request: AttentionRequest): string => {
  const kind = request.kind
  switch (kind._tag) {
    case "Permission":
      return request.title ?? `${kind.tool}(${kind.summary})`
    case "Question":
      return kind.questions.map((q) => q.question).join("; ")
    case "Elicitation":
      return `MCP server ${kind.server}: ${kind.message}`
  }
}

/** The mark of the recommended option in an AskUserQuestion option's label. */
const recommendedMark = "(recommended)"

/**
 * The option --auto-answer chooses for each question, in order: the one whose label says
 * "(Recommended)" where exactly one does, else the first, as workers put their recommendation first.
 */
export const recommendedChoices = (questions: ReadonlyArray<Question>): ReadonlyArray<string> =>
  questions.map((q) => {
    const marked = q.options.filter((o) => o.label.toLowerCase().includes(recommendedMark))
    return (marked.length === 1 ? marked[0] : q.options[0])?.label ?? ""
  })

/** A question tutti answered by --auto-answer, for the run's summary. */
export interface AutoAnswered {
  readonly ticket: TicketId
  /** The questions, as the log names them. */
  readonly question: string
  /** The options chosen, one per question. */
  readonly answers: ReadonlyArray<string>
}

/** The requests open longer than `blockedAfter` at `now`, oldest first: what holds the run. */
export const overdue = (
  requests: ReadonlyArray<AttentionRequest>,
  now: number,
): ReadonlyArray<AttentionRequest> =>
  requests.filter((r) => now - r.createdAt >= Duration.toMillis(blockedAfter))

/** An answer the SDK no longer waits for. */
const Cancelled = { _tag: "Cancelled" } as const
type Outcome = Answer | typeof Cancelled

interface Open {
  readonly request: AttentionRequest
  readonly done: Deferred.Deferred<Outcome>
  /** The number of the callback it came through, in the order they were made. */
  readonly callback: number
}

export class Attention extends Context.Service<
  Attention,
  {
    /** The canUseTool callback for the ticket's session, its calls fibers of `fibers`. */
    request(ticket: TicketId, fibers: SessionFibers): Effect.Effect<CanUseTool>
    /** The onElicitation callback for the ticket's session, its calls fibers of `fibers`. */
    elicitation(ticket: TicketId, fibers: SessionFibers): Effect.Effect<OnElicitation>
    /** Answers the open request `request`; fails NotOpen when it is no longer open. */
    answer(request: string, answer: Answer, via: Via): Effect.Effect<void, NotOpen | DoesNotFit>
    /** The open requests, every worker's, oldest first. */
    readonly current: Effect.Effect<ReadonlyArray<AttentionRequest>>
    /** The open requests, every worker's, oldest first: now, then on each change. */
    readonly open: Stream.Stream<ReadonlyArray<AttentionRequest>>
    /** The ticket's worker's open requests, oldest first: now, then on each change. */
    openFor(ticket: TicketId): Stream.Stream<ReadonlyArray<AttentionRequest>>
    /**
     * Records a call Claude Code denied the ticket's worker without asking: its `permission_denied`,
     * and the call's input when the worker's messages gave it.
     */
    denial(
      ticket: TicketId,
      message: SDKPermissionDeniedMessage,
      input?: Readonly<Record<string, unknown>>,
    ): Effect.Effect<void>
    /** The ticket's requests and answers so far. */
    tally(ticket: TicketId): Effect.Effect<Tally>
    /** The questions answered by --auto-answer so far, in the order they were. */
    readonly autoAnswered: Effect.Effect<ReadonlyArray<AutoAnswered>>
    /**
     * Refuses every answer from now on to the requests of the ticket's sessions so far, open or yet
     * to open, with NotOpen: the run's end has stopped its fiber, and an answer would run its worker
     * on unwatched. Their requests stay open until the session closes, for the end to read. A
     * session made afterwards, the next run's, is answered as before.
     */
    refuse(ticket: TicketId): Effect.Effect<void>
  }
>()("tutti/agent/Attention") {
  /** The live service: requests wait for a person, or with `autoAnswer`, questions for tutti. */
  static readonly layer = (
    options: Pick<Options, "autoAnswer"> = {},
  ): Layer.Layer<Attention, never, Log | EventStream> =>
    Layer.effect(
      Attention,
      Effect.suspend(() => make(options)),
    )
}

/** Answers a request as it opens, or leaves it open (undefined) for a person. */
export type Policy = (request: AttentionRequest) => Answer | undefined

/** --auto-answer, for questions: how long one waits before tutti answers it. */
export interface AutoAnswerOptions {
  /** Duration.zero for at once; counted with the machine awake (Wake.ts). */
  readonly after: Duration.Duration
  /** Whether the ticket's questions are answered so; every ticket's when absent. */
  readonly answers?: (ticket: TicketId) => boolean
}

/** What `make` takes; the test layer sets the policy and the IDs. */
export interface Options {
  readonly policy?: Policy
  /** --auto-answer: questions answered with their recommended options; none when absent. */
  readonly autoAnswer?: AutoAnswerOptions
  /** Draws a request's ID; by default 8 random hex digits. */
  readonly ids?: Effect.Effect<string>
}

const randomId = Effect.sync(() => randomBytes(4).toString("hex"))

// An AbortSignal's abort, as an Effect that completes when it fires.
const aborted = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void)
    const fire = () => resume(Effect.void)
    signal.addEventListener("abort", fire, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", fire))
  })

const sanitizedOptional = <K extends string>(
  key: K,
  value: string | undefined,
  clean: (text: string) => string = sanitize,
): { readonly [P in K]?: string } =>
  (value === undefined ? {} : { [key]: clean(value) }) as { readonly [P in K]?: string }

/** The Attention service over the run's Log and EventStream. */
export const make = (
  options: Options = {},
): Effect.Effect<Attention["Service"], never, Log | EventStream> =>
  Effect.gen(function* () {
    const logs = yield* Log
    const events = yield* EventStream
    const ids = options.ids ?? randomId
    const opened = yield* SubscriptionRef.make<ReadonlyArray<Open>>([])
    const rules = yield* Ref.make<ReadonlySet<string>>(new Set())
    const tallies = yield* Ref.make<ReadonlyMap<string, Tally>>(new Map())
    const autoAnswered = yield* Ref.make<ReadonlyArray<AutoAnswered>>([])
    // The callbacks made so far, and for each ticket the run's end stopped, how many there were
    // then: the requests of those callbacks are refused.
    const made = yield* Ref.make(0)
    const refusedBelow = yield* Ref.make<ReadonlyMap<TicketId, number>>(new Map())
    // Opening a request and announcing it, answering one and withdrawing one each hold the permit,
    // so a request's answer is never recorded before the request itself.
    const one = yield* Semaphore.make(1)

    const change = (ticket: TicketId, f: (tally: Tally) => Tally) =>
      Ref.update(tallies, (all) => new Map(all).set(ticket, f(all.get(ticket) ?? emptyTally)))

    const count = (ticket: TicketId, field: Counted) =>
      change(ticket, (tally) => ({ ...tally, [field]: tally[field] + 1 }))

    const requests = (all: ReadonlyArray<Open>) => all.map((o) => o.request)

    // A fresh ID, none of the open requests' IDs.
    const freshId: Effect.Effect<string> = Effect.gen(function* () {
      const taken = new Set(requests(yield* SubscriptionRef.get(opened)).map((r) => r.id))
      for (;;) {
        const id = yield* ids
        if (!taken.has(id)) return id
      }
    })

    // Takes the request out of the open ones: the Open, or undefined when it wasn't open.
    const take = (id: string) =>
      SubscriptionRef.modify(opened, (all): [Open | undefined, ReadonlyArray<Open>] => {
        const found = all.find((o) => o.request.id === id)
        return found === undefined ? [undefined, all] : [found, all.filter((o) => o !== found)]
      })

    // Whether --auto-answer takes the request, a question of a ticket it answers.
    const autoAnswers = (request: AttentionRequest) => {
      const auto = options.autoAnswer
      return (
        auto !== undefined &&
        request.kind._tag === "Question" &&
        (auto.answers === undefined || auto.answers(request.ticket))
      )
    }
    // Whether it answers it at once: the request's record then doesn't notify (notices.ts).
    const answersAtOnce = (request: AttentionRequest) =>
      autoAnswers(request) && Duration.isZero(options.autoAnswer?.after ?? Duration.zero)

    const asked = (request: AttentionRequest) =>
      Effect.gen(function* () {
        const kind = request.kind
        const base = {
          kind: "attention" as const,
          ticket: request.ticket,
          request: request.id,
          default_to_no: request.defaultToNo,
        }
        switch (kind._tag) {
          case "Permission": {
            yield* count(request.ticket, "permissions")
            yield* logs.writeWith(
              [
                log.permission({
                  id: request.ticket,
                  requestId: request.id,
                  what: describe(request),
                  ...(request.decisionReason === undefined ? {} : { why: request.decisionReason }),
                  answers: answersOf(request),
                  defaultToNo: request.defaultToNo,
                }),
              ],
              events.emit({ ...base, type: "permission", tool: kind.tool, summary: kind.summary }),
            )
            return
          }
          case "Question": {
            yield* count(request.ticket, "questions")
            const questions: ReadonlyArray<typeof AttentionQuestion.Type> = kind.questions.map(
              (q) => ({
                question: q.question,
                ...(q.header === undefined ? {} : { header: q.header }),
                options: q.options.map((o) => ({
                  label: o.label,
                  ...(o.description === undefined ? {} : { description: o.description }),
                })),
                multi_select: q.multiSelect,
              }),
            )
            yield* logs.writeWith(
              [
                log.question({
                  id: request.ticket,
                  requestId: request.id,
                  answers: answersOf(request),
                  defaultToNo: request.defaultToNo,
                  questions: kind.questions.map((q) => ({
                    question: q.question,
                    options: q.options.map((o) => o.label),
                  })),
                }),
              ],
              events.emit({
                ...base,
                type: "question",
                questions,
                ...(answersAtOnce(request) ? { auto_answering: true as const } : {}),
              }),
            )
            return
          }
          case "Elicitation": {
            yield* count(request.ticket, "elicitations")
            yield* logs.writeWith(
              [
                log.elicitation({
                  id: request.ticket,
                  requestId: request.id,
                  answers: answersOf(request),
                  defaultToNo: request.defaultToNo,
                  server: kind.server,
                  message: kind.message,
                  ...(kind.url === undefined ? {} : { url: kind.url }),
                }),
              ],
              events.emit({
                ...base,
                type: "elicitation",
                tool: kind.server,
                summary: sanitizeLine(kind.message),
              }),
            )
            return
          }
        }
      })

    // Logs, records and tallies the answer to a request just taken out of the open ones.
    const answered = (request: AttentionRequest, outcome: Outcome, via: Via | undefined) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        // Whole: the record's field is a count, and a clock at a fraction mustn't fail it.
        const after_ms = Math.max(0, Math.round(now - request.createdAt))
        const base = {
          kind: "attention_answered" as const,
          ticket: request.ticket,
          request: request.id,
          after_ms,
        }
        const kind = request.kind._tag === "Permission" ? "permission" : "question"
        const what = describe(request)
        const viaLog =
          via === "answer_command"
            ? "tutti answer"
            : via === "auto_answer"
              ? "--auto-answer"
              : via === "overnight"
                ? "--overnight"
                : "screen"
        // The answer's line, and `record` with it.
        const line = (record: Event, verdict: log.Verdict, detail?: string) =>
          logs.writeWith(
            [
              log.answered({
                id: request.ticket,
                kind,
                what,
                verdict,
                ...(detail === undefined || detail === "" ? {} : { detail }),
                via: viaLog,
              }),
            ],
            events.emit(record),
          )
        const viaField = via === undefined ? {} : { via }
        switch (outcome._tag) {
          case "Cancelled":
            yield* count(request.ticket, "cancelled")
            yield* line({ ...base, cancelled: true }, "withdrawn")
            return
          case "Allow":
          case "Accept":
            yield* count(request.ticket, outcome._tag === "Allow" ? "allowed" : "answered")
            yield* line(
              { ...base, answer: "allow", ...viaField },
              outcome._tag === "Allow" ? "allowed" : "answered",
            )
            return
          case "AllowForRun":
            yield* count(request.ticket, "allowedForRun")
            yield* line({ ...base, answer: "allow_run", ...viaField }, "allowed for this run")
            return
          case "Deny":
            yield* count(request.ticket, "denied")
            yield* line({ ...base, answer: "deny", ...viaField }, "denied", outcome.reason)
            return
          case "Decline":
            yield* count(request.ticket, "declined")
            yield* line({ ...base, answer: "deny", ...viaField }, "declined")
            return
          case "Choose":
            yield* count(request.ticket, via === "auto_answer" ? "autoAnswered" : "answered")
            if (via === "auto_answer") {
              const auto = { ticket: request.ticket, question: what, answers: outcome.answers }
              yield* Ref.update(autoAnswered, (all) => [...all, auto])
            }
            yield* line(
              { ...base, answer: [...outcome.answers], ...viaField },
              "answered",
              outcome.answers.join(", "),
            )
            return
        }
      })

    const answer = (id: string, given: Answer, via: Via) =>
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(opened)).find((o) => o.request.id === id)
        if (entry === undefined) return yield* new NotOpen({ request: id })
        const found = entry.request
        if (entry.callback < ((yield* Ref.get(refusedBelow)).get(found.ticket) ?? 0)) {
          return yield* new NotOpen({ request: id, why: runEnding })
        }
        if (!fits(found, given)) {
          return yield* new DoesNotFit({ request: id, answer: answerName[given._tag] })
        }
        const open = yield* take(id)
        if (open === undefined) return yield* new NotOpen({ request: id })
        if (given._tag === "AllowForRun") {
          yield* Ref.update(rules, (kept) => {
            const next = new Set(kept)
            for (const update of runRules(open.request)) {
              if (update.type === "addRules")
                for (const rule of update.rules) next.add(ruleKey(rule))
            }
            return next
          })
        }
        yield* answered(open.request, given, via)
        yield* Deferred.succeed(open.done, given)
      }).pipe(one.withPermit)

    // Withdraws the request if it is still open: the SDK no longer waits for it.
    const cancel = (id: string) =>
      Effect.gen(function* () {
        const open = yield* take(id)
        if (open === undefined) return
        yield* answered(open.request, Cancelled, undefined)
        yield* Deferred.succeed(open.done, Cancelled)
      }).pipe(one.withPermit)

    // Opens the request, answers it by the policy if it has one, and waits for its outcome; an
    // abort withdraws it.
    const wait = (request: AttentionRequest, callback: number, signal: AbortSignal) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<Outcome>()
        yield* Effect.andThen(
          SubscriptionRef.update(opened, (all) => [...all, { request, done, callback }]),
          asked(request),
        ).pipe(one.withPermit)
        const policy = options.policy?.(request)
        if (policy !== undefined) yield* Effect.ignore(answer(request.id, policy, "screen"))
        const outcome = Effect.raceFirst(
          Deferred.await(done),
          Effect.andThen(aborted(signal), Effect.andThen(cancel(request.id), Deferred.await(done))),
        )
        // --auto-answer: a question's recommended options once it has waited; an answer from a
        // person first wins, and this one is refused NotOpen.
        const auto = options.autoAnswer
        const kind = request.kind
        const answering =
          auto !== undefined && autoAnswers(request) && kind._tag === "Question"
            ? Effect.raceFirst(
                outcome,
                sleepAwake(auto.after).pipe(
                  Effect.andThen(
                    Effect.ignore(
                      answer(
                        request.id,
                        { _tag: "Choose", answers: recommendedChoices(kind.questions) },
                        "auto_answer",
                      ),
                    ),
                  ),
                  Effect.andThen(Deferred.await(done)),
                ),
              )
            : outcome
        return yield* answering.pipe(Effect.onInterrupt(() => cancel(request.id)))
      })

    // Whether every rule the request suggests was allowed for this run.
    const allowedByRule = (request: AttentionRequest) =>
      Effect.map(Ref.get(rules), (kept) => {
        if (request.defaultToNo || !allowsForRun(request)) return false
        return runRules(request).every(
          (update) =>
            update.type === "addRules" && update.rules.every((rule) => kept.has(ruleKey(rule))),
        )
      })

    // A removal the safety check holds comes without defaultToNo in default mode, so tutti sets it
    // (§ 4.5). decisionReasonType isn't in the SDK's types.
    const heldBySafetyCheck = (options: Parameters<CanUseTool>[2]) =>
      (options as { readonly decisionReasonType?: unknown }).decisionReasonType === "safetyCheck"

    const display = (options: Parameters<CanUseTool>[2]) => ({
      ...sanitizedOptional("title", options.title),
      ...sanitizedOptional("displayName", options.displayName, sanitizeLine),
      ...sanitizedOptional("description", options.description),
      ...sanitizedOptional("decisionReason", options.decisionReason),
      ...sanitizedOptional("blockedPath", options.blockedPath, sanitizeLine),
      ...(options.mcpServer === undefined
        ? {}
        : {
            mcpServer: {
              name: sanitizeLine(options.mcpServer.name),
              source: sanitizeLine(options.mcpServer.source),
            },
          }),
    })

    const canUseTool = (
      ticket: TicketId,
      callback: number,
      toolName: string,
      input: Record<string, unknown>,
      sdk: Parameters<CanUseTool>[2],
    ): Effect.Effect<PermissionResult> =>
      Effect.gen(function* () {
        const questions = toolName === askUserQuestion ? questionsOf(input) : undefined
        const kind: RequestKind =
          questions === undefined
            ? {
                _tag: "Permission",
                tool: sanitizeLine(toolName),
                input,
                suggestions: sdk.suggestions ?? [],
                summary: summarize(toolName, input),
              }
            : { _tag: "Question", questions, input }
        const request: AttentionRequest = {
          id: yield* freshId,
          ticket,
          toolUseID: sdk.toolUseID,
          ...(sdk.agentID === undefined ? {} : { agentID: sdk.agentID }),
          kind,
          ...display(sdk),
          defaultToNo: sdk.defaultToNo === true || heldBySafetyCheck(sdk),
          suppressAlwaysAllowRule: sdk.suppressAlwaysAllowRule ?? false,
          createdAt: yield* Clock.currentTimeMillis,
        }
        if (yield* allowedByRule(request)) {
          yield* count(ticket, "allowedByRule")
          yield* logs.write(log.allowedByRule(ticket, describe(request)))
          return permissionResult(request, { _tag: "AllowForRun" })
        }
        const outcome = yield* wait(request, callback, sdk.signal)
        return outcome._tag === "Cancelled" ? withdrawn : permissionResult(request, outcome)
      })

    const denial = (
      ticket: TicketId,
      message: SDKPermissionDeniedMessage,
      input?: Readonly<Record<string, unknown>>,
    ) =>
      Effect.gen(function* () {
        const tool = sanitizeLine(message.tool_name)
        const by = sanitizeLine(message.decision_reason_type ?? log.unknownDenier)
        const reason = sanitizeLine(message.decision_reason ?? message.message)
        yield* change(ticket, (tally) => ({
          ...tally,
          deniedBy: {
            ...tally.deniedBy,
            [by]: (Object.hasOwn(tally.deniedBy, by) ? (tally.deniedBy[by] ?? 0) : 0) + 1,
          },
        }))
        const what = input === undefined ? tool : `${tool}(${summarize(message.tool_name, input)})`
        yield* logs.writeWith(
          [log.denied({ id: ticket, what, by, reason })],
          events.emit({ kind: "denied", ticket, tool, reason_type: by, reason }),
        )
      })

    const onElicitation = (
      ticket: TicketId,
      callback: number,
      sdk: ElicitationRequest,
      signal: AbortSignal,
    ): Effect.Effect<ElicitationResult> =>
      Effect.gen(function* () {
        const request: AttentionRequest = {
          id: yield* freshId,
          ticket,
          kind: {
            _tag: "Elicitation",
            server: sanitizeLine(sdk.serverName),
            message: sanitize(sdk.message),
            mode: sdk.mode ?? (sdk.url === undefined ? "form" : "url"),
            ...(sdk.url === undefined ? {} : { url: sanitizeLine(sdk.url) }),
            ...(sdk.requestedSchema === undefined ? {} : { requestedSchema: sdk.requestedSchema }),
          },
          ...sanitizedOptional("title", sdk.title),
          ...sanitizedOptional("displayName", sdk.displayName, sanitizeLine),
          ...sanitizedOptional("description", sdk.description),
          defaultToNo: false,
          suppressAlwaysAllowRule: true,
          createdAt: yield* Clock.currentTimeMillis,
        }
        const outcome = yield* wait(request, callback, signal)
        return outcome._tag === "Cancelled" ? { action: "cancel" } : elicitationResult(outcome)
      })

    return Attention.of({
      request: (ticket, fibers) =>
        Effect.gen(function* () {
          const run = yield* FiberSet.runtimePromise(fibers)()
          const callback = yield* Ref.getAndUpdate(made, (n) => n + 1)
          return (toolName, input, sdk) => run(canUseTool(ticket, callback, toolName, input, sdk))
        }),
      elicitation: (ticket, fibers) =>
        Effect.gen(function* () {
          const run = yield* FiberSet.runtimePromise(fibers)()
          const callback = yield* Ref.getAndUpdate(made, (n) => n + 1)
          return (request, sdk) => run(onElicitation(ticket, callback, request, sdk.signal))
        }),
      answer,
      current: Effect.map(SubscriptionRef.get(opened), requests),
      open: Stream.map(SubscriptionRef.changes(opened), requests),
      openFor: (ticket) =>
        SubscriptionRef.changes(opened).pipe(
          Stream.map((all) => requests(all).filter((r) => r.ticket === ticket)),
          Stream.changesWith(
            (a, b) => a.length === b.length && a.every((r, i) => r.id === b[i]?.id),
          ),
        ),
      denial,
      tally: (ticket) => Effect.map(Ref.get(tallies), (all) => all.get(ticket) ?? emptyTally),
      autoAnswered: Ref.get(autoAnswered),
      // Under the permit, so that an answer under way is recorded before it, and none after it.
      refuse: (ticket) =>
        Effect.gen(function* () {
          const below = yield* Ref.get(made)
          yield* Ref.update(refusedBelow, (all) => new Map(all).set(ticket, below))
        }).pipe(one.withPermit),
    })
  })
