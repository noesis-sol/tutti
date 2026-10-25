// The recheck (§ 5 item 8, § 5.1's Review{CHECKS_FAILED} → ToMerge), as orchestra's recheck.go
// has it. A ticket's check can fail on something the ticket didn't change: a flaky test, or a bug
// another ticket fixes later in the run. So a ticket set aside because its check failed on its
// branch rebased onto the base is kept, and once the base has moved on from where its check failed
// (another ticket merged), it goes back in the merge queue, ToMerge by RECHECK, to be rebased and
// checked once more: it merges if the check passes now, and is set aside again if it fails again.
//
// Each ticket is checked again at most once a run, set up first if its setup failed (setup.ts). One
// whose check failed in a folder its own commits change isn't kept: another ticket's change won't
// fix that. Nor is one that something has touched since, as when you have taken it up: reopened, its
// worktree changed (a file left untracked there too), its branch moved, or its worker steered, nor
// one merged by hand meanwhile (handMerged.ts). None is checked again while the run winds down or holds (a stop, or the usage
// limit), or the merges have stopped; nor while a solo ticket runs or is next. A drain, or a run that
// ends stopped, gives up the tickets waiting and names each (dropRechecks); one set aside while the
// run winds down isn't kept. Each takes a slot as a running ticket does, until its merge is over, and
// waits for one to be free: the run looks for those due each time it looks for work, before new
// tickets start. Its session stays open while it may be checked again (§ 4.8).
import { posix } from "node:path"
import { Deferred, Effect, Ref, Result, Stream } from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import { Beads, beadsWhy, type Issue, type TicketId } from "../services/Beads.ts"
import type { CheckError } from "../services/Checks.ts"
import { Git, type GitError, shortHash } from "../services/Git.ts"
import { trackedChanges, untrackedFiles } from "../services/gitStatus.ts"
import type { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, type Log, line, Tag, ticketLine } from "./log.ts"
import { type FinishedTicket, type MergeOptions, type MergeTarget, someFiles } from "./merge.ts"
import type { MergeQueue } from "./mergequeue.ts"
import { Move } from "./phase.ts"
import { clean } from "./repoFiles.ts"
import { info } from "./say.ts"
import { fit } from "./sessions.ts"

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
  rechecked(id: TicketId): Effect.Effect<boolean>
  /** Keeps the ticket to be checked once more. */
  keep(recheck: Recheck): Effect.Effect<void>
  /** Takes the ticket out of those waiting, as checked once more; false when it wasn't waiting. */
  take(id: TicketId): Effect.Effect<boolean>
  /** Takes the ticket out of those waiting, not checked once more; false when it wasn't waiting. */
  drop(id: TicketId): Effect.Effect<boolean>
  /** Takes every ticket out of those waiting, not checked once more: those that were. */
  readonly dropAll: Effect.Effect<ReadonlyArray<Recheck>>
  /** Keeps what the ticket's check said as it set the ticket aside, in place of what it said before. */
  noteFailure(id: TicketId, evidence: string): Effect.Effect<void>
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
    drop: (id) =>
      Ref.modify(ref, (state) => {
        const waiting = state.waiting.filter((each) => each.ticket.id !== id)
        return [waiting.length < state.waiting.length, { ...state, waiting }]
      }),
    dropAll: Ref.modify(ref, (state) => [state.waiting, { ...state, waiting: [] }]),
    noteFailure: (id, evidence) => Ref.update(failures, (said) => new Map(said).set(id, evidence)),
    failures: Ref.get(failures),
  } satisfies Rechecks
})

// A line of a check's output naming a package that failed, by its import path (go test's FAIL,
// gotestsum's === FAIL:), or a file, by its position: a lint, vet or build error's
// `a.go:10:5: …`, tsc's `src/a.ts(10,5): error TS2322: …`, or a Biome diagnostic's header as the
// check keeps it (Checks.ts), `src/a.ts:10:5 lint/style/useConst  FIXABLE` or, for a file's
// format, `src/a.ts format`.
const failedPackage = /^(?:FAIL|=== FAIL:)\s+(\S+)/
const failedFile = /^([^\s:]+\.\w+):\d+(?::\d+)?: /
const failedInTsc = /^([^\s(]+\.\w+)\(\d+,\d+\): error TS\d/
const failedInBiome = /^([^\s:]+\.\w+)(?::\d+(?::\d+)?)? [a-z][\w/]*(?: +[A-Z]+)*$/

/** The file a line of a check's output names by its position; undefined when it names none. */
const fileOf = (line: string): string | undefined =>
  (failedFile.exec(line) ?? failedInTsc.exec(line) ?? failedInBiome.exec(line))?.[1]

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
    const file = pkg === undefined ? fileOf(each) : undefined
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
  options: MergeTarget,
  rechecks: Rechecks,
  onto: string,
  error: CheckError,
): Effect.Effect<Line | "", never, Git | Ledger> =>
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
    // The run winding down dropped the tickets waiting (dropRechecks): one set aside since isn't kept.
    if ((yield* (yield* Ledger).current).windDown !== null) {
      return line`; not checked again in this run, as it winds down`
    }
    yield* rechecks.keep({ ticket, onto, head: head.success })
    return line`; checked once more if ${options.base} moves on in this run`
  })

/**
 * Gives up checking once more the tickets waiting to be, as `why` rules it out (`the run winds
 * down`, `the run stopped`), saying so of each: they stay set aside, their sessions closed. The
 * tickets it gave up.
 */
