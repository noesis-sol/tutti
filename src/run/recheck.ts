// The recheck (§ 5 item 8, § 5.1's Review{CHECKS_FAILED} → ToMerge), as orchestra's recheck.go
// has it. A ticket's check can fail on something the ticket didn't change: a flaky test, or a bug
// another ticket fixes later in the run. So a ticket set aside because its check failed on its
// branch rebased onto the base is kept, and once the base has moved on from where its check failed
// (another ticket merged), it goes back in the merge queue, ToMerge by RECHECK, to be rebased and
// checked once more: it merges if the check passes now, and is set aside again if it fails again.
//
// Each ticket is checked again at most once a run, set up first if its setup failed (setup.ts). One
// whose check failed in a folder its own commits change isn't kept: another ticket's change won't fix that. Nor is one that something
// has touched since, as when you have taken it up: reopened, its worktree changed, its branch moved,
// or its worker steered. None is checked again while the run winds down or the merges have
// stopped. Its session stays open while it may be checked again (§ 4.8).
import { posix } from "node:path"
import { Effect, Ref, Result } from "effect"
import { Beads } from "../services/Beads.ts"
import type { CheckError } from "../services/Checks.ts"
import { Git } from "../services/Git.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, Log, line, Tag, ticketLine } from "./log.ts"
import { beadsWhy, type FinishedTicket, type MergeOptions, uncommitted } from "./merge.ts"
import type { MergeQueue } from "./mergequeue.ts"
import { Cause } from "./phase.ts"

/** A ticket set aside for a failed check, to be checked once more once the base moves on. */
export interface Recheck {
  readonly ticket: FinishedTicket
  /** The commit of the base its check failed on. */
  readonly onto: string
  /** Its branch's commit then. */
  readonly head: string
}

/**
 * The tickets of a run waiting to be checked once more, and those taken up to be; and what the
 * check said of each ticket it set aside, for the run report.
 */
export interface Rechecks {
  /** The tickets waiting to be checked once more, in the order they were set aside. */
  readonly waiting: Effect.Effect<ReadonlyArray<Recheck>>
  /** Whether the ticket has been taken up to be checked once more in this run. */
  rechecked(id: string): Effect.Effect<boolean>
  /** Keeps the ticket to be checked once more. */
  keep(recheck: Recheck): Effect.Effect<void>
  /** Takes the ticket out of those waiting, as checked once more; false when it wasn't waiting. */
  take(id: string): Effect.Effect<boolean>
  /** Keeps what the ticket's check said as it set the ticket aside, in place of what it said before. */
  noteFailure(id: string, evidence: string): Effect.Effect<void>
  /** What the check said of each ticket it set aside, by ticket, in the order they were first. */
  readonly failures: Effect.Effect<ReadonlyMap<string, string>>
}

/** A run's rechecks: none waiting, none taken up. */
export const makeRechecks: Effect.Effect<Rechecks> = Effect.gen(function* () {
  const ref = yield* Ref.make<{
    readonly waiting: ReadonlyArray<Recheck>
    readonly rechecked: ReadonlySet<string>
  }>({ waiting: [], rechecked: new Set() })
  const failures = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
  return {
    waiting: Effect.map(Ref.get(ref), (state) => state.waiting),
    rechecked: (id) => Effect.map(Ref.get(ref), (state) => state.rechecked.has(id)),
    keep: (recheck) =>
      Ref.update(ref, (state) => ({
        ...state,
        waiting: [...state.waiting.filter((each) => each.ticket.id !== recheck.ticket.id), recheck],
      })),
    take: (id) =>
      Ref.modify(ref, (state) => {
        if (!state.waiting.some((each) => each.ticket.id === id)) return [false, state]
        return [
          true,
          {
            waiting: state.waiting.filter((each) => each.ticket.id !== id),
            rechecked: new Set([...state.rechecked, id]),
          },
        ]
      }),
    noteFailure: (id, evidence) => Ref.update(failures, (said) => new Map(said).set(id, evidence)),
    failures: Ref.get(failures),
  } satisfies Rechecks
})

// A line of a check's output naming a package that failed, by its import path (go test's FAIL,
// gotestsum's === FAIL:), or a file, by its position (a lint, vet or build error).
const failedPackage = /^(?:FAIL|=== FAIL:)\s+(\S+)/
const failedFile = /^([^\s:]+\.\w+):\d+(?::\d+)?: /

/** `path` as Go's path.Clean has it: no `.` or `..` parts, no trailing slash, `.` for none. */
const clean = (path: string): string => {
  const normal = posix.normalize(path)
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal
}

/** The folders of `files` (`.` for the top level), each once, sorted. */
export const foldersOf = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(files.map((file) => posix.dirname(file)))].sort()

/**
 * The folders of `own` (those the ticket's own commits change) that the lines `said` of its failed
 * check say it failed in, by a package there or a file; none when they name none.
 */
