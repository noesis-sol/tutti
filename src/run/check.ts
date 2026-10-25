// The merge check (§ 5 item 7, § 3.4): check_fast in a finished ticket's worktree, its branch rebased
// onto the base, within its time limit. The whole output goes to the worktree's .tutti/run/check.log,
// opened through the symlink guard (§ 9.1) and handed to the check as that descriptor, so no link
// the worker left there can send it elsewhere. A passing check's FLAKY: lines are warnings naming the
// ticket: it merges, but a test that passes only on a rerun is a bug nobody would see otherwise.
// Interrupting the check kills its process group (Checks does), and nothing comes of it.
// The untracked files a check writes in the worktree are noted there (checkWrote.ts), so the merge can
// remove the worktree with them.
//
// A quit can cut that check short with the branch already rebased: the ticket stays waiting to
// merge, for the next run (§ 4.8), but its branch is on top of the base then, so its merge would
// fast-forward without checking it. So before tutti rebases a branch, the ticket is marked in
// state.json as rebased and unchecked (`rebased_unchecked`), and a merge check passing on it
// clears the mark: a branch on top of the base that is still marked is checked before it merges.
//
// A branch on top of the base already, as when nothing merged while its ticket ran, is checked
// before it merges too, as orchestra 0.8.5 has it: no ticket reaches the base unchecked. A run
// keeps the commit of each ticket's branch its check last passed on (Passes), so a branch checked
// as its worker fixed it, or resolved its rebase, isn't checked again while it stays on top.
import { join } from "node:path"
import { Clock, Data, Effect, Predicate, Ref, Result, type Schema, type Scope } from "effect"
import { O } from "../native/libc.ts"
import { formatDuration } from "../project/configFile.ts"
import type { TicketId } from "../services/Beads.ts"
import {
  type CheckError,
  type CheckPassed,
  type CheckResult,
  Checks,
  checkLogName,
  OutputBounds,
  type RunOptions,
} from "../services/Checks.ts"
import { type Git, Sha, type StatusEntry } from "../services/Git.ts"
import { Store } from "../services/Store.ts"
import { runFolder, Worktrees } from "../services/Worktrees.ts"
import { noteWritten } from "./checkWrote.ts"
import { type checkSuites, tenths } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { detail, type Line, Log, line, Tag, ticketLine } from "./log.ts"
import { warn } from "./say.ts"

/** How a ticket's merge check went. */
export type Checked = Data.TaggedEnum<{
  /**
   * It passed; `command` is the check that ran. `after`: its worktree's status read as it ended, if
   * git read one (checkWrote.ts's noteWritten), for its caller to look for changes it left.
   */
  Passed: { readonly command: string; readonly after?: ReadonlyArray<StatusEntry> }
  /** No check command is set: the rebased code merges unchecked. `after`, as Passed's. */
  Unchecked: { readonly after?: ReadonlyArray<StatusEntry> }
  /** It failed, timed out or couldn't run; `output` is where its whole output is. */
  Failed: { readonly error: CheckError; readonly output: string }
}>

export const Checked = Data.taggedEnum<Checked>()

/** Which check a `check` record is of (§ 10). */
export type CheckSuite = (typeof checkSuites)[number]

/**
 * Runs `check`, a check or a setup, and writes its `check` record (§ 10) once it ends, `ticket`'s
 * (none for the full check's): what ran, for how long and how it went. A check with no command ran
 * nothing and has none. How it went, as Effect.result gives it.
 */
export const recorded = <R>(
  suite: CheckSuite,
  ticket: string | undefined,
  check: Effect.Effect<CheckResult, CheckError, R>,
  options: { readonly train?: boolean } = {},
): Effect.Effect<Result.Result<CheckResult, CheckError>, never, R | EventStream> =>
  Effect.gen(function* () {
    const events = yield* EventStream
    const start = yield* Clock.currentTimeMillis
    const ran = yield* Effect.result(check)
    const seconds = tenths((yield* Clock.currentTimeMillis) - start)
    const base = {
      kind: "check" as const,
      suite,
      ...(ticket === undefined ? {} : { ticket }),
      seconds,
      ...(options.train === true ? { train: true as const } : {}),
    }
    if (Result.isSuccess(ran)) {
      if (ran.success._tag === "CheckPassed") {
        yield* events.emit({ ...base, command: ran.success.command, result: "passed" })
      }
      return ran
    }
    const error = ran.failure
    yield* events.emit({
      ...base,
      command: error.command,
      result:
        error._tag === "CheckFailed"
          ? "failed"
          : error._tag === "CheckTimedOut"
            ? "timed_out"
            : "not_run",
      ...(error._tag === "CheckNotRun" ? {} : { output: error.outputFile }),
    })
    return ran
  })

/** The ticket a check is for. */
export interface CheckedTicket {
  readonly id: TicketId
  /** Its worktree's folder, absolute. */
  readonly worktree: string
}

