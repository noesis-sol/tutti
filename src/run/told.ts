// What tutti tells its workers (§ 4): the messages it sends a worker's session client_composed, as
// Tag gathers the log's words. A nudge, the carry-on of a resumed session, the reset of a usage
// limit, and the hand-backs of a merge's conflicts and failed check, each starting `tutti: `. A
// ticket's first message, with the facts of its start, is start.ts's firstMessage.
import { type Commit, shortHash } from "../services/Git.ts"
import { failedHow, saidOf } from "./check.ts"
import type { CheckStop } from "./checkback.ts"
import type { HandBackMode, RebaseStop } from "./handback.ts"

/** The continue nudge (settle.ts), to a worker idle with its ticket still in progress. */
export const nudgeText = (id: string): string =>
  `tutti: your ticket ${id} is still in progress. Continue; if something blocks you, ask or ` +
  "defer as your instructions say."

/** What a worker whose question is answered (asked.ts) is told as its session is resumed. */
export const answeredText = (id: string, question: string, title: string): string =>
  `tutti: your question ${question} (${title}) is answered. Read the answer with bd show ` +
  `${question}, then carry on with ${id} as your instructions say.`

/** What a worker whose session went (§ 4.8) is told as it is resumed. */
export const goneText = (id: string): string =>
  `tutti: your session ended unexpectedly with ${id} still in progress, and this is it resumed. ` +
  `Carry on with ${id} where you left off, as your instructions say.`

/** What a suspended worker is told as the next run resumes its session (carry.ts). */
export const resumedText = (id: string, why: string, facts: ReadonlyArray<string> = []): string =>
  [
    `tutti: the last run ended (${why}) while you were working on ${id}, and interrupted you; ` +
      `this run resumes your session. Carry on with ${id} where you left off, as your ` +
      "instructions say.",
    ...facts,
  ].join("\n\n")

/** The message a worker waiting for the usage limit (usageLimit.ts) is sent once it has reset. */
export const resetText = (id: string): string =>
  `tutti: the account's usage limit has reset. Carry on with your ticket ${id} where you left off.`

/**
 * The message a worker waiting for the limit on its hand-back onto `base` (handback.ts) is sent once
 * it has reset: the hand-back to carry on with, not its ticket, which it closed already, as orchestra
 * tells it.
 */
export const resetHandBackText = (
  id: string,
  branch: string,
  mode: HandBackMode,
  base: string,
): string => {
  const what =
    mode === "resolving"
      ? `the rebase of ${branch} onto ${base} tutti handed back to you, resolving its conflicts, finishing it and running the tests`
      : `the failing check tutti handed back to you, fixing ${branch} so that it passes and committing the fix`
  return (
    `tutti: the account's usage limit has reset. Carry on where you left off with ${what}, ` +
    `as tutti's message asked, not with ${id} itself, which you closed already. ` +
    "If you had finished that before the limit, check that git shows it done and say DONE."
  )
}

/**
 * What the worker is asked to do with a rebase stopped on conflicts, as orchestra asks it: the
 * tests of its change and of the files that conflicted, the whole check left to tutti's, which
 * follows; `setup` says when to run the project's setup, if it is to (setup.ts's setupToResolve).
 */
export const resolvePrompt = (stop: RebaseStop, base: string, check: string, setup = ""): string =>
  `tutti: ${base} moved on while you worked; rebasing ${stop.ticket.branch} onto it stopped on ` +
  `conflicts in ${stop.files.join(", ")}. ` +
  `Resolve them keeping the intent of both your change and what landed on ${base}, ` +
  "then git add the files and run GIT_EDITOR=true git rebase --continue; " +
  "if the rebase stops on another commit, resolve that one the same way. " +
  `If ${base} has a commit's change already, wholly or as the part that conflicts, run git rebase ` +
  "--skip for that commit instead of resolving it. " +
  setup +
  "Once the rebase has finished, run the tests of the code you changed and of the files that " +
  "conflicted in the foreground until they pass, since the commits that applied cleanly may " +
  "break them too; fold any fix into the branch's last commit with git commit --amend --no-edit. " +
  `Leave the whole check, '${check}', to tutti: it runs it on the branch next. ` +
  "Don't do anything else: no new commits beyond the rebase, no merge, no push, no ticket changes. " +
  "Say DONE when the rebase is complete and those tests pass."

/** The most commits a check hand-back lists of those that landed on the base. */
export const maxLanded = 30

/**
 * What the worker is asked to do with the failure on its rebased branch, as orchestra asks it: what
 * failed, what the output says, and what the rebase brought in from the base (`landed`, newest
 * first; undefined when git couldn't list it). On a branch on top of the base already, nothing
 * landed, and the prompt says only that the check fails before it merges.
 */
export const fixPrompt = (
  stop: CheckStop,
  base: string,
  check: string,
  landed: ReadonlyArray<Commit> | undefined,
): string => {
  const { id, branch } = stop.ticket
  const lines = saidOf(stop.error)
  const said =
    lines.length === 0
      ? "it printed nothing"
      : `${stop.error._tag !== "CheckNotRun" && stop.error.failingLines.length > 0 ? "these lines say what failed:" : "it ends:"}\n${lines.join("\n")}`
  const listed = (landed ?? []).map((commit) => `${shortHash(commit.hash)} ${commit.subject}`)
  const shown =
    landed === undefined || listed.length === 0
      ? "(git could not list them)"
      : listed.length > maxLanded
        ? [...listed.slice(0, maxLanded), `… and ${listed.length - maxLanded} more`].join("\n")
        : listed.join("\n")
  // What failed and the tests of its change: the whole check is tutti's, run next (orchestra
  // 0.8.5).
  const steps =
    "Run what failed (the tests or other checks the output names) and the tests of the code you " +
    `changed in the foreground until they pass, then commit the fix on ${branch} with ${id} in ` +
    `the commit message. Leave the whole check, '${check}', to tutti: it runs it on the branch ` +
    "next. " +
    "Don't do anything else: no rebase, no amending or rewriting of commits, no merge, no push, " +
    "no ticket changes, and no uncommitted changes left. Say DONE when the fix is committed. " +
    `If what failed passes without a change, the failure not coming from ${branch}, commit ` +
    "nothing and say DONE: tutti runs the check again."
  if (stop.onTop === true) {
    return (
      `tutti: Before ${branch} merges into ${base}, ${failedHow(stop.error)} on it. ` +
      `Its whole output is in ${stop.output}; ${said}\n\n` +
      `Fix ${branch} so that the check passes. ${steps}`
    )
  }
  return (
    `tutti: ${base} moved on while you worked, and ${branch} was rebased onto it; now ` +
    `${failedHow(stop.error)} on it. Its whole output is in ${stop.output}; ${said}\n\n` +
    `What landed on ${base} since your branch was cut (git log --oneline ` +
    `${shortHash(stop.head)}..${shortHash(stop.onto)}):\n${shown}\n\n` +
    `Fix ${branch} so that the check passes, keeping the intent of both your change and what ` +
    `landed on ${base}. ${steps}`
  )
}
