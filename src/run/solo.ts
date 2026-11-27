// The labels that order and hold the run's tickets apart from their priority (§ 2 Solo): a solo
// ticket runs alone, and the one that sets the project's checks up runs first (tutti-z96d). Apart
// from holds.ts, which reads the run's scope, so that the scope's order can read them too.
import type { Issue } from "../services/Beads.ts"

/** The label of a ticket that runs alone (§ 2 Solo). */
export const soloLabel = "solo"

export const isSolo = (issue: Pick<Issue, "labels">): boolean => issue.labels.includes(soloLabel)

/** Labels the tickets init files for the project's tests (§ 8.3). */
export const testWorkLabel = "tutti-tests"

/**
 * Whether `issue` sets the project's checks up: init's solo test-work ticket (tutti-tests and solo),
 * which every merge's check stands on, so it runs first, ahead of every other ticket whatever its
 * priority, and alone (tutti-z96d). The untested areas' test-work tickets, not solo, are ordered
 * as any other.
 */
export const setsChecksUp = (issue: Pick<Issue, "labels">): boolean =>
  isSolo(issue) && issue.labels.includes(testWorkLabel)