export const ownFailures = (
  said: ReadonlyArray<string>,
  own: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (const each of said) {
    const pkg = failedPackage.exec(each)?.[1]
    const file = pkg === undefined ? failedFile.exec(each)?.[1] : undefined
    if (pkg === undefined && file === undefined) continue
    const at = pkg === undefined ? posix.dirname(clean(file as string)) : clean(pkg)
    for (const folder of own) {
      const inIt = at === folder || (folder !== "." && at.endsWith(`/${folder}`))
      if (inIt && !found.includes(folder)) found.push(folder)
    }
  }
  return found
}

/**
 * Keeps the ticket, its check just failed on its branch rebased onto the base at `onto`, to be
 * checked once more after the base moves on, unless its check failed in a folder its own commits
 * change or it was that once. What the CHECKS_FAILED line adds about it; nothing when it was that
 * once, or git can't say where its branch is.
 */
export const keepForRecheck = (
  ticket: FinishedTicket,
  options: MergeOptions,
  rechecks: Rechecks,
  onto: string,
  error: CheckError,
): Effect.Effect<Line | "", never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { id, branch } = ticket
    if (yield* rechecks.rechecked(id)) return ""
    // A setup's output names none of the ticket's code.
    if (error._tag !== "CheckNotRun" && error.check !== "setup" && error.failingLines.length > 0) {
      const changed = yield* Effect.result(git.changedFiles(options.repo, onto, branch))
      const folders = Result.isSuccess(changed) ? foldersOf(changed.success) : []
      const own = ownFailures(error.failingLines, folders)
      if (own.length > 0) {
        return line`; not checked again in this run, as it failed in ${own}, which ${id}'s own commits change`
      }
    }
    const head = yield* Effect.result(git.revParse(options.repo, branch))
    // Without its commit, a branch moved since couldn't be told from one left as it was.
    if (Result.isFailure(head)) return ""
    yield* rechecks.keep({ ticket, onto, head: head.success })
    return line`; checked once more if ${options.base} moves on in this run`
  })

/** Whether the base has moved on from `onto`: on from it, not merely elsewhere. */
const movedOn = (options: MergeOptions, onto: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const base = yield* git.revParse(options.repo, options.base)
    // On a base moved back, its branch would fast-forward unchecked.
    return base !== onto && (yield* git.mergeBase(options.repo, onto, base)) === onto
  }).pipe(Effect.orElseSucceed(() => false))

/** Why the ticket is left as it is rather than checked once more, or undefined. */
const whyNot = (recheck: Recheck, options: MergeOptions) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const git = yield* Git
    const ledger = yield* Ledger
    const { id, branch, worktree } = recheck.ticket
    const issue = yield* Effect.result(beads.show(id))
    if (Result.isFailure(issue)) {
      return line`bd could not say whether it is still closed: ${beadsWhy(issue.failure)}`
    }
    if (issue.success.status !== "closed") return line`it is ${issue.success.status} now`
    const status = yield* Effect.result(git.status(worktree))
    if (Result.isFailure(status) || uncommitted(status.success).length > 0) {
      return line`${worktree} has uncommitted changes`
    }
    const head = yield* Effect.result(git.revParse(options.repo, branch))
    if (Result.isFailure(head) || head.success !== recheck.head) {
      return line`${branch} has moved since its check failed`
    }
    if ((yield* ledger.current).tickets.get(id)?.steered === true) {
      return line`you have steered its worker`
    }
    return undefined
  })

/**
 * Puts back in the merge queue, ToMerge by RECHECK, each ticket waiting to be checked once more
 * whose base has moved on since its check failed; none while the run winds down or the merges
 * have stopped. A ticket touched since stays set aside, and the log says why. The tickets it put
 * back.
 */
export const recheckDue = (
  rechecks: Rechecks,
  queue: Pick<MergeQueue, "offer" | "state">,
  options: MergeOptions,
): Effect.Effect<ReadonlyArray<string>, never, Beads | Git | Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const back: Array<string> = []
    for (const recheck of yield* rechecks.waiting) {
      if ((yield* ledger.current).windDown !== null || (yield* queue.state).stop !== null) break
      if (!(yield* movedOn(options, recheck.onto))) continue
      const { id, branch } = recheck.ticket
      if (!(yield* rechecks.take(id))) continue
      const why = yield* whyNot(recheck, options)
      if (why !== undefined) {
        const text = detail`${id} is not checked again: ${why}; it stays set aside`
        yield* events.emit({ kind: "info", ticket: id, text })
        yield* logs.write(text)
        continue
      }
      const text = ticketLine(
        Tag.recheck,
      )`${id}'s check failed on ${options.base} at ${recheck.onto.slice(0, 7)}, which has moved on since; rebasing ${branch} and checking it once more`
      yield* events.emit({ kind: "info", ticket: id, text })
      yield* logs.write(text)
      const moved = yield* queue.offer(recheck.ticket, (place) => Cause.Recheck({ place }))
      if (Result.isSuccess(moved)) back.push(id)
    }
    return back
  })
