// The playbook in the run (§ 5 item 13, tutti-5fs7.3; run/playbook.ts has its rules):
//
// - As a ticket is dispatched (`choose`), its worker is given the active lessons in its scope, in its
//   holdout's arm. What it was given stays for the run, however often it starts again, and a resume
//   of its session is given it too (`lessonsKey`), as a session's recorded system prompt is not to
//   be counted on; the dispatch record says it, and the ticket's metadata has the version and the
//   lessons.
// - As a ticket ends merged, closed or set aside, its scorecard is counted for each lesson of its
//   choosing, and those it judges are retired: a `lesson_measure` record and a line in the log. The
//   scorecards themselves say which ended (`catchUp`): the ledger tells it soon after each end
//   (`ended`, as the auditor's), and each look of the run asks (`pending`), so that no end can slip
//   past the run's last look, its count and the reflection it calls for lost with it.
// - Every `playbook.reflect_every` such ends, or at `clusterFailures` not clean since the last
//   reflection, the reflector (organs/reflector.ts) reads the scorecards and the worst and the best
//   of those tickets, one reflection at a time, in the run's scope, so that no ticket waits for a
//   model. Each lesson it proposes goes through the gate: a `reflection` record and a line in the log.
//   The run doesn't end while one waits (`pending`), and a quit interrupts it.
//
// The file is read afresh for each, so `tutti playbook` acts on a run under way. Anything wrong with
// it, PLAYBOOK_FAILED, in the log and a `warn` record, leaves workers without lessons and the run going.
// A reflection that fails is REFLECT_FAILED, and changes nothing; one skipped for the usage limit is
// logged by Organs already. A run without organs injects and measures, and doesn't reflect;
// playbook.enabled false does none of it.
import {
  Cause,
  Clock,
  Effect,
  FiberSet,
  FileSystem,
  Option,
  Queue,
  Ref,
  Result,
  type Scope,
  Semaphore,
} from "effect"
import { Transcripts } from "../agent/Transcripts.ts"
import { AppConfig } from "../core/AppConfig.ts"
import { timestamp } from "../core/localTime.ts"
import { causeWhy, detail, type Line, type Log, line, Tag } from "../core/log.ts"
import { footprintText, transcriptText } from "../organs/auditor.ts"
import { type OrganError, Organs } from "../organs/Organs.ts"
import {
  excerptCharacters,
  excerptHeadCharacters,
  lessonsOf,
  reflect,
  type TicketEvidence,
} from "../organs/reflector.ts"
import { ticketText } from "../organs/ticketText.ts"
import { Beads, beadsWhy, type Issue, type TicketId } from "../services/Beads.ts"
import { EventStream } from "../services/EventStream.ts"
import type { DispatchPlaybook, Event, reflectionTriggers } from "../services/events.ts"
import { Git } from "../services/Git.ts"
import { ranked, type Score, type Scoring, scorecardsEvidence } from "../services/scorecard.ts"
import { ensurePlaybookExcluded } from "../services/Worktrees.ts"
import { allItems, type Ended } from "./auditor.ts"
import { RunFibers } from "./fibers.ts"
import type { Footprint } from "./footprint.ts"
import { isGlob } from "./glob.ts"
import {
  addLesson,
  type Candidate,
  type Chosen,
  changePlaybook,
  chosenFor,
  cleanScore,
  dispatchOf,
  effectOf,
  gate,
  judgedOutcome,
  judgement,
  type Lesson,
  lessonsSection,
  measured,
  playbookReport,
  readPlaybook,
  retireLesson,
  versionOf,
} from "./playbook.ts"
import { sayer } from "./say.ts"

const FileSystemService = FileSystem.FileSystem

export type Trigger = (typeof reflectionTriggers)[number]
type Reflected = Extract<Event, { readonly kind: "reflection" }>["lessons"][number]
type MeasuredLesson = Extract<Event, { readonly kind: "lesson_measure" }>["lessons"][number]

export interface RunPlaybook {
  /** What `issue`, of `footprint`, gets of the playbook; undefined with none in its scope. */
  choose(
    issue: Issue,
    footprint?: Footprint,
  ): Effect.Effect<typeof DispatchPlaybook.Type | undefined>
  /** The section of `ticket`'s worker's standing rules that holds its lessons; empty with none. */
  section(ticket: TicketId): Effect.Effect<string>
  /** A ticket's part in the run ended: the scorecards not yet counted are, as `pending` does. */
  ended(end: Ended): Effect.Effect<void>
  /** The scorecards not yet counted are, then: the reflection under way, and those queued. */
  readonly pending: Effect.Effect<number>
  /** Aborts the reflection under way and starts no more, as quitting does (quit.ts). */
  readonly interrupt: Effect.Effect<void>
  /** The scorecards not yet counted are, then: the report's Playbook section. */
  readonly report: Effect.Effect<string>
}

