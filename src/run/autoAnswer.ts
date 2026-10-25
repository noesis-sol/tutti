// --auto-answer for question tickets (§ 2 Question, § 5.1 Asked → Working, § 8.2). With it, tutti
// answers a question a worker filed during the run with the option it recommends, rather than wait
// for the maintainer: at once, or once the question has waited --auto-answer's time with the
// machine awake (Wake.ts) and no answer from them, so one who is there answers first.
//
// The ready poll's fill calls answerQuestions before takeAnswers (asked.ts), which then resumes the
// ticket as it does any answered one. A question is answered when it blocks one of the run's Asked
// tickets, was created after the run began, gives 2 to 4 options with one recommended in its
// metadata (Beads.ts's questionOptions) and isn't maintainer_only: bd human respond records the
// recommended option, saying tutti chose it, which closes the question, and the label
// auto-answered marks it for `bd list --label auto-answered`. Any other question is left to the
// maintainer, its ASKED line (or a carried ticket's line) saying why (`leftWhy`). An answer from the
// maintainer first closes the question, and tutti doesn't answer it again.
//
// orchestra has no such option: a departure on purpose (spec § 8.2).
import { Context, Duration, Effect, Ref, Result } from "effect"
import {
  Beads,
  beadsWhy,
  HumanLabel,
  type Issue,
  maintainerOnly,
  type QuestionOption,
  questionOptions,
  type TicketId,
} from "../services/Beads.ts"
import { Notifier } from "../services/Notifier.ts"
import { awakeSince } from "../services/Wake.ts"
import type { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { type Line, type Log, line, Tag, ticketLine } from "./log.ts"
import { about } from "./notices.ts"
import { say, warn } from "./say.ts"

/** The label of a question tutti answered by --auto-answer. */
export const autoAnsweredLabel = "auto-answered"

/** A question ticket tutti answered by --auto-answer. */
export interface AnsweredQuestion {
  /** The ticket that waited on it. */
  readonly ticket: TicketId
  readonly question: TicketId
  readonly title: string
  /** The option chosen, the recommended one. */
  readonly option: string
}

/** --auto-answer in a run. */
export interface AutoAnswering {
  /** How long a question waits for the maintainer first, counted awake; Duration.zero: not at all. */
  readonly after: Duration.Duration
  /** When the run began, in epoch ms: a question created before it is left to the maintainer. */
  readonly since: number
  /** The questions answered so far, in order: for the resumed worker's message and the summary. */
  readonly answered: Ref.Ref<ReadonlyArray<AnsweredQuestion>>
  /** How many times bd couldn't answer each question; at `respondTries`, it is left to you. */
  readonly failed: Ref.Ref<ReadonlyMap<string, number>>
  /**
   * Whether the run takes work back now (holds.ts's takesBack), as the run sets it once its gate
   * is made: the ready poll answers questions only then, so one asked while the run holds or winds
   * down isn't answered at once.
   */
  readonly takesBack: Ref.Ref<Effect.Effect<boolean>>
  /**
   * The questions whose asked record said tutti answers them at once (`auto_answering`), so
   * notified nothing, not yet answered nor left to you: by question, the ticket waiting on it and
   * the question's title. One the run winds down or ends with, still open, notifies then
   * (notifyLeftOpen).
   */
  readonly atOnce: Ref.Ref<ReadonlyMap<string, TakenAtOnce>>
}

/** A question --auto-answer took at once (AutoAnswering's `atOnce`). */
export interface TakenAtOnce {
  readonly ticket: TicketId
  readonly title: string
}

/** --auto-answer, as the run gives it: null without it, outside a run too. */
export const AutoAnswer = Context.Reference<AutoAnswering | null>("tutti/run/AutoAnswer", {
  defaultValue: () => null,
})

/** --auto-answer for a run that began at `since`, its questions answered after `after`. */
export const makeAutoAnswering = (
  after: Duration.Duration,
  since: number,
): Effect.Effect<AutoAnswering> =>
  Effect.gen(function* () {
    return {
      after,
      since,
      answered: yield* Ref.make<ReadonlyArray<AnsweredQuestion>>([]),
      failed: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
      takesBack: yield* Ref.make<Effect.Effect<boolean>>(Effect.succeed(true)),
      atOnce: yield* Ref.make<ReadonlyMap<string, TakenAtOnce>>(new Map()),
    }
  })

/** How the START line and the title line's pill name --auto-answer: `auto-answer after 10m`. */
export const autoAnswerName = (after: Duration.Duration, formatted: string): string =>
  Duration.isGreaterThan(after, Duration.zero) ? `auto-answer after ${formatted}` : "auto-answer"

/** What bd human respond records as the answer: the option, and that tutti chose it. */
export const responseText = (option: string): string =>
  `${option} (the recommended option, chosen by tutti --auto-answer, not by the maintainer)`

/**
 * Why --auto-answer leaves `question` to the maintainer in a run that began at `since`, or
 * undefined when it answers it: open before the run (left open on purpose, perhaps; a creation
 * time bd doesn't give is taken for one), maintainer_only, or without well-formed options.
 */
export const leftWhy = (question: Issue, since: number): string | undefined => {
  if (!(Date.parse(question.createdAt) >= since)) return "it was open before the run"
  if (maintainerOnly(question.metadata)) return "it asks you to do something only you can"
  if (questionOptions(question.metadata) === undefined) return "it gives no options"
  return undefined
}

/** What a question's line adds for --auto-answer leaving it to the maintainer, `why`. */
export const leavesIt = (why: string): Line => line`; --auto-answer leaves it to you: ${why}`

/** What --auto-answer does with a question, for its Asked line and record. */
export interface AutoAnswerOf {
  /** The part of the line about it: why it leaves the question to you, or nothing. */
  readonly leaves: string
  /** Whether it answers the question at once, in the look that sees it: then nothing notifies. */
  readonly atOnce: boolean
}

/**
 * What --auto-answer does with `question`: why it leaves it, or nothing when it answers it or is
 * off, and whether it answers it at once (bare, not after a time, and the run taking work back). bd shows the question first, as
 * a dependency's metadata may be partial; a question it can't show is said nothing of, and
 * notifies.
 */
export const autoAnswerOf = (question: TicketId): Effect.Effect<AutoAnswerOf, never, Beads> =>
  Effect.gen(function* () {
    const auto = yield* AutoAnswer
    const none = { leaves: "", atOnce: false }
    if (auto === null) return none
    const shown = yield* Effect.result((yield* Beads).show(question))
    if (Result.isFailure(shown)) return none
    const why = leftWhy(shown.success, auto.since)
    // While the run holds or winds down, it doesn't answer it now, so it notifies.
    const now = Duration.isZero(auto.after) && (yield* Effect.flatten(Ref.get(auto.takesBack)))
    return why === undefined
      ? { leaves: "", atOnce: now }
      : { leaves: leavesIt(why), atOnce: false }
  })

/**
 * Notes `question` (`title`), which `ticket` waits on, as one --auto-answer answers at once
 * (autoAnswerOf's `atOnce`), its asked record notifying nothing: until it is answered or left to
 * you, the run's wind-down or end notifies it (notifyLeftOpen).
 */
export const takenAtOnce = (
  ticket: TicketId,
  question: TicketId,
  title: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const auto = yield* AutoAnswer
    if (auto === null) return
    yield* Ref.update(auto.atOnce, (all) => new Map(all).set(question, { ticket, title }))
  })

