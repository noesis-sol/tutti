// The interview's side of the run (§ 4.10, § 5 item 3, § 7.1): New feature at the start question
// talks the feature through in the Interview view, in the command's one renderer, and the run then
// goes on as the interview ends. The view is the screen's (ui/InterviewView.tsx, mounted by the
// InterviewScreen main gives); this drives it: it starts the breakdown's session in its feature mode
// (agent/breakdown.ts's startFeature), shows the view one card's RunView (the session's state and
// its open requests) and the session's transcript, and does what the view's commands ask: an answer
// to a request goes to Attention, a message from the composer to the session, and leaving, which
// the view has asked about first (`End the interview? Nothing has been filed.`, unless the session
// filed something), ends it, as Ctrl+C's quit box does.
//
// Once the breakdown has filed the epic and its tickets and the turn has ended, the session is
// closed, the view goes, and the tree is checked as a spec's is (src/run/spec.ts's checkFiled): a
// root that isn't an epic stops the run; open tickets without files or acceptance criteria, and a
// cycle of blocks links among them, are warnings. Then `filed <epic>: N tickets, starting the run`,
// and the run goes on, scoped to the epic, as --ticket <epic> would: nothing asks. Otherwise the
// interview ends without a run, and interviewEnding says what was filed, if anything, and the exit
// code.
import {
  Clock,
  Data,
  Effect,
  Queue,
  Ref,
  Result,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { AgentHost, type MessageUuid } from "../agent/AgentHost.ts"
import { Attention, type AttentionRequest } from "../agent/Attention.ts"
import { startFeature } from "../agent/breakdown.ts"
import { type Answer, type BreakdownState, filedAny } from "../agent/breakdownTools.ts"
import { interviewWorker } from "../agent/inView.ts"
import { Transcripts } from "../agent/Transcripts.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { type Beads, beadsWhy, type TicketId } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { makeCommands, type UiCommand } from "./commands.ts"
import type { TicketFiling } from "./fileTicket.ts"
import { exitCodes } from "./holds.ts"
import { Log, line } from "./log.ts"
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
import { checkFiled } from "./spec.ts"

/** What the run hands the Interview view: a dashboard's inputs, the description, the filing. */
export interface InterviewInputs extends ScreenInputs {
  /** The description typed at the start question. */
  readonly description: string
  /** Whether the session has filed something: leaving asks first only while nothing is. */
  readonly filed: SubscriptionRef.SubscriptionRef<boolean>
  /** What leaving asks while nothing is filed, in place of the interview's question. */
  readonly leaveQuestion?: string
  /** What leaving says under its question, in place of the interview's. */
  readonly leaveAbout?: string
  /** What the view's head names the session by, in place of `Interview`: a question's talk. */
  readonly name?: string
}

/** The Interview view: shows `inputs` until the scope closes. */
export type InterviewScreen = (inputs: InterviewInputs) => Effect.Effect<void, never, Scope.Scope>

/** How the interview ended. */
export type InterviewOutcome = Data.TaggedEnum<{
  /** The epic and its tickets were filed and checked: the run goes on, scoped to the epic. */
  Run: { readonly epic: TicketId; readonly tickets: number }
  /**
   * The epic and its tickets were filed, but the run won't take them: why, and the exit code (2
   * for a tree it refuses, 4 for one bd couldn't read).
   */
  Refused: { readonly epic: TicketId; readonly why: string; readonly exitCode: number }
  /** You left the view (`quit`: by Ctrl+C's quit box); `state` says what was filed by then. */
  Left: { readonly state: BreakdownState; readonly quit: boolean }
  /** The session ended by itself, before the tree was filed. */
  Ended: { readonly why: string; readonly state: BreakdownState }
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

/** A session the Interview view shows: a feature's or a spec's breakdown, a question's talk. */
export interface InView<A> {
  /** The description typed at the start question, or what the session is for, in its header. */
  readonly description: string
  /** Whether the session has filed something (a question's talk: given its answer). */
  readonly filed: SubscriptionRef.SubscriptionRef<boolean>
  /** What leaving asks while nothing is filed, in place of the interview's question. */
  readonly leaveQuestion?: string
  /** What leaving says under its question, in place of the interview's. */
  readonly leaveAbout?: string
  /** What the view's head names the session by, in place of `Interview`. */
  readonly name?: string
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
          filed: session.filed,
          ...(session.leaveQuestion === undefined ? {} : { leaveQuestion: session.leaveQuestion }),
          ...(session.leaveAbout === undefined ? {} : { leaveAbout: session.leaveAbout }),
          ...(session.name === undefined ? {} : { name: session.name }),
        })
        return yield* session.ended
      }),
    ).pipe(Effect.onInterrupt(() => session.leave))
    return { ended, left: yield* Ref.get(left) }
  })

/** What the run says once the interview has filed the epic and its tickets. */
export const startingLine = (epic: TicketId, tickets: number): string =>
  `filed ${sanitizeLine(epic)}: ${plural(tickets, "ticket")}, starting the run`

