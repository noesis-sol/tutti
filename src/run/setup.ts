// The setup before the merge check (§ 5 item 7, § 5.1's Merging{setup}, § 8.4's checks.setup), as
// orchestra's setup.go has it. A finished ticket's worktree has the dependencies its worker
// installed (node_modules, a virtualenv) for the code as it closed the ticket. Its rebase onto the
// base can bring in a lockfile another ticket changed meanwhile, and the check would then run the
// rebased code against the old dependencies and fail on code the ticket never touched. So before
// the check on a rebased branch, the setup command (checks.setup.command, such as bun install) runs
// in the worktree when the base's commits since its dependencies were last set up change a file
// checks.setup.files names; when git can't say what they change, it runs anyway. Before the check
// on a worker's fix of a failed check, or on its resolution of a rebase, the worker's own commits
// count too, as orchestra's checkRebased has it ("the rebase, or the fix, may have changed the
// dependencies"): a fix that changes bun.lock is checked on the dependencies it names. It runs
// within the check's time limit, its whole output in the worktree's .tutti/run/setup.log, and a
// setup that fails fails the check: the ticket is set aside as for a failing check (merge.ts).
//
// What a worktree was last set up for is a commit of the base, and one of its branch: the base's
// where its branch left it, and the branch's before its worker's fix or resolution, until a setup in
// this run passes, then the ones that setup was for. A setup that fails leaves them as they were, so
// a recheck, or the next fix, sets up again. The branch's own commits count only after a fix or a
// resolution: those its worker made before it closed the ticket, it installed for itself.
import { basename, join } from "node:path"
import { Effect, Ref, Result } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { type CheckError, Checks, setupLogName } from "../services/Checks.ts"
import { Git } from "../services/Git.ts"
import { runFolder, type Worktrees } from "../services/Worktrees.ts"
import { outputTo } from "./check.ts"
import { globMatch } from "./footprint.ts"
import { Ledger } from "./ledger.ts"
import { detail, Log, line } from "./log.ts"
import type { FinishedTicket, MergeOptions } from "./merge.ts"
import { Detail } from "./phase.ts"

/** The commits the tickets' dependencies were last set up for in a run. */
export interface SetUps {
  /**
   * The base commit the ticket's dependencies were last set up for: `fork`, where its branch left
   * the base, the first time it is asked, until `set` says otherwise.
   */
  from(id: string, fork: string): Effect.Effect<string>
  /**
   * The branch commit the ticket's dependencies were last set up for, as far as its worker's own
   * commits go: `at`, its branch before its worker's fix or resolution, the first time it is asked,
   * until `set` says otherwise; "" when git couldn't say.
   */
  since(id: string, at: string): Effect.Effect<string>
  /** The ticket's dependencies are now set up for the base at `onto` and its branch at `head`. */
  set(id: string, onto: string, head: string): Effect.Effect<void>
}

/** What a ticket's dependencies were last set up for, of what was asked: the base's commit, its branch's. */
interface SetUpFor {
  readonly base?: string
  readonly head?: string
}

/** A run's setups: none yet. */
export const makeSetUps: Effect.Effect<SetUps> = Effect.map(
  Ref.make<ReadonlyMap<string, SetUpFor>>(new Map()),
  (ref) => {
    /** The ticket's `key`, `first` and kept so the first time it is asked. */
    const get = (id: string, key: keyof SetUpFor, first: string) =>
      Ref.modify(ref, (setUps): [string, ReadonlyMap<string, SetUpFor>] => {
        const was = setUps.get(id)
        const kept = was?.[key]
        if (kept !== undefined) return [kept, setUps]
        return [first, new Map(setUps).set(id, { ...was, [key]: first })]
      })
    return {
      from: (id, fork) => get(id, "base", fork),
      since: (id, at) => get(id, "head", at),
      set: (id, onto, head) =>
        Ref.update(ref, (setUps) => new Map(setUps).set(id, { base: onto, head })),
    } satisfies SetUps
  },
)

/**
 * The files of `files` that one of `globs` matches: by its name, or by its path from the
 * repository's top when the glob has a slash (a leading one aside), as orchestra matches them.
 */