/**
 * How the check, or the setup before it, failed, for a line about it: `'<check>' fails`, or did not
 * finish; `the setup '<setup>', run before the check, fails`.
 */
export const failedHow = (error: CheckError): string => {
  const what =
    error.check === "setup"
      ? line`the setup '${error.command}', run before the check,`
      : line`'${error.command}'`
  return `${what} ${howFailed(error)}`
}

/** How a command failed, for a line naming it: it fails, did not finish, or could not be run. */
export const howFailed = (error: CheckError): string => {
  switch (error._tag) {
    case "CheckFailed":
      return "fails"
    case "CheckTimedOut":
      return `did not finish within ${formatDuration(error.timeLimit)}`
    case "CheckNotRun":
      return line`could not be run (${error.reason})`
  }
}

/** What the check said of its failure: the lines saying what failed, else its last maxSaid lines. */
export const saidOf = (error: CheckError): ReadonlyArray<string> =>
  error._tag === "CheckNotRun"
    ? []
    : error.failingLines.length > 0
      ? error.failingLines
      : error.lastLines.slice(-OutputBounds.maxSaid)

/**
 * Where a command run in the ticket's worktree writes its whole output, for the scope: `name` in its
 * .tutti/run/, opened through the symlink guard and handed over as its descriptor; /dev/null when it
 * can't be opened, and the log says why, `whose` naming the command's output, on the ticket's line;
 * on a detail line for a worktree of no ticket's (`id` left out), as the full check's.
 */
export const outputTo = (
  ticket: Pick<CheckedTicket, "worktree"> & { readonly id?: TicketId },
  name: string,
  whose: string,
): Effect.Effect<
  Pick<RunOptions, "outputFile" | "outputFd">,
  never,
  Worktrees | Log | Scope.Scope
> =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    const log = yield* Log
    const output = join(ticket.worktree, runFolder, name)
    const opened = yield* Effect.result(
      worktrees.openRunFile(ticket.worktree, name, O.WRONLY | O.CREAT | O.TRUNC),
    )
    if (opened._tag === "Success") return { outputFile: output, outputFd: opened.success }
    const why =
      opened.failure._tag === "RunFilesOutside"
        ? line`a symbolic link stands at ${opened.failure.path}`
        : line`${opened.failure.message}`
    yield* log.write(
      ticket.id === undefined
        ? detail`${whose} whole output can't be kept in ${output}: ${why}`
        : ticketLine(ticket.id)`${whose} whole output can't be kept in ${output}: ${why}`,
    )
    return { outputFile: "/dev/null" }
  })

/**
 * The FLAKY warnings of `what`, a check that passed with tests that failed and then passed on a
 * rerun: one for each test it names, and one for those it counts beyond them.
 */
export const flakyWarnings = (
  what: string,
  passed: Pick<CheckPassed, "flaky" | "flakyCount">,
): ReadonlyArray<Line> => {
  const warnings = passed.flaky.map(
    (test) =>
      ticketLine(
        Tag.flaky,
      )`${what} passed, but a test failed and then passed on a rerun: ${test === "" ? "it doesn't say which" : test}`,
  )
  const more = passed.flakyCount - passed.flaky.length
  if (more > 0) {
    warnings.push(
      ticketLine(
        Tag.flaky,
      )`${what} passed, but ${more} more tests failed and then passed on a rerun`,
    )
  }
  return warnings
}

/** The Store metadata key marking a ticket's branch as rebased by tutti and not checked since. */
export const uncheckedKey = "rebased_unchecked"

/** Where a branch marked rebased and unchecked was before tutti rebased it. */
export interface Unchecked {
  /** Where it left the base, for the setup (setup.ts); undefined when git couldn't say. */
  readonly fork: Sha | undefined
  /** Its commit; undefined when git couldn't say. */
  readonly head: Sha | undefined
}

/**
 * The mark `value` holds, or undefined when it holds none. state.json is anyone's to edit, so a
 * value that isn't a mark is one with nothing of where, and only a commit hash is taken for one.
 */
export const uncheckedOf = (value: Schema.Json | undefined): Unchecked | undefined => {
  if (value === undefined || value === null) return undefined
  const fields: Readonly<Record<string, unknown>> = Predicate.isObject(value) ? value : {}
  const hash = (key: string) => Sha.parse(Object.hasOwn(fields, key) ? fields[key] : undefined)
  return { fork: hash("fork"), head: hash("head") }
}

/**
 * Marks the ticket's branch as rebased and unchecked, before tutti rebases it: a quit before its
 * check passes leaves the mark for the next run. A Store that can't be written leaves it unmarked.
 */
export const markUnchecked = (
  id: TicketId,
  unchecked: Unchecked,
): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    const { fork, head } = unchecked
    const mark = {
      ...(fork === undefined ? {} : { fork }),
      ...(head === undefined ? {} : { head }),
    }
    yield* Effect.ignore(store.setMetadata(id, uncheckedKey, mark))
  })

/** The field of the mark saying its rebase's conflicts were handed back to its worker. */
const handedBackField = "handed_back"

