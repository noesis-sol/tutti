// What one fill reads of bd and git once, as it needs it, and keeps for its picks (FillReads): bd's
// open list and its closed tickets labelled unmerged, the parents waiting for their subtickets,
// each ticket's issue as bd show gives it, the repository's files and the tickets' changes, and
// what git says of closed blockers' branches.
import { Context, Effect, Ref, Result } from "effect"
import type { BeadsError, Issue, TicketId } from "../../services/Beads.ts"
import { asksGit, leftUnmerged, parentsWaiting, unmerged } from "../holds.ts"
import type { State } from "../ledger.ts"
import type { Sources } from "../overlap.ts"
import type { RepoFiles } from "../repoFiles.ts"
import { unclosedIn, unmergedLabel } from "../scope.ts"
import { issueOf } from "./place.ts"
import { remember } from "./queue.ts"
import type { Scheduling } from "./state.ts"

/** bd's open list as the look read it at its start, for the fill it gives it to (fillWith). */
export const LookOpen = Context.Reference<ReadonlyArray<Issue> | undefined>("tutti/run/LookOpen", {
  defaultValue: () => undefined,
})

/**
 * What holds a ticket in line back for a parent or a ticket not merged: the closed tickets
 * labelled unmerged, those of them left unmerged by an earlier run, and the parents waiting for
 * their subtickets.
 */
export interface Holders {
  readonly labelled: ReadonlyArray<Issue>
  readonly left: ReadonlyArray<Issue>
  readonly parents: ReadonlyMap<TicketId, ReadonlyArray<TicketId>>
}

/** What one fill reads once, as it needs it; the fields not read-only are read on first use. */
export interface FillReads {
  /** bd ready's list, as the fill read it. */
  readonly found: ReadonlyArray<Issue>
  /** bd's open list as the look read it, or undefined where the fill read its own. */
  readonly looked: ReadonlyArray<Issue> | undefined
  /** bd's open list, the look's or the fill's own; read afresh by `holding` where it has to be. */
  open: ReadonlyArray<Issue>
  /** The holders, once `holding` has read them. */
  holders: Holders | undefined
  /** Each ticket's issue as bd show gave it, or null when bd couldn't (`showOnce`). */
  readonly shown: Map<TicketId, Issue | null>
  /** The issues the waiting tickets' links link to, from the fill's lists (`linksOf`). */
  linked: ReadonlyMap<TicketId, Issue> | undefined
  /** The files' contents comparing footprints asks about, read once a fill. */
  readonly sources: Sources
  /** The repository's files, with footprints on. */
  readonly repo: RepoFiles | undefined
  /** The running tickets' worktree changes (`changedIn`). */
  readonly changes: Map<TicketId, ReadonlyArray<string>>
  /** What each waiting ticket's branch changes (`branchIn`). */
  readonly branches: Map<TicketId, ReadonlyArray<string>>
  /** The tickets' branches there are, once read for `branchIn`; names undefined where git can't say. */
  existing: { readonly names: ReadonlySet<string> | undefined } | undefined
  /** The predictor's guesses so far, which join the footprints. */
  predicted: ReadonlyMap<TicketId, ReadonlyArray<string>>
  /** The base as the fill first asked git of a closed blocker's branch (`branchesOf`). */
  head: { readonly at: string | undefined } | undefined
  /** Why git finds each closed blocker's work only on its branch, undefined for not (`branchesOf`). */
  readonly offBase: Map<TicketId, string | undefined>
}

/**
 * A fill's reads begun: bd's open list (the look's, or read now), with the queue's `unclosed`
 * remembered from it, the repository's files with footprints on, and, with the predictor, `queue`
 * (the candidates) given to it and its guesses so far.
 */
export const fillReads = (
  sched: Scheduling,
  found: ReadonlyArray<Issue>,
  queue: ReadonlyArray<Issue>,
): Effect.Effect<FillReads, BeadsError> =>
  Effect.gen(function* () {
    const { options } = sched
    const looked = yield* LookOpen
    const open = looked ?? (yield* sched.beads.list())
    const unclosed = unclosedIn(open, options.scope, sched.filter)
    yield* remember(sched, (m) => ({ ...m, unclosed }))
    const footprints = options.footprints
    const repo = footprints === undefined ? undefined : yield* footprints.repo
    const reads: FillReads = {
      found,
      looked,
      open,
      holders: undefined,
      shown: new Map(),
      linked: undefined,
      sources: new Map(),
      repo,
      changes: new Map(),
      branches: new Map(),
      existing: undefined,
      predicted: new Map(),
      head: undefined,
      offBase: new Map(),
    }
    // The ready tickets naming nothing, nor with commits on their branches, go to the predictor;
    // its guesses so far join footprints.
    const predictor = options.predictor
    if (predictor !== undefined && repo !== undefined) {
      yield* predictor.queue(queue, repo, (id) => branchIn(sched, reads, id))
    }
    if (predictor !== undefined) reads.predicted = yield* predictor.predicted
    return reads
  })

