// DEFERRED_FREE (§ 5 item 4), as orchestra's deferred_free.go has it. A ticket deferred because it
// started before its blocker merged, or deferred by hand, stays deferred once the blocker merges:
// nothing brings it back. The run's START block, and the box of a run with nothing to run, list
// each such ticket with the command that reopens it. Only list: a deferral can have other reasons,
// so the maintainer decides. One deferred until a later date (bd defer --until) was deferred on
// purpose, with a time to look again, and isn't listed until that time has come.
import { Clock, Effect, Result } from "effect"
import { Beads, type BeadsError, HumanLabel, type Issue } from "../services/Beads.ts"
import { shellWord } from "../services/exec.ts"
import { Git } from "../services/Git.ts"
import { branchOf } from "../services/Worktrees.ts"
import type { Carried } from "./carry.ts"
import { asking, type Branches, type ClosedBranches } from "./closedBranches.ts"
import { EventStream } from "./eventstream.ts"
import { detail, Log, line } from "./log.ts"
import { descendants, excludedTypes, type Filter } from "./scope.ts"

/** A deferred ticket in the run's scope whose blockers have all merged. */
export interface DeferredFree {
  readonly id: string
  /** The tickets blocking it, each closed and merged. */
  readonly blockers: ReadonlyArray<string>
  /**
   * Its worktree (on tutti/<id>), left with no commits beyond the base and no uncommitted changes,
   * and so safe to remove; absent when there is none, or it holds work.
   */
  readonly worktree?: string
  /**
   * Its worktree when that has no commits beyond the base but uncommitted changes, which removing
   * it with --force would lose; absent otherwise.
   */
  readonly uncommitted?: string
}

/** The command that puts the ticket back in bd ready. */
export const reopen = (d: DeferredFree): string => `bd update ${d.id} --status open`

/** The command that removes the ticket's empty worktree and its branch; undefined without one. */
export const cleanup = (d: DeferredFree): string | undefined =>
  d.worktree === undefined
    ? undefined
    : `git worktree remove ${shellWord(d.worktree)} && git branch -d ${branchOf(d.id)}`

/** The command that shows the uncommitted changes in the ticket's worktree; undefined without them. */
export const changes = (d: DeferredFree): string | undefined =>
  d.uncommitted === undefined ? undefined : `git -C ${shellWord(d.uncommitted)} status`

/** What frees the ticket: `its blockers have merged (A, B)`. */
export const why = (d: DeferredFree): string =>
  `its blockers have merged (${d.blockers.join(", ")})`

/**
 * The DEFERRED_FREE line the START block gives the ticket, naming its empty worktree too, or the
 * uncommitted changes that keep it. The IDs are Beads': the Log's `line` sanitises the text.
 */
export const startLine = (d: DeferredFree, base: string): string => {
  const head = `DEFERRED_FREE: ${d.id}: ${why(d)}; to run it: ${reopen(d)}`
  const removable = cleanup(d)
  if (removable !== undefined) {
    return `${head}; its worktree has no commits beyond ${base}, safe to remove: ${removable}`
  }
  const kept = changes(d)
  return kept === undefined
    ? head
    : `${head}; its worktree holds uncommitted changes, not safe to remove: ${kept}`
}

/** What listing the deferred tickets whose blockers have merged needs to know of the run. */
export interface Freeing {
  /** The main checkout. */
  readonly repo: string
  /** The branch tickets merge into. */
  readonly base: string
  /** The queue's `exclude_types`. */
  readonly filter: Filter
  /** Whether the ticket is in the run's scope. */
  readonly inScope: (id: string) => boolean
  /** Why the blocker `id`, closed in bd or not, hasn't merged; undefined once it has. */
  readonly pending: (id: string, closed: boolean) => Effect.Effect<string | undefined, never, Git>
}

/**
 * Why a blocker hasn't merged as a run starts, before its loop: its worker, carried over from the
 * last run, is busy with it; it isn't closed; it is closed but not merged (`unmerged`, as the run
 * finds those left so by an earlier run); or, closed where no run saw it close, git finds its work
 * only on its branch (`branches`, closedBranches.ts). A closed blocker none of those has merged,
 * though bd may still label it `unmerged`: the run and git, not a label, say what has merged.
 */
export const startPending =
  (carried: ReadonlySet<string>, unmerged: ReadonlySet<string>, branches?: Branches) =>
  (id: string, closed: boolean): Effect.Effect<string | undefined, never, Git> =>
    carried.has(id)
      ? Effect.succeed("running")
      : !closed
        ? Effect.succeed("not closed")
        : unmerged.has(id)
          ? Effect.succeed("left unmerged by an earlier run")
          : branches === undefined
            ? Effect.succeed(undefined)
            : branches(id)

/** Whether the ticket was deferred until a date still to come, as against `now` (epoch ms). */
const deferredUntilLater = (issue: Issue, now: number): boolean => {
  if (issue.deferUntil === undefined) return false
  const until = Date.parse(issue.deferUntil)
  return !Number.isNaN(until) && until > now
}

/** The tickets blocking `issue`, as bd show gives it, if each is closed and merged. */
const mergedBlockers = (
  freeing: Freeing,
  issue: Issue,
): Effect.Effect<ReadonlyArray<string> | undefined, never, Git> =>
  Effect.gen(function* () {
    const ids: Array<string> = []
    for (const link of issue.dependencies) {
      if (link.type !== "blocks") continue
      const closed = link.issue?.status === "closed"
      if ((yield* freeing.pending(link.id, closed)) !== undefined) return undefined
      ids.push(link.id)
    }
    return ids
  })

