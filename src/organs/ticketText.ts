// The ticket as a person reads bd show (§ 6): the text the organs that read a ticket (triage, the
// critic, the auditor, the reflector) are given of it. Its ID and title, its status, priority and
// type, its labels, then each of its texts that has words.
import type { Issue } from "../services/Beads.ts"

/** The ticket as a person reads bd show: its ID and title, then each of its texts that has words. */
export const ticketText = (issue: Issue): string => {
  const about = [
    `Status: ${issue.status}`,
    ...(issue.priority === undefined ? [] : [`Priority: P${issue.priority}`]),
    `Type: ${issue.type}`,
  ].join(" · ")
  const texts: ReadonlyArray<readonly [string, string]> = [
    ["Description", issue.description],
    ["Design", issue.design],
    ["Acceptance criteria", issue.acceptance],
    ["Notes", issue.notes],
  ]
  return [
    `${issue.id}: ${issue.title}`,
    about,
    ...(issue.labels.length === 0 ? [] : [`Labels: ${issue.labels.join(", ")}`]),
    ...texts.flatMap(([title, text]) =>
      text.trim() === "" ? [] : [`\n${title}:\n${text.trim()}`],
    ),
  ].join("\n")
}
