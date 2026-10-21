// The run report's evidence that the run gathers as it goes and at its end (§ 6.2, orchestra's
// failedChecksSection and outsideScopeSection), given to the report as sections (ReportRun.sections):
// what the check said of each ticket set aside after its check failed, and, for a run scoped with
// --ticket, the follow-ups filed in the run outside its scope, left for a later run. From the first
// the reviewer tells a failure in a ticket's own code from one elsewhere, without sending you to the
// log; from the second it names the work the run left for a later one.
import { Effect, Result } from "effect"
import { type Section, section } from "../organs/evidence.ts"
import { type Beads, type BeadsError, HumanLabel, type Issue } from "../services/Beads.ts"
import { type CheckError, OutputBounds } from "../services/Checks.ts"
import { Git } from "../services/Git.ts"
import { failedHow } from "./check.ts"
import type { Entry } from "./ledger.ts"
import { branchOn } from "./log.ts"
import type { FinishedTicket, MergeOptions } from "./merge.ts"
import { foldersOf, type Rechecks } from "./recheck.ts"
import { descendants } from "./scope.ts"

/** The most folders the reviewer is given of those a ticket's own commits change, as orchestra's. */
export const maxFolders = 20

/** How many characters of a follow-up's description the reviewer is given. */
export const followUpWidth = 400

/** What a failed check is said with: the ticket, where it ran, and what came of it. */
export interface FailedCheck {
  readonly id: string
  readonly branch: string
  readonly base: string
  /** The base's commit the branch was rebased onto, or is on top of. */
  readonly onto: string
  /** The branch was on top of the base already, not rebased. */
  readonly onTop?: boolean
  readonly error: CheckError
  /** Where its whole output is. */
  readonly output: string
  /** The folders the ticket's own commits change, sorted; null when git couldn't list them. */
  readonly folders: ReadonlyArray<string> | null
}

/** The folders, as the reviewer reads them: at most maxFolders, the top level named as such. */
const foldersSaid = (folders: ReadonlyArray<string> | null): string => {
  if (folders === null || folders.length === 0) return "none that git could list"
  const named = folders
    .slice(0, maxFolders)
    .map((folder) => (folder === "." ? "the top level (.)" : folder))
  const more = folders.length - named.length
  return `${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

/**
 * What the reviewer is told of a ticket's failed check: how it failed, on what, where its output
 * is, the lines that say what failed (else its last lines), and the folders its own commits change,
 * so the reviewer can tell a failure in its code from one elsewhere.
 */
export const failedCheckSaid = (f: FailedCheck): string => {
  const at = f.onto.slice(0, 7)
  const notRun = f.error.check === "setup" ? ", so the check did not run" : ""
  const where = f.error._tag === "CheckNotRun" ? "" : `; its output is in ${f.output}`
  const lines = [
    `${f.id}: ${failedHow(f.error)} on ${branchOn(f.branch, f.base, f.onTop === true)} at ${at}${notRun}${where}.`,
  ]
  if (f.error._tag !== "CheckNotRun") {
    const { failingLines } = f.error
    const lastLines = f.error.lastLines.slice(-OutputBounds.maxSaid)
    const said = failingLines.length > 0 ? failingLines : lastLines
    lines.push(
      failingLines.length > 0
        ? "The lines of its output that say what failed:"
        : lastLines.length > 0
          ? "No line of its output says what failed; its last lines:"
          : "It printed nothing.",
      ...said.map((each) => `    ${each}`),
    )
  }
  lines.push(
    `Folders that ${f.id}'s own commits change (${at}..${f.branch}): ${foldersSaid(f.folders)}`,
  )
  return lines.join("\n")
}

/**
 * Keeps for the report what the ticket's check said as it set the ticket aside, its branch rebased
 * onto the base at `onto`, or `onTop` of it already, with the folders its own commits change.
 */