/**
 * The holders, read once a fill, for the first ticket it weighs: the tickets left unmerged by an
 * earlier run, and the parents waiting for their subtickets, those of the tickets not closed or
 * left unmerged, and of the run's tickets not merged yet. bd ready's list counts with bd's open
 * list: the look read that list before the answers were taken, and a child a worker filed
 * meanwhile is in bd ready alone, its parent with it (tutti-k8wx). A ticket bd ready lists that the
 * look's list lacks says the backlog changed since that list was read, and a child filed with it
 * that bd ready omits (blocked by a ticket outside its parent's subtickets, or in progress) is in
 * neither list: the open list is then read afresh (tutti-7tun). bd show gives the parent of one
 * the run didn't dispatch.
 */
export const holding = (sched: Scheduling, reads: FillReads): Effect.Effect<Holders, BeadsError> =>
  Effect.gen(function* () {
    if (reads.holders !== undefined) return reads.holders
    const { beads, ledger } = sched
    const labelled = yield* beads.list({ status: "closed", labels: [unmergedLabel] })
    const left = leftUnmerged(yield* ledger.current, labelled)
    if (reads.looked !== undefined) {
      const lookedIds = new Set(reads.looked.map((issue) => issue.id))
      if (reads.found.some((issue) => !lookedIds.has(issue.id))) reads.open = yield* beads.list()
    }
    const openIds = new Set([...reads.open, ...reads.found].map((issue) => issue.id))
    const parentOf = new Map((yield* Ref.get(sched.memo)).parentOf)
    for (const id of unmerged(yield* ledger.current)) {
      if (parentOf.has(id) || openIds.has(id)) continue
      const read = yield* beads.show(id).pipe(Effect.result)
      if (Result.isSuccess(read)) parentOf.set(id, read.success.parent ?? null)
    }
    yield* remember(sched, (m) => ({ ...m, parentOf: new Map([...m.parentOf, ...parentOf]) }))
    const parents = parentsWaiting(
      [...reads.open, ...reads.found, ...left],
      yield* ledger.current,
      parentOf,
    )
    reads.holders = { labelled, left, parents }
    return reads.holders
  })

/** A ticket's issue as bd show gives it, read once a fill; null when bd couldn't. */
export const showOnce = (
  sched: Scheduling,
  reads: FillReads,
  id: TicketId,
): Effect.Effect<Issue | null> =>
  Effect.gen(function* () {
    if (reads.shown.has(id)) return reads.shown.get(id) ?? null
    const issue = yield* issueOf(sched, id)
    reads.shown.set(id, issue)
    return issue
  })

/**
 * A waiting ticket's links with the issues they link to, as bd show gives them, from the lists
 * the fill has read: bd's open list and its closed tickets labelled unmerged. An issue in neither
 * is closed without the label, or one bd hides from both (a tombstone), and reads as closed
 * (closedLink): git says whether its work is on the base (asksGit).
 */
export const linksOf = (
  sched: Scheduling,
  reads: FillReads,
  issue: Issue,
): Effect.Effect<Issue, BeadsError> =>
  Effect.gen(function* () {
    if (reads.linked === undefined) {
      const { labelled } = yield* holding(sched, reads)
      reads.linked = new Map([...reads.open, ...labelled].map((each) => [each.id, each]))
    }
    const known = reads.linked
    return {
      ...issue,
      dependencies: issue.dependencies.map((link) => {
        const other = known.get(link.id)
        return other === undefined ? link : { ...link, issue: other }
      }),
    }
  })

/** The files the running ticket's worktree changed, as the repository has them, read once a fill. */
export const changedIn = (
  sched: Scheduling,
  reads: FillReads,
  id: TicketId,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const known = reads.changes.get(id)
    const { footprints } = sched.options
    const repo = reads.repo
    if (known !== undefined || footprints === undefined || repo === undefined) {
      return known ?? []
    }
    const files = (yield* footprints.changed(id)).map((f) => repo.file(f))
    reads.changes.set(id, files)
    return files
  })

/**
 * What a waiting ticket's branch changes, read once a fill, as are the tickets' branches there
 * are, in one git call for them all.
 */
export const branchIn = (
  sched: Scheduling,
  reads: FillReads,
  id: TicketId,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const known = reads.branches.get(id)
    const { footprints } = sched.options
    if (known !== undefined || footprints?.branch === undefined) return known ?? []
    reads.existing ??= {
      names: footprints.branches === undefined ? undefined : yield* footprints.branches,
    }
    const files = yield* footprints.branch(id, reads.existing.names)
    reads.branches.set(id, files)
    return files
  })

/**
 * Why git finds each closed blocker's work only on its branch (Options.closedBranches), for the
 * blockers of `links` the holds ask git about, asked once a fill, at the base where the fill
 * first found it; none without the option.
 */
export const branchesOf = (
  sched: Scheduling,
  reads: FillReads,
  state: State,
  links: Issue,
): Effect.Effect<Map<TicketId, string>> =>
  Effect.gen(function* () {
    const found = new Map<TicketId, string>()
    const closed = sched.options.closedBranches
    if (closed === undefined) return found
    for (const link of links.dependencies) {
      if (link.type !== "blocks" && link.type !== "discovered-from") continue
      if (!asksGit(state, link)) continue
      if (!reads.offBase.has(link.id)) {
        reads.head ??= { at: yield* closed.head }
        reads.offBase.set(link.id, yield* closed.why(link.id, reads.head.at))
      }
      const why = reads.offBase.get(link.id)
      if (why !== undefined) found.set(link.id, why)
    }
    return found
  })
