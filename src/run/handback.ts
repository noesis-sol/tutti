// The conflict hand-back (§ 4.7, § 5 item 7's MERGE_CONFLICT with hand-back, § 5.1's Merging →
// Resolving and Resolving → ToMerge, Blocked), as orchestra's handback.go has it. A finished
// ticket's rebase that stops on conflicts is handed back to its worker to resolve when it can take
// it: hand-backs on, a check command set to check the resolution with, attempts left, git able to say
// what the rebase stopped on, and its worker Idle or Failed and not steered, or its session closed by
// tutti, which is resumed for it (not a Gone resume, so it counts toward no resume limit). The
// rebase is left in progress, the ticket moves Merging → Resolving{attempt} with the RESOLVING
// line, and the merge queue goes on with the tickets behind it meanwhile.
//
// The hand-back is a client_composed message with orchestra's instructions. It is under way from its
// push until its send is no longer outstanding and the worker has settled, within resolve_timeout
// from the push. Then tutti looks at what the worker left without taking its word for it: the rebase
// finished, the worktree clean and on its branch, the branch on top of the base it was rebased onto
// with only the ticket's own commits, and the check passing. A resolution verified goes back in the
// merge queue, ToMerge; one rejected, or not done in time, is Blocked (MERGE_CONFLICT), the branch
// put back as the ticket closed it and the ticket's notes saying why. One whose check fails goes on
// to checkback.ts, which hands the failure back too, Fixing{afterResolution}, or blocks it.
//
// A conflict that can't be handed back is Blocked at once, its rebase aborted, and the MERGE_CONFLICT
// line says why. For a worker you have steered, the hand-back due to it waits: it is kept in
// `waiting`, for its view to offer as a notice (§ 4.3).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { type Duration, Effect, Option, Queue, Ref, Result, Stream } from "effect"
import { AgentHost, type From } from "../agent/AgentHost.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads } from "../services/Beads.ts"
import type { CheckError } from "../services/Checks.ts"
import { Git } from "../services/Git.ts"
import { Store } from "../services/Store.ts"
import { failedHow, runMergeCheck } from "./check.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, Log, line, resolving, Tag, ticketLine } from "./log.ts"
import {
  abandonRebase,
  type FinishedTicket,
  gitWhy,
  type MergeEnv,
  type MergeOptions,
  offBranch,
  uncommitted,
} from "./merge.ts"
import { Cause } from "./phase.ts"
import { answers, namesTicket, untilSettled } from "./settle.ts"

/** How many times a ticket's rebase conflicts are handed back to its worker in a run. */
export const maxHandBacks = 2

/** A rebase stopped on conflicts in a finished ticket's worktree, as the merge found it. */
export interface RebaseStop {
  readonly ticket: FinishedTicket
  /** The base's commit the branch was being rebased onto. */
  readonly onto: string
  /** The branch's commit before the rebase; "" when git couldn't say. */
  readonly head: string
  /** How many commits of its own the branch had then; -1 when git couldn't say. */
  readonly own: number
  /** The files the rebase stopped on. */
  readonly files: ReadonlyArray<string>
}

/** A run's conflict hand-backs: how many each ticket has had, and those waiting on you. */
export interface HandBacks {
  /** How many times the ticket's conflicts have been handed back to its worker in this run. */
  count(id: string): Effect.Effect<number>
  /** Counts one more hand-back of the ticket's conflicts: this one's number. */
  next(id: string): Effect.Effect<number>
  /**
   * The hand-backs due to workers you have steered, which wait until you hand them over: each
   * ticket's latest, in the order they came.
   */
  readonly waiting: Effect.Effect<ReadonlyArray<RebaseStop>>
  /** Keeps a hand-back due to a steered worker, in place of any earlier one of its ticket's. */
  wait(stop: RebaseStop): Effect.Effect<void>
  /** Takes the ticket's waiting hand-back out of those waiting; undefined when it has none. */
  take(id: string): Effect.Effect<RebaseStop | undefined>
}

