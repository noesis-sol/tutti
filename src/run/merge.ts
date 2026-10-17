// A finished ticket's merge (§ 5 item 7, § 5.1's Merging), one at a time from the merge queue. It
// comes in two parts:
//
// - prepare, which may be interrupted: a worktree off its branch (OFF_BRANCH) is set aside before
//   anything is done; when the base moved on while the ticket ran, a worktree with uncommitted
//   changes (DIRTY_WORKTREE) is set aside, and the branch is rebased (a refusal is REBASE_FAILED,
//   conflicts MERGE_CONFLICT), set up when the rebase changed a dependency file (setup.ts), and
//   checked again (CHECKS_FAILED, a failing setup too). A rebase interrupted is aborted, putting the
//   branch back; a setup or check interrupted is killed.
// - fastForward, the step from the fast-forward to the end of its notes, which the merge queue runs
//   protected from interruption (§ 3.4): the main checkout ready (DIRTY_TREE, GIT_FAILED), the base
//   fast-forwarded (MERGE_FAILED), the worktree and branch removed, the epics the ticket was the last
//   to merge under closed, up the tree. exec's time limits kill a command themselves, without
//   interrupting its fiber, so each git command's limit holds in there too.
//
// Hand-backs (Resolving, Fixing) come later: for now a conflict is Blocked and a failing check is set aside for review, kept to be checked once more
// once the base moves on (recheck.ts).
import { Effect, Result } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, type BeadsError } from "../services/Beads.ts"
import type { CheckError, Checks } from "../services/Checks.ts"
import { Git, type GitError, type StatusEntry } from "../services/Git.ts"
import { runFolder, Worktrees } from "../services/Worktrees.ts"
import { leaveForReview } from "./aside.ts"
import { failedHow, runMergeCheck, saidOf } from "./check.ts"
import type { Event } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, Log, line, Tag, tagged, ticketLine } from "./log.ts"
import { Cause, Detail } from "./phase.ts"
import { keepForRecheck, type Rechecks } from "./recheck.ts"
import { type SetUps, setUp } from "./setup.ts"
import { ignoredFolders } from "./startup.ts"

/** A ticket its worker finished: closed, committed, its worktree clean and on its branch. */
export interface FinishedTicket {
  readonly id: string
  /** Its title as Beads gave it. */
  readonly title: string
  /** `tutti/<id>`. */
  readonly branch: string
  /** Its worktree's folder, absolute. */
  readonly worktree: string
}

export interface MergeOptions {
  /** The main checkout. */
  readonly repo: string
  /** The branch finished tickets land on. */
  readonly base: string
}

/** What stops the merges, and the exit code the run ends with for it (§ 5 item 10). */
export const stopCodes = { DIRTY_TREE: 5, GIT_FAILED: 4, MERGE_FAILED: 6 } as const
export type StopWhy = keyof typeof stopCodes

/** A merge that stopped the merges: its ticket is Blocked, and the run holds or stops. */
export interface MergeStop {
  readonly why: StopWhy
  readonly code: number
  readonly ticket: string
  /** The line the log has for it. */
  readonly line: Line
}

/** What prepare leaves: the merge over (set aside, blocked or stopped), or ready to fast-forward. */
export type Prepared =
  | { readonly _tag: "Over"; readonly stop?: MergeStop }
  | { readonly _tag: "Ready"; readonly onto: string }

/**
 * How many passes may find the base moved and rebase onto it. Only merges move it during a run,
 * and they queue; a second pass covers a commit made by hand while the check ran.
 */
export const maxPasses = 3

/** What git said of its failure, in a few words. */
export const gitWhy = (error: GitError): string =>
  error._tag === "GitFailed"
    ? (error.stderr.trim().split("\n")[0] ?? "") || `exit code ${error.exitCode}`
    : `git took longer than ${formatDuration(error.timeLimit)}`

/** What bd said of its failure, in a few words. */
export const beadsWhy = (error: BeadsError): string => {
  switch (error._tag) {
    case "BeadsFailed":
      return (error.stderr.trim().split("\n")[0] ?? "") || `exit code ${error.exitCode}`
    case "BeadsTimedOut":
      return `bd took longer than ${formatDuration(error.timeLimit)}`
    case "BeadsUnreadable":
      return error.reason
  }
}