/** `question` answered or left to you: no longer one taken at once (takenAtOnce). */
const settled = (auto: AutoAnswering, question: string): Effect.Effect<void> =>
  Ref.update(auto.atOnce, (all) => {
    const left = new Map(all)
    left.delete(question)
    return left
  })

/**
 * Notifies `<ticket> needs your answer` for each question --auto-answer took at once (takenAtOnce)
 * and hasn't answered, still open: as the run winds down or ends, which answers none, its asked
 * record having notified nothing. Each notifies once; one closed meanwhile was answered by you,
 * and one bd can't show notifies anyway.
 */
export const notifyLeftOpen: Effect.Effect<void, never, Beads | Notifier> = Effect.gen(
  function* () {
    const auto = yield* AutoAnswer
    if (auto === null) return
    const taken = yield* Ref.getAndSet(auto.atOnce, new Map())
    if (taken.size === 0) return
    const beads = yield* Beads
    const notifier = yield* Notifier
    for (const [question, { ticket, title }] of taken) {
      const shown = yield* Effect.result(beads.show(question as TicketId))
      if (Result.isSuccess(shown) && shown.success.status === "closed") continue
      yield* notifier.notify(about(`${ticket} needs your answer`, title))
    }
  },
)

/** The part of an Asked line about --auto-answer for `question` (autoAnswerOf's `leaves`). */
export const leavesPart = (question: TicketId): Effect.Effect<string, never, Beads> =>
  Effect.map(autoAnswerOf(question), (of) => of.leaves)

/** The option tutti chose for `question` by --auto-answer this run, if it did. */
export const answeredWith = (question: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const auto = yield* AutoAnswer
    if (auto === null) return undefined
    return (yield* Ref.get(auto.answered)).find((each) => each.question === question)?.option
  })

/** The questions answered by --auto-answer this run, in order; none without it. */
export const answeredQuestions: Effect.Effect<ReadonlyArray<AnsweredQuestion>> = Effect.gen(
  function* () {
    const auto = yield* AutoAnswer
    return auto === null ? [] : yield* Ref.get(auto.answered)
  },
)

