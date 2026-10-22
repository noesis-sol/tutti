// Predicting footprints (§ 5 items 5 and 13, Appendix A), as orchestra v0.7.7 does. A ready ticket
// naming nothing (no files, functions, area labels or files metadata, nor predicted files that are
// still in the repository) would run beside anything. The scheduler queues each one here, once a
// run, unless it is solo, which runs alone anyway; the predictor organ guesses the files it will
// change, in the background and one ticket at a time. The guess is kept for the run and on the
// ticket, as `predicted_files` metadata (a JSON list, which reads back whole: a path may hold a comma
// or a space), and from then on the ticket's footprint is those files, marked (predicted). The
// scheduler never waits for a guess: until one is in, the ticket keeps its empty footprint, and a
// running ticket naming nothing gets its guess as the next fill reads its footprint. A defect while
// predicting one ticket is PREDICT_FAILED in the log: that ticket keeps its empty footprint, and the
// queue goes on.
import { Cause, Effect, FiberSet, Queue, Ref, Result, type Scope } from "effect"
import { type OrganError, Organs } from "../organs/Organs.ts"
import { predictFiles } from "../organs/predictor.ts"
import { Beads, beadsWhy, type Issue, MetadataKey } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { RunFibers } from "./fibers.ts"
import {
  branchFootprint,
  type Footprint,
  isEmpty,
  type RepoFiles,
  ticketFootprint,
} from "./footprint.ts"
import { isSolo } from "./holds.ts"
import { causeWhy, detail, type Line, Log, line, Tag } from "./log.ts"

export interface Predictor {
  /**
   * Queues each ticket whose footprint names nothing, unless it is solo or was weighed before in
   * this run. `branch` gives the files a ticket's branch changes on top of the base (as
   * `Footprints.branch`), read for a ticket naming nothing: one with some is footprinted from them,
   * so it is never queued.
   * Returns at once: the predictor works through its queue in the background.
   */
  queue(
    issues: ReadonlyArray<Issue>,
    repo: RepoFiles,
    branch: (ticket: string) => Effect.Effect<ReadonlyArray<string>>,
  ): Effect.Effect<void>
  /** The files predicted in this run, by ticket. */
  readonly predicted: Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>
  /** Stops the predictor, the guess under way aborted: the run takes no more tickets. */
  readonly interrupt: Effect.Effect<void>
}

/**
 * The ticket's footprint: for a ticket whose branch changes files on top of the base (`branch`),
 * branchFootprint's; else ticketFootprint's, or, for a ticket naming nothing, the files predicted
 * for it in this run when bd hasn't handed back those kept on the ticket.
 */
export const footprintOf = (
  issue: Issue,
  repo: RepoFiles,
  predicted: ReadonlyMap<string, ReadonlyArray<string>>,
  branch: ReadonlyArray<string> = [],
): Footprint => {
  if (branch.length > 0) return branchFootprint(issue, branch, repo)
  const fp = ticketFootprint(issue, repo)
  const files = predicted.get(issue.id)
  return isEmpty(fp) && files !== undefined
    ? ticketFootprint({ ...issue, predictedFiles: files }, repo)
    : fp
}

/** `  <id> footprint predicted: a.ts, b.ts`. */
export const predictedLine = (id: string, files: ReadonlyArray<string>): Line =>
  detail`${id} footprint predicted: ${files}`

/** `  <id> footprint not predicted: <why>`. */
export const notPredictedLine = (id: string, why: string): Line =>
  detail`${id} footprint not predicted: ${why}`

/** `  PREDICT_FAILED for <id>: <why>`. */
export const predictFailedLine = (id: string, why: string): Line =>
  `  ${Tag.predictFailed} for ${line`${id}: ${why}`}` as Line

/** Why the predictor gave no answer, on one line. */
const failure = (error: Exclude<OrganError, { _tag: "OrganSkipped" }>): string => {
  switch (error._tag) {
    case "OrganFailed":
    case "OrganRefused":
      return error.reason.split("\n")[0] ?? error.reason
    case "OrganTimedOut":
      return "the predictor ran past its time limit"
  }
}

/**
 * The run's predictor, its queue worked through by a fiber in the run's scope. `repo` is the main
 * checkout, whose files (git ls-files) the predictor chooses from.
 */
export const make = (options: {
  readonly repo: string
}): Effect.Effect<Predictor, never, Organs | Beads | Git | Log | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const git = yield* Git
    const logs = yield* Log
    const queued = yield* Queue.unbounded<Issue>()
    const seen = new Set<string>()
    const predicted = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
    const organs = yield* Organs

    const predict = (queuedIssue: Issue) =>
      Effect.gen(function* () {
        const tracked = yield* git
          .trackedFiles(options.repo)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        if (tracked.length === 0) return // no files to choose from
        // The ticket as it is now: its text may have changed since bd ready listed it.
        const issue = yield* beads
          .show(queuedIssue.id)
          .pipe(Effect.orElseSucceed(() => queuedIssue))
        const answer = yield* predictFiles(issue, tracked).pipe(
          Effect.provideService(Organs, organs),
          Effect.result,
        )
        if (Result.isFailure(answer)) {
          // A call skipped for the usage limit is logged as such already.
          if (answer.failure._tag === "OrganSkipped") return
          return yield* logs.write(notPredictedLine(issue.id, failure(answer.failure)))
        }
        const files = answer.success
        if (files.length === 0) {
          return yield* logs.write(notPredictedLine(issue.id, "the ticket gives no clue"))
        }
        yield* Ref.update(predicted, (all) => new Map([...all, [issue.id, files]]))
        const kept = yield* beads
          .setMetadata(issue.id, MetadataKey.predictedFiles, JSON.stringify(files))
          .pipe(Effect.result)
        if (Result.isFailure(kept)) {
          yield* logs.write(
            detail`${issue.id} footprint predicted, but bd could not keep it: ${beadsWhy(kept.failure)}`,
          )
        }
        yield* logs.write(predictedLine(issue.id, files))
      }).pipe(
        // A defect loses this ticket's guess, not the queue; an interruption (a quit) goes on up.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : logs.write(predictFailedLine(queuedIssue.id, causeWhy(cause))),
        ),
      )

    const fibers = yield* (yield* RunFibers).make<never, never>("predictor")
    yield* FiberSet.run(fibers, Effect.forever(Effect.flatMap(Queue.take(queued), predict)))

    return {
      queue: (issues, repo, branch) =>
        Effect.gen(function* () {
          const all = yield* Ref.get(predicted)
          for (const issue of issues) {
            if (seen.has(issue.id) || isSolo(issue)) continue
            if (!isEmpty(footprintOf(issue, repo, all))) continue
            // Its branch is read last, for a ticket whose text names nothing only, and once a run:
            // its commits stay there until it merges.
            seen.add(issue.id)
            if (!isEmpty(footprintOf(issue, repo, all, yield* branch(issue.id)))) continue
            yield* Queue.offer(queued, issue)
          }
        }),
      predicted: Ref.get(predicted),
      interrupt: FiberSet.clear(fibers),
    }
  })