/** Whether `path` is `folder` or inside it. */
const under = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`)

/** The tracked files with uncommitted changes, outside .tutti/run/: git won't rebase over them. */
export const uncommitted = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  status
    .filter((entry) => entry.code !== "??" && entry.code !== "!!" && !under(entry.path, runFolder))
    .map((entry) => entry.path)
    .sort()

/** The changed files in the main checkout outside the tools' folders, as the startup checks see them. */
export const changedOutsideTools = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  status
    .map((entry) => entry.path)
    .filter((path) => !ignoredFolders.some((folder) => under(path, folder)))
    .sort()

/** `n` subtickets are merged, as the epic's line says. */
export const allMerged = (n: number): string =>
  n === 1 ? "its 1 subticket is merged" : `all ${n} subtickets are merged`

/** Every service a merge uses. */
export type MergeEnv = AppConfig | Git | Worktrees | Beads | Ledger | Log | EventStream | Checks

const services = Effect.all({
  config: AppConfig,
  git: Git,
  worktrees: Worktrees,
  beads: Beads,
  ledger: Ledger,
  log: Log,
  events: EventStream,
})

/** Sets the ticket aside for review, Merging → Review, with its note, warn record and log line. */
const aside = (ticket: FinishedTicket, why: string, short: string, text: Line) =>
  leaveForReview(ticket.id, { why, detail: short, text })

/** The ticket can't merge until you act: Merging → Blocked, with `record` beside it. */
const block = (ticket: FinishedTicket, why: string, record: Event, text: Line) =>
  Effect.gen(function* () {
    const { ledger, log } = yield* services
    yield* ledger.transition(ticket.id, Cause.Block({ why }), { beside: [record] })
    yield* log.write(text)
  })

/** A merge that stops the merges: DIRTY_TREE and GIT_FAILED hold the run, MERGE_FAILED stops it. */
const stopOver = (ticket: FinishedTicket, why: StopWhy, blocked: string, reason: string) =>
  Effect.gen(function* () {
    const text =
      why === "MERGE_FAILED" ? tagged(why)`${reason}` : tagged(Tag.hold)`${line`${why}: ${reason}`}`
    const record: Event =
      why === "MERGE_FAILED"
        ? { kind: "stop", detail: why, ticket: ticket.id, blocked, text }
        : { kind: "hold", ticket: ticket.id, blocked, text }
    yield* block(ticket, why, record, text)
    return { why, code: stopCodes[why], ticket: ticket.id, line: text } satisfies MergeStop
  })

/** What the worktree has checked out when it isn't the ticket's branch; undefined when it is. */
export const offBranch = (ticket: FinishedTicket) =>
  Effect.gen(function* () {
    const { git } = yield* services
    const on = yield* Effect.result(git.currentBranch(ticket.worktree))
    // git's own errors set the ticket aside later, if need be.
    if (Result.isFailure(on)) return undefined
    if (on.success._tag === "Some") {
      return on.success.value === ticket.branch ? undefined : `${on.success.value} checked out`
    }
    const rebasing = yield* Effect.result(git.rebaseInProgress(ticket.worktree))
    return Result.isSuccess(rebasing) && rebasing.success
      ? "a rebase in progress, on a detached HEAD"
      : "a detached HEAD"
  })

/** Puts the branch back after a rebase that didn't finish, if one is under way. */
export const abandonRebase = (worktree: string) =>
  Effect.gen(function* () {
    const { git } = yield* services
    if (yield* git.rebaseInProgress(worktree)) yield* git.abortRebase(worktree)
  }).pipe(Effect.ignore)

/** What a merge keeps of each ticket for the run: the rechecks due, the setups done. */
export interface MergeMemory {
  readonly rechecks: Rechecks
  readonly setUps: SetUps
}

/**
 * Rebases the ticket, its branch off the base at `fork`, onto the base, which moved on to `onto`,
 * sets it up if need be and checks it; the merge is over when any of them sets it aside. An
 * interrupted rebase is aborted here too, whichever Git it ran on.
 */
const rebaseAndCheck = (
  ticket: FinishedTicket,
  options: MergeOptions,
  memory: MergeMemory,
  fork: string,
  onto: string,
) =>
  Effect.gen(function* () {
    const { git, ledger, log } = yield* services
    const { id, branch, worktree } = ticket
    const { base } = options
    const status = yield* Effect.result(git.status(worktree))
    const dirty = Result.isSuccess(status) ? uncommitted(status.success) : []
    if (dirty.length > 0) {
      yield* aside(
        ticket,
        Tag.dirtyWorktree,
        "uncommitted changes in its worktree",
        ticketLine(
          Tag.dirtyWorktree,
        )`${id} closed, but ${worktree} has uncommitted changes to ${dirty}, so ${branch} can't be rebased onto ${base}, which moved on while it ran; worktree left for review (commit or undo them, rebase onto ${base}, check, merge)`,
      )
      return false
    }
    yield* ledger.refine(id, Detail.Step({ step: "rebase" }))
    const rebased = yield* Effect.result(
      git.rebase(worktree, base).pipe(Effect.onInterrupt(() => abandonRebase(worktree))),
    )
    if (Result.isFailure(rebased)) {
      const error = rebased.failure
      if (error._tag === "RebaseConflict") {
        // Not handed back to its worker (that comes later): the branch is put back as it closed.
        yield* abandonRebase(worktree)
        const files = error.files
        const text = ticketLine(
          Tag.mergeConflict,
        )`${id} closed, but ${branch} conflicts with ${base} in ${files}, which moved on while it ran; worktree ${worktree} left for review (rebase onto ${base}, check, merge)`
        yield* block(
          ticket,
          Tag.mergeConflict,
          {
            kind: "warn",
            ticket: id,
            aside: true,
            detail: `conflicts with ${base}`,
            blocked:
              files.length === 0
                ? `merge conflict with ${base}`
                : `merge conflict in ${files.join(", ")}`,
            text,
          },
          text,
        )
        return false
      }
      yield* aside(
        ticket,
        Tag.rebaseFailed,
        "rebase failed",
        ticketLine(
          Tag.rebaseFailed,
        )`${id} closed, but git could not rebase ${branch} onto ${base}, which moved on while it ran: ${gitWhy(error)}; worktree ${worktree} left for review`,
      )
      return false
    }
    yield* log.write(detail`rebased ${branch} onto ${base}, which moved on while it ran`)
    const setup = yield* setUp(ticket, options, memory.setUps, fork, onto)
    if (setup._tag === "Failed") {
      yield* checksFailed(ticket, options, memory.rechecks, onto, setup.error, setup.output)
      return false
    }
    yield* ledger.refine(id, Detail.Step({ step: "check" }))
    const checked = yield* runMergeCheck(ticket)
    switch (checked._tag) {
      case "Unchecked":
        yield* log.write(
          detail`no check command in .tutti/settings.json: merging ${branch} without checking the rebased code`,
        )
        return true
      case "Passed":
        return true
      case "Failed":
        yield* checksFailed(ticket, options, memory.rechecks, onto, checked.error, checked.output)
        return false
    }
  })

