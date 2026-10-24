// A ticket merged by hand while the run goes on (§ 5 item 8, orchestra 0.9.0's handmerged.go). A
// ticket closed but not merged, set aside or blocked in this run, or left `unmerged` by an earlier
// one, may be merged by hand meanwhile: you review it and merge its branch. So each time the base
// has moved on, before the tickets set aside for a failed check are checked once more, and once more
// as the run ends, the run asks git of each such ticket, as loadUnmerged does as the run starts
// (unmerged.ts's mergedSince). One on the base now is Done, merged by hand: it isn't checked again,
// its session is closed, its worktree and branch are removed as after a merge (removeMerged), its
// `unmerged` label is removed, and the epics above it close; the tickets it blocks start, and the
// end line and the report count it closed rather than set aside. One left `unmerged` by an earlier
// run loses its label. A ticket being merged, handed back, or blocked on a conflict whose hand-back
// waits for its steered worker, is left to its merge.
//
// removeMerged is also the cleanup of a carried-over ticket dropped as merged by hand (carry.ts).
import { Effect, Ref, Result } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { Beads, type Issue } from "../services/Beads.ts"
import { type Commit, Git } from "../services/Git.ts"
import { allChanges } from "../services/gitStatus.ts"
import { Store } from "../services/Store.ts"
import { branchOf, Worktrees } from "../services/Worktrees.ts"
import { EventStream } from "./eventstream.ts"
import type { HandBacks } from "./handback.ts"
import { handBackWaits, Ledger } from "./ledger.ts"
import { detail, type Line, Log, line, Tag } from "./log.ts"
import { closeEpics, gitWhy, type MergeEnv, type MergeOptions, restoreBranch } from "./merge.ts"
import { Cause } from "./phase.ts"
import type { Rechecks } from "./recheck.ts"
import { unmergedLabel } from "./scope.ts"
import { mergedSince, unlabel } from "./unmerged.ts"

/** `<hash> <subject>`, the hash cut to 7, as the log names a commit. */
const named = (commit: Commit) => line`${commit.hash.slice(0, 7)} ${commit.subject}`

/** What removeMerged did with a ticket's worktree and branch, as its line goes on to say. */
export interface Removed {
  /** Whether both are gone. */
  readonly removed: boolean
  /** The rest of the line: `; worktree and branch removed`, or why they are left. */
  readonly text: Line
}

/**
 * Removes the worktree and branch of ticket `id`, its work on the base already, merged by hand, as
 * after a merge: the branch moved to the base first when the base holds its changes without its
 * commits (squash-merged), so that git deletes it as merged (its reflog keeps them). A worktree with
 * uncommitted changes is left, with its branch, as is one git can't say is clean. Without a
 * worktree, only the branch is removed.
 */
export const removeMerged = (
  id: string,
  worktree: string | undefined,
  branch: string,
  options: MergeOptions,
): Effect.Effect<Removed, never, Git | Worktrees> =>
  Effect.gen(function* () {
    const git = yield* Git
    const worktrees = yield* Worktrees
    if (worktree !== undefined) {
      const status = yield* Effect.result(git.status(worktree))
      if (Result.isFailure(status)) {
        return {
          removed: false,
          text: line`; worktree ${worktree} and ${branch} left as they are, as git can't say whether ${worktree} has uncommitted changes: ${gitWhy(status.failure)}`,
        }
      }
      const dirty = allChanges(status.success)
      if (dirty.length > 0) {
        return {
          removed: false,
          text: line`; worktree ${worktree} has uncommitted changes (${dirty}), so it and ${branch} are left as they are (commit or remove them, then remove it)`,
        }
      }
      const ahead = yield* Effect.result(git.log(options.repo, options.base, branch))
      if (Result.isFailure(ahead) || ahead.success.length > 0) {
        yield* restoreBranch({ branch, worktree }, options.base, 1)
      }
    }
    const cleanup = yield* Effect.result(worktrees.remove(id))
    if (Result.isSuccess(cleanup)) {
      return {
        removed: true,
        text:
          worktree === undefined ? line`; ${branch} removed` : line`; worktree and branch removed`,
      }
    }
    const why =
      cleanup.failure._tag === "BadTicketId" ? cleanup.failure.why : gitWhy(cleanup.failure)
    const what = worktree === undefined ? branch : `${worktree} / ${branch}`
    return { removed: false, text: line`, but ${Tag.cleanupFailed} for ${what}: ${why}` }
  })

/** `; its 'unmerged' label is removed` once bd removed it; nothing for a ticket without it. */
const unlabelled = (issue: Issue) =>
  Effect.gen(function* () {
    if (!issue.labels.includes(unmergedLabel)) return ""
    return (yield* unlabel(issue.id)) ? line`; its '${unmergedLabel}' label is removed` : ""
  })

