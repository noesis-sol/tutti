// The setup before the merge check (§ 5 item 7, § 5.1's Merging{setup}, § 8.4's checks.setup), as
// orchestra's setup.go has it. A finished ticket's worktree has the dependencies its worker
// installed (node_modules, a virtualenv) for the code as it closed the ticket. Its rebase onto the
// base can bring in a lockfile another ticket changed meanwhile, and the check would then run the
// rebased code against the old dependencies and fail on code the ticket never touched. So before
// the check on a rebased branch, the setup command (checks.setup.command, such as bun install) runs
// in the worktree when the base's commits since its dependencies were last set up change a file
// checks.setup.files names; when git can't say what they change, it runs anyway. It runs within
// the check's time limit, its whole output in the worktree's .tutti/run/setup.log, and a setup that
// fails fails the check: the ticket is set aside as for a failing check (merge.ts).
//
// What a worktree was last set up for is a commit of the base: the one its branch left the base at,
// until a setup in this run passes, then the one that setup was for. A setup that fails leaves it as
// it was, so a recheck sets up again. orchestra compares the branch's commits instead, which counts
// the ticket's own changes to a lockfile too; its worker installed those itself.
import { basename, join } from "node:path"
import { Effect, Ref, Result } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { type CheckError, Checks, setupLogName } from "../services/Checks.ts"
import { Git } from "../services/Git.ts"
import { runFolder, type Worktrees } from "../services/Worktrees.ts"
import { outputFile } from "./check.ts"
import { globMatch } from "./footprint.ts"
import { Ledger } from "./ledger.ts"
import { detail, Log, line } from "./log.ts"
import type { FinishedTicket, MergeOptions } from "./merge.ts"
import { Detail } from "./phase.ts"

/** The base commits the tickets' dependencies were last set up for in a run. */
export interface SetUps {
  /**
   * The base commit the ticket's dependencies were last set up for: `fork`, where its branch left
   * the base, the first time it is asked, until `set` says otherwise.
   */
  from(id: string, fork: string): Effect.Effect<string>
  /** The ticket's dependencies are now set up for the base at `onto`. */
  set(id: string, onto: string): Effect.Effect<void>
}

/** A run's setups: none yet. */
export const makeSetUps: Effect.Effect<SetUps> = Effect.map(
  Ref.make<ReadonlyMap<string, string>>(new Map()),
  (ref) =>
    ({
      from: (id, fork) =>
        Ref.modify(ref, (setUps) => {
          const from = setUps.get(id)
          return from === undefined ? [fork, new Map(setUps).set(id, fork)] : [from, setUps]
        }),
      set: (id, onto) => Ref.update(ref, (setUps) => new Map(setUps).set(id, onto)),
    }) satisfies SetUps,
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
 * Runs the setup command in the ticket's worktree, its branch just rebased onto the base at `onto`
 * from `fork`, when the base's commits since its dependencies were last set up change a file
 * checks.setup.files names, or git can't say whether they do; Merging{setup} while it runs.
 */
export const setUp = (
  ticket: FinishedTicket,
  options: MergeOptions,
  setUps: SetUps,
  fork: string,
  onto: string,
): Effect.Effect<SetUp, never, AppConfig | Checks | Git | Worktrees | Ledger | Log> =>
  Effect.gen(function* () {
    const { command, files } = (yield* AppConfig).settings.checks.setup
    if (command === null) return { _tag: "Unneeded" } satisfies SetUp
    const git = yield* Git
    const from = yield* setUps.from(ticket.id, fork)
    const changed = yield* Effect.result(git.changedFiles(options.repo, from, onto))
    let what = "git could not say what the rebase changed"
    if (Result.isSuccess(changed)) {
      const hit = setupFilesIn(changed.success, files)
      if (hit.length === 0) return { _tag: "Unneeded" } satisfies SetUp
      what = line`${fileList(hit)} changed in the rebase`
    }
    yield* (yield* Ledger).refine(ticket.id, Detail.Step({ step: "setup" }))
    yield* (yield* Log).write(detail`${ticket.id}: ${what}; running '${command}' before the check`)
    const checks = yield* Checks
    const output = join(ticket.worktree, runFolder, setupLogName)
    const ran = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* outputFile(ticket, setupLogName, "the setup's")
        return yield* Effect.result(
          checks.setup({ cwd: ticket.worktree, outputFile: file, before: "fast" }),
        )
      }),
    )
    if (Result.isFailure(ran)) {
      return { _tag: "Failed", error: ran.failure, output } satisfies SetUp
    }
    if (ran.success._tag === "NoCheckCommand") return { _tag: "Unneeded" } satisfies SetUp
    yield* setUps.set(ticket.id, onto)
    return { _tag: "Passed" } satisfies SetUp
  })