/** The short why of a ticket set aside as its check, or the setup before it, failed. */
export const checksFailedDetail = (error: CheckError): string => {
  const what = error.check === "setup" ? "setup" : "checks"
  return `${what} ${error._tag === "CheckTimedOut" ? "timed out" : "failed"}`
}

/**
 * Sets the ticket aside as its check, or the setup before it, failed on its branch rebased onto the
 * base at `onto`, kept to be checked once more once the base moves on, unless this was that once
 * (recheck.ts).
 */
const checksFailed = (
  ticket: FinishedTicket,
  options: MergeOptions,
  rechecks: Rechecks,
  onto: string,
  error: CheckError,
  output: string,
) =>
  Effect.gen(function* () {
    const { log } = yield* services
    const where = error._tag === "CheckNotRun" ? "" : line` (output is in ${output})`
    const again = (yield* rechecks.rechecked(ticket.id)) ? " again" : ""
    const later = yield* keepForRecheck(ticket, options, rechecks, onto, error)
    yield* aside(
      ticket,
      Tag.checksFailed,
      `${checksFailedDetail(error)}${again}`,
      ticketLine(
        Tag.checksFailed,
      )`${ticket.id} closed, but ${failedHow(error)}${again} on ${ticket.branch} rebased onto ${options.base}; worktree ${ticket.worktree} left for review${where}${later}`,
    )
    const said = saidOf(error)
    if (said.length > 0) yield* log.write(...said.map((each) => detail`  ${each}`))
  })