/** The playbook turned off. */
export const off: RunPlaybook = {
  choose: () => Effect.succeed(undefined),
  section: () => Effect.succeed(""),
  ended: () => Effect.void,
  pending: Effect.succeed(0),
  interrupt: Effect.void,
  report: Effect.succeed(""),
}

/** How many tickets not clean, since the last reflection, make a cluster of failures. */
export const clusterFailures = 3

/** How many of the worst and of the best tickets the reflector reads closely. */
export const readClosely = { worst: 2, best: 1 }

/** What calls for a reflection after `since`, the judged ends since the last one; none for none. */
export const triggerOf = (since: ReadonlyArray<Score>, every: number): Trigger | undefined =>
  every > 0 && since.length >= every
    ? "every"
    : since.filter((score) => !cleanScore(score)).length >= clusterFailures
      ? "failures"
      : undefined

/** The tickets of `scores` the reflector reads closely: the worst few, then the best. */
export const closely = (
  scores: ReadonlyArray<Score>,
): ReadonlyArray<{ readonly ticket: string; readonly standing: "worst" | "best" }> => {
  const all = ranked(scores).map(({ score }) => score.ticket)
  const worst = all.slice(0, readClosely.worst)
  const best = all.slice(worst.length).slice(-readClosely.best)
  return [
    ...worst.map((ticket) => ({ ticket, standing: "worst" as const })),
    ...best.map((ticket) => ({ ticket, standing: "best" as const })),
  ]
}

/** The footprint of `issue` where the run read none: the files its metadata lists or predicts. */
export const namedFootprint = (
  issue: Pick<Issue, "files" | "predictedFiles">,
): Pick<Footprint, "files" | "globs"> => {
  const named = [...issue.files, ...issue.predictedFiles]
  return { files: named.filter((name) => !isGlob(name)), globs: named.filter(isGlob) }
}

/** The gate's way through `candidates`, in turn, each against the pool as the last left it. */
export const admit = (
  lessons: ReadonlyArray<Lesson>,
  candidates: ReadonlyArray<Candidate>,
  context: {
    readonly known: (ticket: string, event: string) => boolean
    readonly transcripts: ReadonlyArray<string>
    readonly cap: number
    readonly at: string
  },
): { readonly lessons: ReadonlyArray<Lesson>; readonly result: ReadonlyArray<Reflected> } => {
  let pool = lessons
  const result = candidates.map((candidate): Reflected => {
    const said = {
      text: candidate.text,
      kind: candidate.kind,
      scope: candidate.scope,
      evidence: candidate.evidence,
    }
    const refused = gate(candidate, { ...context, lessons: pool })
    if (refused !== undefined) return { ...said, refused }
    const added = addLesson(pool, candidate, context.cap, context.at)
    if (added === undefined) return { ...said, refused: "capped" }
    pool = added.lessons
    return {
      ...said,
      id: added.lesson.id,
      state: added.lesson.state === "active" ? "active" : "proposed",
      ...(added.displaced === undefined ? {} : { displaced: added.displaced }),
    }
  })
  return { lessons: pool, result }
}

/**
 * `lessons` with `ticket`'s scorecard counted for those of `chosen` still active, and those it
 * judges retired; the same `lessons` when it counts for none.
 */
export const measure = (
  lessons: ReadonlyArray<Lesson>,
  chosen: Pick<Chosen, "lessons" | "held">,
  ticket: string,
  clean: boolean,
  uses: number,
): { readonly lessons: ReadonlyArray<Lesson>; readonly result: ReadonlyArray<MeasuredLesson> } => {
  const shown = new Set(chosen.lessons.map((lesson) => lesson.id))
  const held = new Set(chosen.held.map((lesson) => lesson.id))
  const applies = (lesson: Lesson) =>
    lesson.state === "active" &&
    (shown.has(lesson.id) || held.has(lesson.id)) &&
    !lesson.measured.includes(ticket)
  if (!lessons.some(applies)) return { lessons, result: [] }
  let pool = lessons.map((lesson) =>
    applies(lesson) ? measured(lesson, ticket, shown.has(lesson.id), clean) : lesson,
  )
  const result = lessons.filter(applies).map((before): MeasuredLesson => {
    const lesson = pool.find((each) => each.id === before.id) ?? before
    const retired = judgement(lesson, uses)
    if (retired !== undefined) pool = [...retireLesson(pool, lesson.id, retired)]
    const found = effectOf(lesson)
    return {
      id: lesson.id,
      shown: shown.has(lesson.id),
      helpful: lesson.helpful,
      harmful: lesson.harmful,
      held_clean: lesson.held_clean,
      held_bad: lesson.held_bad,
      ...(found === undefined ? {} : { effect: found.effect, p: found.p }),
      ...(retired === undefined ? {} : { retired }),
    }
  })
  return { lessons: pool, result }
}

