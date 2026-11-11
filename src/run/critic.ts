// The critic in the run (§ 5 item 13, § 6.2, tutti-5fs7.2): mid-run, it reviews merged work and
// files follow-up tickets for what it finds, so that an improvement to the code arrives as an
// ordinary ticket the run, or the next one, takes up, never as a change nobody asked for.
//
// The merge queue tells it of each merge (`merged`): the run's every `organs.critic_every`th merge
// is due a review (`every`), and so is a merge whose ticket's scorecard is in the worst decile of
// the run's merged tickets so far, once ten have merged (`worst`); a ticket is reviewed once. Each
// look of the run, after its fill (run.ts), starts the next review due, one at a time, while the
// run is idle enough for it (`idle`): a slot the fill left free, no merge under way (checks side by
// side slow each other 1.1-2.3x, tutti-0vbd), and the memory not pressed (tutti-wm30). Its end wakes
// the run, which doesn't end while a review runs, or waits while it could start one (`pending`).
//
// A review gives the critic organ (organs/critic.ts) the ticket as bd show gives it, its scorecard,
// the project's CLAUDE.md and AGENTS.md at the merged commit, the files the merge changed and their
// diff. Each finding it reports is then judged:
// - one of low confidence is dropped (doubtful), as is one whose path:line the merged tree hasn't
//   (ungrounded);
// - one alike an open ticket, by its title or by the finding it was filed for, is dropped
//   (duplicate);
// - a severe one (a broken build, a security issue) is asked of the maintainer as a question, a
//   needs-you item, never filed as a ticket;
// - the rest are filed, at most `organs.critic_tickets` a run, the most severe first: discovered from
//   the merged ticket, labelled `review`, the priority from the severity; past the cap, dropped
//   (capped). Each filed ticket is a follow-up on the merged ticket's scorecard (score_update).
// It never edits code, reopens or reverts merged work. Each review is a `review` record, with its
// checklist, its findings and what became of each, and a line in the log; a review that fails is
// CRITIC_FAILED, in the log and a `warn` record, and changes nothing. One skipped for the usage limit
// is logged by Organs already.
//
// Off with the settings' organs.critic false, or a run without organs. A quit interrupts the review
// under way, and those due are dropped.
import { Cause, Effect, FiberSet, Ref, Result, type Scope } from "effect"
import { AppConfig } from "../core/AppConfig.ts"
import { causeWhy, detail, type Line, type Log, line, Tag } from "../core/log.ts"
import {
  conventionFiles,
  conventionsCharacters,
  cut,
  diffCharacters,
  type Evidence,
  type Finding,
  fileDiffCharacters,
  alike as findingsAlike,
  findingsOf,
  priorityOf,
  rescore,
} from "../organs/critic.ts"
import type { OrganError } from "../organs/Organs.ts"
import { Organs } from "../organs/Organs.ts"
import { ticketText } from "../organs/predictor.ts"
import {
  Beads,
  beadsWhy,
  HumanLabel,
  type Issue,
  MetadataKey,
  type TicketId,
} from "../services/Beads.ts"
import { EventStream } from "../services/EventStream.ts"
import type { Event, findingDropped, reviewTriggers } from "../services/events.ts"
import { Git, gitWhy, shortHash } from "../services/Git.ts"
import { ranked, type Score, scorecardsEvidence } from "../services/scorecard.ts"
import { RunFibers } from "./fibers.ts"
import { sayer } from "./say.ts"

export type Trigger = (typeof reviewTriggers)[number]
type Dropped = (typeof findingDropped)[number]
type ReviewFinding = Extract<Event, { readonly kind: "review" }>["findings"][number]

/** A merge, as the merge queue tells the critic of it. */
export interface MergedWork {
  readonly ticket: TicketId
  /** The base's commit the ticket's branch was put on. */
  readonly onto: string
  /** The commit the merge put the base at. */
  readonly at: string
}

