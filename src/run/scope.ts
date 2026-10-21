// The run's scope (§ 2 Scope, § 5 items 5 and 14): which of bd ready a run may take, and, for a run
// scoped with --ticket <id>, where that ticket and its descendants stand at the end: SCOPE_DONE when
// they are all closed and merged, SCOPE_OPEN naming each one that isn't and why, as orchestra's
// scope.go says it. A run without a scope takes the whole of bd ready and has no scope line.
import { Effect } from "effect"
import {
  type Beads,
  type BeadsError,
  type Dependency,
  HumanLabel,
  type Issue,
} from "../services/Beads.ts"
import type { State } from "./ledger.ts"

/** The issue type that is never dispatched, whatever `exclude_types` says (§ 2 Ticket). */
export const epicType = "epic"

/** What bd ready is read with: the questions and these types left out. */
export interface Filter {
  /** The queue's `exclude_types`; epics are left out besides. */
  readonly excludeTypes: ReadonlyArray<string>
}

/** The types a run never takes: `exclude_types`, and epics. */
export const excludedTypes = (filter: Filter): ReadonlyArray<string> =>
  filter.excludeTypes.includes(epicType) ? filter.excludeTypes : [...filter.excludeTypes, epicType]

/** Whether the run may take `issue` from bd ready: not a question, nor of an excluded type. */
export const takes = (filter: Filter, issue: Issue): boolean =>
  !issue.labels.includes(HumanLabel) && !excludedTypes(filter).includes(issue.type)

/** The issue's priority for sorting: bd's 0 to 4, and after them an issue bd gives none. */
const rank = (issue: Issue): number => issue.priority ?? 9

/** `issues` highest priority first, keeping bd's order among equals. */
export const byPriority = (issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> =>
  issues
    .map((issue, i) => [issue, i] as const)
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j)
    .map(([issue]) => issue)

/**
 * bd ready within `scope` (null: all of it), minus questions and the excluded types, highest
 * priority first. A scope is its ticket and its descendants: bd ready --parent names the
 * descendants, taken with the ticket itself from the whole of bd ready in its order. bd filters,
 * and the result is filtered again, as orchestra does.
 */
export const ready = (
  beads: Beads["Service"],
  scope: string | null,
  filter: Filter,
): Effect.Effect<ReadonlyArray<Issue>, BeadsError> =>
  Effect.gen(function* () {
    const options = { excludeLabels: [HumanLabel], excludeTypes: excludedTypes(filter) }
    const all = yield* beads.ready(options)
    if (scope === null) return byPriority(all.filter((issue) => takes(filter, issue)))
    const inScope = new Set([
      scope,
      ...(yield* beads.ready({ ...options, parent: scope })).map((issue) => issue.id),
    ])
    const under = all.filter((issue) => inScope.has(issue.id))
    return byPriority(under.filter((issue) => takes(filter, issue)))
  })

/**
 * How many of `open`, bd's tickets not closed, the queue draws from: those the run may take, in its
 * scope, a scope being its ticket and the descendants `open` gives it (a closed ticket has none open).
 */
export const unclosedIn = (
  open: ReadonlyArray<Issue>,
  scope: string | null,
  filter: Filter,
): number => {
  const parentOf = new Map(open.map((issue) => [issue.id, issue.parent]))
  const inScope = (id: string): boolean => {
    const seen = new Set<string>()
    for (let at: string | undefined = id; at !== undefined; at = parentOf.get(at)) {
      if (at === scope) return true
      if (seen.has(at)) return false
      seen.add(at)
    }
    return false
  }
  return open.filter((issue) => takes(filter, issue) && (scope === null || inScope(issue.id)))
    .length
}

/** The ticket's subtickets, theirs and so on, closed or not: bd lists one level at a time. */
export const descendants = (
  beads: Beads["Service"],
  id: string,
): Effect.Effect<ReadonlyArray<Issue>, BeadsError> =>
  Effect.gen(function* () {
    const found: Array<Issue> = []
    const seen = new Set([id])
    for (let queue = [id]; queue.length > 0; ) {
      const [next, ...rest] = queue
      queue = rest
      for (const child of yield* beads.list({ all: true, parent: next as string })) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        found.push(child)
        queue.push(child.id)
      }
    }
    return found
  })

/** What the run knows of a scope's tickets beside Beads, to say why one isn't done. */
export interface View {
  /** Why the ticket is closed but not merged, or undefined when it isn't. */
  unmerged(issue: Pick<Issue, "id" | "status" | "labels">): string | undefined
  /** Whether the run set the ticket aside. */
  aside(id: string): boolean
  /** Whether the run closed the ticket, an epic, as its last subticket merged. */
  closedByRun(id: string): boolean
  /**
   * Where the whole output is of the setup that failed in the ticket's worktree, keeping it out of
   * the run, Waiting{setup}; undefined when it didn't.
   */
  setupFailed?(id: string): string | undefined
}

