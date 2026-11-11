// Nothing to run (§ 5 item 4, § 7.11), as orchestra's nothing.go has it. A run with nothing to do
// says so before it starts, rather than open the dashboard only to end at once: `check` reads what
// the run would start from (bd ready in its scope, and the workers the last run left) and, when
// neither gives it anything, says why: everything is done (`✓ All done`), or nothing is ready
// (`○ Nothing ready to run`, with each reason and its command), and the deferred tickets whose
// blockers have merged (DEFERRED_FREE). The run then prints that in a box on the main screen, or
// as plain lines, and exits 0 without a dashboard, triage, a report or a notification.
import { Effect, Result } from "effect"
import { Beads, type BeadsError, HumanLabel, type Issue, type TicketId } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import type { Worktrees } from "../services/Worktrees.ts"
import type { Branches } from "./closedBranches.ts"
import * as free from "./deferredFree.ts"
import { waitsOnLinks } from "./holds.ts"
import * as scope from "./scope.ts"

/** What holds back a ready ticket the run would otherwise start (§ 2 Held back). */
export type HoldKind =
  /** A parent waiting for its subtickets to be closed and merged. */
  | "parent"
  /** A ticket waiting for a closed ticket blocking it to merge. */
  | "blocker"
  /** A follow-up waiting for the closed ticket it was discovered from to merge. */
  | "followUp"

/** Why a run has nothing to do: everything is done, or nothing is ready, and what holds the rest. */
export interface NothingToRun {
  /** The run's scope (--ticket), or null for all of bd ready. */
  readonly scope: TicketId | null
  /**
   * No ticket is left but those of the excluded types, never run, and none is closed but not
   * merged. In a scoped run: SCOPE_DONE.
   */
  readonly allDone: boolean
  /** When all is done, the tickets of the excluded types (epics) still open, for you to close. */
  readonly stillOpen: ReadonlyArray<string>

  // Nothing ready, in a run of all of bd ready: the tickets not closed, other than those of the
  // excluded types, by what holds them, and the tickets closed but not merged.
  /** Questions (labelled human) waiting for your answer. */
  readonly questions: number
  /** Open or blocked, waiting on other tickets. */
  readonly waiting: number
  /** Ready parents the run holds back for their subtickets, which bd blocked doesn't list. */
  readonly heldParents: number
  /** Ready tickets the run holds back for a closed blocker to merge. */
  readonly heldBlocked: number
  /** Ready follow-ups the run holds back for the ticket they were discovered from to merge. */
  readonly heldFollowUps: number
  readonly inProgress: number
  readonly deferred: number
  /** In any other status. */
  readonly other: number
  /** Closed but not merged. */
  readonly unmerged: number

  /** Nothing ready in a scoped run: each ticket of the scope not done, as SCOPE_OPEN names it. */
  readonly notDone: ReadonlyArray<scope.NotDone>
  /** Each deferred ticket of the run's scope whose blockers have all merged, for you to reopen. */
  readonly deferredFree: ReadonlyArray<free.DeferredFree>
  /** Why bd couldn't say which those are, for the log: it only drops the list. */
  readonly freeError: string | null
  /** The run's done line for this early exit, as the log and events.jsonl record it. */
  readonly done: string
}

/** Nothing ready and nothing held: what a NothingToRun has unless it says otherwise. */
const none: NothingToRun = {
  scope: null,
  allDone: false,
  stillOpen: [],
  questions: 0,
  waiting: 0,
  heldParents: 0,
  heldBlocked: 0,
  heldFollowUps: 0,
  inProgress: 0,
  deferred: 0,
  other: 0,
  unmerged: 0,
  notDone: [],
  deferredFree: [],
  freeError: null,
  done: "",
}

/** A NothingToRun with `fields`, the rest none. */
export const make = (fields: Partial<NothingToRun>): NothingToRun => ({ ...none, ...fields })

/** How many tickets not closed are left, in a run of all of bd ready: not those closed unmerged. */
export const open = (n: NothingToRun): number =>
  n.questions +
  n.waiting +
  n.heldParents +
  n.heldBlocked +
  n.heldFollowUps +
  n.inProgress +
  n.deferred +
  n.other

