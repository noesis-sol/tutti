// The interview's side of the run (§ 4.10, § 5 item 3, § 7.1): New feature at the start question
// talks the feature through in the Interview view, in the command's one renderer, and the run then
// goes on as the interview ends. The view is the screen's (ui/InterviewView.tsx, mounted by the
// InterviewScreen main gives); this drives it: it starts the session (agent/interview.ts), shows
// the view one card's RunView (the session's state and its open requests) and the session's
// transcript, and does what the view's commands ask: an answer to a request goes to Attention, a
// message from the composer to the session, and leaving, which the view has asked about first
// (`End the interview? Nothing has been filed.`, unless file_feature filed something), ends it, as
// Ctrl+C's quit box does.
//
// Once file_feature has filed the epic and the turn has ended, the session is closed, the view goes,
// and the plan confirmation asks `Start the run on <epic> (N tickets)? [y/N]`: y runs the epic, as
// --ticket <epic> would; n, or Esc, leaves it filed and says how to run it. Otherwise the interview
// ends without a run, and interviewEnding says what was filed, if anything, and the exit code.
import { Clock, Data, Effect, Queue, Ref, type Scope, Stream, SubscriptionRef } from "effect"
import { AgentHost, type MessageUuid } from "../agent/AgentHost.ts"
import { Attention, type AttentionRequest } from "../agent/Attention.ts"
import { filedPlan, interviewWorker, startInterview } from "../agent/interview.ts"
import type { Filing } from "../agent/interviewTools.ts"
import { Transcripts } from "../agent/Transcripts.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import type { AppConfig } from "../cli/AppConfig.ts"
import { filingFailedLines } from "../project/planFile.ts"
import type { Beads, TicketId } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import { FormCancelled, type Plan } from "../ui/questions.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { makeCommands, type UiCommand } from "./commands.ts"
import type { TicketFiling } from "./fileTicket.ts"
import { exitCodes } from "./holds.ts"
import { TicketPhase } from "./phase.ts"
import type { QuestionNews } from "./questionNews.ts"
import {
  type Card,
  emptyView,
  type RunView,
  shownRequest,
  stateStatus,
  statusTone,
} from "./runView.ts"
import { Screen, type ScreenInputs } from "./screen.ts"

/** What the run hands the Interview view: a dashboard's inputs, the description, the filing. */
export interface InterviewInputs extends ScreenInputs {
  /** The description typed at the start question. */
  readonly description: string
  /** What file_feature has filed: leaving asks first only while nothing is. */
  readonly filing: SubscriptionRef.SubscriptionRef<Filing>
  /** Whether something is filed, where `filing` doesn't say: a spec's refinement. */
  readonly filed?: SubscriptionRef.SubscriptionRef<boolean>
  /** What leaving asks while nothing is filed, in place of the interview's question. */
  readonly leaveQuestion?: string
}

/** The Interview view: shows `inputs` until the scope closes. */
export type InterviewScreen = (inputs: InterviewInputs) => Effect.Effect<void, never, Scope.Scope>

/** How the interview ended. */
export type InterviewOutcome = Data.TaggedEnum<{
  /** The epic was filed and you said y: the run goes on, scoped to it. */
  Run: { readonly epic: TicketId; readonly tickets: number }
  /** The epic was filed and you said n, or Esc: it stays filed, and nothing runs. */
  Declined: { readonly epic: TicketId; readonly tickets: number }
  /** You left the view (`quit`: by Ctrl+C's quit box); `filing` says what was filed by then. */
  Left: { readonly filing: Filing; readonly quit: boolean }
  /** The session ended by itself, before the epic was filed. */
  Ended: { readonly why: string; readonly filing: Filing }
  /** The session couldn't start. */
  NotStarted: { readonly why: string }
}>

export const InterviewOutcome = Data.taggedEnum<InterviewOutcome>()

/**
 * What the interview's card says of its session at `now`: `your turn` while it waits for your
 * answer.
 */
export const interviewStatus = (
  state: WorkerState | null,
  requests: Card["requests"],
  now?: number,
): string => {
  if (requests.length === 0 && state === null) return "starting"
  if (requests.length === 0 && state?._tag === "Idle") return "your turn"
  return stateStatus(state ?? undefined, requests, "working", now)
}

/** The interview's one card at `now`: its session's state and open requests, since `since`. */
export const interviewCard = (
  description: string,
  since: number,
  state: WorkerState | null,
  open: ReadonlyArray<AttentionRequest>,
  now?: number,
): Card => {
  const requests = open.map(shownRequest)
  const phase = TicketPhase.Working()
  return {
    ticket: interviewWorker,
    label: interviewWorker,
    title: description.split("\n").find((line) => line.trim() !== "") ?? "",
    worker: 1,
    phase,
    state,
    status: interviewStatus(state, requests, now),
    tone: statusTone(phase, state, requests, "working"),
    motion:
      state === null ||
      state._tag === "Starting" ||
      state._tag === "Working" ||
      state._tag === "Retrying"
        ? "spinner"
        : "idle",
    since,
    action: null,
    latest: null,
    steered: false,
    requests,
  }
}

