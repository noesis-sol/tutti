// The run report (§ 5 item 13 and 14, § 6.2, § 9.1): at the end of a run that wasn't quit, the
// reviewer (organs/reviewer.ts) writes what finished, what was set aside and why, and what needs
// you, from the run's evidence, gathered as orchestra gathers it: the final line, the run's log,
// the commits merged, the tickets closed, set aside and still in progress, the tickets still ready,
// and what the organs cost before it. In place of orchestra's hook tallies, it is given each
// ticket's tallies of attention requests and their answers (Attention's), the calls Claude Code
// denied without asking, by type, your messages and its compactions, and whether a person
// steered it, with the requests and denials as the log has them (the last of them, past a cap),
// from which its Needs you section recommends rules for the calls that kept being asked about or
// denied. Each list and section is capped to the last of it that fits, and a set-aside ticket's
// notes to their end, so that an overnight run's evidence keeps within the reviewer's context.
//
// The report is titled with the run's date, times, base and scope (escaped for Markdown, § 7.10),
// ends with the run's organ cost total, the report's own call included (§ 6.1), and is written to
// .tutti/reports/<start time>.md, then printed with the post-run printer (§ 7.1) under an organ
// line. It is skipped with --review=false and when the run was quit (§ 4.8). While the usage-limit
// hold is on it can't run (§ 4.12): a hold lifted before the end lets it run, and one that held the
// run to its end skips it. Ctrl+C, which interrupts it, skips it too; a defect is REVIEW_FAILED.
import { join } from "node:path"
import { Cause, Clock, Effect, Result } from "effect"
import { Attention, type Tally } from "../agent/Attention.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { makeFoldersUnder, type Refusal, writeFileUnder } from "../native/libc.ts"
import { type InputPart, type Section, section } from "../organs/evidence.ts"
import { dollars, OrganCost, type Total } from "../organs/OrganCost.ts"
import { type OrganError, OrganHold, type Organs, skippedLine } from "../organs/Organs.ts"
import { review } from "../organs/reviewer.ts"
import { printReport } from "../print/markdown.ts"
import type { Printer } from "../print/organLine.ts"
import type { Ending } from "../print/summary.ts"
import { Beads, type BeadsError, type Issue } from "../services/Beads.ts"
import { Git, type GitError } from "../services/Git.ts"
import { oneLine } from "../ui/oneLine.ts"
import { escapeMarkdown, sanitize, sanitizeLine } from "../ui/sanitize.ts"
import type { Theme } from "../ui/theme.ts"
import { exitCodes, exitMeanings } from "./holds.ts"
import { type Entry, Ledger } from "./ledger.ts"
import { clock, clockFrom, reportName, span } from "./localTime.ts"
import * as log from "./log.ts"
import { causeWhy, filed, type Kept, type Line, Log, line, Tag, tagged } from "./log.ts"
import { phaseFacts, type ReportSection, type TicketPhase, WaitFor } from "./phase.ts"

/** Where the reports go, below the repository. */
export const reportsDir = ".tutti/reports"

/** How many characters of a closed ticket's close reason the reviewer is given, as orchestra's. */
export const closeReasonWidth = 400

/**
 * How many characters of a set-aside ticket's notes the reviewer is given: their end, where the
 * latest notes are, a triage's or a worker's last word among them.
 */
export const notesWidth = 1500

/** How many bd show calls the report runs at once, for the tickets closed and set aside. */
export const showConcurrency = 4

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
  /**
   * What the report says after the reviewer's text, whatever it wrote, in Markdown: a failed full
   * check and the end of its output (fullCheckReport).
   */
  readonly after?: string
}

/** Where the report is printed after the dashboard. */
export interface ReportOut {
  readonly printer: Printer
  readonly theme: Theme
  /** The terminal's width. */
  readonly width: number
  /**
   * The run's log prints on the same output, in plain mode (§ 7.6): what the log says of the
   * report is said there alone, not again on the printer.
   */
  readonly logged?: boolean
}

/** Every service the report uses. */
export type ReportEnv = AppConfig | Organs | OrganCost | Ledger | Attention | Log | Beads | Git

/** REVIEW_FAILED: the reviewer gave no report. */
export const reviewFailed = tagged("REVIEW_FAILED")

/** REPORT: the report written, and where. */
export const reportWritten = (path: string): Line => tagged("REPORT")`written to ${path}`

