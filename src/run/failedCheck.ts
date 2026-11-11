// A finished ticket whose check, or the setup before it, failed in its merge: set aside for review,
// CHECKS_FAILED, kept to be checked once more once the base moves on (recheck.ts) and what the
// check said kept for the report (reportEvidence.ts). The merge (merge.ts) and a check hand-back
// that ends with the ticket set aside (checkback.ts) both end here.
import { Effect } from "effect"
import { branchOn, detail, type Line, Log, line, Tag } from "../core/log.ts"
import type { CheckError } from "../services/Checks.ts"
import { failedHow, outputKept, saidOf } from "./check.ts"
import {
  closedBut,
  type FinishedTicket,
  type MergeEnv,
  type MergeOptions,
  type Rechecks,
} from "./mergeShared.ts"
import { keepForRecheck } from "./recheck.ts"
import { noteFailedCheck } from "./reportEvidence.ts"

/** The short why of a ticket set aside as its check, or the setup before it, failed. */
export const checksFailedDetail = (error: CheckError): string => {
  const what = error.check === "setup" ? "setup" : "checks"
  return `${what} ${error._tag === "CheckTimedOut" ? "timed out" : "failed"}`
}

/** How a check, or the setup before it, failed on a ticket's branch, for checksFailed. */
export interface FailedCheck {
  /** The base's commit its branch was rebased onto, or is on top of. */
  readonly onto: string
  readonly error: CheckError
  /** Where its whole output is in its worktree. */
  readonly output: string
  /** Its copy beside the ticket's transcript, where it was kept (check.ts's CheckFailure). */
  readonly kept?: string | undefined
  /** What came of handing it back to its worker, if anything, as its line says it. */
  readonly tried?: Line | string
  /** On top of the base already, not rebased. */
  readonly onTop?: boolean
}

/**
 * Sets the ticket aside as its check, or the setup before it, failed on its branch rebased onto the
 * base at `onto`, or `onTop` of it already, kept to be checked once more once the base moves on,
 * unless this was that once (recheck.ts), and what the check said kept for the report
 * (reportEvidence.ts).
 */
export const checksFailed = (
  ticket: FinishedTicket,
  options: MergeOptions,
  rechecks: Rechecks,
  { onto, error, tried = "", onTop = false, ...failure }: FailedCheck,
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const log = yield* Log
    // The worktree goes once the ticket is set aside: its kept copy is named where there is one.
    const output = outputKept(failure)
    const where = error._tag === "CheckNotRun" ? "" : line` (output is in ${output})`
    const again = (yield* rechecks.rechecked(ticket.id)) ? " again" : ""
    const later = yield* keepForRecheck(ticket, options, rechecks, onto, error)
    yield* closedBut(
      ticket,
      Tag.checksFailed,
      `${checksFailedDetail(error)}${again}`,
      error._tag === "CheckNotRun" ? undefined : output,
    )`${failedHow(error)}${again} on ${branchOn(ticket.branch, options.base, onTop)}${tried}; worktree ${ticket.worktree} left for review${where}${later}`
    const said = saidOf(error)
    if (said.length > 0) yield* log.write(...said.map((each) => detail`  ${each}`))
    yield* noteFailedCheck(ticket, options, rechecks, onto, error, output, onTop)
  })