/** The RunView the Interview view reads: the interview's card, and its open requests. */
export const interviewView = (card: Card): RunView => ({
  ...emptyView,
  cards: [card],
  requests: card.requests,
})

/** How the Interview view was left: not at all, by Esc or ← Back, or by Ctrl+C's quit box. */
export type Left = "no" | "left" | "quit"

/** A session the Interview view shows: the feature interview's, or a spec's refinement. */
export interface InView<A> {
  /** The description typed at the start question, or what the session is for, in its header. */
  readonly description: string
  /** What file_feature has filed (an interview's), or nothing (a refinement's). */
  readonly filing: SubscriptionRef.SubscriptionRef<Filing>
  /** Whether the session has filed something, where `filing` doesn't say. */
  readonly filed?: SubscriptionRef.SubscriptionRef<boolean>
  /** What leaving asks while nothing is filed, in place of the interview's question. */
  readonly leaveQuestion?: string
  readonly send: (text: string, uuid?: MessageUuid) => Effect.Effect<unknown, unknown>
  /** Closes the session. */
  readonly leave: Effect.Effect<void>
  /** The session's end. */
  readonly ended: Effect.Effect<A>
}

/**
 * Shows `session`, the interview worker's, in the Interview view with `screen` until it ends: its
 * card, its open requests and its transcript, the view's commands done as they come. Its end, and
 * how the view was left.
 */
export const inInterviewView = <A>(
  session: InView<A>,
  screen: InterviewScreen,
): Effect.Effect<
  { readonly ended: A; readonly left: Left },
  never,
  AgentHost | Attention | Transcripts
> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const attention = yield* Attention
    const transcripts = yield* Transcripts
    const { description } = session
    // Whether you left the view, and how.
    const left = yield* Ref.make<Left>("no")

    const ended = yield* Effect.scoped(
      Effect.gen(function* () {
        const since = yield* Clock.currentTimeMillis
        const now = {
          state: null as WorkerState | null,
          requests: [] as ReadonlyArray<AttentionRequest>,
        }
        const view = yield* SubscriptionRef.make(
          interviewView(interviewCard(description, since, null, [])),
        )
        const redraw = Effect.flatMap(Clock.currentTimeMillis, (at) =>
          SubscriptionRef.set(
            view,
            interviewView(interviewCard(description, since, now.state, now.requests, at)),
          ),
        )
        yield* host.state(interviewWorker).pipe(
          Stream.runForEach((state) =>
            Effect.andThen(
              Effect.sync(() => {
                now.state = state
              }),
              redraw,
            ),
          ),
          Effect.ignore,
          Effect.forkScoped,
        )
        yield* attention.openFor(interviewWorker).pipe(
          Stream.runForEach((requests) =>
            Effect.andThen(
              Effect.sync(() => {
                now.requests = requests
              }),
              redraw,
            ),
          ),
          Effect.forkScoped,
        )

        const leave = (how: "left" | "quit") => Effect.andThen(Ref.set(left, how), session.leave)
        const handle = (command: UiCommand): Effect.Effect<void> => {
          switch (command._tag) {
            case "Answer":
              return Effect.ignore(attention.answer(command.requestId, command.answer, "screen"))
            case "SendMessage":
              return Effect.ignore(session.send(command.text, command.uuid))
            case "CloseWorker":
              return leave("left")
            case "Quit":
            case "Drain":
              return leave("quit")
            default:
              return Effect.void
          }
        }
        const commands = yield* makeCommands
        yield* Queue.take(commands).pipe(Effect.flatMap(handle), Effect.forever, Effect.forkScoped)
        yield* screen({
          view,
          screen: yield* SubscriptionRef.make<Screen>(Screen.Interview()),
          commands,
          transcripts,
          handBacks: yield* SubscriptionRef.make<ReadonlyArray<string>>([]),
          filings: yield* SubscriptionRef.make<ReadonlyArray<TicketFiling>>([]),
          questions: yield* SubscriptionRef.make<ReadonlyArray<QuestionNews>>([]),
          description,
          filing: session.filing,
          ...(session.filed === undefined ? {} : { filed: session.filed }),
          ...(session.leaveQuestion === undefined ? {} : { leaveQuestion: session.leaveQuestion }),
        })
        return yield* session.ended
      }),
    ).pipe(Effect.onInterrupt(() => session.leave))
    return { ended, left: yield* Ref.get(left) }
  })