/** A run's hand-backs: none yet. */
export const makeHandBacks: Effect.Effect<HandBacks> = Effect.gen(function* () {
  const ref = yield* Ref.make<{
    readonly counts: ReadonlyMap<string, number>
    readonly waiting: ReadonlyArray<RebaseStop>
  }>({ counts: new Map(), waiting: [] })
  return {
    count: (id) => Effect.map(Ref.get(ref), (state) => state.counts.get(id) ?? 0),
    next: (id) =>
      Ref.modify(ref, (state) => {
        const n = (state.counts.get(id) ?? 0) + 1
        return [n, { ...state, counts: new Map([...state.counts, [id, n]]) }]
      }),
    waiting: Effect.map(Ref.get(ref), (state) => state.waiting),
    wait: (stop) =>
      Ref.update(ref, (state) => ({
        ...state,
        waiting: [...state.waiting.filter((each) => each.ticket.id !== stop.ticket.id), stop],
      })),
    take: (id) =>
      Ref.modify(ref, (state) => {
        const found = state.waiting.find((each) => each.ticket.id === id)
        if (found === undefined) return [undefined, state]
        return [found, { ...state, waiting: state.waiting.filter((each) => each !== found) }]
      }),
  } satisfies HandBacks
})

/** Where the branch conflicts with the base, for a line: ` in a.ts, b.ts`, or nothing. */
const inFiles = (files: ReadonlyArray<string>): Line =>
  files.length === 0 ? line`` : line` in ${files}`

/** What a worker that can't take a hand-back is doing, for a line. */
export const away = (state: WorkerState): string | undefined => {
  switch (state._tag) {
    case "Idle":
    case "Failed":
    case "Closed":
      return undefined
    case "Starting":
      return "its worker is starting"
    case "Working":
      return "its worker is working"
    case "Retrying":
      return "its worker is retrying"
    case "NeedsYou":
      return "its worker needs you"
    case "UsageLimited":
      return "its worker is at the account's usage limit"
    case "Gone":
      return `its worker is gone (${state.why})`
  }
}

/** Why the conflicts can't be handed back, and whether the hand-back waits for you. */
export interface NotHandedBack {
  readonly why: string
  /** Its worker is steered: the hand-back waits in its view. */
  readonly waits: boolean
}

/**
 * Why `stop` can't be handed back to the ticket's worker, the `handedBack`th time so far; undefined
 * when it can.
 */
export const whyNotHandBack = (
  stop: RebaseStop,
  handedBack: number,
): Effect.Effect<NotHandedBack | undefined, never, AppConfig | AgentHost | Ledger | Store> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ledger = yield* Ledger
    const { id } = stop.ticket
    const not = (why: string, waits = false) => ({ why, waits }) satisfies NotHandedBack
    if (!config.settings.merge.resolve_conflicts) return not("resolving conflicts is turned off")
    if (config.settings.checks.fast.command === null) {
      return not("there is no check command in .tutti/settings.json to check a resolution with")
    }
    if (handedBack >= maxHandBacks) {
      return not(`it was handed back to its worker ${handedBack} times already`)
    }
    if (stop.head === "" || stop.own < 1 || stop.files.length === 0) {
      return not("git could not say what the rebase stopped on")
    }
    if ((yield* ledger.current).tickets.get(id)?.steered === true) {
      return not("you have steered its worker, so the hand-back waits in its view", true)
    }
    const busy = yield* workerAway(id)
    return busy === undefined ? undefined : not(busy)
  })

/**
 * Why the ticket's worker can't take a hand-back, as it is now: undefined when it is Idle or
 * Failed, or its session, closed by tutti in this run or an earlier one, can be resumed.
 */
export const workerAway = (
  id: string,
): Effect.Effect<string | undefined, never, AgentHost | Store> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const store = yield* Store
    const state = yield* Effect.result(host.current(id))
    if (Result.isSuccess(state)) return away(state.success)
    // No worker in this run: its session, closed by an earlier one, is resumed.
    const saved = yield* store.ticket(id)
    return saved?.session === undefined ? "its worker has no session to resume" : undefined
  })

/** What the worker is asked to do with a rebase stopped on conflicts, as orchestra asks it. */
export const resolvePrompt = (stop: RebaseStop, base: string, check: string): string =>
  `tutti: ${base} moved on while you worked; rebasing ${stop.ticket.branch} onto it stopped on ` +
  `conflicts in ${stop.files.join(", ")}. ` +
  `Resolve them keeping the intent of both your change and what landed on ${base}, ` +
  "then git add the files and run GIT_EDITOR=true git rebase --continue; " +
  "if the rebase stops on another commit, resolve that one the same way. " +
  `If ${base} has a commit's change already, wholly or as the part that conflicts, run git rebase ` +
  "--skip for that commit instead of resolving it. " +
  `Once the rebase has finished, run '${check}' in the foreground until it passes, since the ` +
  "commits that applied cleanly may break it too; fold any fix into the branch's last commit with " +
  "git commit --amend --no-edit. " +
  "Don't do anything else: no new commits beyond the rebase, no merge, no push, no ticket changes. " +
  "Say DONE when the rebase is complete and the check passes."