/** The label of a ticket closed but not merged, which later runs read (§ 5.1). */
export const unmergedLabel = "unmerged"

/**
 * The View the ledger gives: a closed ticket the run still has short of Done is not merged (for
 * the reason its phase gives, if any), and so is one labelled `unmerged`; one Deferred, left for
 * Review or Blocked was set aside; `closed` names the epics the run closed; `setups` gives, by
 * ticket, where the output is of the setup that failed in its worktree.
 */
export const ledgerView = (
  state: State,
  closed: ReadonlySet<string> = new Set(),
  setups: ReadonlyMap<string, string> = new Map(),
): View => ({
  unmerged: (issue) => {
    const phase = state.tickets.get(issue.id)?.phase
    if (issue.status !== "closed" || phase?._tag === "Done") return undefined
    switch (phase?._tag) {
      case "Review":
      case "Blocked":
      case "Stopped":
        return phase.why
      case "ToMerge":
      case "Merging":
      case "Resolving":
      case "Fixing":
        return "waiting to merge"
    }
    return issue.labels.includes(unmergedLabel) ? `labelled ${unmergedLabel}` : undefined
  },
  aside: (id) => {
    const tag = state.tickets.get(id)?.phase._tag
    return tag === "Deferred" || tag === "Review" || tag === "Blocked"
  },
  closedByRun: (id) => closed.has(id),
  setupFailed: (id) => setups.get(id),
})

/** A ticket of the scope that isn't closed and merged, and why, as SCOPE_OPEN names it. */
export interface NotDone {
  readonly id: string
  /** `blocked by Y`, `in progress`, `waiting for its subtickets`, … */
  readonly why: string
}

/** Where a scope stands at the end of its run. */
export type End =
  /**
   * Its ticket and every descendant closed and merged. `closed` says who closed the ticket, an
   * epic: tutti as its last subticket merged, or, should that not have happened, you.
   */
  | {
      readonly _tag: "Done"
      readonly root: string
      readonly subtickets: number
      readonly closed: "tutti" | "you" | null
    }
  /** Descendants not done, or only the ticket itself (`notDone` is then just the ticket). */
  | {
      readonly _tag: "Open"
      readonly root: string
      readonly subtickets: number
      readonly notDone: ReadonlyArray<NotDone>
      /** Only the ticket itself is left. */
      readonly onlyRoot: boolean
    }
  /** bd couldn't say: `what` it couldn't read, and why. */
  | {
      readonly _tag: "Unreadable"
      readonly root: string
      readonly what: string
      readonly reason: string
    }

/** An open question for the maintainer that blocks `issue`, as bd show gives its links. */
const openQuestion = (issue: Issue): Dependency | undefined =>
  issue.dependencies.find(
    (link) =>
      link.type === "blocks" &&
      link.issue !== undefined &&
      link.issue.status !== "closed" &&
      link.issue.labels.includes(HumanLabel),
  )

/** Why `issue`, of the scope `inScope`, isn't closed and merged; `openKids` that its subtickets aren't. */
const notDoneWhy = (
  beads: Beads["Service"],
  view: View,
  filter: Filter,
  brief: Issue,
  inScope: ReadonlySet<string>,
  openKids: boolean,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const unmerged = view.unmerged(brief)
    if (unmerged !== undefined) return `closed but not merged: ${unmerged}`
    // bd show gives the issues it links to, with their status and labels.
    const issue = yield* beads.show(brief.id).pipe(Effect.orElseSucceed(() => brief))
    const question = openQuestion(issue)
    if (question !== undefined) return `waiting on your answer to ${question.id}`
    if (view.aside(issue.id)) return "set aside in this run"
    const setup = view.setupFailed?.(issue.id)
    if (setup !== undefined) return `its setup failed; the whole output is in ${setup}`
    if (issue.status === "deferred") return "deferred"
    if (issue.status === "in_progress") return "in progress"
    for (const link of issue.dependencies) {
      if (link.type !== "blocks") continue
      const where = inScope.has(link.id) ? "" : " outside the scope"
      if (link.issue !== undefined && link.issue.status !== "closed") {
        return `blocked by ${link.id}${where}`
      }
      if (link.issue !== undefined && view.unmerged(link.issue) !== undefined) {
        return `blocked by ${link.id}${where}, closed but not merged`
      }
    }
    for (const link of issue.dependencies) {
      if (
        link.type === "discovered-from" &&
        link.issue?.status === "closed" &&
        view.unmerged(link.issue) !== undefined
      ) {
        return `filed by ${link.id}'s worker; ${link.id} is closed but not merged`
      }
    }
    if (openKids) return "waiting for its subtickets"
    if (excludedTypes(filter).includes(issue.type)) {
      return `its subtickets are merged; close it with: bd close ${issue.id}`
    }
    return "not started"
  })