/** The report not written, and why. */
export const reportNotSaved = (why: string): Line => line`report not saved: ${why}`

/** What the run's exit code means, for the reviewer (§ 5 item 10), from `exitMeanings`. */
export const exitMeaning = (code: number): string => {
  const name = (Object.keys(exitCodes) as Array<keyof typeof exitCodes>).find(
    (each) => exitCodes[each] === code,
  )
  return name === undefined ? "unknown" : exitMeanings[name]
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
export const steeredInRun = (entry: Entry, logLines: ReadonlyArray<Kept>): boolean =>
  entry.steered ||
  entry.tallies.messages > 0 ||
  logLines.some((each) => each.tag === Tag.steered && each.ticket === entry.ticket)

/** What a Waiting ticket waits for, as the reviewer reads it. */
const waitSaid = (wait: WaitFor): string =>
  WaitFor.$match(wait, {
    Blockers: ({ ids }) => `back in the queue until ${ids.join(", ")} merges`,
    Setup: () =>
      "its worktree's setup failed; back in the queue until a ticket merges or a probe passes",
    Probe: () => "back in the queue until the environment probe passes",
    SetupProblem: () => "a setup problem stopped its worker; back in the next run",
  })

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
      return `Waiting (${waitSaid(phase.for)})`
    case "HeldBack":
    case "Deferred":
    case "Review":
    case "Blocked":
    case "Stopped":
      return `${phase._tag} (${phase.why})`
    case "Fixing":
    case "Resolving":
      return `${phase._tag} (attempt ${phase.attempt})`
    case "Queued":
    case "Working":
    case "ToMerge":
    case "Merging":
      return phase._tag
  }
}

/** The order Claude Code's denials are said in, by type; another type comes after, by name. */
const denierOrder = ["classifier", "safetyCheck", "mode", "rule"]

const denierRank = (by: string): number => {
  const rank = denierOrder.indexOf(by)
  return rank === -1 ? denierOrder.length : rank
}

/**
 * A ticket's attention tallies, in words: its requests by kind, their answers, the calls a rule
 * you allowed for this run allowed, and the calls Claude Code denied without asking, by type.
 */
export const attentionSaid = (t: Tally): ReadonlyArray<string> => {
  const kinds = [
    ...(t.permissions > 0 ? [counted(t.permissions, "permission")] : []),
    ...(t.questions > 0 ? [counted(t.questions, "question")] : []),
    ...(t.elicitations > 0 ? [counted(t.elicitations, "elicitation")] : []),
  ]
  const requests = t.permissions + t.questions + t.elicitations
  const answers: ReadonlyArray<readonly [number, string]> = [
    [t.allowed, "allowed"],
    [t.allowedForRun, "allowed for this run"],
    [t.answered, "answered"],
    [t.denied, "denied by you"],
    [t.declined, "declined"],
    [t.cancelled, "withdrawn"],
  ]
  const denials = Object.entries(t.deniedBy)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => denierRank(a) - denierRank(b) || a.localeCompare(b))
  const denied = denials.reduce((sum, [, n]) => sum + n, 0)
  return [
    ...(requests > 0 ? [`${counted(requests, "attention request")} (${kinds.join(", ")})`] : []),
    ...answers.flatMap(([n, verdict]) => (n > 0 ? [`${n} ${verdict}`] : [])),
    ...(t.allowedByRule > 0
      ? [`${counted(t.allowedByRule, "call")} allowed by a rule you allowed for this run`]
      : []),
    ...(denied > 0
      ? [
          `${counted(denied, "call")} Claude Code denied without asking (` +
            `${denials.map(([by, n]) => `${n} by ${log.denier(by)}`).join(", ")})`,
        ]
      : []),
  ]
}

/**
 * A ticket's tallies and steering, one line: `tut-1 (Done (merged in abc)): 3 attention requests
 * (3 permissions), 2 allowed, 1 denied by you, 1 call Claude Code denied without asking (1 by the
 * safety check), 2 of your messages, compacted once; steered by you.`
 */