/**
 * The worktree a worker left for ticket `id` when its branch has no commits beyond the base: as
 * empty when it has no uncommitted changes either, else as uncommitted. Neither when there is
 * none, it has commits, or git can't list the worktrees or the commits; a git status that fails
 * counts as uncommitted changes.
 */
const leftWorktree = (
  freeing: Freeing,
  id: string,
): Effect.Effect<Pick<DeferredFree, "worktree" | "uncommitted">, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const branch = branchOf(id)
    const worktrees = yield* Effect.result(git.worktrees(freeing.repo))
    if (Result.isFailure(worktrees)) return {}
    const found = worktrees.success.find((each) => each.branch === branch && !each.prunable)
    if (found === undefined) return {}
    const commits = yield* Effect.result(git.log(freeing.repo, freeing.base, branch))
    if (Result.isFailure(commits) || commits.success.length > 0) return {}
    const status = yield* Effect.result(git.status(found.path))
    return Result.isSuccess(status) && status.success.length === 0
      ? { worktree: found.path }
      : { uncommitted: found.path }
  })

/**
 * The deferred tickets among `unclosed` (bd's tickets not closed) that are in the run's scope, not
 * questions nor of an excluded type, not deferred until a later date, and have at least one
 * blocker, each closed and merged. bd show is read for each deferred one; its error is bd's, and
 * drops the list.
 */
export const list = (
  freeing: Freeing,
  unclosed: ReadonlyArray<Issue>,
): Effect.Effect<ReadonlyArray<DeferredFree>, BeadsError, Beads | Git> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const now = yield* Clock.currentTimeMillis
    const excluded = excludedTypes(freeing.filter)
    const free: Array<DeferredFree> = []
    for (const ticket of unclosed) {
      if (
        ticket.status !== "deferred" ||
        !freeing.inScope(ticket.id) ||
        excluded.includes(ticket.type) ||
        ticket.labels.includes(HumanLabel) ||
        deferredUntilLater(ticket, now)
      ) {
        continue
      }
      const blockers = yield* mergedBlockers(freeing, yield* beads.show(ticket.id))
      if (blockers === undefined || blockers.length === 0) continue
      free.push({ id: ticket.id, blockers, ...(yield* leftWorktree(freeing, ticket.id)) })
    }
    return free
  })

/** What the log says when bd can't say which deferred tickets are free to run. */
export const unreadable = (reason: string): string =>
  `cannot list the deferred tickets whose blockers have merged: ${reason}`

/** bd's error, in a few words. */
export const reasonOf = (error: BeadsError): string =>
  error._tag === "BeadsFailed"
    ? `${error.command}: ${error.stderr.trim() || `exit code ${error.exitCode}`}`
    : error._tag === "BeadsTimedOut"
      ? `${error.command}: bd timed out`
      : `${error.command}: ${error.reason}`

/**
 * Lists, in the START block, the deferred tickets whose blockers have merged, once the run knows
 * the tickets carried over and left unmerged: each a DEFERRED_FREE line in the log and an `info`
 * record. A bd failure only drops the list, with a line in the log.
 */
export const say = (
  freeing: Freeing,
): Effect.Effect<void, never, Beads | Git | Log | EventStream> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const logs = yield* Log
    const events = yield* EventStream
    const free = yield* Effect.result(Effect.flatMap(beads.list(), (open) => list(freeing, open)))
    if (Result.isFailure(free)) {
      yield* logs.write(line`${unreadable(reasonOf(free.failure))}`)
      return
    }
    for (const d of free.success) {
      const text = detail`${startLine(d, freeing.base)}`
      yield* logs.writeWith([text], events.emit({ kind: "info", ticket: d.id, text }))
    }
  })

/**
 * What became of a saved worker that leaves its ticket's work not yet merged: under way in the run,
 * or kept for a later one, as the box of a run with nothing to run counts every carried ticket.
 */
const underWay: ReadonlySet<Carried> = new Set<Carried>([
  "resumed",
  "asked",
  "toMerge",
  "kept",
  "waiting",
])

/**
 * Says, in the START block of a run scoped to `root` (--ticket, or null for all of bd ready), the
 * deferred tickets whose blockers have merged, given what became of the workers carried over, the
 * tickets left unmerged by an earlier run, and what the run's `closedBranches` says of a blocker
 * closed where no run saw it close: the scope is the ticket and its descendants. bd failing to list
 * those drops the list, with a line in the log.
 */
export const sayAtStart = (options: {
  readonly repo: string
  readonly base: string
  readonly filter: Filter
  readonly root: string | null
  readonly carried: ReadonlyMap<string, Carried>
  readonly unmerged: ReadonlySet<string>
  readonly closedBranches?: ClosedBranches
}): Effect.Effect<void, never, Beads | Git | Log | EventStream> =>
  Effect.gen(function* () {
    const { root } = options
    const subs = yield* Effect.result(
      root === null ? Effect.succeed([]) : descendants(yield* Beads, root),
    )
    if (Result.isFailure(subs)) {
      yield* (yield* Log).write(line`${unreadable(reasonOf(subs.failure))}`)
      return
    }
    const scope = new Set([...(root === null ? [] : [root]), ...subs.success.map((sub) => sub.id)])
    const busy = new Set(
      [...options.carried].filter(([, what]) => underWay.has(what)).map(([id]) => id),
    )
    yield* say({
      repo: options.repo,
      base: options.base,
      filter: options.filter,
      inScope: (id) => root === null || scope.has(id),
      pending: startPending(
        busy,
        options.unmerged,
        options.closedBranches === undefined ? undefined : asking(options.closedBranches),
      ),
    })
  })
