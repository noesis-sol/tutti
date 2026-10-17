// The run report (§ 5 item 13 and 14, § 6.2, § 9.1): at the end of a run that wasn't quit, the
// reviewer (organs/reviewer.ts) writes what finished, what was set aside and why, and what needs
// you, from the run's evidence, gathered as orchestra gathers it: the final line, the run's log,
// the commits merged, the tickets closed, set aside and still in progress, the tickets still ready,
// and what the organs cost before it. In place of orchestra's hook tallies, it is given each
// ticket's tallies of attention requests, answers, denials and your messages, and whether a person
// steered it, with the requests and denials as the log has them, from which its Needs you section
// recommends rules for the calls that kept being asked about or denied.
//
// The report is titled with the run's date, times, base and scope (escaped for Markdown, § 7.10),
// ends with the run's organ cost total, the report's own call included (§ 6.1), and is written to
// .tutti/reports/<start time>.md, then printed with the post-run printer (§ 7.1) under an organ
// line. It is skipped with --review=false and when the run was quit (§ 4.8). While the usage-limit
// hold is on it can't run (§ 4.12): a hold lifted before the end lets it run, and one that held the
// run to its end skips it. Ctrl+C, which interrupts it, skips it too.
import { join } from "node:path"
import { Clock, Effect, FileSystem } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { type InputPart, type Section, section } from "../organs/evidence.ts"
import { dollars, OrganCost } from "../organs/OrganCost.ts"
import { type OrganError, OrganHold, type Organs, skippedLine } from "../organs/Organs.ts"
import { review } from "../organs/reviewer.ts"
import { printReport } from "../print/markdown.ts"
import type { Printer } from "../print/organLine.ts"
import type { Ending } from "../print/summary.ts"
import { Beads, type BeadsError, type Issue } from "../services/Beads.ts"
import { Git, type GitError } from "../services/Git.ts"
import { escapeMarkdown, sanitize, sanitizeLine } from "../ui/sanitize.ts"
import type { Theme } from "../ui/theme.ts"
import { type Entry, Ledger } from "./ledger.ts"
import * as log from "./log.ts"
import { type Line, Log, line, Tag, tagged } from "./log.ts"
import type { PhaseTag, TicketPhase } from "./phase.ts"

/** Where the reports go, below the repository. */
export const reportsDir = ".tutti/reports"

/** How many characters of a closed ticket's close reason the reviewer is given, as orchestra's. */
export const closeReasonWidth = 400

/** What the run tells the report of itself as it ends. */
export interface ReportRun {
  /** When the run started, in epoch milliseconds: the report's name and its title's first time. */
  readonly started: number
  /** Where finished tickets landed. */
  readonly base: string
  /** The base's commit when the run started: the commits merged are those after it. */
  readonly startHead: string
  /** How the run ended: its final line. */
  readonly ending: Ending
  readonly exitCode: number
  /** The run was quit (INTERRUPTED): there is no report. */
  readonly quit: boolean
  /**
   * The rest of the evidence the run gathered, as sections: the failed checks, the full check, the
   * feature request, the follow-ups filed outside a scoped run.
   */
  readonly sections?: ReadonlyArray<Section>
}

/** Where the report is printed after the dashboard. */
export interface ReportOut {
  readonly printer: Printer
  readonly theme: Theme
  /** The terminal's width. */
  readonly width: number
}

/** Every service the report uses. */
export type ReportEnv =
  | AppConfig
  | Organs
  | OrganCost
  | Ledger
  | Log
  | Beads
  | Git
  | FileSystem.FileSystem

/** REVIEW_FAILED: the reviewer gave no report. */
export const reviewFailed = tagged("REVIEW_FAILED")

/** REPORT: the report written, and where. */
export const reportWritten = (path: string): Line => tagged("REPORT")`written to ${path}`

/** The report not written, and why. */
export const reportNotSaved = (why: string): Line => line`report not saved: ${why}`

const pad = (n: number): string => String(n).padStart(2, "0")