/** The MERGE_CONFLICT line of a ticket whose conflicts aren't resolved, saying why. */
const conflictLine = (stop: RebaseStop, base: string, why: string): Line => {
  const { id, branch, worktree } = stop.ticket
  return ticketLine(
    Tag.mergeConflict,
  )`${id} closed, but ${branch} conflicts with ${base}${inFiles(stop.files)}, which moved on while it ran (${why}); worktree ${worktree} left for review (rebase onto ${base}, check, merge)`
}

/**
 * Blocks the ticket on its conflicts (MERGE_CONFLICT), saying why: by Block from Merging or
 * Resolving, by Aside from Fixing{afterResolution}.
 */
const block = (stop: RebaseStop, base: string, why: string, by: "Block" | "Aside" = "Block") =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const { files } = stop
    const text = conflictLine(stop, base, why)
    const cause =
      by === "Block"
        ? Cause.Block({ why: Tag.mergeConflict })
        : Cause.Aside({ why: Tag.mergeConflict })
    yield* ledger.transition(stop.ticket.id, cause, {
      beside: [
        {
          kind: "warn",
          ticket: stop.ticket.id,
          aside: true,
          detail: `conflicts with ${base}`,
          blocked:
            files.length === 0
              ? `merge conflict with ${base}`
              : `merge conflict in ${files.join(", ")}`,
          text,
        },
      ],
    })
    yield* logs.write(text)
  })

/**
 * Sets aside `stop`'s conflicts without handing them back: the rebase aborted, the ticket Blocked,
 * and the MERGE_CONFLICT line saying why. A hand-back due to a steered worker is kept, waiting.
 */
export const notHandedBack = (
  stop: RebaseStop,
  options: MergeOptions,
  not: NotHandedBack,
  handBacks: HandBacks,
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { worktree } = stop.ticket
    yield* abandonRebase(worktree)
    const stuck = yield* Effect.result(git.rebaseInProgress(worktree))
    const left =
      Result.isSuccess(stuck) && !stuck.success
        ? ""
        : line`; its rebase could not be aborted, so ${worktree} is left mid-rebase`
    if (not.waits) yield* handBacks.wait(stop)
    yield* block(stop, options.base, `not handed back to its worker: ${not.why}${left}`)
  })

/**
 * Hands `stop`'s conflicts back: the ticket Merging → Resolving, its attempt counted, and the
 * RESOLVING line. False when the ledger refused (PHASE_BUG): the rebase is then aborted.
 */
export const handOver = (
  stop: RebaseStop,
  options: MergeOptions,
  handBacks: HandBacks,
): Effect.Effect<boolean, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { id } = stop.ticket
    const attempt = (yield* handBacks.count(id)) + 1
    const moved = yield* ledger.transition(id, Cause.ConflictsHandedBack({ attempt }))
    if (Result.isFailure(moved)) {
      yield* abandonRebase(stop.ticket.worktree)
      return false
    }
    yield* handBacks.next(id)
    const text = resolving({
      id,
      base: options.base,
      files: stop.files,
      limit: formatDuration(config.settings.merge.resolve_timeout),
    })
    yield* events.emit({ kind: "info", ticket: id, text })
    yield* logs.write(text)
    return true
  })

/** How a worker in `state` is described once its time ran out. */
const still = (state: WorkerState): string =>
  away(state) ?? (state._tag === "Closed" ? "its session is closed" : "its worker is idle")

/**
 * Gives the ticket's worker a hand-back, `prompt`, resuming its session if tutti closed it, and
 * waits until its send is no longer outstanding and the worker has settled, within `limit` from the
 * push. Why it wasn't done; undefined when what it left is to be looked at.
 */