/**
 * The interview of the feature `description` describes, shown with `io.screen`; once the epic is
 * filed, `io.confirm` asks whether to run it. How it ended; fails as the confirmation does when it
 * fails other than by being cancelled.
 */
export const interview = <E>(
  description: string,
  io: {
    readonly screen: InterviewScreen
    readonly confirm: (plan: Plan, question: string) => Effect.Effect<boolean, FormCancelled | E>
  },
): Effect.Effect<
  InterviewOutcome,
  Exclude<E, FormCancelled>,
  AgentHost | AppConfig | Beads | Git | Attention | Transcripts
> =>
  Effect.gen(function* () {
    const started = yield* Effect.result(startInterview(description))
    if (started._tag === "Failure") {
      return InterviewOutcome.NotStarted({ why: started.failure.reason })
    }
    const session = started.success
    const { ended, left: how } = yield* inInterviewView(
      {
        description,
        filing: session.filing,
        send: session.send,
        leave: session.leave,
        ended: session.ended,
      },
      io.screen,
    )

    if (ended._tag === "Filed") {
      const confirmed = yield* Effect.result(io.confirm(ended.plan, ended.question))
      const filed = { epic: ended.epic, tickets: ended.tickets }
      if (confirmed._tag === "Failure") {
        if (confirmed.failure instanceof FormCancelled) return InterviewOutcome.Declined(filed)
        return yield* Effect.fail(confirmed.failure as Exclude<E, FormCancelled>)
      }
      return confirmed.success ? InterviewOutcome.Run(filed) : InterviewOutcome.Declined(filed)
    }
    return how === "no"
      ? InterviewOutcome.Ended({ why: ended.why, filing: ended.filing })
      : InterviewOutcome.Left({ filing: ended.filing, quit: how === "quit" })
  }).pipe(
    // The interview's scope, which its tools' calls end with.
    Effect.scoped,
  )

/** What an interview that ran nothing says, on stdout and stderr, and the exit code it ends with. */
export interface InterviewEnding {
  readonly out: ReadonlyArray<string>
  readonly error: ReadonlyArray<string>
  readonly exitCode: number
}

const plural = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`)

/** The epic filed, and how to run it. */
export const filedLine = (epic: TicketId, tickets: number): string => {
  const id = sanitizeLine(epic)
  return `Filed epic ${id} with ${plural(tickets, "ticket")}; nothing was run. Run it with: tutti --ticket ${id}`
}

/** What file_feature had filed when the interview ended without a run, and the exit code. */
const filingEnding = (filing: Filing, nothing: InterviewEnding): InterviewEnding => {
  switch (filing._tag) {
    case "None":
      return nothing
    case "Filing":
      return {
        out: [],
        error: [
          "tutti: the interview ended while it was filing the feature; check what was filed with: bd list --type epic",
        ],
        exitCode: exitCodes.tool,
      }
    case "Filed": {
      const plan = filedPlan(filing.plan, filing.filed)
      return {
        out: [filedLine(filing.filed.epic, plan.tickets.length)],
        error: [],
        exitCode: nothing.exitCode === exitCodes.interrupted ? exitCodes.interrupted : exitCodes.ok,
      }
    }
    case "Stopped":
      return {
        out: [],
        error: filingFailedLines(filing.failed).map(sanitizeLine),
        exitCode: exitCodes.tool,
      }
  }
}

/** An interview's end that runs nothing. */
export type NoRun = Exclude<InterviewOutcome, { readonly _tag: "Run" }>

/** What the run says when the interview ran nothing, and its exit code. */
export const interviewEnding = (outcome: NoRun): InterviewEnding => {
  switch (outcome._tag) {
    case "Declined":
      return { out: [filedLine(outcome.epic, outcome.tickets)], error: [], exitCode: exitCodes.ok }
    case "Left":
      return filingEnding(
        outcome.filing,
        outcome.quit
          ? { out: [], error: [quitMessage], exitCode: exitCodes.interrupted }
          : { out: [], error: [leftMessage], exitCode: exitCodes.ok },
      )
    case "Ended":
      return filingEnding(outcome.filing, {
        out: [],
        error: [
          `tutti: the interview's session ended: ${sanitizeLine(outcome.why)}; nothing was filed.`,
        ],
        exitCode: exitCodes.tool,
      })
    case "NotStarted":
      return {
        out: [],
        error: [
          `tutti: the interview couldn't start: ${sanitizeLine(outcome.why)}; nothing was filed.`,
        ],
        exitCode: exitCodes.tool,
      }
  }
}

/** What the run says once you left the interview with nothing filed. */
export const leftMessage = "tutti: the interview ended; nothing was filed."

/** What the run says once Ctrl+C's quit box ended the interview with nothing filed. */
export const quitMessage = "tutti: stopped before the run started; nothing was filed."
