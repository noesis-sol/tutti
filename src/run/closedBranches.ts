// A ticket closed where the run didn't see it close (by hand, by another tool, under an earlier
// tutti) went through no merge: bd counts it done, but its work may be only on its branch. So, as
// orchestra's closed_unmerged.go has it, a closed blocker is not merged while git says so: tutti/<id>
// exists, has commits the base doesn't have, and the base doesn't hold its changes (squash-merged by
// hand), the tests unmerged.ts's mergedSince makes of a branch. A branch with nothing beyond the
// base, or no branch at all, holds nothing back: deleting it frees the tickets it blocks. Where git
// fails to tell, the blocker is not merged either, until git can.
//
// What git said is kept for each ticket and the commit the base is on, so that a fill asks git once
// for each blocker, not once for each ready ticket it blocks, and again once the base moves; one
// found not on the base is asked of again too once its branch is on another commit or gone. The
// first time a blocker is found so, CLOSED_UNMERGED says once how to clear it.
import { Effect, Result } from "effect"
import { Git, type GitError } from "../services/Git.ts"
import { branchOf } from "../services/Worktrees.ts"
import { EventStream } from "./eventstream.ts"
import { type Line, Log, Tag, ticketLine } from "./log.ts"
import { gitWhy } from "./merge.ts"

/** Where the run's tickets merge: the main checkout and the base branch. */
export interface Where {
  readonly repo: string
  readonly base: string
}

/** Closed tickets' branches, as git finds them, kept for each ticket and the base's commit. */
export interface ClosedBranches {
  /** The commit the base is on, read once a fill; undefined when git can't say. */
  readonly head: Effect.Effect<string | undefined>
  /**
   * Why closed ticket `id`'s work is only on its branch, the base on `head`, or undefined when it
   * isn't: `tutti/<id> is not on <base>`, or that git can't tell, with git's error.
   */
  why(id: string, head: string | undefined): Effect.Effect<string | undefined>
}

/** The CLOSED_UNMERGED warning, said once of each closed ticket whose work is only on its branch. */
export const closedUnmergedLine = (id: string, base: string): Line => {
  const branch = branchOf(id)
  return ticketLine(
    Tag.closedUnmerged,
  )`${id} is closed, but ${branch} is not on ${base}: the tickets it blocks wait until it merges; merge it into ${base}, or delete the branch if its work isn't wanted (git branch -D ${branch})`
}

/** Whether the branch is there, as rev-parse --verify --quiet says: it exits 1, silent, if not. */
export const branchThere = (repo: string, branch: string): Effect.Effect<boolean, GitError, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    return yield* git.revParse(repo, `refs/heads/${branch}`).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        error._tag === "GitFailed" && error.exitCode === 1 && error.stderr.trim() === ""
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    )
  })

/**
 * Why closed ticket `id`'s work is only on its branch, as git finds it: `<branch> is not on
 * <base>` when the branch is there, has commits the base doesn't and the base doesn't hold its
 * changes; undefined when it is on the base, or gone. Git failing to tell fails with its error.
 */
export const branchOff = (
  id: string,
  where: Where,
): Effect.Effect<string | undefined, GitError, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const branch = branchOf(id)
    if (!(yield* branchThere(where.repo, branch))) return undefined
    if ((yield* git.log(where.repo, where.base, branch)).length === 0) return undefined
    if (yield* git.holds(where.repo, where.base, branch)) return undefined
    return `${branch} is not on ${where.base}`
  })

/** What git said of a closed ticket's branch: why, with the base on `head` and the branch on `tip`. */
interface Known {
  readonly head: string
  readonly tip: string | undefined
  readonly why: string | undefined
}

/** The ClosedBranches of the checkout `where` names, warning on its Log and EventStream. */
export const closedBranches = (
  where: Where,
): Effect.Effect<ClosedBranches, never, Git | Log | EventStream> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Git | Log | EventStream>()
    const git = yield* Git
    const known = new Map<string, Known>()
    const warned = new Set<string>()
    // The commit the branch is on; undefined when git can't say, so that it is asked again.
    const tipOf = (id: string) =>
      git.revParse(where.repo, `refs/heads/${branchOf(id)}`).pipe(
        Effect.map((hash): string | undefined => hash),
        Effect.orElseSucceed(() => undefined),
      )
    return {
      head: git.revParse(where.repo, where.base).pipe(
        Effect.map((hash): string | undefined => hash),
        Effect.orElseSucceed(() => undefined),
      ),
      why: (id, head) =>
        Effect.gen(function* () {
          const before = known.get(id)
          if (before !== undefined && head !== undefined && before.head === head) {
            if (before.why === undefined) return undefined
            if (before.tip !== undefined && (yield* tipOf(id)) === before.tip) return before.why
          }
          // The tip before git is asked: a branch that moves meanwhile is asked of again.
          const tip = yield* tipOf(id)
          const off = yield* Effect.result(branchOff(id, where))
          if (Result.isFailure(off)) {
            known.delete(id)
            return `git can't tell whether ${branchOf(id)} is on ${where.base}: ${gitWhy(off.failure)}`
          }
          const why = off.success
          if (head === undefined) known.delete(id)
          else known.set(id, { head, tip, why })
          if (why !== undefined && !warned.has(id)) {
            warned.add(id)
            const text = closedUnmergedLine(id, where.base)
            yield* (yield* EventStream).emit({ kind: "warn", ticket: id, text })
            yield* (yield* Log).write(text)
          }
          return why
        }).pipe(Effect.provideContext(context)),
    }
  })