export interface Critic {
  /** The merge queue merged `work`: a review is due when its trigger says so. */
  merged(work: MergedWork): Effect.Effect<void>
  /** Starts the next review due, if none runs and the run is idle enough for it. */
  readonly look: Effect.Effect<void>
  /** The review under way, and those due while the run is idle enough to start them. */
  readonly pending: Effect.Effect<number>
  /** Aborts the review under way and starts no more, as quitting does (quit.ts). */
  readonly interrupt: Effect.Effect<void>
}

/** The critic turned off: it reviews nothing. */
export const off: Critic = {
  merged: () => Effect.void,
  look: Effect.void,
  pending: Effect.succeed(0),
  interrupt: Effect.void,
}

/** The label of the tickets the critic files. */
export const reviewLabel = "review"

/** The metadata key of a filed ticket's finding, `path:line criterion`, for later dedup. */
export const findingKey = "review_finding"

/** How few merged tickets the run has before it has a worst decile. */
export const decileFrom = 10

/** Whether the run's `merges`th merge is due a review, every `every`; never with 0. */
export const everyDue = (merges: number, every: number): boolean =>
  every > 0 && merges > 0 && merges % every === 0

/**
 * Whether `ticket`'s scorecard is in the worst decile of the merged tickets' among `scores` (by
 * scorecard.ts's ranking): the worst tenth, rounded down, of ten or more.
 */
export const inWorstDecile = (ticket: string, scores: ReadonlyArray<Score>): boolean => {
  const merged = scores.filter((score) => score.outcome === "merged")
  const worst = merged.length < decileFrom ? 0 : Math.floor(merged.length / 10)
  return ranked(merged)
    .slice(0, worst)
    .some(({ score }) => score.ticket === ticket)
}

/** What calls for a review of `ticket`, merged as the run's `merges`th merge; none for none. */
export const triggerOf = (
  ticket: string,
  merges: number,
  every: number,
  scores: ReadonlyArray<Score>,
): Trigger | undefined =>
  everyDue(merges, every) ? "every" : inWorstDecile(ticket, scores) ? "worst" : undefined

/** The key of a finding, as a filed ticket's metadata keeps it. */
export const keyOf = (finding: Finding): string =>
  `${finding.file}:${finding.line} ${finding.criterion}`

/** The open ticket `finding` is alike, by its title or the finding it was filed for. */
export const duplicateOf = (finding: Finding, open: ReadonlyArray<Issue>): Issue | undefined =>
  open.find(
    (issue) =>
      findingsAlike(issue.title, finding.title) || issue.metadata[findingKey] === keyOf(finding),
  )

const triggerWords: Readonly<Record<Trigger, string>> = {
  every: "one of the run's every so many merges",
  worst: "its scorecard in the run's worst decile",
}

/** A filed ticket's description: the finding, where, against what, and where it came from. */
export const ticketDescription = (
  finding: Finding,
  from: { readonly ticket: string; readonly at: string; readonly trigger: Trigger },
): string =>
  `${finding.detail}\n\n` +
  `Where: ${finding.file}:${finding.line}\n` +
  `Criterion: ${finding.criterion}\n` +
  `Severity: ${finding.severity}, ${finding.confidence} confidence\n\n` +
  `Found by tutti's critic reviewing ${from.ticket}'s merge (${shortHash(from.at)}), ` +
  `${triggerWords[from.trigger]}.`

/** A severe finding's options for the maintainer, the first recommended. */
export const severeOptions = [
  {
    label: "Fix it now",
    description: "by hand or with a ticket of your own, before the branch goes further",
  },
  {
    label: "Leave it for later",
    description: "it stays on the branch until someone files it",
  },
  {
    label: "Not a problem",
    description: "the critic was wrong; nothing to do",
  },
] as const

/** A severe finding's question: what it found, and the options. */
export const questionDescription = (
  finding: Finding,
  from: { readonly ticket: string; readonly at: string; readonly trigger: Trigger },
): string =>
  `${ticketDescription(finding, from)}\n\n` +
  "A severe finding is asked of you rather than filed as a ticket. Options:\n" +
  severeOptions.map((option, i) => `${i + 1}. ${option.label}: ${option.description}`).join("\n") +
  `\n\nRecommended: ${severeOptions[0].label}.`