/** `  lessons for <id>: clean; shown L1; held back L2; retired L3 (no_effect)`. */
export const measureLine = (
  id: string,
  clean: boolean,
  lessons: ReadonlyArray<MeasuredLesson>,
): Line => {
  const named = (list: ReadonlyArray<MeasuredLesson>) => list.map((each) => each.id).join(", ")
  const shown = lessons.filter((each) => each.shown)
  const held = lessons.filter((each) => !each.shown)
  const retired = lessons.flatMap((each) =>
    each.retired === undefined ? [] : [`${each.id} (${each.retired})`],
  )
  const parts = [
    clean ? "clean" : "not clean",
    ...(shown.length === 0 ? [] : [`shown ${named(shown)}`]),
    ...(held.length === 0 ? [] : [`held back ${named(held)}`]),
    ...(retired.length === 0 ? [] : [`retired ${retired.join(", ")}`]),
  ]
  return detail`lessons for ${id}: ${parts.join("; ")}`
}

/** `  reflection: 3 lessons; active L1; proposed L2; refused 1 duplicate`. */
export const reflectionLine = (lessons: ReadonlyArray<Reflected>): Line => {
  const ids = (state: "active" | "proposed") =>
    lessons.flatMap((each) => (each.state === state && each.id !== undefined ? [each.id] : []))
  const refused = new Map<string, number>()
  for (const each of lessons) {
    if (each.refused !== undefined) refused.set(each.refused, (refused.get(each.refused) ?? 0) + 1)
  }
  const parts = [
    lessons.length === 1 ? "1 lesson" : `${lessons.length} lessons`,
    ...(ids("active").length === 0 ? [] : [`active ${ids("active").join(", ")}`]),
    ...(ids("proposed").length === 0 ? [] : [`proposed ${ids("proposed").join(", ")}`]),
    ...(refused.size === 0
      ? []
      : [`refused ${[...refused].map(([why, n]) => `${n} ${why}`).join(", ")}`]),
  ]
  return detail`reflection: ${parts.join("; ")}`
}

/** `  REFLECT_FAILED: <why>`. */
export const reflectFailedLine = (why: string): Line =>
  `  ${Tag.reflectFailed} ${line`${why}`}` as Line

/** `  PLAYBOOK_FAILED: <why>`. */
export const playbookFailedLine = (why: string): Line =>
  `  ${Tag.playbookFailed} ${line`${why}`}` as Line

/** Why the reflector gave no answer, on one line. */
const failure = (error: Exclude<OrganError, { _tag: "OrganSkipped" }>): string => {
  switch (error._tag) {
    case "OrganFailed":
    case "OrganRefused":
      return error.reason.split("\n")[0] ?? error.reason
    case "OrganTimedOut":
      return "the reflector ran past its time limit"
  }
}

/** A reflection due. */
interface Due {
  readonly trigger: Trigger
  readonly tickets: ReadonlyArray<string>
}

/** Whether the run's records hold `event` about `ticket` (scorecard.ts's recordRef). */
export const recordKnown = (scoring: Scoring, ticket: string, event: string): boolean =>
  scoring.tallies.get(ticket)?.records.includes(event) === true

/**
 * The run's playbook, its reflections run by a fiber in the run's scope, where `organs` has the
 * run's Organs. `repo` is the main checkout; `done` is told each time a reflection ends.
 */