/** What a ticket of the run, set aside or blocked, was until it was merged by hand. */
const wasOf = (phase: "Review" | "Blocked") => (phase === "Review" ? "set aside" : "blocked")

/**
 * Takes the ticket of the run, set aside or blocked, as merged by hand with `commit` (see above):
 * Done, its session closed, its worktree and branch removed, its record in state.json forgotten,
 * its label removed and the epics above it closed.
 */
const takeAsMerged = (
  issue: Issue,
  phase: "Review" | "Blocked",
  commit: Commit,
  rechecks: Pick<Rechecks, "drop">,
  options: MergeOptions,
) =>
  Effect.gen(function* () {
    const git = yield* Git
    const ledger = yield* Ledger
    const store = yield* Store
    const { id } = issue
    yield* rechecks.drop(id)
    yield* (yield* AgentHost).close(id)
    // Its worktree, as git has it on its branch.
    const branch = branchOf(id)
    const listed = yield* Effect.result(git.worktrees(options.repo))
    const worktree = Result.isSuccess(listed)
      ? listed.success.find((each) => each.branch === branch && !each.prunable)?.path
      : undefined
    const removed = yield* removeMerged(id, worktree, branch, options)
    const label = yield* unlabelled(issue)
    const was = wasOf(phase)
    const text = detail`${id}, ${was} in this run, is on ${options.base} now (${named(commit)}): merged by hand, so no longer ${was}${removed.text}${label}`
    yield* ledger.transition(id, Cause.MergedByHand({ commit: commit.hash }), {
      beside: [
        {
          kind: "closed",
          ticket: id,
          title: issue.title,
          detail: `${commit.hash.slice(0, 7)} merged by hand`,
          text,
        },
      ],
      lines: [text],
    })
    // Done, it has nothing left for a later run: its record in state.json goes.
    yield* Effect.ignore(store.remove(id))
    yield* closeEpics(id)
  })

/**
 * Asks git, once the base has moved on since `seen` (the base as it last asked, bd answering for
 * every ticket), of each ticket closed but not merged whether it was merged by hand since, and
 * takes those that were as merged (see above). The tickets it found merged.
 */
export const mergedByHand = (
  seen: Ref.Ref<string | undefined>,
  memory: { readonly rechecks: Pick<Rechecks, "drop">; readonly handBacks: HandBacks },
  options: MergeOptions,
): Effect.Effect<ReadonlyArray<string>, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { base } = options
    // git failing, it is asked again as the run next looks.
    const head = yield* Effect.result(git.revParse(options.repo, base))
    if (Result.isFailure(head)) return []
    if ((yield* Ref.get(seen)) === head.success) return []

    const found: Array<string> = []
    // bd failing for a ticket, the base isn't taken as seen: the next look asks again, though it
    // hasn't moved, and so does the run's last.
    let failed = false
    const waiting = new Set((yield* memory.handBacks.waiting).map((each) => each.ticket.id))
    const state = yield* ledger.current
    for (const entry of state.tickets.values()) {
      const phase = entry.phase._tag
      if (phase !== "Review" && phase !== "Blocked") continue
      if (handBackWaits(entry) || waiting.has(entry.ticket)) continue
      const shown = yield* Effect.result(beads.show(entry.ticket))
      if (Result.isFailure(shown)) {
        failed = true
        continue
      }
      if (shown.success.status !== "closed") continue
      const merged = (yield* mergedSince(shown.success, options)).merged
      if (merged === undefined) continue
      // Still as it was: a recheck may have taken it up meanwhile.
      if ((yield* ledger.current).tickets.get(entry.ticket)?.phase._tag !== phase) continue
      yield* takeAsMerged(shown.success, phase, merged, memory.rechecks, options)
      found.push(entry.ticket)
    }

    // Those an earlier run left `unmerged` that this run hasn't taken up.
    const labelled = yield* Effect.result(beads.list({ status: "closed", labels: [unmergedLabel] }))
    if (Result.isFailure(labelled)) return found
    if (!failed) yield* Ref.set(seen, head.success)
    for (const issue of labelled.success) {
      if (state.tickets.has(issue.id) || found.includes(issue.id)) continue
      const merged = (yield* mergedSince(issue, options)).merged
      if (merged === undefined) continue
      const removed = yield* unlabel(issue.id)
      const label = removed ? line`; its '${unmergedLabel}' label is removed` : ""
      const text = detail`${issue.id}, left unmerged by an earlier run, is on ${base} now (${named(merged)}): merged by hand${label}`
      yield* logs.writeWith([text], events.emit({ kind: "info", ticket: issue.id, text }))
      found.push(issue.id)
    }
    return found
  })