/**
 * Whether the mark `value` says its rebase's conflicts were handed back to the ticket's worker: a
 * rebase in progress in its worktree is then its worker's unfinished resolution (carry.ts).
 */
export const handedBackOf = (value: Schema.Json | undefined): boolean =>
  Predicate.isObject(value) &&
  Object.hasOwn(value, handedBackField) &&
  value[handedBackField] === true

/**
 * Notes on the ticket's mark that its rebase's conflicts are handed back to its worker, the rebase
 * left in progress for it to resolve; the next rebase's mark drops it. Nothing without a mark.
 */
export const markHandedBack = (id: TicketId): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    const metadata = yield* store.metadata(id)
    const value = Object.hasOwn(metadata, uncheckedKey) ? metadata[uncheckedKey] : undefined
    if (typeof value !== "object" || value === null || Array.isArray(value)) return
    yield* Effect.ignore(store.setMetadata(id, uncheckedKey, { ...value, [handedBackField]: true }))
  })

/** The ticket's mark, if its branch was rebased and hasn't been checked since. */
export const uncheckedMark = (id: TicketId): Effect.Effect<Unchecked | undefined, never, Store> =>
  Effect.gen(function* () {
    const metadata = yield* (yield* Store).metadata(id)
    return uncheckedOf(Object.hasOwn(metadata, uncheckedKey) ? metadata[uncheckedKey] : undefined)
  })

/** Clears the ticket's mark, its branch checked as it is now, if it has one. */
export const clearUnchecked = (id: TicketId): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    if ((yield* uncheckedMark(id)) === undefined) return
    yield* Effect.ignore(store.unsetMetadata(id, uncheckedKey))
  })

/** The commits of the tickets' branches the merge check last passed on in a run. */
export interface Passes {
  /** The ticket's branch's commit the check last passed on in this run, if it passed. */
  at(id: TicketId): Effect.Effect<string | undefined>
  /** The check passed on the ticket's branch at `commit`. */
  set(id: TicketId, commit: string): Effect.Effect<void>
}

/** A run's passes: none yet. */
export const makePasses: Effect.Effect<Passes> = Effect.map(
  Ref.make<ReadonlyMap<string, string>>(new Map()),
  (ref) =>
    ({
      at: (id) => Effect.map(Ref.get(ref), (passes) => passes.get(id)),
      set: (id, commit) => Ref.update(ref, (passes) => new Map(passes).set(id, commit)),
    }) satisfies Passes,
)

/**
 * Runs the merge check in the ticket's worktree, its output in check.log, and says how it went,
 * its `check` record of `suite` (merge by default) written. A check that passes, or that there is none of, clears the ticket's rebased-and-unchecked mark.
 * `before`: its worktree's status, as checkOnce's.
 */
export const runMergeCheck = (
  ticket: CheckedTicket,
  suite: CheckSuite = "merge",
  before?: ReadonlyArray<StatusEntry>,
): Effect.Effect<Checked, never, Checks | Git | Worktrees | Store | Log | EventStream> =>
  Effect.tap(checkOnce(ticket, { suite, before }), (checked) =>
    checked._tag === "Failed" ? Effect.void : clearUnchecked(ticket.id),
  )

/**
 * Runs the merge check in the ticket's worktree, its output in check.log, and says how it went,
 * its `check` record written as `how` says, leaving its rebased-and-unchecked mark as it is: as for a check ahead of its turn to merge
 * (mergetrain.ts), on a branch that may yet be put back. `how.before`: its worktree's status as
 * the caller read it just before, nothing having run in it since (noteWritten's).
 */
export const checkOnce = (
  ticket: CheckedTicket,
  how: {
    readonly suite: CheckSuite
    readonly train?: boolean
    readonly before?: ReadonlyArray<StatusEntry> | undefined
  } = { suite: "merge" },
): Effect.Effect<Checked, never, Checks | Git | Worktrees | Log | EventStream> =>
  Effect.gen(function* () {
    const checks = yield* Checks
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const to = yield* outputTo(ticket, checkLogName, "the check's")
        let status: ReadonlyArray<StatusEntry> | undefined
        const ran = yield* recorded(
          how.suite,
          ticket.id,
          noteWritten(ticket.worktree, checks.fast({ cwd: ticket.worktree, ...to }), {
            before: how.before,
            read: (after) => {
              status = after
            },
          }),
          how.train === true ? { train: true } : {},
        )
        if (ran._tag === "Failure") {
          return Checked.Failed({ error: ran.failure, output: to.outputFile })
        }
        const result = ran.success
        const after = status === undefined ? {} : { after: status }
        if (result._tag === "NoCheckCommand") return Checked.Unchecked(after)
        const what = line`${ticket.id}'s check '${result.command}'`
        for (const warning of flakyWarnings(what, result)) {
          yield* warn(warning, ticket.id)
        }
        return Checked.Passed({ command: result.command, ...after })
      }),
    )
  })