export const give = (
  ticket: FinishedTicket,
  prompt: string,
  limit: Duration.Duration,
): Effect.Effect<string | undefined, never, AgentHost | Store> =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* AgentHost
      const store = yield* Store
      const { id, worktree } = ticket
      const from: From = "clientComposed"
      const state = yield* Effect.result(host.current(id))
      let taken: Effect.Effect<void>
      if (Result.isSuccess(state) && state.success._tag !== "Closed") {
        // The session's messages are taken from before the send, so its turn's result can't be
        // missed.
        const heard = yield* Queue.unbounded<SDKMessage>()
        yield* host.messages(id).pipe(
          Stream.runForEach(({ message }) => Queue.offer(heard, message)),
          Effect.ignore,
          Effect.forkScoped({ startImmediately: true }),
        )
        const sent = yield* Effect.result(host.send(id, prompt, from))
        if (Result.isFailure(sent)) {
          return line`its worker did not take the hand-back (${sent.failure.why})`
        }
        const answered = Stream.fromQueue(heard).pipe(
          Stream.filter((message) => answers(message, sent.success)),
          Stream.runHead,
        )
        const ended = host.state(id).pipe(
          Stream.filter((each) => each._tag === "Gone" || each._tag === "Closed"),
          Stream.runHead,
          Effect.ignore,
        )
        taken = Effect.raceFirst(Effect.asVoid(answered), ended)
      } else {
        const session = (yield* store.ticket(id))?.session
        if (session === undefined) return line`its worker has no session to resume`
        const resumed = yield* Effect.result(
          host.resume(id, { sessionId: session, cwd: worktree }, { text: prompt, from }),
        )
        if (Result.isFailure(resumed)) {
          return line`its session could not be resumed: ${resumed.failure.reason}`
        }
        // The resume put its state back at Starting: it settles only once the hand-back's turn,
        // the first of a resumed session, is over.
        taken = Effect.void
      }
      const settled = yield* Effect.raceFirst(
        Effect.map(Effect.andThen(taken, untilSettled(id)), Option.some),
        Effect.as(Effect.sleep(limit), Option.none<WorkerState>()),
      )
      if (Option.isSome(settled)) return undefined
      const now = yield* Effect.result(host.current(id))
      const how = Result.isSuccess(now) ? still(now.success) : "its worker is gone"
      return line`${how} after ${formatDuration(limit)}, with the hand-back not done`
    }),
  )

/**
 * Why what the worker left is rejected, looked at without taking its word for it: the rebase over,
 * the worktree clean and on its branch, and the branch on top of the base it was rebased onto with
 * the ticket's own commits and nothing more (as many as it had, or fewer where its worker skipped
 * those the base has already). A branch left changing nothing passes too. Undefined when it passes.
 */
export const verifyResolved = (
  stop: RebaseStop,
  options: MergeOptions,
): Effect.Effect<string | undefined, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { id, branch, worktree } = stop.ticket
    const { repo, base } = options
    const read = yield* Effect.result(
      Effect.gen(function* () {
        if (yield* git.rebaseInProgress(worktree))
          return line`its worker left the rebase unfinished`
        if (uncommitted(yield* git.status(worktree)).length > 0) {
          return line`its worker left uncommitted changes in ${worktree}`
        }
        const on = yield* offBranch(stop.ticket)
        if (on !== undefined) return line`its worker left ${worktree} with ${on}, not ${branch}`
        if ((yield* git.mergeBase(repo, stop.onto, branch)) !== stop.onto) {
          return line`${branch} is not on top of ${base} as it was rebased onto`
        }
        if ((yield* git.changedFiles(repo, stop.onto, branch)).length === 0) return undefined
        const commits = yield* git.log(repo, stop.onto, branch)
        if (!commits.some((commit) => namesTicket(commit.message, id))) {
          return line`no commit on ${branch} names ${id} any more`
        }
        if (commits.length > stop.own) {
          return line`${branch} has ${commits.length} commits where the ticket had ${stop.own} (a commit made besides the rebase?)`
        }
        return undefined
      }),
    )
    return Result.isSuccess(read)
      ? read.success
      : line`git could not say what its worker left: ${gitWhy(read.failure)}`
  })

/**
 * Puts the branch back as the ticket closed it, at `stop.head`, after a rejected resolution: a
 * rebase in progress aborted, and the branch reset when it is elsewhere and the worktree is clean
 * and on it. What it did, for the lines and notes.
 */
