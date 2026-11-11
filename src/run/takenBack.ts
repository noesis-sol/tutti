// A conflict fixed by hand, taken back (§ 5 item 8, § 5.1's Blocked{MERGE_CONFLICT} → ToMerge). A
// ticket blocked on its conflict can be taken up by you: you rebase its branch in its worktree,
// resolve the conflicts and leave it for tutti to merge. The recheck (recheck.ts) skips a branch that
// moved and handMerged.ts finds what you merged yourself, so without this it would wait for the run's
// end. So each time the run looks for work, after the rechecks, it asks git of each such ticket, in
// this run or left `unmerged` by an earlier one, and puts it back ToMerge, by TakenBack, when:
//
// 1. its branch has moved on from the commit kept as it was blocked (keepConflictHead, in state.json
//    so that a later run has it too): one that moved is your work, as a blocked ticket's worker is
//    done with it. A ticket with no commit kept can't be told from one left as it was, so isn't taken;
// 2. its worktree is on its branch, with no rebase, merge or cherry-pick in progress and no
//    uncommitted changes to tracked files, so that a resolve half done isn't taken;
// 3. it rebases cleanly onto the base now (git merge-tree --write-tree, which touches nothing).
//
// It goes through the merge as any ticket: rebased, checked, fast-forwarded. Conflicting again, it is
// Blocked again with no hand-back in this run, as you took it up from its worker (HandBacks' takeUp),
// its new commit kept, so it isn't tried again until the branch moves again. A branch that moved and
// still conflicts is said once for each commit and left Blocked, merge-tree asked again only once
// the branch or the base has moved.
//
// None is taken back while the run holds or winds down, or the merges have stopped (recheck.ts's
// notNow), nor without a slot, as a recheck takes one; a solo ticket running or next leaves none. A
// hand-back waiting for its steered worker is left to you to hand over. One left by an earlier run
// must be closed and labelled `unmerged` still, and in the run's scope. fixedLeft asks the same of
// those before the run starts, so that one of them is something to run.
import { Deferred, Effect, Option, Ref, Result, type Schema } from "effect"
import { AppConfig } from "../core/AppConfig.ts"
import { type Log, Tag, ticketLine } from "../core/log.ts"
import { Beads, type Issue, type TicketId } from "../services/Beads.ts"
import type { EventStream } from "../services/EventStream.ts"
import { Git, Sha, shortHash } from "../services/Git.ts"
import { trackedChanges } from "../services/gitStatus.ts"
import { Store, type TicketRecord, ticketsIn } from "../services/Store.ts"
import { branchOf, ticketIdProblem } from "../services/Worktrees.ts"
import { clearUnchecked } from "./check.ts"
import type { HandBacks } from "./handback.ts"
import { handBackWaits, Ledger } from "./ledger.ts"
import type { MergeQueue } from "./mergequeue.ts"
import type { FinishedTicket, MergeOptions, MergeTarget } from "./mergeShared.ts"
import { Move } from "./phase.ts"
import { mergeOver, notNow } from "./recheck.ts"
import { info } from "./say.ts"
import { descendants, unmergedLabel } from "./scope.ts"

/** The Store metadata key holding the branch's commit as its ticket was blocked on its conflict. */
export const conflictHeadKey = "conflict_head"

/** The commit `value` holds; state.json is anyone's to edit, so anything else is none. */
const conflictHeadOf = (metadata: Readonly<Record<string, Schema.Json>>): Sha | undefined => {
  const value = Object.hasOwn(metadata, conflictHeadKey) ? metadata[conflictHeadKey] : undefined
  return typeof value === "string" ? Sha.parse(value) : undefined
}

/**
 * Keeps where the ticket's branch is, before it is blocked on its conflict. git failing keeps none,
 * rather than one from an earlier block: the branch would seem to have moved.
 */
export const keepConflictHead = (
  ticket: Pick<FinishedTicket, "id" | "branch">,
  options: Pick<MergeTarget, "repo">,
): Effect.Effect<void, never, Git | Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    const head = yield* Effect.result((yield* Git).revParse(options.repo, ticket.branch))
    yield* Effect.ignore(
      Result.isSuccess(head)
        ? store.setMetadata(ticket.id, conflictHeadKey, head.success)
        : forgetConflictHead(ticket.id),
    )
  })

