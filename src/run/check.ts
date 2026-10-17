// The merge check (§ 5 item 7, § 3.4): check_fast in a finished ticket's worktree, its branch rebased
// onto the base, within its time limit. The whole output goes to the worktree's .tutti/run/check.log,
// opened through the symlink guard (§ 9.1) and handed to the check as /dev/fd/<n>, so no link the
// worker left there can send it elsewhere. A passing check's FLAKY: lines are warnings naming the
// ticket: it merges, but a test that passes only on a rerun is a bug nobody would see otherwise.
// Interrupting the check kills its process group (Checks does), and nothing comes of it.
import { join } from "node:path"
import { Effect } from "effect"
import { O } from "../native/libc.ts"
import { formatDuration } from "../project/configFile.ts"
import { type CheckError, Checks, checkLogName } from "../services/Checks.ts"
import { runFolder, Worktrees } from "../services/Worktrees.ts"
import { EventStream } from "./eventstream.ts"
import { Log, line, Tag, ticketLine } from "./log.ts"

/** How a ticket's merge check went. */
export type Checked =
  | { readonly _tag: "Passed" }
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

/** How the check failed, for a line about it: `'<check>' fails`, or did not finish. */
export const failedHow = (error: CheckError): string => {
  switch (error._tag) {
    case "CheckFailed":
      return line`'${error.command}' fails`
    case "CheckTimedOut":
      return line`'${error.command}' did not finish within ${formatDuration(error.timeLimit)}`
    case "CheckNotRun":
      return line`'${error.command}' could not be run (${error.reason})`
  }
}

/** What the check said of its failure: the lines that say what failed, else its last lines. */
export const saidOf = (error: CheckError): ReadonlyArray<string> =>
  error._tag === "CheckNotRun"
    ? []
    : error.failingLines.length > 0
      ? error.failingLines
      : error.lastLines

/** Runs the merge check in the ticket's worktree, its output in check.log, and says how it went. */
export const runMergeCheck = (
  ticket: CheckedTicket,
): Effect.Effect<Checked, never, Checks | Worktrees | Log | EventStream> =>
  Effect.gen(function* () {
    const checks = yield* Checks
    const worktrees = yield* Worktrees
    const log = yield* Log
    const events = yield* EventStream
    const output = join(ticket.worktree, runFolder, checkLogName)
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* Effect.result(
          worktrees.openRunFile(ticket.worktree, checkLogName, O.WRONLY | O.CREAT | O.TRUNC),
        )
        let outputFile = "/dev/null"
        if (opened._tag === "Success") {
          outputFile = `/dev/fd/${opened.success}`
        } else {
          const why =
            opened.failure._tag === "RunFilesOutside"
              ? line`a symbolic link stands at ${opened.failure.path}`
              : line`${opened.failure.message}`
          yield* log.write(
            ticketLine(ticket.id)`the check's whole output can't be kept in ${output}: ${why}`,
          )
        }
        const ran = yield* Effect.result(checks.fast({ cwd: ticket.worktree, outputFile }))
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
        return { _tag: "Passed" } satisfies Checked
      }),
    )
  })