export const undoResolution = (stop: RebaseStop): Effect.Effect<string, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { branch, worktree } = stop.ticket
    const to = stop.head
    const short = (hash: string) => hash.slice(0, 10)
    let aborted = false
    const rebasing = yield* Effect.result(git.rebaseInProgress(worktree))
    if (Result.isFailure(rebasing) || rebasing.success) {
      const abort = yield* Effect.result(git.abortRebase(worktree))
      if (Result.isFailure(abort)) {
        return line`the rebase could not be aborted, so ${worktree} is left mid-rebase`
      }
      aborted = true
    }
    const status = yield* Effect.result(git.status(worktree))
    const dirty = Result.isFailure(status) || uncommitted(status.success).length > 0
    const at = yield* Effect.result(git.revParse(worktree, branch))
    const now = Result.isSuccess(at) ? at.success : ""
    if (now === to) {
      return aborted ? line`the rebase was aborted` : line`${branch} is as the ticket closed it`
    }
    if (dirty) {
      return line`${branch} is left as its worker left it (it was at ${short(to)} before the rebase)`
    }
    const on = yield* offBranch(stop.ticket)
    if (on !== undefined) {
      return line`${branch} is left at ${short(now)} (it was at ${short(to)} before the rebase), as ${worktree} has ${on}`
    }
    const reset = yield* Effect.result(git.resetBranch(worktree, to))
    if (Result.isFailure(reset)) {
      return line`${branch} could not be reset to ${short(to)}, where it was before the rebase; it is left at ${short(now)}`
    }
    return line`${branch} was reset to ${short(to)}, where it was before the rebase (its worker's attempt is ${short(now)})`
  })

/**
 * How a hand-back ended: the resolution verified and checked, the ticket blocked, or the resolution
 * verified but its check failing, for checkback.ts to hand back or block.
 */
export type Resolved =
  | { readonly _tag: "Verified" }
  | { readonly _tag: "Blocked" }
  | { readonly _tag: "CheckFailed"; readonly error: CheckError; readonly output: string }

/** Why a resolution whose check fails is rejected, for its lines and notes. */
export const failedResolved = (stop: RebaseStop, error: CheckError, output: string): string => {
  const where = error._tag === "CheckTimedOut" ? "" : line` (output is in ${output})`
  return line`${failedHow(error)} on the resolved ${stop.ticket.branch}${where}`
}

/**
 * Rejects the worker's resolution of `stop` for `why`: its branch put back as the ticket closed it,
 * its notes saying why, and the ticket Blocked (MERGE_CONFLICT), by `by` (see block).
 */
export const rejectResolution = (
  stop: RebaseStop,
  options: MergeOptions,
  why: string,
  by: "Block" | "Aside" = "Block",
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const { id, branch } = stop.ticket
    const { base } = options
    const undone = yield* undoResolution(stop)
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: `tutti: ${branch} conflicted with ${base} in ${stop.files.join(", ")}; its worker was asked to resolve the rebase, but ${why}, so ${id} was set aside for review; ${undone}.`,
      }),
    )
    yield* block(stop, base, `handed back to its worker, but ${why}; ${undone}`, by)
  })

/**
 * The hand-back of `stop`'s conflicts to the ticket's worker, Resolving: the hand-back given, what
 * the worker left verified and checked. Verified: the caller puts it back in the merge queue; its
 * check failing: the caller hands that back, or blocks it (checkback.ts). Else it is Blocked here,
 * its branch put back and its notes saying why.
 */
export const resolve = (
  stop: RebaseStop,
  options: MergeOptions,
): Effect.Effect<Resolved, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const logs = yield* Log
    const { id } = stop.ticket
    const { base } = options
    const check = config.settings.checks.fast.command ?? ""
    const limit = config.settings.merge.resolve_timeout
    let why: string | undefined = yield* give(stop.ticket, resolvePrompt(stop, base, check), limit)
    if (why === undefined) why = yield* verifyResolved(stop, options)
    if (why === undefined) {
      yield* logs.write(detail`${id}'s worker finished the rebase; checking it with '${check}'`)
      const checked = yield* runMergeCheck(stop.ticket)
      if (checked._tag !== "Failed") return { _tag: "Verified" } satisfies Resolved
      return {
        _tag: "CheckFailed",
        error: checked.error,
        output: checked.output,
      } satisfies Resolved
    }
    yield* rejectResolution(stop, options, why)
    return { _tag: "Blocked" } satisfies Resolved
  })