/** The local time at `millis` as `09:05`. */
const clockTime = (millis: number): string => {
  const t = new Date(millis)
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/** The local date at `millis` as `2026-10-17`. */
const date = (millis: number): string => {
  const t = new Date(millis)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

/** The report's file name for a run started at `started`: `2026-10-17-090503.md`, local time. */
export const reportName = (started: number): string => {
  const t = new Date(started)
  return `${date(started)}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.md`
}

/** What the run's exit code means, for the reviewer (§ 5 item 10). */
export const exitMeaning = (code: number): string => {
  switch (code) {
    case 0:
      return (
        "nothing was left to start or merge, or the limit was reached; " +
        "a run of one ticket says in its final line whether all of it is merged"
      )
    case 3:
      return "a worker stopped the run (PAUSED, BLOCKED, TICKET_LIMIT) and needs attention"
    case 4:
      return "a Beads, git or Agent SDK command failed"
    case 5:
      return "the main checkout had uncommitted changes or left its branch"
    case 6:
      return "a finished ticket's branch did not fast-forward"
    case 7:
      return "workers kept failing at once, whichever ticket they had: the environment, not the tickets"
    case 8:
      return "the account's usage limit held the run, and it reset too late or at an unknown time"
    case 130:
      return "the run was quit"
  }
  return "unknown"
}

/** `n` and `noun`, `noun` made plural unless n is 1: `1 denial`, `3 denials`. */
const counted = (n: number, noun: string, plural = `${noun}s`): string =>
  `${n} ${n === 1 ? noun : plural}`

/** `once`, `twice`, `3 times`. */
const times = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`)

/**
 * Whether you steered `entry`'s worker at any time in this run: it is steered now, you sent it a
 * message, or the log has its STEERED line (an interrupt, released since).
 */
export const steeredInRun = (entry: Entry, logLines: ReadonlyArray<string>): boolean => {
  if (entry.steered || entry.tallies.messages > 0) return true
  const steered = log.steered(entry.ticket)
  return logLines.some((each) => each.endsWith(steered))
}

/** A phase as the reviewer reads it: `Review (CHECKS_FAILED)`, `Done (merged in abc123)`. */
export const phaseSaid = (phase: TicketPhase): string => {
  switch (phase._tag) {
    case "Done":
      return phase.outcome._tag === "Merged"
        ? `Done (merged in ${phase.outcome.commit})`
        : "Done (closed with no change to merge)"
    case "Asked":
      return `Asked (waits on question ${phase.question})`
    case "Waiting":
      return `Waiting (back in the queue until ${phase.for} merges)`
    case "HeldBack":
    case "Deferred":
    case "Review":
    case "Blocked":
    case "Stopped":
      return `${phase._tag} (${phase.why})`
    case "Fixing":
    case "Resolving":
      return `${phase._tag} (attempt ${phase.attempt})`
    default:
      return phase._tag
  }
}

/**
 * A ticket's tallies and steering, one line: `tut-1 (Done (merged in abc)): 3 attention requests,
 * 2 answers, 1 denial, 2 of your messages, compacted once; steered by you.`
 */
export const talliesLine = (entry: Entry, steered: boolean): string => {
  const t = entry.tallies
  const said = [
    ...(t.requests > 0 ? [counted(t.requests, "attention request")] : []),
    ...(t.answers > 0 ? [counted(t.answers, "answer")] : []),
    ...(t.denials > 0 ? [counted(t.denials, "denial")] : []),
    ...(t.messages > 0 ? [counted(t.messages, "of your messages", "of your messages")] : []),
    ...(t.compactions > 0 ? [`compacted ${times(t.compactions)}`] : []),
  ]
  const tallies = said.length === 0 ? "no attention requests, denials or messages" : said.join(", ")
  return `${entry.ticket} (${phaseSaid(entry.phase)}): ${tallies}; ${steered ? "steered by you" : "not steered"}.`
}

/** The tags of the log lines that record attention requests, their answers and denials. */
const attentionTags = [Tag.permission, Tag.question, Tag.allowed, Tag.denied]

/** The run's log lines that record attention requests, their answers and denials. */
export const attentionLines = (logLines: ReadonlyArray<string>): ReadonlyArray<string> =>
  logLines.filter((each) => attentionTags.some((tag) => each.includes(`  ${tag}: `)))

/** The phases of a ticket closed in this run. */
const closed: ReadonlySet<PhaseTag> = new Set(["Done"])

/** The phases of a ticket set aside in this run. */
const setAside: ReadonlySet<PhaseTag> = new Set([
  "Deferred",
  "Review",
  "Blocked",
  "Asked",
  "Waiting",
])

/** The phases of a ticket still in progress when the run stopped. */
const inProgress: ReadonlySet<PhaseTag> = new Set([
  "Working",
  "ToMerge",
  "Merging",
  "Resolving",
  "Fixing",
  "Stopped",
])

/** What a failed bd or git call said, in a few words. */
const failure = (error: BeadsError | GitError): string =>
  "stderr" in error && error.stderr.trim() !== ""
    ? (error.stderr.trim().split("\n")[0] ?? error._tag)
    : error._tag

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
 * The reviewer's input: the run's evidence, in sections, then tutti's own line on the run, with the
 * request last, as Claude reads long inputs best with it at the end.
 */
export const gather = (
  run: ReportRun,
): Effect.Effect<
  ReadonlyArray<InputPart>,
  never,
  AppConfig | OrganCost | Ledger | Log | Beads | Git
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const beads = yield* Beads
    const git = yield* Git
    const logLines = yield* (yield* Log).lines
    const entries = [...(yield* (yield* Ledger).current).tickets.values()]
    const now = yield* Clock.currentTimeMillis

    const commits = yield* git.log(config.repo, run.startHead, run.base).pipe(
      Effect.map((list) => list.map((c) => `${c.hash} ${c.subject}`).join("\n")),
      Effect.catch((error) => Effect.succeed(`(git log failed: ${failure(error)})`)),
    )

    const shown = (entry: Entry, describe: (issue: Issue) => string) =>
      beads.show(entry.ticket).pipe(
        Effect.map(describe),
        Effect.catch((error) =>
          Effect.succeed(`${entry.ticket}: ${entry.title}\n(bd show failed: ${failure(error)})`),
        ),
      )

    const closedText = yield* Effect.forEach(
      entries.filter((entry) => closed.has(entry.phase._tag)),
      (entry) =>
        shown(entry, (issue) => {
          const reason = cut(issue.closeReason, closeReasonWidth)
          return (
            `${entry.ticket}: ${issue.title}\n${phaseSaid(entry.phase)}\n` +
            `Close reason: ${reason === "" ? "(none given)" : reason}`
          )
        }),
    )

    const asideText = yield* Effect.forEach(
      entries.filter((entry) => setAside.has(entry.phase._tag)),
      (entry) =>
        shown(entry, (issue) =>
          [
            `${entry.ticket}: ${issue.title}`,
            `${phaseSaid(entry.phase)}; bd status ${issue.status}`,
            ...(issue.notes.trim() === "" ? [] : [`Notes:\n${issue.notes.trim()}`]),
          ].join("\n"),
        ),
    )

    const runningText = entries
      .filter((entry) => inProgress.has(entry.phase._tag))
      .map((entry) => `${entry.ticket}: ${entry.title}\n${phaseSaid(entry.phase)}`)

    const ready = yield* beads.ready(config.ticket === null ? {} : { parent: config.ticket }).pipe(
      Effect.map((issues) => String(issues.length)),
      Effect.catch(() => Effect.succeed("unknown, bd could not list them")),
    )

    const tallies =
      entries.length === 0
        ? "None: the run took up no tickets."
        : entries.map((entry) => talliesLine(entry, steeredInRun(entry, logLines))).join("\n")

    const cost = yield* (yield* OrganCost).total
    const costSaid =
      cost.calls === 0
        ? "No organ call before this report said what it cost."
        : `${costTotal(cost)}, before this report.`

    const scope =
      config.ticket === null ? "Run" : `Run of ticket ${config.ticket} and its subtickets only`
    const ending = run.ending.text
    const meaning = ending.startsWith("DRAINED")
      ? "you asked the run to stop after its running tickets, and they finished"
      : exitMeaning(run.exitCode)

    // The final line goes inside the tags: it can quote what the run gathered, such as a triage
    // summary written from a ticket.
    return [
      section("The run's final line", ending),
      section("tutti's log for this run", logLines.join("\n")),
      section(`Commits merged into ${run.base} in this run`, commits),
      section(
        "Tickets closed in this run, merged or with no change to merge (ID, title, phase, close reason)",
        closedText.join("\n\n"),
      ),
      section(
        "Tickets set aside in this run (ID, title, phase, bd status, notes including triage notes)",
        asideText.join("\n\n"),
      ),
      section("Tickets in progress when the run stopped", runningText.join("\n\n")),
      section("Tickets still ready", ready),
      section(
        "Each ticket's attention requests, their answers and denials, your messages to its worker, " +
          "its compactions, and whether you steered it",
        tallies,
      ),
      section(
        "The attention requests, answers and denials of this run, as the log has them",
        attentionLines(logLines).join("\n"),
      ),
      section("What the run's organs (triage, the predictor and the like) cost", costSaid),
      ...(run.sections ?? []),
      `${scope}, on branch ${run.base} of ${config.repo}, from ${clockTime(run.started)} to ` +
        `${clockTime(now)}. Exit code ${run.exitCode} (${meaning}). Write its report.\n`,
    ]
  })

/** The run's organ costs: `$0.0456 in 3 organ calls, 4 turns in all`. */
export const costTotal = (cost: {
  readonly calls: number
  readonly costUsd: number
  readonly turns: number
}): string =>
  `${dollars(cost.costUsd)} in ${counted(cost.calls, "organ call")}, ${counted(cost.turns, "turn")} in all`

/**
 * The report as written and printed: its title, the reviewer's words, and the organs' cost total,
 * when a call said what it cost. The base and the scope are sanitised to one line and escaped for
 * Markdown; the reviewer's words, Markdown themselves, are sanitised.
 */
export const compose = (p: {
  readonly started: number
  readonly ended: number
  readonly base: string
  readonly scope: string | null
  readonly body: string
  readonly cost: { readonly calls: number; readonly costUsd: number; readonly turns: number }
}): string => {
  const text = (untrusted: string) => escapeMarkdown(sanitizeLine(untrusted))
  const scope = p.scope === null ? "" : ` · ${text(p.scope)}`
  const title =
    `# tutti run · ${date(p.started)} ${clockTime(p.started)}–${clockTime(p.ended)} · ` +
    `${text(p.base)}${scope}`
  const cost = p.cost.calls === 0 ? "" : `\nOrgans: ${costTotal(p.cost)}.\n`
  return `${title}\n\n${sanitize(p.body).trim()}\n${cost}`
}

/** What an organ error says, on one line. */
const organFailure = (error: OrganError): string => {
  switch (error._tag) {
    case "OrganFailed":
    case "OrganRefused":
      return error.reason.split("\n")[0] ?? error.reason
    case "OrganTimedOut":
      return "the reviewer ran past its time limit"
    case "OrganSkipped":
      return "the usage limit holds the run"
  }
}

/**
 * The run report, at the end of the run: gathered, written by the reviewer, saved to
 * .tutti/reports/<start time>.md and printed, each step said on the printer. Nothing at all when
 * --review=false or the run was quit.
 */
export const runReport = (run: ReportRun, out: ReportOut): Effect.Effect<void, never, ReportEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    if (run.quit || !config.settings.organs.review) return
    const logs = yield* Log
    const hold = yield* OrganHold
    if (yield* hold.held) {
      yield* logs.write(skippedLine("reviewer"))
      yield* out.printer.say("Run report skipped: the usage limit held the run to its end")
      return
    }
    const step = yield* out.printer.organ("Writing the run report with Claude…")
    const written = yield* Effect.exit(Effect.flatMap(gather(run), review)).pipe(
      Effect.onInterrupt(() => step.done("Run report skipped")),
    )
    if (written._tag === "Failure") {
      const reason = written.cause.reasons.find((r) => r._tag === "Fail")
      if (reason === undefined) return yield* step.done("Run report skipped")
      const error = reason.error
      if (error._tag === "OrganSkipped") {
        return yield* step.done("Run report skipped: the usage limit holds the run")
      }
      const message = reviewFailed`${organFailure(error)}`
      yield* logs.write(message)
      return yield* step.warn(message)
    }
    yield* step.done("Run report written")
    const report = compose({
      started: run.started,
      ended: yield* Clock.currentTimeMillis,
      base: run.base,
      scope: config.ticket,
      body: written.value,
      cost: yield* (yield* OrganCost).total,
    })
    yield* printReport(out.printer, report, out.theme, out.width)
    const name = join(reportsDir, reportName(run.started))
    const fs = yield* FileSystem.FileSystem
    const saved = yield* Effect.exit(
      Effect.andThen(
        fs.makeDirectory(join(config.repo, reportsDir), { recursive: true }),
        fs.writeFileString(join(config.repo, name), report),
      ),
    )
    if (saved._tag === "Failure") {
      const reason = saved.cause.reasons.find((r) => r._tag === "Fail")
      const why = reason === undefined ? "interrupted" : (reason.error.message.split("\n")[0] ?? "")
      yield* logs.write(reportNotSaved(why))
      return yield* out.printer.warn(`Report not saved: ${why}`)
    }
    yield* logs.write(reportWritten(name))
    yield* out.printer.say(`Report saved to ${name}`)
  })
