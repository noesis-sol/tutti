// A ticket merged by hand while the run goes on (§ 5 item 8, orchestra 0.9.0's handmerged.go). A
// ticket closed but not merged, set aside or blocked in this run, or left `unmerged` by an earlier
// one, may be merged by hand meanwhile: you review it and merge its branch. So each time the base
// has moved on, before the tickets set aside for a failed check are checked once more, and once more
// as the run ends, the run asks git of each such ticket, as loadUnmerged does as the run starts
// (unmerged.ts's mergedSince). One on the base now is Done, merged by hand: it isn't checked again,
// its session is closed, and it is retired as after a merge (merge.ts's retire): its worktree and
// branch removed (removeMerged, as byHand says), its `unmerged` label removed, and the epics above it
// closed; the tickets it blocks start, and the end line and the report count it closed rather than
// set aside. One left `unmerged` by an earlier run loses its label and the record that run left of
// it in state.json (unmerged.ts's forgetLeft). A ticket being merged, handed back, or blocked on a
// conflict whose hand-back waits for its steered worker, is left to its merge.
//
// byHand and removedText are also the cleanup of a carried-over ticket dropped as merged by hand
// (carry.ts).
import { Effect, Ref, Result } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { Beads, type Issue } from "../services/Beads.ts"
import { type Commit, Git, gitWhy, shortHash } from "../services/Git.ts"
import { branchOf } from "../services/Worktrees.ts"
import type { HandBacks } from "./handback.ts"
import { handBackWaits, Ledger } from "./ledger.ts"
import { detail, type Line, line } from "./log.ts"
import {
  type Cleanup,
  cleanupFailed,
  type DoneTicket,
  type MergeEnv,
  type MergeTarget,
  retire,
} from "./merge.ts"
import { Move } from "./phase.ts"
import type { Rechecks } from "./recheck.ts"
import { info } from "./say.ts"
import { unmergedLabel } from "./scope.ts"
import { forgetLeft, mergedSince, namedCommit as named, unlabel } from "./unmerged.ts"

/**
 * What removeMerged did with the worktree and branch of a ticket merged by hand, as its line goes
 * on to say it: `; worktree and branch removed`, or why they are left.
 */
export const removedText = (
  ticket: Pick<DoneTicket, "branch" | "worktree">,
  cleanup: Cleanup,
): Line => {
  const { branch } = ticket
  const worktree = ticket.worktree ?? ""
  switch (cleanup._tag) {
    case "Removed":
      return ticket.worktree === undefined
        ? line`; ${branch} removed`
        : line`; worktree and branch removed`
    case "Unreadable":
      return line`; worktree ${worktree} and ${branch} left as they are, as git can't say whether ${worktree} has uncommitted changes: ${gitWhy(cleanup.error)}`
    case "Changed":
      return line`; worktree ${worktree} has uncommitted changes (${cleanup.files}), so it and ${branch} are left as they are (commit or remove them, then remove it)`
    case "Failed":
      return line`, but ${cleanupFailed(ticket, cleanup)}`
  }
}

/**
 * How the worktree and branch of a ticket merged by hand are removed (removeMerged): the branch
 * moved to the base first when it has commits beyond it, as when the base holds its changes
 * without its commits (squash-merged); a worktree with uncommitted changes left, with its branch,
 * as is one git can't say is clean.
 */
export const byHand = { moveToBase: "ahead", leaveChanged: true } as const

/** `; its 'unmerged' label is removed` once bd removed it. */
const unlabelled = (removed: boolean) =>
  removed ? line`; its '${unmergedLabel}' label is removed` : ""

/** What a ticket of the run, set aside or blocked, was until it was merged by hand. */
const wasOf = (phase: "Review" | "Blocked") => (phase === "Review" ? "set aside" : "blocked")

/**
 * Takes the ticket of the run, set aside or blocked, as merged by hand with `commit` (see above):
 * its session closed, then retired (merge.ts's retire), Done.
 */
const takeAsMerged = (
  issue: Issue,
  phase: "Review" | "Blocked",
  commit: Commit,
  rechecks: Pick<Rechecks, "drop">,
  options: MergeTarget,
) =>
  Effect.gen(function* () {
    const git = yield* Git
    const { id } = issue
    yield* rechecks.drop(id)
    // Its part in the run is over: its worker is ended, as sessions.ts's fit ends a merged one's.
    yield* (yield* AgentHost).end(id)
    // Its worktree, as git has it on its branch, removed there without looking for it again.
    const branch = branchOf(id)
    const listed = yield* Effect.result(git.worktrees(options.repo))
    const worktree = Result.isSuccess(listed)
      ? listed.success.find((each) => each.branch === branch && !each.prunable)?.path
      : undefined
    const was = wasOf(phase)
    const ticket = { id, title: issue.title, branch, worktree }
    yield* retire(ticket, options, {
      ...byHand,
      move: Move.MergedByHand({ commit: commit.hash }),
      issue,
      closed: (cleanup, removed) => ({
        detail: `${shortHash(commit.hash)} merged by hand`,
        text: detail`${id}, ${was} in this run, is on ${options.base} now (${named(commit)}): merged by hand, so no longer ${was}${removedText(ticket, cleanup)}${unlabelled(removed)}`,
      }),
    })
  })

/**
 * Asks git, once the base has moved on since `seen` (the base as it last asked, bd answering for
 * every ticket), of each ticket closed but not merged whether it was merged by hand since, and
 * takes those that were as merged (see above). `at`: where the base is, as a merge just put it;
 * git is asked without it. The tickets it found merged.
 */
export const mergedByHand = (
  seen: Ref.Ref<string | undefined>,
  memory: { readonly rechecks: Pick<Rechecks, "drop">; readonly handBacks: HandBacks },
  options: MergeTarget,
  at?: string,
): Effect.Effect<ReadonlyArray<string>, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const beads = yield* Beads
    const ledger = yield* Ledger
    const { base } = options
    // git failing, it is asked again as the run next looks.
    const head =
      at === undefined ? yield* Effect.result(git.revParse(options.repo, base)) : Result.succeed(at)
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
      const label = unlabelled(yield* unlabel(issue.id))
      yield* forgetLeft(issue.id)
      const text = detail`${issue.id}, left unmerged by an earlier run, is on ${base} now (${named(merged)}): merged by hand${label}`
      yield* info(text, issue.id)
      found.push(issue.id)
    }
    return found
  })