const reasonOf = (error: BeadsError): string =>
  error._tag === "BeadsFailed"
    ? error.stderr.trim() || `exit code ${error.exitCode}`
    : error._tag === "BeadsTimedOut"
      ? "bd timed out"
      : error.reason

/**
 * Where the scope of `root` stands, as the end of its run says it: its descendants and the ticket
 * itself, read from Beads, with what the run knows of them (`view`).
 */
export const end = (
  beads: Beads["Service"],
  root: string,
  view: View,
  filter: Filter,
): Effect.Effect<End> =>
  Effect.gen(function* () {
    const subs = yield* descendants(beads, root).pipe(Effect.result)
    if (subs._tag === "Failure") {
      const what = `${root}'s subtickets`
      return { _tag: "Unreadable", root, what, reason: reasonOf(subs.failure) } as const
    }
    const top = yield* beads.show(root).pipe(Effect.result)
    if (top._tag === "Failure") {
      return { _tag: "Unreadable", root, what: root, reason: reasonOf(top.failure) } as const
    }
    const tickets = subs.success
    const inScope = new Set([root, ...tickets.map((issue) => issue.id)])
    const done = (issue: Issue) => issue.status === "closed" && view.unmerged(issue) === undefined
    const openParents = new Set(
      tickets.flatMap((issue) => (done(issue) || issue.parent === undefined ? [] : [issue.parent])),
    )
    const notDone: Array<NotDone> = []
    for (const issue of tickets) {
      if (done(issue)) continue
      const why = yield* notDoneWhy(beads, view, filter, issue, inScope, openParents.has(issue.id))
      notDone.push({ id: issue.id, why })
    }
    const subtickets = tickets.length
    if (notDone.length > 0) {
      return { _tag: "Open", root, subtickets, notDone, onlyRoot: false } as const
    }
    if (done(top.success)) {
      const closed = view.closedByRun(root) ? "tutti" : null
      return { _tag: "Done", root, subtickets, closed } as const
    }
    if (excludedTypes(filter).includes(top.success.type)) {
      return { _tag: "Done", root, subtickets, closed: "you" } as const
    }
    const why = yield* notDoneWhy(beads, view, filter, top.success, inScope, false)
    return { _tag: "Open", root, subtickets, notDone: [{ id: root, why }], onlyRoot: true } as const
  })

/** `1 subticket` or `n subtickets`. */
const subtickets = (n: number): string => (n === 1 ? "1 subticket" : `${n} subtickets`)

/**
 * The scope line, as orchestra words it: `SCOPE_DONE: <id> and its 3 subtickets are merged`,
 * `SCOPE_OPEN: <id>: 2 of its 5 subtickets not done: <id>.2 (blocked by x-7 outside the scope), …`,
 * or `SCOPE_UNREADABLE: could not read <id>: …`. The texts are Beads' IDs and words: the Log's
 * `line` sanitises them where they are logged.
 */
export const line = (scope: End): string => {
  const { root } = scope
  switch (scope._tag) {
    case "Unreadable":
      return `SCOPE_UNREADABLE: could not ${scope.what === root ? "read" : "list"} ${scope.what}: ${scope.reason}`
    case "Done": {
      const verb = scope.subtickets === 1 ? "is" : "are"
      const merged = `${root}'s ${subtickets(scope.subtickets)} ${verb} merged`
      if (scope.closed === "tutti") return `SCOPE_DONE: ${merged}; tutti closed ${root}`
      if (scope.closed === "you") return `SCOPE_DONE: ${merged}; close it with: bd close ${root}`
      return `SCOPE_DONE: ${root} and its ${subtickets(scope.subtickets)} are merged`
    }
    case "Open": {
      if (scope.onlyRoot) {
        const why = scope.notDone[0]?.why ?? "not started"
        const verb = scope.subtickets === 1 ? "is" : "are"
        return `SCOPE_OPEN: ${root}: its ${subtickets(scope.subtickets)} ${verb} merged, but ${root} itself is not done (${why})`
      }
      const open = scope.notDone.map((each) => `${each.id} (${each.why})`).join(", ")
      return `SCOPE_OPEN: ${root}: ${scope.notDone.length} of its ${subtickets(scope.subtickets)} not done: ${open}`
    }
  }
}