/**
 * The part of the merge that may be interrupted: the ticket's worktree checked to be on its branch,
 * and, each time the base has moved on, rebased onto it, set up if need be and checked. Ready once
 * its branch is on top of the base; over when it was set aside (kept in the memory's rechecks when
 * its check failed), blocked or stopped the merges.
 */
export const prepare = (
  ticket: FinishedTicket,
  options: MergeOptions,
  memory: MergeMemory,
): Effect.Effect<Prepared, never, MergeEnv> =>
  Effect.gen(function* () {
    const { git } = yield* services
    const { id, branch, worktree } = ticket
    const { repo, base } = options
    const on = yield* offBranch(ticket)
    if (on !== undefined) {
      yield* aside(
        ticket,
        Tag.offBranch,
        `worktree not on ${branch}`,
        ticketLine(
          Tag.offBranch,
        )`${id} closed, but its worktree ${worktree} has ${on}, not ${branch}; worktree left for review`,
      )
      return { _tag: "Over" } satisfies Prepared
    }
    for (let pass = 0; ; pass++) {
      const where = yield* Effect.result(
        Effect.all({ onto: git.revParse(repo, base), fork: git.mergeBase(repo, base, branch) }),
      )
      if (Result.isFailure(where)) {
        const stop = yield* stopOver(
          ticket,
          "GIT_FAILED",
          "git failed",
          line`could not tell where ${branch} left ${base}: ${gitWhy(where.failure)}; ${branch} is not merged, its worktree ${worktree} left for review`,
        )
        return { _tag: "Over", stop } satisfies Prepared
      }
      const { onto, fork } = where.success
      if (fork === onto) return { _tag: "Ready", onto } satisfies Prepared
      if (pass === maxPasses) {
        const text = ticketLine(
          Tag.mergeConflict,
        )`${id} closed, but ${base} kept changing while its checks ran (commits made by hand?); worktree ${worktree} left for review`
        yield* block(
          ticket,
          Tag.mergeConflict,
          {
            kind: "warn",
            ticket: id,
            aside: true,
            detail: `${base} kept changing`,
            blocked: `${base} kept changing`,
            text,
          },
          text,
        )
        return { _tag: "Over" } satisfies Prepared
      }
      if (!(yield* rebaseAndCheck(ticket, options, memory, fork, onto))) {
        return { _tag: "Over" } satisfies Prepared
      }
    }
  })

/** The epics `id` was the last subticket to merge under, closed, each then its own parent's. */
const closeEpics = (id: string) =>
  Effect.gen(function* () {
    const { config, beads, ledger, log, events } = yield* services
    const say = (text: Line, ticket: string) =>
      Effect.andThen(log.write(text), events.emit({ kind: "info", ticket, text }))
    const shown = yield* Effect.result(beads.show(id))
    let parent = Result.isSuccess(shown) ? shown.success.parent : undefined
    while (parent !== undefined) {
      const epic = parent
      const read = yield* Effect.result(
        Effect.all({ issue: beads.show(epic), children: beads.list({ parent: epic, all: true }) }),
      )
      if (Result.isFailure(read)) {
        yield* say(
          detail`bd could not say whether the subtickets of ${epic} are all merged: ${beadsWhy(read.failure)}; it is left open`,
          epic,
        )
        return
      }
      const { issue, children } = read.success
      if (issue.status === "closed" || !config.settings.queue.exclude_types.includes(issue.type)) {
        return
      }
      const state = yield* ledger.current
      const merged = children.every(
        (child) =>
          child.status === "closed" &&
          !child.labels.includes("unmerged") &&
          (state.tickets.get(child.id)?.phase._tag ?? "Done") === "Done",
      )
      if (!merged) return
      const all = allMerged(children.length)
      const closed = yield* Effect.result(
        beads.close(epic, `${all[0]?.toUpperCase()}${all.slice(1)}; closed by tutti after ${id}`),
      )
      if (Result.isFailure(closed)) {
        yield* say(
          detail`${all}, but bd could not close ${epic}: ${beadsWhy(closed.failure)}; close it with: bd close ${epic}`,
          epic,
        )
        return
      }
      yield* say(detail`closed epic ${epic}: ${all}`, epic)
      parent = issue.parent
    }
  })