/** The open questions for the maintainer that block `issue`, as bd show links them. */
const openQuestions = (issue: Issue): ReadonlyArray<TicketId> =>
  issue.dependencies.flatMap((dependency) =>
    dependency.type === "blocks" &&
    dependency.issue !== undefined &&
    dependency.issue.status !== "closed" &&
    dependency.issue.labels.includes(HumanLabel)
      ? [dependency.id]
      : [],
  )

/**
 * How many times tutti asks bd to answer a question, a look apart, before it leaves it to you: bd
 * failing at once is mostly its database busy, and a run kept open for a bd that never answers
 * wouldn't end.
 */
export const respondTries = 3

/**
 * Answers `question`, which `ticket` waits on, with `option`: its record, line and label. Whether
 * it is answered, or is to be tried again at the next look, bd having failed to answer it.
 */
const answer = (
  auto: AutoAnswering,
  ticket: TicketId,
  question: Issue,
  option: QuestionOption,
): Effect.Effect<"answered" | "again" | "left", never, Beads | Log | EventStream | Notifier> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const { id, title } = question
    const responded = yield* Effect.result(beads.respond(id, responseText(option.label)))
    if (Result.isFailure(responded)) {
      const tries = ((yield* Ref.get(auto.failed)).get(id) ?? 0) + 1
      yield* Ref.update(auto.failed, (all) => new Map(all).set(id, tries))
      const why = beadsWhy(responded.failure)
      // Said the first time, and as it gives up.
      if (tries >= respondTries) {
        const text = ticketLine(
          Tag.autoAnswered,
        )`bd could not answer ${id} (${title}) by --auto-answer, ${respondTries} times: ${why}; it is left to you: bd human respond ${id}`
        yield* warn(text, ticket)
        // Bare, its asked record didn't notify (autoAnswerOf), so you are told now.
        if (Duration.isZero(auto.after)) {
          yield* (yield* Notifier).notify(about(`${ticket} needs your answer`, title))
        }
        yield* settled(auto, id)
        return "left"
      }
      if (tries === 1) {
        const text = ticketLine(
          Tag.autoAnswered,
        )`bd could not answer ${id} (${title}) by --auto-answer: ${why}; the next look tries again`
        yield* warn(text, ticket)
      }
      return "again"
    }
    yield* Ref.update(auto.answered, (all) => [
      ...all,
      { ticket, question: id, title, option: option.label },
    ])
    yield* settled(auto, id)
    const text = ticketLine(
      Tag.autoAnswered,
    )`${id} (${title}), which ${ticket} waits on, answered with its recommended option by --auto-answer, not by you: ${option.label}`
    yield* say({
      kind: "auto_answered",
      ticket,
      question: id,
      title,
      option: option.label,
      text,
    })
    const labelled = yield* Effect.result(beads.addLabel(id, autoAnsweredLabel))
    if (Result.isFailure(labelled)) {
      const failed = ticketLine(
        Tag.labelFailed,
      )`bd could not label ${id} ${autoAnsweredLabel}: ${beadsWhy(labelled.failure)}; label it with: bd label add ${id} ${autoAnsweredLabel}`
      yield* warn(failed, ticket)
    }
    return "answered"
  })

/**
 * Answers by --auto-answer each question it takes (`leftWhy`) that blocks one of the run's Asked
 * tickets and has waited --auto-answer's time: what the ready poll's fill does before takeAnswers.
 * Whether a question it takes still waits, for its time or for bd to answer it again, which keeps
 * the run from ending on it.
 */
export const answerQuestions: Effect.Effect<
  boolean,
  never,
  Beads | Ledger | Log | EventStream | Notifier
> = Effect.gen(function* () {
  const auto = yield* AutoAnswer
  if (auto === null) return false
  const beads = yield* Beads
  const after = Duration.toMillis(auto.after)
  let waiting = false
  for (const entry of (yield* (yield* Ledger).current).tickets.values()) {
    if (entry.phase._tag !== "Asked") continue
    const issue = yield* Effect.result(beads.show(entry.ticket))
    if (Result.isFailure(issue)) continue
    for (const id of openQuestions(issue.success)) {
      // Shown on its own for its whole metadata; one closed meanwhile was answered by you.
      const shown = yield* Effect.result(beads.show(id))
      if (Result.isFailure(shown) || shown.success.status === "closed") continue
      const question = shown.success
      const options = questionOptions(question.metadata)
      if (leftWhy(question, auto.since) !== undefined || options === undefined) continue
      const recommended = options[0]
      if (recommended === undefined) continue
      // Left to you once bd has failed to answer it `respondTries` times.
      if (((yield* Ref.get(auto.failed)).get(id) ?? 0) >= respondTries) continue
      if (after > 0 && (yield* awakeSince(Date.parse(question.createdAt))) < after) {
        waiting = true
        continue
      }
      if ((yield* answer(auto, entry.ticket, question, recommended)) === "again") waiting = true
    }
  }
  return waiting
})