export const make = (options: {
  readonly repo: string
  readonly organs: Option.Option<Organs["Service"]>
  readonly done?: Effect.Effect<void>
}): Effect.Effect<
  RunPlaybook,
  never,
  | AppConfig
  | Beads
  | Git
  | Transcripts
  | Log
  | EventStream
  | RunFibers
  | FileSystem.FileSystem
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const settings = (yield* AppConfig).settings.playbook
    if (!settings.enabled) return off
    const beads = yield* Beads
    const git = yield* Git
    const events = yield* EventStream
    const transcripts = yield* Transcripts
    const { say, warn } = yield* sayer
    const { repo } = options
    const chosen = yield* Ref.make<ReadonlyMap<string, Chosen>>(new Map())
    const since = yield* Ref.make<ReadonlyArray<string>>([])
    const queued = yield* Queue.unbounded<Due>()
    const pending = yield* Ref.make(0)
    const stopped = yield* Ref.make(false)
    // Each ticket's end last taken in, by its scorecard's outcome and seconds; one at a time.
    const taken = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
    const taking = yield* Semaphore.make(1)
    const excluded = yield* Ref.make(false)
    const fileSystem = yield* FileSystemService
    // One warning a run for a file that can't be used: it would say the same for every ticket.
    const warned = yield* Ref.make(false)

    const failed = (why: string) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(warned, true)) return
        yield* warn(playbookFailedLine(why))
      })

    const lessonsNow = readPlaybook(repo).pipe(
      Effect.map((read) => read.lessons),
      Effect.catch((error) => Effect.as(failed(error.reason), [] as ReadonlyArray<Lesson>)),
    )

    // Kept out of git before the run first writes it, in a project init set up before there was one.
    const exclude = Effect.gen(function* () {
      if (yield* Ref.getAndSet(excluded, true)) return
      const dir = yield* Effect.result(git.commonDir(repo))
      if (Result.isFailure(dir)) return
      yield* ensurePlaybookExcluded(dir.success).pipe(
        Effect.provideService(FileSystemService, fileSystem),
        Effect.catch((error) => failed(error.reason)),
      )
    })

    const countFor = (ticket: string, score: Score) =>
      Effect.gen(function* () {
        const given = (yield* Ref.get(chosen)).get(ticket)
        if (given === undefined) return
        const clean = cleanScore(score)
        yield* exclude
        const counted = yield* Effect.result(
          changePlaybook(repo, (lessons) =>
            measure(lessons, given, ticket, clean, settings.judged_after),
          ),
        )
        if (Result.isFailure(counted)) return yield* failed(counted.failure.reason)
        if (counted.success.length === 0) return
        yield* say({
          kind: "lesson_measure",
          ticket,
          clean,
          version: versionOf(yield* lessonsNow),
          lessons: counted.success,
          text: measureLine(ticket, clean, counted.success),
        })
      })

    const closeRead = (scoring: Scoring, ticket: string, standing: "worst" | "best") =>
      Effect.gen(function* () {
        const shown = yield* Effect.result(beads.show(ticket as TicketId))
        const items = yield* allItems(transcripts, ticket as TicketId)
        return {
          ticket,
          standing,
          shown: Result.isSuccess(shown)
            ? ticketText(shown.success)
            : `${ticket}\n(bd show failed: ${beadsWhy(shown.failure)})`,
          footprint: Result.isSuccess(shown) ? footprintText(shown.success) : "(unknown)",
          records: (scoring.tallies.get(ticket)?.records ?? []).join("\n"),
          transcript: transcriptText(items, excerptCharacters, excerptHeadCharacters),
        } satisfies TicketEvidence
      })

    const reflectOne = (organs: Organs["Service"], due: Due) =>
      Effect.gen(function* () {
        const { scoring } = yield* events.figures
        const scores = [...scoring.scores.values()]
        const called = due.tickets.flatMap((ticket) => {
          const score = scoring.scores.get(ticket)
          return score === undefined ? [] : [score]
        })
        const tickets = yield* Effect.forEach(closely(called), ({ ticket, standing }) =>
          closeRead(scoring, ticket, standing),
        )
        const read = tickets.filter((each) => each.transcript.trim() !== "")
        // Nothing to compare: a model turn would have only the figures it can't explain.
        if (read.length === 0) return
        const pool = yield* lessonsNow
        const answer = yield* reflect({
          scorecards: scorecardsEvidence(scores).join("\n"),
          lessons: pool
            .filter((lesson) => lesson.state !== "retired")
            .map((lesson) => `${lesson.id} (${lesson.kind}): ${lesson.text}`)
            .join("\n"),
          tickets: read,
          most: settings.lessons_proposed,
        }).pipe(Effect.provideService(Organs, organs), Effect.result)
        if (Result.isFailure(answer)) {
          // A call skipped for the usage limit is logged as such already.
          if (answer.failure._tag === "OrganSkipped") return
          return yield* warn(reflectFailedLine(failure(answer.failure)))
        }
        const candidates = lessonsOf(answer.success, settings.lessons_proposed)
        const at = timestamp(new Date(yield* Clock.currentTimeMillis))
        const { scoring: latest } = yield* events.figures
        yield* exclude
        const admitted = yield* Effect.result(
          changePlaybook(repo, (lessons) =>
            admit(lessons, candidates, {
              known: (ticket, event) => recordKnown(latest, ticket, event),
              transcripts: read.map((each) => each.transcript),
              cap: settings.pool_cap,
              at,
            }),
          ),
        )
        if (Result.isFailure(admitted)) return yield* failed(admitted.failure.reason)
        yield* say({
          kind: "reflection",
          trigger: due.trigger,
          tickets: due.tickets,
          version: versionOf(yield* lessonsNow),
          lessons: admitted.success,
          text: reflectionLine(admitted.success),
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : warn(reflectFailedLine(causeWhy(cause))),
        ),
        Effect.ensuring(
          Effect.andThen(
            Ref.update(pending, (n) => n - 1),
            options.done ?? Effect.void,
          ),
        ),
      )

    const fibers = yield* (yield* RunFibers).make<never, never>("playbook")
    if (Option.isSome(options.organs)) {
      const organs = options.organs.value
      yield* FiberSet.run(
        fibers,
        Effect.forever(Effect.flatMap(Queue.take(queued), (due) => reflectOne(organs, due))),
      )
    }

    const reflectionDue = (ticket: string) =>
      Effect.gen(function* () {
        if (Option.isNone(options.organs) || (yield* Ref.get(stopped))) return
        const { scoring } = yield* events.figures
        const due = yield* Ref.modify(since, (was) => {
          const tickets = was.includes(ticket) ? was : [...was, ticket]
          const scores = tickets.flatMap((each) => {
            const score = scoring.scores.get(each)
            return score === undefined ? [] : [score]
          })
          const trigger = triggerOf(scores, settings.reflect_every)
          return trigger === undefined
            ? ([undefined, tickets] as const)
            : ([{ trigger, tickets }, []] as const)
        })
        if (due === undefined) return
        yield* Ref.update(pending, (n) => n + 1)
        yield* Queue.offer(queued, due)
      })

    // Each judged end the scorecards hold and this hasn't taken in: counted, and towards a reflection.
    const catchUp = taking.withPermits(1)(
      Effect.gen(function* () {
        const { scoring } = yield* events.figures
        for (const [ticket, score] of scoring.scores) {
          if (!judgedOutcome(score.outcome)) continue
          const end = `${score.outcome} ${score.seconds}`
          if ((yield* Ref.get(taken)).get(ticket) === end) continue
          yield* countFor(ticket, score)
          yield* reflectionDue(ticket)
          yield* Ref.update(taken, (now) => new Map(now).set(ticket, end))
        }
      }),
    )

    return {
      choose: (issue, footprint) =>
        Effect.gen(function* () {
          const kept = (yield* Ref.get(chosen)).get(issue.id)
          if (kept !== undefined) return dispatchOf(kept)
          const given = chosenFor(
            yield* lessonsNow,
            footprint ?? namedFootprint(issue),
            issue.id,
            settings.lessons_injected,
          )
          const said = dispatchOf(given)
          if (said === undefined) return undefined
          yield* Ref.update(chosen, (now) => new Map(now).set(issue.id, given))
          const noted = yield* Effect.result(
            beads.update(issue.id, {
              setMetadata: {
                playbook_version: String(said.version),
                ...(said.lessons.length === 0 ? {} : { playbook_lessons: said.lessons.join(",") }),
              },
            }),
          )
          if (Result.isFailure(noted)) {
            yield* warn(
              playbookFailedLine(
                `could not note the playbook's version on ${issue.id}: ${beadsWhy(noted.failure)}`,
              ),
              issue.id,
            )
          }
          return said
        }),
      section: (ticket) =>
        Effect.map(Ref.get(chosen), (now) => {
          const given = now.get(ticket)
          return given === undefined ? "" : lessonsSection(given)
        }),
      ended: () => catchUp,
      pending: Effect.andThen(catchUp, Ref.get(pending)),
      interrupt: Effect.gen(function* () {
        yield* Ref.set(stopped, true)
        yield* FiberSet.clear(fibers)
        yield* Queue.clear(queued)
        yield* Ref.set(pending, 0)
      }),
      report: Effect.andThen(catchUp, Effect.map(lessonsNow, playbookReport)),
    } satisfies RunPlaybook
  })