export const talliesLine = (entry: Entry, attention: Tally, steered: boolean): string => {
  const t = entry.tallies
  const said = [
    ...attentionSaid(attention),
    ...(t.messages > 0 ? [counted(t.messages, "of your messages", "of your messages")] : []),
    ...(t.compactions > 0 ? [`compacted ${times(t.compactions)}`] : []),
  ]
  const tallies = said.length === 0 ? "no attention requests, denials or messages" : said.join(", ")
  return `${entry.ticket} (${phaseSaid(entry.phase)}): ${tallies}; ${steered ? "steered by you" : "not steered"}.`
}

/** The tags of the log lines that record attention requests, their answers and denials. */
const attentionTags: ReadonlyArray<string> = [Tag.permission, Tag.question, Tag.allowed, Tag.denied]

/** The run's log lines that record attention requests, their answers and denials, by their tags. */
export const attentionLines = (logLines: ReadonlyArray<Kept>): ReadonlyArray<Kept> =>
  logLines.filter((each) => each.tag !== null && attentionTags.includes(each.tag))

/**
 * How much of the log's end the reviewer is given past the START block: so many lines, and no more
 * than so many characters, so that an overnight run's log leaves room in its context for the rest.
 */
export const logCap = { lines: 1500, characters: 150_000 }

/**
 * How many of the run's last attention lines the reviewer is given, and no more than so many
 * characters of them: a run with many requests or denials keeps room in its context, and each
 * ticket's tallies, in their own section, still count them all.
 */
export const attentionCap = { lines: 500, characters: 50_000 }

/**
 * How many of the run's last commits, closed tickets, set-aside tickets, tickets in progress and
 * tickets' tallies the reviewer is given, and no more than so many characters of each list: an
 * overnight run with hundreds of tickets keeps within the reviewer's context (`reviewerBudget`).
 */
export const listCaps = {
  commits: { lines: 1000, characters: 30_000 },
  closed: { lines: 300, characters: 80_000 },
  setAside: { lines: 200, characters: 60_000 },
  inProgress: { lines: 100, characters: 15_000 },
  tallies: { lines: 1000, characters: 40_000 },
}

/**
 * How much of the end of each section the run gathers itself (ReportRun.sections: the failed
 * checks, the full check, the feature request, the follow-ups) the reviewer is given.
 */
export const evidenceCap = { lines: 1000, characters: 15_000 }

/** The most sections the run gathers itself (ReportRun.sections). */
export const runSections = 4

/**
 * About how many characters of evidence the reviewer is given at most: every section's cap, and
 * room for their titles and tutti's own line. Its context holds this with room for its prompt and
 * its answer.
 */
export const reviewerBudget =
  logCap.characters +
  attentionCap.characters +
  Object.values(listCaps).reduce((sum, cap) => sum + cap.characters, 0) +
  runSections * evidenceCap.characters +
  5_000

/** How many lines (or a list's items) and characters a capped section keeps of its end. */
type Cap = { readonly lines: number; readonly characters: number }

/**
 * `items` whole when they fit `cap`, else their first `kept` items, the line `said(cut, last)`
 * makes of how many were cut and of the items that follow, and the last items that fit, each
 * after `separator`; the items are lines unless `noun` says what else they are.
 */
const cappedTail = (
  items: ReadonlyArray<string>,
  kept: number,
  cap: Cap,
  said: (cut: number, last: string) => string,
  separator = "\n",
  noun: { readonly one: string; readonly many: string } = { one: "line", many: "lines" },
): string => {
  const headEnd = Math.min(Math.max(kept, 0), items.length)
  let tailStart = items.length
  let characters = 0
  while (tailStart > headEnd && items.length - tailStart < cap.lines) {
    characters += (items[tailStart - 1] ?? "").length + separator.length
    if (characters > cap.characters) break
    tailStart -= 1
  }
  const cut = tailStart - headEnd
  if (cut === 0) return items.join(separator)
  const left = items.length - tailStart
  const last =
    left === 0
      ? `its last ${noun.one} is too long to give`
      : left === 1
        ? `the last ${noun.one} follows`
        : `the last ${left} follow`
  return [...items.slice(0, headEnd), said(cut, last), ...items.slice(tailStart)].join(separator)
}

/**
 * The run's log as the reviewer reads it: whole when it fits `cap`, else its first `kept` lines
 * (those up to the end of the START block), a line saying how many lines were cut, and the last
 * lines that fit. The attention lines have their own section (`cappedAttention`), uncut by this.
 */