/** `  review <id>: 3 findings; filed a, b; asked q; dropped 1 duplicate`. */
export const reviewLine = (id: TicketId, findings: ReadonlyArray<ReviewFinding>): Line => {
  const filed = findings.flatMap((f) =>
    f.filed !== undefined && f.severity !== "severe" ? [f.filed] : [],
  )
  const asked = findings.flatMap((f) =>
    f.filed !== undefined && f.severity === "severe" ? [f.filed] : [],
  )
  const dropped = new Map<Dropped, number>()
  for (const f of findings) {
    if (f.dropped !== undefined) dropped.set(f.dropped, (dropped.get(f.dropped) ?? 0) + 1)
  }
  const parts = [
    findings.length === 1 ? "1 finding" : `${findings.length} findings`,
    ...(filed.length === 0 ? [] : [`filed ${filed.join(", ")}`]),
    ...(asked.length === 0 ? [] : [`asked ${asked.join(", ")}`]),
    ...(dropped.size === 0
      ? []
      : [`dropped ${[...dropped].map(([why, n]) => `${n} ${why}`).join(", ")}`]),
  ]
  return detail`review ${id}: ${parts.join("; ")}`
}

/** `  CRITIC_FAILED for <id>: <why>`. */
export const criticFailedLine = (id: TicketId, why: string): Line =>
  `  ${Tag.criticFailed} for ${line`${id}: ${why}`}` as Line

/** Why the critic gave no answer, on one line. */
const failure = (error: Exclude<OrganError, { _tag: "OrganSkipped" }>): string => {
  switch (error._tag) {
    case "OrganFailed":
    case "OrganRefused":
      return error.reason.split("\n")[0] ?? error.reason
    case "OrganTimedOut":
      return "the critic ran past its time limit"
  }
}

/** A review due. */
interface Due extends MergedWork {
  readonly trigger: Trigger
}

interface State {
  /** The merges the run has made. */
  readonly merges: number
  /** The reviews due, oldest first. */
  readonly due: ReadonlyArray<Due>
  readonly running: boolean
  /** The tickets reviewed or due, each once. */
  readonly reviewed: ReadonlySet<string>
  /** The tickets filed so far, for the cap. */
  readonly filed: number
  /** Set once quitting began: no more reviews. */
  readonly stopped: boolean
}

/**
 * The run's critic, its reviews run by a fiber in the run's scope. `repo` is the main checkout;
 * `idle` whether the run is idle enough for a review now; `done` is told each time one ends.
 */