/** Forgets the commit kept, as the ticket's merge starts: it is back in line, however it got there. */
export const forgetConflictHead = (id: TicketId): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    if (conflictHeadOf(yield* store.metadata(id)) === undefined) return
    yield* Effect.ignore(store.unsetMetadata(id, conflictHeadKey))
  })

/** A ticket that may be taken back, as the Store has it. */
interface Candidate {
  readonly id: TicketId
  /** Its branch's commit as it was blocked. */
  readonly kept: Sha
  readonly branch: string
  readonly worktree: string
}

/** The tickets with a commit kept and a worktree that `fits` says of, in ID order. */
const candidates = (
  fits: (id: TicketId, record: TicketRecord) => boolean,
): Effect.Effect<ReadonlyArray<Candidate>, never, Store> =>
  Effect.gen(function* () {
    const found: Array<Candidate> = []
    for (const [id, record] of ticketsIn(yield* (yield* Store).state)) {
      const kept = conflictHeadOf(record.metadata)
      if (kept === undefined || record.worktree === undefined) continue
      if (ticketIdProblem(id) !== undefined || !fits(id, record)) continue
      found.push({ id, kept, branch: record.branch ?? branchOf(id), worktree: record.worktree })
    }
    return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })

/** Whether the record is one an earlier run left, blocked. */
const leftBlocked = (record: TicketRecord): boolean =>
  record.phase === "Blocked" && record.suspended === undefined

/**
 * The branch's commit, when it has moved on from the one kept and its worktree is left clean on it;
 * undefined otherwise, as when git can't say.
 */
const movedAndClean = (candidate: Candidate, options: Pick<MergeTarget, "repo">) =>
  Effect.gen(function* () {
    const git = yield* Git
    const { branch, worktree } = candidate
    const head = yield* git.revParse(options.repo, branch)
    if (head === candidate.kept) return undefined
    const on = yield* git.currentBranch(worktree)
    if (Option.getOrUndefined(on) !== branch) return undefined
    if (yield* git.operationInProgress(worktree)) return undefined
    return trackedChanges(yield* git.status(worktree)).length > 0 ? undefined : head
  }).pipe(Effect.orElseSucceed(() => undefined))

/** Whether a ticket an earlier run left is still as it left it: closed, labelled `unmerged`. */
const stillLeft = (issue: Issue): boolean =>
  issue.status === "closed" && issue.labels.includes(unmergedLabel)

/**
 * The tickets earlier runs left `unmerged` on a conflict whose branches have been fixed by hand and
 * rebase cleanly now: those the run's first look takes back, but only read, for the Nothing to run
 * box. git or bd that can't say leaves a ticket out.
 */
export const fixedLeft = (
  options: MergeTarget,
): Effect.Effect<ReadonlySet<TicketId>, never, Beads | Git | Store> =>
  Effect.gen(function* () {
    const git = yield* Git
    const beads = yield* Beads
    const fixed = new Set<TicketId>()
    for (const candidate of yield* candidates((_, record) => leftBlocked(record))) {
      const head = yield* movedAndClean(candidate, options)
      if (head === undefined) continue
      const clashes = yield* Effect.result(git.conflicts(options.repo, options.base, head))
      if (Result.isFailure(clashes) || clashes.success.length > 0) continue
      const issue = yield* Effect.result(beads.show(candidate.id))
      if (Result.isSuccess(issue) && stillLeft(issue.success)) fixed.add(candidate.id)
    }
    return fixed
  })

/** The commits a ticket's branch and the base were at when its branch last conflicted. */
export interface Conflicting {
  readonly head: Sha
  readonly base: Sha
}

/**
 * Puts back in the merge queue, ToMerge by TakenBack, each ticket blocked on a conflict and fixed by
 * hand since (see above), each in a slot of its own until its merge is over (`options.recheckSlot`).
 * `conflicting`: what the run has found still conflicting, by ticket. `at`: where the base is, as a
 * merge just put it; git is asked without it. The tickets it put back.
 */
export const takeBackDue = (
  conflicting: Ref.Ref<ReadonlyMap<string, Conflicting>>,
  handBacks: Pick<HandBacks, "waiting" | "takeUp">,
  queue: Pick<MergeQueue, "offer" | "state" | "changes">,
  options: MergeOptions,
  at?: Sha,
): Effect.Effect<
  ReadonlyArray<string>,
  never,
  AppConfig | Beads | Git | Ledger | Log | EventStream | Store
> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const git = yield* Git
    const ledger = yield* Ledger
    const store = yield* Store
    const root = (yield* AppConfig).ticket
    const { base } = options
    const waiting = new Set((yield* handBacks.waiting).map((stop) => stop.ticket.id))
    const tickets = (yield* ledger.current).tickets
    const left = (id: TicketId) => !tickets.has(id)

    /** Whether it is the run's, blocked on its conflict and not waiting on you, as it is now. */
    const blocked = (id: TicketId, now: typeof tickets) => {
      const entry = now.get(id)
      return (
        entry?.phase._tag === "Blocked" &&
        entry.phase.why === Tag.mergeConflict &&
        !handBackWaits(entry) &&
        !waiting.has(id)
      )
    }

    /**
     * The ticket as bd has it, when it is still closed; one an earlier run left must be labelled
     * still, and in the run's scope. bd failing, it is asked again at the next look.
     */
    const stillOurs = (id: TicketId) =>
      Effect.gen(function* () {
        const issue = yield* beads.show(id)
        if (!left(id)) return issue.status === "closed" ? issue : undefined
        if (!stillLeft(issue)) return undefined
        if (root === null || id === root) return issue
        const subs = yield* descendants(beads, root)
        return subs.some((sub) => sub.id === id) ? issue : undefined
      }).pipe(Effect.orElseSucceed(() => undefined))

    const back: Array<string> = []
    // Where the base is, read once for every ticket, when one is due a look.
    let onto: Sha | undefined = at
    const found = yield* candidates(
      (id, record) => blocked(id, tickets) || (left(id) && leftBlocked(record)),
    )
    for (const candidate of found) {
      if (yield* notNow(queue, options)) break
      const { id, branch, worktree } = candidate
      const head = yield* movedAndClean(candidate, options)
      if (head === undefined) continue
      if (onto === undefined) {
        const read = yield* Effect.result(git.revParse(options.repo, base))
        if (Result.isFailure(read)) break
        onto = read.success
      }
      const before = (yield* Ref.get(conflicting)).get(id)
      if (before?.head === head && before.base === onto) continue
      const clashes = yield* Effect.result(git.conflicts(options.repo, onto, head))
      if (Result.isFailure(clashes)) continue
      const issue = yield* stillOurs(id)
      if (issue === undefined) continue
      if (clashes.success.length > 0) {
        const seen = { head, base: onto }
        yield* Ref.update(conflicting, (all) => new Map(all).set(id, seen))
        if (before?.head === head) continue
        const text = ticketLine(
          Tag.takenBack,
        )`${branch} moved on to ${shortHash(head)} since its conflict, but still conflicts with ${base} in ${clashes.success}; it stays blocked`
        yield* info(text, id)
        continue
      }
      // Its slot is held from before its offer until its merge is over, as a recheck's is.
      const offered = yield* Deferred.make<void>()
      const work = Effect.andThen(Deferred.await(offered), mergeOver(queue, id))
      if (!(yield* options.recheckSlot(id, work))) break
      const put = Effect.gen(function* () {
        // As it is now: a hand-over or a wait for the slot may have changed it meanwhile.
        const now = (yield* ledger.current).tickets
        if (left(id) ? now.has(id) : !blocked(id, now)) return
        const text = ticketLine(
          Tag.takenBack,
        )`${branch} moved on to ${shortHash(head)} since its conflict and rebases cleanly onto ${base} now: back in the merge queue`
        yield* info(text, id)
        yield* handBacks.takeUp(id)
        // What tutti last rebased isn't this branch: its merge starts afresh.
        yield* clearUnchecked(id)
        // Taken up into the run, as carry.ts takes a ticket up: the run's end saves it again.
        yield* Effect.ignore(
          store.updateTicket(id, ({ suspended: _, phase: __, ...record }) => record),
        )
        const moved = yield* queue.offer(
          { id, title: issue.title, branch, worktree },
          (place) => Move.TakenBack({ place }),
          false,
        )
        if (Result.isSuccess(moved)) back.push(id)
      })
      yield* put.pipe(Effect.ensuring(Deferred.succeed(offered, undefined)))
    }
    return back
  })