/**
 * The interview of the feature `description` describes, shown with `io.screen`: the breakdown's
 * session in its feature mode. Once it has filed the epic and its tickets, the tree is checked, its
 * warnings said with `io.error`, and `filed <epic>: N tickets, starting the run` with `io.say`, the
 * log hearing both. How it ended.
 */
export const interview = (
  description: string,
  io: {
    readonly screen: InterviewScreen
    readonly say: (text: string) => Effect.Effect<void>
    readonly error: (text: string) => Effect.Effect<void>
  },
): Effect.Effect<
  InterviewOutcome,
  never,
  AgentHost | AppConfig | Beads | Git | Log | Attention | Transcripts
> =>
  Effect.gen(function* () {
    const started = yield* Effect.result(startFeature({ description, effort: null }))
    if (started._tag === "Failure") {
      return InterviewOutcome.NotStarted({ why: started.failure.reason })
    }
    const breakdown = started.success
    // Whether it has filed something, for the view's leaving question.
    const filed = yield* SubscriptionRef.make(false)
    yield* SubscriptionRef.changes(breakdown.state).pipe(
      Stream.runForEach((now) => SubscriptionRef.set(filed, filedAny(now))),
      Effect.forkScoped,
    )
    const { ended, left: how } = yield* inInterviewView(
      {
        description,
        filed,
        send: breakdown.send,
        leave: breakdown.leave,
        ended: breakdown.ended,
      },
      io.screen,
    )
    switch (ended._tag) {
      case "Left":
        return InterviewOutcome.Left({ state: ended.state, quit: how === "quit" })
      case "NoTree":
      case "Failed":
        return how === "no"
          ? InterviewOutcome.Ended({ why: ended.why, state: ended.state })
          : InterviewOutcome.Left({ state: ended.state, quit: how === "quit" })
      case "Filed":
        break
    }
    const log = yield* Log
    const epic = ended.root
    const checked = yield* Effect.result(
      checkFiled(epic, null, (yield* AppConfig).settings.concurrent),
    )
    if (Result.isFailure(checked)) {
      const why = `bd couldn't read the tree under it: ${beadsWhy(checked.failure)}`
      yield* log.write(line`the interview filed ${epic}, but ${why}`)
      return InterviewOutcome.Refused({ epic, why, exitCode: exitCodes.tool })
    }
    const tree = checked.success
    if (tree.refused !== null) {
      yield* log.write(line`won't run what the interview filed: ${tree.refused}`)
      return InterviewOutcome.Refused({ epic, why: tree.refused, exitCode: exitCodes.setup })
    }
    for (const warning of tree.warnings) {
      yield* io.error(`warning: ${warning}`)
      yield* log.write(line`warning: ${warning}`)
    }
    yield* io.say(startingLine(epic, tree.tickets))
    yield* log.write(line`${startingLine(epic, tree.tickets)}`)
    return InterviewOutcome.Run({ epic, tickets: tree.tickets })
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

/** What the breakdown had filed when the interview ended without a run, and the exit code. */
const filedEnding = (state: BreakdownState, nothing: InterviewEnding): InterviewEnding => {
  if (!filedAny(state) && state.answer._tag !== "Filing") return nothing
  const answer: Answer = state.answer
  const root = state.root === null ? "the epic" : sanitizeLine(state.root)
  switch (answer._tag) {
    case "Filed":
      return {
        out: [filedLine(state.root ?? ("?" as TicketId), state.tickets)],
        error: [],
        exitCode: nothing.exitCode === exitCodes.interrupted ? exitCodes.interrupted : exitCodes.ok,
      }
    case "Filing":
      return {
        out: [],
        error: [
          `tutti: the interview ended while it was filing ${root}'s tickets; check what was filed with: bd list --parent ${root}`,
        ],
        exitCode: exitCodes.tool,
      }
    case "Stopped":
      return {
        out: [],
        error: [sanitizeLine(answer.stopped.message), `tutti: nothing was run under ${root}.`],
        exitCode: exitCodes.tool,
      }
    case "None":
    case "Problem":
      return {
        out: [],
        error: [
          `tutti: the interview ended with the epic ${root} filed, but not its tickets; nothing was run. Close it with: bd close ${root}`,
        ],
        exitCode: nothing.exitCode === exitCodes.interrupted ? exitCodes.interrupted : exitCodes.ok,
      }
  }
}

/** An interview's end that runs nothing. */
export type NoRun = Exclude<InterviewOutcome, { readonly _tag: "Run" }>

/** What the run says when the interview ran nothing, and its exit code. */
export const interviewEnding = (outcome: NoRun): InterviewEnding => {
  switch (outcome._tag) {
    case "Refused": {
      const id = sanitizeLine(outcome.epic)
      return {
        out: [],
        error: [
          `tutti won't run what the interview filed under ${id}: ${sanitizeLine(outcome.why)}`,
        ],
        exitCode: outcome.exitCode,
      }
    }
    case "Left":
      return filedEnding(
        outcome.state,
        outcome.quit
          ? { out: [], error: [quitMessage], exitCode: exitCodes.interrupted }
          : { out: [], error: [leftMessage], exitCode: exitCodes.ok },
      )
    case "Ended":
      return filedEnding(outcome.state, {
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