export const dropRechecks = (
  rechecks: Pick<Rechecks, "dropAll">,
  why: string,
): Effect.Effect<ReadonlyArray<string>, never, AgentHost | Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const dropped = (yield* rechecks.dropAll).map((recheck) => recheck.ticket.id)
    for (const id of dropped) {
      const text = detail`${id} is not checked again in this run, as ${why}; it stays set aside`
      yield* info(text, id)
      yield* fit(id)
    }
    return dropped
  })

/** Whether the base, at `base` now, has moved on from `onto`: on from it, not merely elsewhere. */
const movedOn = (options: MergeTarget, onto: string, base: string) =>
  Effect.gen(function* () {
    // On a base moved back, its branch would fast-forward unchecked.
    return base !== onto && (yield* (yield* Git).mergeBase(options.repo, onto, base)) === onto
  }).pipe(Effect.orElseSucceed(() => false))

/**
 * Why the ticket, `issue` as bd has it now, is left as it is rather than checked once more, or
 * undefined.
 */
const whyNot = (recheck: Recheck, issue: Issue, options: MergeTarget) =>
  Effect.gen(function* () {
    const git = yield* Git
    const ledger = yield* Ledger
    const { id, branch, worktree } = recheck.ticket
    if (issue.status !== "closed") return line`it is ${issue.status} now`
    const status = yield* Effect.result(git.status(worktree))
    if (Result.isFailure(status) || trackedChanges(status.success).length > 0) {
      return line`${worktree} has uncommitted changes`
    }
    // The check runs in the worktree and would see them, but the merge of its branch wouldn't.
    const loose = untrackedFiles(status.success)
    if (loose.length > 0) return line`${worktree} has untracked files: ${someFiles(loose)}`
    const head = yield* Effect.result(git.revParse(options.repo, branch))
    if (Result.isFailure(head) || head.success !== recheck.head) {
      return line`${branch} has moved since its check failed`
    }
    if ((yield* ledger.current).tickets.get(id)?.steered === true) {
      return line`you have steered its worker`
    }
    return undefined
  })

/** Waits until ticket `id` has left the merge queue (merged, set aside or blocked), or the merges stop. */
const mergeOver = (queue: Pick<MergeQueue, "changes">, id: TicketId) =>
  queue.changes.pipe(
    Stream.filter(
      (state) =>
        state.stop !== null ||
        (state.merging !== id && !state.waiting.includes(id) && !state.resolving.includes(id)),
    ),
    Stream.runHead,
    Effect.asVoid,
  )

/** Whether no ticket is checked again now: the run winds down or holds, or the merges have stopped. */
const notNow = (queue: Pick<MergeQueue, "state">, options: MergeOptions) =>
  Effect.gen(function* () {
    if ((yield* (yield* Ledger).current).windDown !== null) return true
    if ((yield* queue.state).stop !== null) return true
    return (yield* options.noMore) !== undefined
  })

/**
 * Puts back in the merge queue, ToMerge by RECHECK, each ticket waiting to be checked once more
 * whose base has moved on since its check failed, each in a slot of its own until its merge is
 * over (`options.recheckSlot`); none while the run winds down or holds, the merges have stopped, a
 * solo ticket runs or is next, or no slot is free. A ticket touched since stays set aside, and the
 * log says why. `at`: where the base is, as a merge just put it; git is asked without it. The
 * tickets it put back.
 */
export const recheckDue = (
  rechecks: Rechecks,
  queue: Pick<MergeQueue, "offer" | "state" | "changes">,
  options: MergeOptions,
  at?: string,
): Effect.Effect<ReadonlyArray<string>, never, Beads | Git | Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const back: Array<string> = []
    // Where the base is, read once for every ticket waiting, when one is due a look.
    let base: Result.Result<string, GitError> | undefined =
      at === undefined ? undefined : Result.succeed(at)
    for (const recheck of yield* rechecks.waiting) {
      if (yield* notNow(queue, options)) break
      base ??= yield* Effect.result((yield* Git).revParse(options.repo, options.base))
      if (Result.isFailure(base) || !(yield* movedOn(options, recheck.onto, base.success))) continue
      const { id, branch } = recheck.ticket
      // Its slot is held from before its offer until its merge is over: a slot that waited for
      // nothing to start waiting would see it out of the queue before it went in.
      const offered = yield* Deferred.make<void>()
      const work = Effect.andThen(Deferred.await(offered), mergeOver(queue, id))
      if (!(yield* options.recheckSlot(id, work))) break
      const put = Effect.gen(function* () {
        // bd failing doesn't use up its recheck: it stays waiting, asked again at the next look.
        const issue = yield* Effect.result((yield* Beads).show(id))
        if (Result.isFailure(issue)) {
          const text = detail`${id} is not checked again yet: bd could not say whether it is still closed: ${beadsWhy(issue.failure)}; it is asked again at the next look`
          yield* info(text, id)
          return
        }
        if (!(yield* rechecks.take(id))) return
        const why = yield* whyNot(recheck, issue.success, options)
        if (why !== undefined) {
          const text = detail`${id} is not checked again: ${why}; it stays set aside`
          yield* info(text, id)
          return
        }
        const text = ticketLine(
          Tag.recheck,
        )`${id}'s check failed on ${options.base} at ${shortHash(recheck.onto)}, which has moved on since; rebasing ${branch} and checking it once more`
        yield* info(text, id)
        const moved = yield* queue.offer(recheck.ticket, (place) => Move.Recheck({ place }), false)
        if (Result.isSuccess(moved)) back.push(id)
      })
      yield* put.pipe(Effect.ensuring(Deferred.succeed(offered, undefined)))
    }
    return back
  })
