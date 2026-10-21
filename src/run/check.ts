// The merge check (§ 5 item 7, § 3.4): check_fast in a finished ticket's worktree, its branch rebased
// onto the base, within its time limit. The whole output goes to the worktree's .tutti/run/check.log,
// opened through the symlink guard (§ 9.1) and handed to the check as that descriptor, so no link
// the worker left there can send it elsewhere. A passing check's FLAKY: lines are warnings naming the
// ticket: it merges, but a test that passes only on a rerun is a bug nobody would see otherwise.
// Interrupting the check kills its process group (Checks does), and nothing comes of it.
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
import { Effect, Ref, type Schema, type Scope } from "effect"
import { O } from "../native/libc.ts"
import { formatDuration } from "../project/configFile.ts"
import {
  type CheckError,
  Checks,
  checkLogName,
  OutputBounds,
  type RunOptions,
} from "../services/Checks.ts"
import { Store } from "../services/Store.ts"
import { runFolder, Worktrees } from "../services/Worktrees.ts"
import { EventStream } from "./eventstream.ts"
import { Log, line, Tag, ticketLine } from "./log.ts"

/** How a ticket's merge check went. */
export type Checked =
  /** It passed; `command` is the check that ran. */
  | { readonly _tag: "Passed"; readonly command: string }
  /** No check command is set: the rebased code merges unchecked. */
  | { readonly _tag: "Unchecked" }
  /** It failed, timed out or couldn't run; `output` is where its whole output is. */
  | { readonly _tag: "Failed"; readonly error: CheckError; readonly output: string }

/** The ticket a check is for. */
export interface CheckedTicket {
  readonly id: string
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
  switch (error._tag) {
    case "CheckFailed":
      return `${what} fails`
    case "CheckTimedOut":
      return `${what} did not finish within ${formatDuration(error.timeLimit)}`
    case "CheckNotRun":
      return `${what} could not be run (${line`${error.reason}`})`
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
 * can't be opened, and the log says why, `whose` naming the command's output.
 */
export const outputTo = (
  ticket: CheckedTicket,
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
      ticketLine(ticket.id)`${whose} whole output can't be kept in ${output}: ${why}`,
    )
    return { outputFile: "/dev/null" }
  })

/** The Store metadata key marking a ticket's branch as rebased by tutti and not checked since. */
export const uncheckedKey = "rebased_unchecked"

/** Where a branch marked rebased and unchecked was before tutti rebased it. */
export interface Unchecked {
  /** Where it left the base, for the setup (setup.ts). */
  readonly fork: string
  /** Its commit; "" when git couldn't say. */
  readonly head: string
}

/**
 * The mark `value` holds, or undefined when it holds none. state.json is anyone's to edit, so a
 * value that isn't a mark is one with nothing of where, and only a commit hash is taken for one.
 */
export const uncheckedOf = (value: Schema.Json | undefined): Unchecked | undefined => {
  if (value === undefined || value === null) return undefined
  const fields: Readonly<Record<string, Schema.Json>> =
    typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, Schema.Json>>)
      : {}
  const hash = (key: string) => {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined
    return typeof field === "string" && /^[0-9a-f]{7,64}$/.test(field) ? field : ""
  }
  return { fork: hash("fork"), head: hash("head") }
}

/**
 * Marks the ticket's branch as rebased and unchecked, before tutti rebases it: a quit before its
 * check passes leaves the mark for the next run. A Store that can't be written leaves it unmarked.
 */
export const markUnchecked = (
  id: string,
  unchecked: Unchecked,
): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* Effect.ignore(store.setMetadata(id, uncheckedKey, { ...unchecked }))
  })

/** The ticket's mark, if its branch was rebased and hasn't been checked since. */
export const uncheckedMark = (id: string): Effect.Effect<Unchecked | undefined, never, Store> =>
  Effect.gen(function* () {
    const metadata = yield* (yield* Store).metadata(id)
    return uncheckedOf(Object.hasOwn(metadata, uncheckedKey) ? metadata[uncheckedKey] : undefined)
  })

/** Clears the ticket's mark, its branch checked as it is now, if it has one. */
export const clearUnchecked = (id: string): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    if ((yield* uncheckedMark(id)) === undefined) return
    yield* Effect.ignore(store.unsetMetadata(id, uncheckedKey))
  })

/** The commits of the tickets' branches the merge check last passed on in a run. */
export interface Passes {
  /** The ticket's branch's commit the check last passed on in this run, if it passed. */
  at(id: string): Effect.Effect<string | undefined>
  /** The check passed on the ticket's branch at `commit`. */
  set(id: string, commit: string): Effect.Effect<void>
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
 * Runs the merge check in the ticket's worktree, its output in check.log, and says how it went. A
 * check that passes, or that there is none of, clears the ticket's rebased-and-unchecked mark.
 */
export const runMergeCheck = (
  ticket: CheckedTicket,
): Effect.Effect<Checked, never, Checks | Worktrees | Store | Log | EventStream> =>
  Effect.tap(checkOnce(ticket), (checked) =>
    checked._tag === "Failed" ? Effect.void : clearUnchecked(ticket.id),
  )

/**
 * Runs the merge check in the ticket's worktree, its output in check.log, and says how it went,
 * leaving its rebased-and-unchecked mark as it is: as for a check ahead of its turn to merge
 * (mergetrain.ts), on a branch that may yet be put back.
 */
export const checkOnce = (
  ticket: CheckedTicket,
): Effect.Effect<Checked, never, Checks | Worktrees | Log | EventStream> =>
  Effect.gen(function* () {
    const checks = yield* Checks
    const log = yield* Log
    const events = yield* EventStream
    const output = join(ticket.worktree, runFolder, checkLogName)
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const to = yield* outputTo(ticket, checkLogName, "the check's")
        const ran = yield* Effect.result(checks.fast({ cwd: ticket.worktree, ...to }))
        if (ran._tag === "Failure") {
          return { _tag: "Failed", error: ran.failure, output } satisfies Checked
        }
        const result = ran.success
        if (result._tag === "NoCheckCommand") return { _tag: "Unchecked" } satisfies Checked
        const what = line`${ticket.id}'s check '${result.command}'`
        const flaky = result.flaky.map(
          (test) =>
            ticketLine(
              Tag.flaky,
            )`${what} passed, but a test failed and then passed on a rerun: ${test === "" ? "it doesn't say which" : test}`,
        )
        const more = result.flakyCount - result.flaky.length
        if (more > 0) {
          flaky.push(
            ticketLine(
              Tag.flaky,
            )`${what} passed, but ${more} more tests failed and then passed on a rerun`,
          )
        }
        for (const warning of flaky) {
          yield* log.write(warning)
          yield* events.emit({ kind: "warn", ticket: ticket.id, text: warning })
        }
        return { _tag: "Passed", command: result.command } satisfies Checked
      }),
    )
  })