export const setupFilesIn = (
  files: ReadonlyArray<string>,
  globs: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  files.filter((file) =>
    globs.some((glob) =>
      glob.includes("/")
        ? globMatch((glob.startsWith("/") ? glob.slice(1) : glob).split("/"), file.split("/"))
        : globMatch([glob], [basename(file)]),
    ),
  )

/** The most files a line names of those the rebase changed. */
export const maxFilesNamed = 5

/** The files for a line: at most maxFilesNamed of them, then how many more. */
export const fileList = (files: ReadonlyArray<string>): string =>
  files.length <= maxFilesNamed
    ? line`${files}`
    : line`${files.slice(0, maxFilesNamed)} and ${files.length - maxFilesNamed} more`

/** How the setup before a ticket's check went. */
export type SetUp =
  /** No setup command is set, or no file it is for changed: nothing ran. */
  | { readonly _tag: "Unneeded" }
  | { readonly _tag: "Passed" }
  /** It failed, timed out or couldn't run; `output` is where its whole output is. */
  | { readonly _tag: "Failed"; readonly error: CheckError; readonly output: string }

/**
 * A worker's own commits on the ticket's branch since it closed the ticket, whose changes to a setup
 * file count before their check too: its fix of a failed check, or its resolution of the rebase,
 * made on its branch at `from`.
 */
export interface Fix {
  readonly what: "fix" | "resolution"
  readonly from: string
}

/**
 * Runs the setup command in the ticket's worktree, its branch just rebased onto the base at `onto`
 * from `fork`, when the base's commits since its dependencies were last set up change a file
 * checks.setup.files names, or, after its worker's `fix`, the branch's commits since then do, or git
 * can't say whether they do; Merging{setup} while it runs, unless it is for a `fix` (checked again
 * in Fixing or Resolving).
 */
export const setUp = (
  ticket: FinishedTicket,
  options: MergeOptions,
  setUps: SetUps,
  fork: string,
  onto: string,
  fix?: Fix,
): Effect.Effect<SetUp, never, AppConfig | Checks | Git | Worktrees | Ledger | Log> =>
  Effect.gen(function* () {
    const { command, files } = (yield* AppConfig).settings.checks.setup
    if (command === null) return { _tag: "Unneeded" } satisfies SetUp
    const git = yield* Git
    const from = yield* setUps.from(ticket.id, fork)
    const changed = yield* Effect.result(git.changedFiles(options.repo, from, onto))
    const at = yield* Effect.result(git.revParse(options.repo, ticket.branch))
    const head = Result.isSuccess(at) ? at.success : ""
    const why: Array<string> = []
    const rebased = Result.isSuccess(changed) ? setupFilesIn(changed.success, files) : []
    if (Result.isFailure(changed)) why.push("git could not say what the rebase changed")
    else if (rebased.length > 0) why.push(line`${fileList(rebased)} changed in the rebase`)
    if (fix !== undefined) {
      const since = yield* setUps.since(ticket.id, fix.from)
      const own =
        since === "" || head === ""
          ? undefined
          : yield* Effect.result(git.filesBetween(options.repo, since, head))
      if (own === undefined || Result.isFailure(own)) {
        why.push(line`git could not say what its worker's ${fix.what} changed`)
      } else {
        const hit = setupFilesIn(own.success, files).filter((file) => !rebased.includes(file))
        if (hit.length > 0) why.push(line`${fileList(hit)} changed in its worker's ${fix.what}`)
      }
    }
    if (why.length === 0) return { _tag: "Unneeded" } satisfies SetUp
    const what = why.join(" and ")
    if (fix === undefined) yield* (yield* Ledger).refine(ticket.id, Detail.Step({ step: "setup" }))
    yield* (yield* Log).write(detail`${ticket.id}: ${what}; running '${command}' before the check`)
    const checks = yield* Checks
    const output = join(ticket.worktree, runFolder, setupLogName)
    const ran = yield* Effect.scoped(
      Effect.gen(function* () {
        const to = yield* outputTo(ticket, setupLogName, "the setup's")
        return yield* Effect.result(checks.setup({ cwd: ticket.worktree, ...to, before: "fast" }))
      }),
    )
    if (Result.isFailure(ran)) {
      return { _tag: "Failed", error: ran.failure, output } satisfies SetUp
    }
    if (ran.success._tag === "NoCheckCommand") return { _tag: "Unneeded" } satisfies SetUp
    yield* setUps.set(ticket.id, onto, head)
    return { _tag: "Passed" } satisfies SetUp
  })