export const cappedLog = (
  logLines: ReadonlyArray<string>,
  kept: number,
  cap: Cap = logCap,
): string =>
  cappedTail(logLines, kept, cap, (cut, last) => {
    const where =
      Math.min(Math.max(kept, 0), logLines.length) === 0 ? "" : ", after the START block"
    return `[${counted(cut, "line")} of the log cut here${where}; ${last}]`
  })

/**
 * The run's attention lines (`attentionLines`) as the reviewer reads them: whole when they fit
 * `cap`, else a line saying how many of the earliest were cut, and the last lines that fit.
 */
export const cappedAttention = (lines: ReadonlyArray<string>, cap: Cap = attentionCap): string =>
  cappedTail(
    lines,
    0,
    cap,
    (cut, last) =>
      `[${counted(cut, "earlier attention line")} cut here, still counted in each ticket's ` +
      `tallies; ${last}]`,
  )

/**
 * A list of the run's, its `items` one or more lines each (`separator` between them), as the
 * reviewer reads it: whole when it fits `cap`, else a line saying how many of the earliest `noun`
 * were cut, and the last items that fit.
 */
export const cappedList = (
  items: ReadonlyArray<string>,
  cap: Cap,
  noun: { readonly one: string; readonly many: string },
  separator = "\n\n",
): string =>
  cappedTail(
    items,
    0,
    cap,
    (cut, last) =>
      `[${cut === 1 ? `1 earlier ${noun.one}` : `${cut} earlier ${noun.many}`} cut here; ${last}]`,
    separator,
    noun,
  )

/**
 * A section the run gathered itself (ReportRun.sections) as the reviewer reads it: its body whole
 * when it fits `cap`, else a line saying how many of its first lines were cut, and its last lines
 * that fit.
 */
export const cappedEvidence = (s: Section, cap: Cap = evidenceCap): Section =>
  section(
    s.title,
    cappedTail(
      s.body.split("\n"),
      0,
      cap,
      (cut, last) => `[${counted(cut, "earlier line")} of this section cut here; ${last}]`,
    ),
  )

/**
 * A set-aside ticket's notes as the reviewer reads them: whole when they fit `width` characters,
 * else a line saying how many of their first characters were cut, and their end, from the start of
 * a line where the end holds a line break.
 */
export const notesTail = (notes: string, width: number = notesWidth): string => {
  const chars = [...notes]
  if (chars.length <= width) return notes
  const tail = chars.slice(chars.length - width).join("")
  const lineStart = tail.indexOf("\n")
  const end = lineStart === -1 ? tail : tail.slice(lineStart + 1)
  const cut = chars.length - [...end].length
  return `[the notes' first ${counted(cut, "character")} cut here; their end follows]\n${end}`
}

/** Whether `entry` is in the reviewer's `section` (phase.ts phaseFacts). */
const inSection =
  (section: ReportSection) =>
  (entry: Entry): boolean =>
    phaseFacts[entry.phase._tag].report === section

/** What a failed bd or git call said, in a few words. */
const failure = (error: BeadsError | GitError): string =>
  "stderr" in error && error.stderr.trim() !== ""
    ? (error.stderr.trim().split("\n")[0] ?? error._tag)
    : error._tag

/**
 * When the run went, as the reviewer's closing line says it: `from 09:05 to 10:30`, the end's date
 * given when it is on another day, `from 23:10 to 2026-10-18 01:40`.
 */
export const ranFrom = (started: number, ended: number): string =>
  `from ${clock(started)} to ${clockFrom(ended, started)}`

/**
 * The reviewer's input: the run's evidence, in sections, then tutti's own line on the run, with the
 * request last, as Claude reads long inputs best with it at the end.
 */