/**
 * The protected step: the base fast-forwarded to the ticket's branch, on top of it at `onto`, in
 * the main checkout, then the worktree and branch removed, the ticket Done and the epics above it
 * closed. Undefined when it merged; the stop when the main checkout or git kept it from merging.
 */
export const fastForward = (
  ticket: FinishedTicket,
  options: MergeOptions,
  onto: string,
): Effect.Effect<MergeStop | undefined, never, MergeEnv> =>
  Effect.gen(function* () {
    const { git, worktrees, ledger, log } = yield* services
    const { id, title, branch, worktree } = ticket
    const { repo, base } = options
    yield* ledger.refine(id, Detail.Step({ step: "fast-forward" }))
    const left = line`${branch} is not merged, its worktree ${worktree} left for review`
    const checkout = yield* Effect.result(
      Effect.all({ status: git.status(repo), on: git.currentBranch(repo) }),
    )
    if (Result.isFailure(checkout)) {
      return yield* stopOver(
        ticket,
        "GIT_FAILED",
        "git failed",
        line`could not read the state of ${repo}: ${gitWhy(checkout.failure)}; ${left}`,
      )
    }
    if (changedOutsideTools(checkout.success.status).length > 0) {
      return yield* stopOver(
        ticket,
        "DIRTY_TREE",
        "main checkout has uncommitted changes",
        line`uncommitted changes in ${repo}; ${left}. Inspect with: git status`,
      )
    }
    const on = checkout.success.on
    if (on._tag === "None" || on.value !== base) {
      return yield* stopOver(
        ticket,
        "DIRTY_TREE",
        `main checkout is not on ${base}`,
        line`${repo} is no longer on ${base}; ${left}. Check it out again to continue`,
      )
    }
    const merged = yield* Effect.result(git.fastForward(repo, branch))
    if (Result.isFailure(merged)) {
      // Changes git leaves out of a clean tree (.beads/, .tutti/run/) can be in the way too.
      const local = new Set(checkout.success.status.map((entry) => entry.path))
      const changed = yield* Effect.result(git.changedFiles(repo, base, branch))
      const inTheWay = Result.isSuccess(changed)
        ? changed.success.filter((path) => local.has(path)).sort()
        : []
      if (inTheWay.length > 0) {
        return yield* stopOver(
          ticket,
          "DIRTY_TREE",
          "main checkout has uncommitted changes",
          line`uncommitted changes in ${repo} to ${inTheWay}, which ${branch} changes; ${left}. Commit or undo them, then run again`,
        )
      }
      return yield* stopOver(
        ticket,
        "MERGE_FAILED",
        `does not fast-forward onto ${base}`,
        line`${branch} does not fast-forward onto ${base}: ${gitWhy(merged.failure)}; its worktree ${worktree} left for review`,
      )
    }
    const commits = yield* Effect.result(git.log(repo, onto, base))
    const own = Result.isSuccess(commits) ? commits.success : []
    const commit = own.find((each) => each.message.includes(id)) ?? own[0]
    let hash = commit?.hash
    if (hash === undefined) {
      const head = yield* Effect.result(git.revParse(repo, base))
      hash = Result.isSuccess(head) ? head.success : onto
    }
    const short = hash.slice(0, 7)
    const named = commit === undefined ? short : line`${short} ${commit.subject}`
    const cleanup = yield* Effect.result(worktrees.remove(id))
    const text = Result.isSuccess(cleanup)
      ? detail`${id} closed (${named}); merged into ${base}, worktree and branch removed`
      : detail`${id} closed (${named}); merged into ${base}, but ${Tag.cleanupFailed} for ${worktree} / ${branch}: ${
          cleanup.failure._tag === "BadTicketId" ? cleanup.failure.why : gitWhy(cleanup.failure)
        }`
    yield* ledger.transition(id, Cause.FastForwarded({ commit: hash }), {
      beside: [
        {
          kind: "closed",
          ticket: id,
          title,
          detail: Result.isSuccess(cleanup)
            ? `${short} merged into ${base}`
            : `${short} merged; cleanup failed`,
          text,
        },
      ],
    })
    yield* log.write(text)
    yield* closeEpics(id)
    return undefined
  })