/** The done line of a run with nothing to run, before a scoped run's SCOPE_ part. */
export const readyEmpty = (allDone: boolean): string =>
  `READY_EMPTY after 0 tickets: ${allDone ? "everything is done" : "nothing ready"}`

/** Why a ticket the run finds closed but not merged at its start is so. */
export const earlierRun = "left unmerged by an earlier run"

/** What the run knows as it starts, before its loop, beside Beads. */
export interface Options {
  /** The ticket the run is scoped to (--ticket), or null for the whole of bd ready. */
  readonly scope: TicketId | null
  /** The queue's `exclude_types`. */
  readonly filter: scope.Filter
  /** The main checkout. */
  readonly repo: string
  /** The branch tickets merge into. */
  readonly base: string
  /** The tickets whose workers the last run left, for this one to carry on with (§ 4.8). */
  readonly carried: ReadonlySet<TicketId>
  /** The tickets closed but not merged, as the run finds them (merged by hand counts as merged). */
  readonly unmerged: ReadonlySet<TicketId>
  /**
   * Why git finds a closed ticket's work only on its branch (closedBranches.ts's startBranches),
   * for a blocker closed where no run saw it close; without it, such a blocker counts as merged.
   */
  readonly branches?: Branches
  /** What holds back a ready ticket as the run starts, or undefined when it would start. */
  readonly held: (issue: Issue) => Effect.Effect<HoldKind | undefined, BeadsError, Git>
}

/** Holds nothing back. */
export const noHolds = (): Effect.Effect<HoldKind | undefined> => Effect.succeed(undefined)

/**
 * What holds back a ready ticket as the run starts, as its scheduler would hold it back (§ 5 item
 * 5), given the tickets closed but not merged (`unmerged`) and why git finds a closed ticket's work
 * only on its branch (`branches`): a parent whose subtickets aren't all closed and merged, a ticket
 * blocked by one not merged, a follow-up filed from one. Nothing runs yet, so a blocker or a source
 * holds it back only while closed and not merged: left so by an earlier run, or closed where no run
 * saw it close with its work only on its branch.
 */
export const heldAtStart =
  (beads: Beads["Service"], unmerged: ReadonlySet<TicketId>, branches?: Branches) =>
  (issue: Issue): Effect.Effect<HoldKind | undefined, BeadsError, Git> =>
    Effect.gen(function* () {
      const children = yield* beads.list({ parent: issue.id, all: true })
      if (children.some((child) => child.status !== "closed" || unmerged.has(child.id))) {
        return "parent"
      }
      // bd ready gives a ticket's links: one linking to none it could wait on has no bd show.
      if (!waitsOnLinks(issue)) return undefined
      const links = (yield* beads.show(issue.id)).dependencies
      const by = (type: string) =>
        Effect.gen(function* () {
          for (const link of links) {
            if (link.type !== type) continue
            if (unmerged.has(link.id)) return true
            // bd ready lists a ticket once its blockers are closed: one bd show didn't describe is.
            if (branches === undefined || (link.issue?.status ?? "closed") !== "closed") continue
            if ((yield* branches(link.id)) !== undefined) return true
          }
          return false
        })
      if (yield* by("blocks")) return "blocker"
      if (yield* by("discovered-from")) return "followUp"
      return undefined
    })

/**
 * Why a run of all of bd ready has nothing to run, given the tickets not closed (`unclosed`), how
 * many are closed but not merged, and the ready tickets, all held back, with what holds each.
 */
export const allNothing = (
  filter: scope.Filter,
  unclosed: ReadonlyArray<Issue>,
  unmerged: number,
  held: ReadonlyMap<string, HoldKind>,
): NothingToRun => {
  const excluded = scope.excludedTypes(filter)
  const counts = { ...none, unmerged }
  const stillOpen: Array<string> = []
  for (const ticket of unclosed) {
    const hold = held.get(ticket.id)
    if (excluded.includes(ticket.type)) stillOpen.push(ticket.id)
    else if (hold === "parent") counts.heldParents++
    else if (hold === "followUp") counts.heldFollowUps++
    else if (hold !== undefined) counts.heldBlocked++
    else if (ticket.labels.includes(HumanLabel)) counts.questions++
    else if (ticket.status === "open" || ticket.status === "blocked") counts.waiting++
    else if (ticket.status === "in_progress") counts.inProgress++
    else if (ticket.status === "deferred") counts.deferred++
    else counts.other++
  }
  const allDone = open(counts) === 0 && unmerged === 0
  return { ...counts, allDone, stillOpen: allDone ? stillOpen : [], done: readyEmpty(allDone) }
}