export const gather = (
  run: ReportRun,
): Effect.Effect<
  ReadonlyArray<InputPart>,
  never,
  AppConfig | OrganCost | Ledger | Attention | Log | Beads | Git
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const attention = yield* Attention
    const beads = yield* Beads
    const git = yield* Git
    const logs = yield* Log
    const logLines = yield* logs.lines
    const startBlockEnd = yield* logs.startBlockEnd
    const entries = [...(yield* (yield* Ledger).current).tickets.values()]
    const now = yield* Clock.currentTimeMillis

    const commits = yield* git.log(config.repo, run.startHead, run.base).pipe(
      Effect.map((list) =>
        cappedList(
          list.map((c) => `${c.hash} ${c.subject}`),
          listCaps.commits,
          { one: "commit", many: "commits" },
          "\n",
        ),
      ),
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
      entries.filter(inSection("closed")),
      (entry) =>
        shown(entry, (issue) => {
          const reason = oneLine(issue.closeReason, closeReasonWidth)
          return (
            `${entry.ticket}: ${issue.title}\n${phaseSaid(entry.phase)}\n` +
            `Close reason: ${reason === "" ? "(none given)" : reason}`
          )
        }),
      { concurrency: showConcurrency },
    )

    const asideText = yield* Effect.forEach(
      entries.filter(inSection("setAside")),
      (entry) =>
        shown(entry, (issue) =>
          [
            `${entry.ticket}: ${issue.title}`,
            `${phaseSaid(entry.phase)}; bd status ${issue.status}`,
            ...(issue.notes.trim() === "" ? [] : [`Notes:\n${notesTail(issue.notes.trim())}`]),
          ].join("\n"),
        ),
      { concurrency: showConcurrency },
    )

    const runningText = entries
      .filter(inSection("inProgress"))
      .map((entry) => `${entry.ticket}: ${entry.title}\n${phaseSaid(entry.phase)}`)

    const ready = yield* beads.ready(config.ticket === null ? {} : { parent: config.ticket }).pipe(
      Effect.map((issues) => String(issues.length)),
      Effect.catch(() => Effect.succeed("unknown, bd could not list them")),
    )

    const tallies =
      entries.length === 0
        ? "None: the run took up no tickets."
        : cappedList(
            yield* Effect.forEach(entries, (entry) =>
              Effect.map(attention.tally(entry.ticket), (tally) =>
                talliesLine(entry, tally, steeredInRun(entry, logLines)),
              ),
            ),
            listCaps.tallies,
            { one: "ticket's line", many: "tickets' lines" },
            "\n",
          )

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
      section("tutti's log for this run", cappedLog(logLines.map(filed), startBlockEnd)),
      section(`Commits merged into ${run.base} in this run`, commits),
      section(
        "Tickets closed in this run, merged or with no change to merge (ID, title, phase, close reason)",
        cappedList(closedText, listCaps.closed, { one: "closed ticket", many: "closed tickets" }),
      ),
      section(
        "Tickets set aside in this run (ID, title, phase, bd status, notes including triage notes)",
        cappedList(asideText, listCaps.setAside, {
          one: "set-aside ticket",
          many: "set-aside tickets",
        }),
      ),
      section(
        "Tickets in progress when the run stopped",
        cappedList(runningText, listCaps.inProgress, {
          one: "ticket in progress",
          many: "tickets in progress",
        }),
      ),
      section("Tickets still ready", ready),
      section(
        "Each ticket's attention requests and their answers, the calls Claude Code denied its " +
          "worker without asking, your messages to its worker, its compactions, and whether you " +
          "steered it",
        tallies,
      ),
      section(
        "The attention requests, answers and denials of this run, as the log has them",
        cappedAttention(attentionLines(logLines).map(filed)),
      ),
      section("What the run's organs (triage, the predictor and the like) cost", costSaid),
      ...(run.sections ?? []).map((each) => cappedEvidence(each)),
      `${scope}, on branch ${run.base} of ${config.repo}, ${ranFrom(run.started, now)}. ` +
        `Exit code ${run.exitCode} (${meaning}). Write its report.\n`,
    ]
  })

/** What the report says of the run's organ calls. */
type OrganTotal = Pick<Total, "calls" | "costUsd" | "turns" | "unknown">

/**
 * The run's organ costs: `$0.0456 in 3 organ calls, 4 turns in all`, naming the calls whose cost
 * it leaves out: `$0.0456 in 7 organ calls, 9 turns in all; 1 call's cost unknown`.
 */
export const costTotal = (cost: OrganTotal): string => {
  const known = `${dollars(cost.costUsd)} in ${counted(cost.calls, "organ call")}, ${counted(cost.turns, "turn")} in all`
  if (cost.unknown === 0) return known
  return `${known}; ${cost.unknown === 1 ? "1 call's" : `${cost.unknown} calls'`} cost unknown`
}

/**
 * The report as written and printed: its title, the reviewer's words, what the run says after them
 * (a failed full check), and the organs' cost total, when a call said what it cost. The base and
 * the scope are sanitised to one line and escaped for Markdown; the reviewer's words and the run's
 * after them, Markdown themselves, are sanitised.
 */
