// A branch rebased by hand while the run goes on (§ 4.3, § 5.1's Blocked → ToMerge). A ticket Blocked
// on its conflict waits on you: you may rebase its branch in its worktree, and the merge it waits for
// is then the queue's to do. So each time the run looks for work, as it looks for failed checks to
// check once more, it asks git where each such ticket's branch is. One that has moved and left the
// base somewhere else since it was set aside was rebased, or had the base merged into it: back in the
// merge queue, ToMerge by HandedOver, it is rebased again if the base has moved on since, checked and
// merged, as any ticket is. A commit on the branch with no rebase isn't taken for one, and neither is a
// worktree you are still working in, mid-rebase, off its branch or with uncommitted changes: the look
// after you finish takes it up. Hand-backs are as they were: it conflicting again is handed back while
// it has any left, and blocked otherwise.
import { Effect, Result } from "effect"
import type { TicketId } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { onBranch, WorktreeStatus, worktreeStatus } from "./branch.ts"
import type { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Log, line, Tag } from "./log.ts"
import type { FinishedTicket, MergeTarget } from "./merge.ts"
import type { MergeQueue } from "./mergequeue.ts"
import { Move } from "./phase.ts"
import { info } from "./say.ts"

/**
 * What says you are still working in the ticket's worktree, which a merge would set aside for it:
 * off its branch (mid-rebase, as a rebase's detached HEAD is), or with uncommitted changes. Undefined
 * when it is on its branch and clean. git failing, it is taken as being worked in.
 */
export const stillWorkedIn = (
  ticket: FinishedTicket,
): Effect.Effect<string | undefined, never, Git> =>
  Effect.gen(function* () {
    const on = yield* onBranch(ticket, 1)
    if (on._tag === "OffBranch") return line`its worktree ${ticket.worktree} has ${on.on}`
    if (on._tag === "Unknown") return line`git could not read its worktree ${ticket.worktree}`
    const status = yield* worktreeStatus(ticket.worktree)
    return WorktreeStatus.$match(status, {
      Clean: () => undefined,
      Dirty: ({ files }) =>
        line`its worktree ${ticket.worktree} has uncommitted changes to ${files}`,
      Unknown: () => line`git could not read its worktree ${ticket.worktree}`,
    })
  })

/**
 * Puts back in the merge queue the tickets Blocked on their conflicts whose branches were rebased by
 * hand since they were set aside; the tickets it put back. One no longer Blocked on its conflict is
 * forgotten: merged by hand (handMerged.ts).
 */
export const rebasedByHand = (
  queue: Pick<MergeQueue, "offer" | "handBacks">,
  { repo, base }: MergeTarget,
): Effect.Effect<ReadonlyArray<TicketId>, never, Git | Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const git = yield* Git
    const ledger = yield* Ledger
    const back: Array<TicketId> = []
    for (const aside of yield* queue.handBacks.setAside) {
      const { id, branch } = aside.ticket
      const phase = (yield* ledger.current).tickets.get(id)?.phase
      if (phase?._tag !== "Blocked" || phase.why !== Tag.mergeConflict) {
        yield* queue.handBacks.takeAside(id)
        continue
      }
      if (aside.head === undefined || aside.fork === undefined) continue
      // One read for a branch left as it was, the usual case at each look.
      const head = yield* Effect.result(git.revParse(repo, branch))
      if (Result.isFailure(head) || head.success === aside.head) continue
      const fork = yield* Effect.result(git.mergeBase(repo, base, branch))
      if (Result.isFailure(fork) || fork.success === aside.fork) continue
      if ((yield* stillWorkedIn(aside.ticket)) !== undefined) continue
      yield* queue.handBacks.takeAside(id)
      // Said before the queue can take it up, so its merge's lines come after.
      yield* info(
        detail`${branch} was rebased by hand: ${id} is back in the merge queue, to be checked and merged onto ${base}`,
        id,
      )
      const moved = yield* queue.offer(aside.ticket, (place) => Move.HandedOver({ place }), false)
      // The ledger refused (PHASE_BUG, logged): it stays set aside.
      if (Result.isSuccess(moved)) back.push(id)
      else yield* queue.handBacks.keepAside(aside)
    }
    return back
  })