/** Why a scoped run has nothing to run, as the scope's end says it; null when bd can't say. */
const scopeNothing = (
  beads: Beads["Service"],
  root: TicketId,
  filter: scope.Filter,
  unmerged: ReadonlySet<TicketId>,
): Effect.Effect<NothingToRun | null> =>
  Effect.map(
    scope.end(
      beads,
      root,
      {
        unmerged: (issue) => (unmerged.has(issue.id) ? earlierRun : undefined),
        aside: () => false,
        closedByRun: () => false,
      },
      filter,
    ),
    (end) => {
      if (end._tag === "Unreadable") return null
      const allDone = end._tag === "Done"
      return make({
        scope: root,
        allDone,
        stillOpen: end._tag === "Done" && end.closed === "you" ? [root] : [],
        notDone: end._tag === "Open" ? end.notDone : [],
        done: `${readyEmpty(allDone)}; ${scope.line(end)}`,
      })
    },
  )

/**
 * Why the run `options` describes has nothing to run, or null when it has something: bd ready, in
 * the run's scope, lists a ticket it would start, or the last run left a worker on a ticket in the
 * scope for this one to carry on with. A ready ticket held back at the start is not one it would
 * start. With nothing to run, it lists the deferred tickets whose blockers have merged, unless
 * `deferred` is false (the start question's count, which doesn't show them). `ready` is bd ready
 * in the scope when the caller has just read it, read here otherwise. It only reads, so it can run
 * before the loop. Its error is bd's, when it can't tell: the run then goes ahead, and the loop
 * reports it.
 */
export const check = (
  options: Options,
  read: { readonly deferred?: boolean; readonly ready?: ReadonlyArray<Issue> } = {},
): Effect.Effect<NothingToRun | null, BeadsError, Beads | Git | Worktrees> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const root = options.scope
    const ready = read.ready ?? (yield* scope.ready(beads, root, options.filter))
    const subs = root === null ? [] : yield* scope.descendants(beads, root)
    const inScope = new Set([...(root === null ? [] : [root]), ...subs.map((issue) => issue.id)])
    const within = (id: TicketId) => root === null || inScope.has(id)
    if ([...options.carried].some(within)) return null
    const held = new Map<string, HoldKind>()
    for (const issue of ready) {
      if (options.carried.has(issue.id)) continue
      const hold = yield* options.held(issue)
      if (hold === undefined) return null
      held.set(issue.id, hold)
    }
    // Read only once every ready ticket has turned out held back.
    let unclosed: ReadonlyArray<Issue> | null =
      ready.length > 0 || root === null ? yield* beads.list() : null
    const n =
      root === null
        ? allNothing(options.filter, unclosed ?? [], options.unmerged.size, held)
        : yield* scopeNothing(beads, root, options.filter, options.unmerged)
    if (n === null || read.deferred === false) return n
    if (unclosed === null) {
      const listed = yield* Effect.result(beads.list())
      if (Result.isFailure(listed)) {
        return { ...n, freeError: free.unreadable(free.reasonOf(listed.failure)) }
      }
      unclosed = listed.success
    }
    const freeing: free.Freeing = {
      repo: options.repo,
      base: options.base,
      filter: options.filter,
      inScope: within,
      pending: free.startPending(options.carried, options.unmerged, options.branches),
    }
    const listed = yield* Effect.result(free.list(freeing, unclosed))
    return Result.isSuccess(listed)
      ? { ...n, deferredFree: listed.success }
      : { ...n, freeError: free.unreadable(free.reasonOf(listed.failure)) }
  })