export const noteFailedCheck = (
  ticket: FinishedTicket,
  options: MergeOptions,
  rechecks: Rechecks,
  onto: string,
  error: CheckError,
  output: string,
  onTop = false,
): Effect.Effect<void, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const changed = yield* Effect.result(git.changedFiles(options.repo, onto, ticket.branch))
    const said = failedCheckSaid({
      id: ticket.id,
      branch: ticket.branch,
      base: options.base,
      onto,
      onTop,
      error,
      output,
      folders: Result.isSuccess(changed) ? foldersOf(changed.success) : null,
    })
    yield* rechecks.noteFailure(ticket.id, said)
  })

/** Whether the run left the ticket set aside after its check failed. */
const asideForCheck = (entry: Entry): boolean =>
  entry.phase._tag === "Review" && entry.phase.why === "CHECKS_FAILED"

/**
 * The section on what the check said of each ticket the run left set aside after its check failed,
 * in the order they were first set aside; none when there is no such ticket. A ticket checked once
 * more and merged since is left out.
 */
export const failedChecksSection = (
  entries: ReadonlyMap<string, Entry>,
  failures: ReadonlyMap<string, string>,
): ReadonlyArray<Section> => {
  const said = [...failures].flatMap(([id, text]) => {
    const entry = entries.get(id)
    return entry !== undefined && asideForCheck(entry) ? [text] : []
  })
  return said.length === 0
    ? []
    : [
        section(
          "What the check said of each ticket set aside after its check failed",
          said.join("\n\n"),
        ),
      ]
}

/**
 * The follow-ups among `open` (the tickets not closed) filed in a run started at `started`, in
 * epoch milliseconds, outside its scope `inScope`: created since the second it started, and no
 * question for you. A ticket whose creation time can't be read is left out.
 */
export const filedOutside = (
  open: ReadonlyArray<Issue>,
  inScope: ReadonlySet<string>,
  started: number,
): ReadonlyArray<Issue> => {
  const since = Math.floor(started / 1000) * 1000
  return open.filter((issue) => {
    const created = Date.parse(issue.createdAt)
    return (
      !inScope.has(issue.id) &&
      !issue.labels.includes(HumanLabel) &&
      !Number.isNaN(created) &&
      created >= since
    )
  })
}

/** `text` on one line, cut to `width` characters with `…`. */
const cut = (text: string, width: number): string => {
  const one = text
    .split(/\s+/)
    .filter((word) => word !== "")
    .join(" ")
  const chars = [...one]
  return chars.length > width ? `${chars.slice(0, width - 1).join("")}…` : one
}

/**
 * A follow-up, as the reviewer reads it: its ID and title, its type and status, the tickets it
 * links to, and its description, cut short.
 */
export const followUpSaid = (issue: Issue): string => {
  const links = issue.dependencies.map((link) => `${link.type} ${link.id}`)
  const description = cut(issue.description, followUpWidth)
  return [
    `${issue.id}: ${issue.title}`,
    `${issue.type}, ${issue.status}${links.length === 0 ? "" : `; links: ${links.join(", ")}`}`,
    ...(description === "" ? [] : [`Description: ${description}`]),
  ].join("\n")
}

/**
 * The section on the follow-ups a run scoped to `scope`, started at `started`, filed outside its
 * scope, left for a later run; none when bd can't tell them.
 */
export const followUpsSection = (
  beads: Beads["Service"],
  scope: string,
  started: number,
): Effect.Effect<ReadonlyArray<Section>> =>
  Effect.gen(function* () {
    const subs = yield* descendants(beads, scope)
    const open = yield* beads.list()
    const inScope = new Set([scope, ...subs.map((issue) => issue.id)])
    const filed = filedOutside(open, inScope, started)
    return [
      section(
        `Follow-ups filed in this run outside the scope of ${scope}, left for a later run`,
        filed.map(followUpSaid).join("\n\n"),
      ),
    ]
  }).pipe(Effect.catch((_: BeadsError) => Effect.succeed([])))