export const make = (options: {
  readonly repo: string
  readonly idle: Effect.Effect<boolean>
  readonly done?: Effect.Effect<void>
}): Effect.Effect<
  Critic,
  never,
  AppConfig | Organs | Beads | Git | Log | EventStream | RunFibers | Scope.Scope
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const settings = config.settings.organs
    if (!settings.critic) return off
    const organs = yield* Organs
    const beads = yield* Beads
    const git = yield* Git
    const events = yield* EventStream
    const { say, warn } = yield* sayer
    const state = yield* Ref.make<State>({
      merges: 0,
      due: [],
      running: false,
      reviewed: new Set(),
      filed: 0,
      stopped: false,
    })
    const fibers = yield* (yield* RunFibers).make<void, never>("critic")

    const conventionsText = (at: string) =>
      Effect.gen(function* () {
        const texts: Array<string> = []
        for (const file of conventionFiles) {
          const text = yield* Effect.result(git.fileAt(options.repo, at, file))
          if (Result.isSuccess(text) && text.success.trim() !== "") {
            texts.push(`### ${file}\n\n${cut(text.success.trim(), conventionsCharacters)}`)
          }
        }
        return texts.join("\n\n")
      })

    const diffText = (due: Due, files: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const diffs: Array<string> = []
        let length = 0
        for (const file of files) {
          if (length >= diffCharacters) break
          const diff = yield* git
            .diffOf(options.repo, due.onto, due.at, file)
            .pipe(
              Effect.catch((error) =>
                Effect.succeed(`(git diff of ${file} failed: ${gitWhy(error)})`),
              ),
            )
          const text = cut(diff.trimEnd(), fileDiffCharacters)
          diffs.push(text)
          length += text.length
        }
        return cut(diffs.join("\n"), diffCharacters)
      })

    // The evidence for one merged ticket, gathered as its review starts.
    const gather = (due: Due) =>
      Effect.gen(function* () {
        const id = due.ticket
        const shown = yield* beads.show(id).pipe(
          Effect.map(ticketText),
          Effect.catch((error) => Effect.succeed(`${id}\n(bd show failed: ${beadsWhy(error)})`)),
        )
        const scores = [...(yield* events.figures).scoring.scores.values()]
        const scorecard =
          scorecardsEvidence(scores).find((each) => each.startsWith(`${id}: `)) ?? ""
        const files = yield* Effect.result(git.filesBetween(options.repo, due.onto, due.at))
        const changed = Result.isSuccess(files) ? files.success : []
        return {
          ticket: id,
          shown,
          scorecard,
          conventions: yield* conventionsText(due.at),
          files: Result.isSuccess(files)
            ? changed.join("\n")
            : `(git diff failed: ${gitWhy(files.failure)})`,
          diff: yield* diffText(due, changed),
          merge: `merged at ${shortHash(due.at)} onto ${shortHash(due.onto)}`,
        } satisfies Evidence
      })

    // Whether the merged tree has the file, with as many lines as `line`.
    const hasLine = (file: string, line: number, at: string) =>
      Effect.map(Effect.result(git.fileAt(options.repo, at, file)), (text) =>
        Result.isSuccess(text) ? text.success.split("\n").length >= line : false,
      )

    // The finding at the place the merged tree has, its path as given or without the a/ or b/ a
    // diff's paths start with; undefined where it has neither.
    const grounded = (finding: Finding, at: string) =>
      Effect.gen(function* () {
        if (yield* hasLine(finding.file, finding.line, at)) return finding
        const bare = finding.file.replace(/^[ab]\//, "")
        if (bare === finding.file || !(yield* hasLine(bare, finding.line, at))) return undefined
        return { ...finding, file: bare }
      })

    // Takes one filing from the cap, if it has one left.
    const takeFiling = Ref.modify(state, (now) =>
      now.filed >= settings.critic_tickets
        ? ([false, now] as const)
        : ([true, { ...now, filed: now.filed + 1 }] as const),
    )
    const giveFilingBack = Ref.update(state, (now) => ({ ...now, filed: now.filed - 1 }))

    // Each finding judged, filed, asked or dropped, in turn.
    const judge = (due: Due, findings: ReadonlyArray<Finding>) =>
      Effect.gen(function* () {
        const listed = yield* Effect.result(beads.list())
        const open: Array<Issue> = Result.isSuccess(listed)
          ? listed.success.filter((issue) => issue.status !== "closed")
          : []
        const from = { ticket: due.ticket, at: due.at, trigger: due.trigger }
        const judged: Array<ReviewFinding> = []
        for (const read of findings) {
          const placed = read.confidence === "low" ? undefined : yield* grounded(read, due.at)
          const finding = placed ?? read
          const said = {
            title: finding.title,
            severity: finding.severity,
            criterion: finding.criterion,
            evidence: `${finding.file}:${finding.line}`,
            confidence: finding.confidence,
          }
          const drop = (why: Dropped, extra: { readonly duplicate_of?: string } = {}) =>
            judged.push({ ...said, dropped: why, ...extra })
          if (finding.confidence === "low") {
            drop("doubtful")
            continue
          }
          if (placed === undefined) {
            drop("ungrounded")
            continue
          }
          const twin = duplicateOf(finding, open)
          if (twin !== undefined) {
            drop("duplicate", { duplicate_of: twin.id })
            continue
          }
          const severe = finding.severity === "severe"
          if (!severe && !(yield* takeFiling)) {
            drop("capped")
            continue
          }
          const created = yield* Effect.result(
            finding.severity === "severe"
              ? beads.create({
                  title: finding.title,
                  description: questionDescription(finding, from),
                  type: "task",
                  priority: 0,
                  labels: [HumanLabel, reviewLabel],
                  discoveredFrom: [due.ticket],
                  metadata: {
                    [MetadataKey.options]: severeOptions,
                    [MetadataKey.recommended]: 0,
                    [MetadataKey.maintainerOnly]: true,
                    [findingKey]: keyOf(finding),
                  },
                })
              : beads.create({
                  title: finding.title,
                  description: ticketDescription(finding, from),
                  type: "task",
                  priority: priorityOf(finding.severity),
                  labels: [reviewLabel],
                  discoveredFrom: [due.ticket],
                  metadata: { [findingKey]: keyOf(finding) },
                }),
          )
          if (Result.isFailure(created)) {
            if (!severe) yield* giveFilingBack
            yield* warn(criticFailedLine(due.ticket, beadsWhy(created.failure)), due.ticket)
            drop("failed")
            continue
          }
          const issue = created.success
          open.push(issue)
          judged.push({ ...said, filed: issue.id })
          // A question for the maintainer is no follow-up, as the scorecards count them.
          if (!severe) {
            yield* events.emit({ kind: "score_update", ticket: due.ticket, follow_up: issue.id })
          }
        }
        return judged
      })

    // A defect in one review, CRITIC_FAILED; an interruption (a quit) goes on up.
    const survived = (id: TicketId, cause: Cause.Cause<never>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : warn(criticFailedLine(id, causeWhy(cause)), id)

    const reviewOne = (due: Due) =>
      Effect.gen(function* () {
        const evidence = yield* gather(due)
        const answer = yield* rescore(evidence).pipe(
          Effect.provideService(Organs, organs),
          Effect.result,
        )
        if (Result.isFailure(answer)) {
          // A call skipped for the usage limit is logged as such already.
          if (answer.failure._tag === "OrganSkipped") return
          yield* warn(criticFailedLine(due.ticket, failure(answer.failure)), due.ticket)
          return
        }
        const judged = yield* judge(due, findingsOf(answer.success))
        yield* say({
          kind: "review",
          ticket: due.ticket,
          trigger: due.trigger,
          commit: due.at,
          checklist: answer.success.checklist
            .map((each) => each.trim())
            .filter((each) => each !== ""),
          findings: judged,
          text: reviewLine(due.ticket, judged),
        })
      }).pipe(
        Effect.catchCause((cause) => survived(due.ticket, cause)),
        Effect.ensuring(
          Effect.andThen(
            Ref.update(state, (now) => ({ ...now, running: false })),
            options.done ?? Effect.void,
          ),
        ),
      )

    return {
      merged: (work) =>
        Effect.gen(function* () {
          const merges = yield* Ref.modify(state, (now) => {
            const next = { ...now, merges: now.merges + 1 }
            return [next.merges, next] as const
          })
          const scores = [...(yield* events.figures).scoring.scores.values()]
          const trigger = triggerOf(work.ticket, merges, settings.critic_every, scores)
          if (trigger === undefined) return
          yield* Ref.update(state, (now) =>
            now.stopped || now.reviewed.has(work.ticket)
              ? now
              : {
                  ...now,
                  due: [...now.due, { ...work, trigger }],
                  reviewed: new Set(now.reviewed).add(work.ticket),
                },
          )
        }),
      look: Effect.gen(function* () {
        const now = yield* Ref.get(state)
        if (now.running || now.stopped || now.due.length === 0) return
        if (!(yield* options.idle)) return
        const next = yield* Ref.modify(state, (was) => {
          const [first, ...rest] = was.due
          if (was.running || first === undefined) return [undefined, was] as const
          return [first, { ...was, due: rest, running: true }] as const
        })
        if (next !== undefined) yield* FiberSet.run(fibers, reviewOne(next))
      }),
      pending: Effect.gen(function* () {
        const now = yield* Ref.get(state)
        if (now.running) return 1 + now.due.length
        if (now.stopped || now.due.length === 0) return 0
        return (yield* options.idle) ? now.due.length : 0
      }),
      interrupt: Effect.andThen(
        Ref.update(state, (now) => ({ ...now, stopped: true, due: [] })),
        FiberSet.clear(fibers),
      ),
    } satisfies Critic
  })