export const compose = (p: {
  readonly started: number
  readonly ended: number
  readonly base: string
  readonly scope: string | null
  readonly body: string
  readonly after?: string
  readonly cost: OrganTotal
}): string => {
  const text = (untrusted: string) => escapeMarkdown(sanitizeLine(untrusted))
  const scope = p.scope === null ? "" : ` · ${text(p.scope)}`
  const title = `# tutti run · ${span(p.started, p.ended)} · ` + `${text(p.base)}${scope}`
  const cost = p.cost.calls === 0 ? "" : `\nOrgans: ${costTotal(p.cost)}.\n`
  return `${title}\n\n${sanitize(p.body).trim()}\n${sanitize(p.after ?? "")}${cost}`
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
 * Why the report wasn't saved, on one line: the refusal's first line, a defect's message, or
 * `interrupted` for a Ctrl+C alone.
 */
export const notSavedWhy = (cause: Cause.Cause<Refusal>): string => {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted"
  const error = Cause.findError(cause)
  return Result.isSuccess(error) ? (error.success.message.split("\n")[0] ?? "") : causeWhy(cause)
}

/**
 * The run report, at the end of the run: gathered, written by the reviewer, saved to
 * .tutti/reports/<start time>.md and printed, each step said on the printer, or by the log alone
 * where it prints there too (ReportOut.logged). Nothing at all when
 * --review=false or the run was quit: `out` is made only when the report has something to print.
 */
export const runReport = (
  run: ReportRun,
  made: Effect.Effect<ReportOut>,
): Effect.Effect<void, never, ReportEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    if (run.quit || !config.settings.organs.review) return
    const out = yield* made
    const logs = yield* Log
    const hold = yield* OrganHold
    /** Says `line` on the printer, unless the log has just printed its own line there. */
    const unlogged = (line: Effect.Effect<void>) => (out.logged === true ? Effect.void : line)
    if (yield* hold.held) {
      yield* logs.write(skippedLine("reviewer"))
      yield* unlogged(
        out.printer.say("Run report skipped: the usage limit held the run to its end"),
      )
      return
    }
    const step = yield* out.printer.organ("Writing the run report with Claude…")
    const written = yield* Effect.exit(Effect.flatMap(gather(run), review)).pipe(
      Effect.onInterrupt(() => step.done("Run report skipped")),
    )
    if (written._tag === "Failure") {
      // Ctrl+C skips it; a defect in gathering or reviewing, which organs don't turn into errors,
      // is REVIEW_FAILED with the defect's message.
      if (Cause.hasInterruptsOnly(written.cause)) return yield* step.done("Run report skipped")
      const error = Cause.findError(written.cause)
      if (Result.isSuccess(error) && error.success._tag === "OrganSkipped") {
        // The organ has written the reviewer's skipped line.
        return yield* out.logged === true
          ? step.drop
          : step.done("Run report skipped: the usage limit holds the run")
      }
      const message = reviewFailed`${Result.isSuccess(error) ? organFailure(error.success) : causeWhy(written.cause)}`
      yield* logs.write(message)
      return yield* out.logged === true ? step.drop : step.warn(message)
    }
    yield* step.done("Run report written")
    const report = compose({
      started: run.started,
      ended: yield* Clock.currentTimeMillis,
      base: run.base,
      scope: config.ticket,
      body: written.value,
      ...(run.after === undefined ? {} : { after: run.after }),
      cost: yield* (yield* OrganCost).total,
    })
    yield* printReport(out.printer, report, out.theme, out.width)
    const name = join(reportsDir, reportName(run.started))
    // Through the symlink guard (§ 9.1): a link at .tutti, .tutti/reports or the report's name,
    // which a merged ticket can leave there, is refused rather than written through.
    const saved = yield* Effect.exit(
      Effect.andThen(
        Effect.sync(() => makeFoldersUnder(config.repo, reportsDir)),
        writeFileUnder(config.repo, name, report),
      ),
    )
    if (saved._tag === "Failure") {
      const why = notSavedWhy(saved.cause)
      yield* logs.write(reportNotSaved(why))
      return yield* unlogged(out.printer.warn(`Report not saved: ${why}`))
    }
    yield* logs.write(reportWritten(name))
    yield* unlogged(out.printer.say(`Report saved to ${name}`))
  })
