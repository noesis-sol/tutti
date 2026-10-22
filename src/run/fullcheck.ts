// The full check (§ 5 item 12, § 2): the project's check_full (checks.full.command, such as
// scripts/check-full.sh), every suite, those too slow to run on every merge included, as orchestra's
// fullcheck.go has it. It runs once a run has ended by itself (READY_EMPTY, LIMIT_REACHED, DRAINED)
// having merged a ticket, after the closing line and before the end record, on the base's head in a
// worktree of its own on no branch, so the main checkout stays as it is; the worktree is removed
// afterwards, whatever the check left in it. Nothing is installed in a new worktree, so the setup
// command (checks.setup.command, such as bun install) runs there first, within check_full's time
// limit; a setup that fails is said as such and files no ticket: it is not a suite's failure.
//
// A failure keeps the whole output in the main checkout's .tutti/run/check-full.log (§ 9.1), and
// its last 40 lines go to the log, the reviewer and the run report, after the reviewer's text; it
// files a P2 bug labelled check-full for the suite it failed in (the last SUITE: line), titled
// `Full check fails: <suite>`, unless one is open for that suite already, which is noted instead:
// each failing suite has one ticket. A quit while it runs stops it (its process group is killed) and
// says it was skipped. Each way it can go is a full_check record (§ 10).
import { readSync, writeSync } from "node:fs"
import { join } from "node:path"
import { Clock, Duration, Effect, Result, type Scope } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { O } from "../native/libc.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, type Issue } from "../services/Beads.ts"
import {
  type CheckError,
  type CheckPassed,
  Checks,
  type RunOptions,
  setupLogName,
} from "../services/Checks.ts"
import { Git } from "../services/Git.ts"
import { runFolder, Worktrees } from "../services/Worktrees.ts"
import { escapeMarkdown, sanitizeLine } from "../ui/sanitize.ts"
import { saidOf } from "./check.ts"
import type { fullCheckOutcomes } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { dateClock } from "./localTime.ts"
import { detail, type Line, Log, line, logFile, Tag, ticketLine } from "./log.ts"
import { beadsWhy, gitWhy } from "./merge.ts"
import type { TicketPhase } from "./phase.ts"

/** Marks the ticket filed for a suite the full check failed in; orchestra's label too (§ 11). */
export const fullCheckLabel = "check-full"

/** The file in the main checkout's .tutti/run/ that holds the last failing full check's output. */
export const fullCheckLogName = "check-full.log"

/** How the full check's worktree's folder name starts, under the worktrees' folder. */
export const fullCheckFolderPrefix = "check-full-"

/** How many of the last lines of a failed full check's output the log, the reviewer and the report have. */
export const fullCheckEnd = 40

/** Begins the title of a ticket filed for a full check's suite. */
export const fullCheckPrefix = "Full check fails: "

/** The most characters a ticket's title has, as workers are asked to keep them. */
export const titleWidth = 60

/** How the full check went, as its full_check record's detail says. */
export type FullCheckOutcome = (typeof fullCheckOutcomes)[number]

/** How the full check went, for the report. */
export interface FullChecked {
  readonly outcome: FullCheckOutcome
  /** The base's commit it ran on; "" when git couldn't say. */
  readonly at: string
  /** How long it ran, in milliseconds. */
  readonly took: number
  /** The suite it failed in; absent when it didn't, or when the setup before it failed. */
  readonly suite?: string
  /** The setup command, when the full check failed in it. */
  readonly setup?: string
  /** Where its whole output is, when it failed. */
  readonly output?: string
  /** The end of its output, its last fullCheckEnd lines, when it failed. */
  readonly end: ReadonlyArray<string>
  /** The ticket filed for the suite, or the one open for it already. */
  readonly ticket?: string
  /** What became of the ticket, for a line: `filed X`, `X is open for it already`. */
  readonly filed?: string
  /** The line that said how it went. */
  readonly text: Line
}

/** Whether the full check failed, in a suite or in the setup before it. */
const didFail = (checked: FullChecked): boolean =>
  checked.outcome === "failed" || checked.outcome === "timed out"

/**
 * What the reviewer is told of the full check: the line that said how it went, and, when it failed,
 * the end of its output.
 */
export const fullCheckEvidence = (checked: FullChecked): string =>
  didFail(checked) && checked.end.length > 0
    ? `${checked.text}\nThe end of its output:\n${checked.end.join("\n")}`
    : checked.text

/** The longest run of backticks in `text`. */
const backticks = (text: string): number =>
  Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length))

/** `text`, sanitised to one line, as a Markdown code span that no backtick in it can close. */
const codeSpan = (text: string): string => {
  const one = sanitizeLine(text)
  const fence = "`".repeat(backticks(one) + 1)
  const pad = one.startsWith("`") || one.endsWith("`") ? " " : ""
  return `${fence}${pad}${one}${pad}${fence}`
}

/** `lines`, each sanitised, as a Markdown code block that no line in it can close. */
const codeBlock = (lines: ReadonlyArray<string>): string => {
  const body = lines.map((each) => sanitizeLine(each))
  const fence = "`".repeat(Math.max(3, ...body.map((each) => backticks(each) + 1)))
  return `${fence}\n${body.join("\n")}\n${fence}`
}

/**
 * What the run report says of a full check that failed, `command`, after the reviewer's text, so it
 * is there whatever the reviewer wrote: how it failed, where its whole output is, and the end of
 * the output in a code block; "" for one that didn't fail. Markdown, the run's words escaped.
 */
export const fullCheckReport = (checked: FullChecked, command: string): string => {
  if (!didFail(checked)) return ""
  const text = (untrusted: string) => escapeMarkdown(sanitizeLine(untrusted))
  const how =
    checked.setup === undefined
      ? `${codeSpan(command)} ${checked.outcome} in the suite ${text(checked.suite ?? command)}`
      : `${codeSpan(command)} did not run: the setup before it, ${codeSpan(checked.setup)}, ${checked.outcome}`
  const filed = checked.filed === undefined ? "" : `; ${text(checked.filed)}`
  const output =
    checked.output === undefined ? "" : ` The whole output is in ${codeSpan(checked.output)}.`
  const end =
    checked.end.length === 0 ? " It printed nothing." : ` Its end:\n\n${codeBlock(checked.end)}`
  return `\n## Full check\n\n${how}${filed}.${output}${end}\n`
}

/**
 * Whether the full check runs after a run: the project has one (`command`), the run ended by itself
 * (`stopped` is false: no stop, no hold), and one of its tickets merged.
 */
export const fullCheckDue = (
  command: string | null,
  stopped: boolean,
  phases: Iterable<TicketPhase>,
): boolean => {
  if (command === null || stopped) return false
  for (const phase of phases) {
    if (phase._tag === "Done" && phase.outcome._tag === "Merged") return true
  }
  return false
}

/**
 * The title of the ticket filed for `suite`: `Full check fails: <suite>`, cut to titleWidth. An open
 * one with it, labelled check-full, is the suite's, or one of the suites its title, cut, begins (see
 * filedForSuite).
 */
export const fullCheckTitle = (suite: string): string => {
  const title = `${fullCheckPrefix}${suite}`
  const chars = Array.from(title)
  return chars.length > titleWidth ? `${chars.slice(0, titleWidth - 1).join("")}…` : title
}

/** What a filed ticket's description and notes say of its suite, which tells a cut title's apart. */
const suiteSaid = (suite: string): string => `in the suite ${suite}, at the end of the run`

/**
 * Whether `issue`, an open ticket, was filed for `suite`: titled fullCheckTitle(suite) and labelled
 * check-full. A title cut to titleWidth stands for every suite it begins, so its description, which
 * names its suite, says which.
 */
export const filedForSuite = (issue: Issue, suite: string): boolean => {
  const title = fullCheckTitle(suite)
  if (issue.title !== title || !issue.labels.includes(fullCheckLabel)) return false
  return title === `${fullCheckPrefix}${suite}` || issue.description.includes(suiteSaid(suite))
}

/** A commit's hash, short, for a line. */
const short = (commit: string): string => commit.slice(0, 7)

/** A time a command took, to the second: `2m5s`, `0s`. */
const took = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  return seconds === 0 ? "0s" : formatDuration(Duration.seconds(seconds))
}

/** How a command of the full check failed, for a line: it fails, or did not finish. */
const howFailed = (error: CheckError): string => {
  switch (error._tag) {
    case "CheckFailed":
      return "fails"
    case "CheckTimedOut":
      return `did not finish within ${formatDuration(error.timeLimit)}`
    case "CheckNotRun":
      return line`could not be run (${error.reason})`
  }
}

/** Copies what the descriptor `from` reads to the descriptor `to`. */
const copyTo = (from: number, to: number): void => {
  const chunk = Buffer.alloc(64 * 1024)
  for (;;) {
    const read = readSync(from, chunk, 0, chunk.length, null)
    if (read === 0) return
    for (let written = 0; written < read; ) {
      written += writeSync(to, chunk, written, read - written)
    }
  }
}

type Env = AppConfig | Beads | Checks | Git | Worktrees | Log | EventStream

/** The run the full check comes at the end of. */
export interface FullCheckOptions {
  /** The branch the run merged into. */
  readonly base: string
  /** When the run started, for the ticket filed: epoch milliseconds. */
  readonly started: number
  /** The setup command as the run has it now, a merge's settings taken (setup.ts); checks.setup's when absent. */
  readonly setup?: string | null
}

/**
 * Runs the full check on the base's head in a worktree of its own, removed afterwards, the setup
 * first when the project has one, and says how it went in a full_check record and the log. A
 * failure keeps its whole output in the main checkout's .tutti/run/check-full.log and files a P2
 * ticket labelled check-full for its suite, unless one is open for it already; a failed setup files
 * none. Interrupted, it says it was skipped. Call it when fullCheckDue says so. It never fails.
 */
export const fullCheck = (options: FullCheckOptions): Effect.Effect<FullChecked, never, Env> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const git = yield* Git
    const worktrees = yield* Worktrees
    const logs = yield* Log
    const events = yield* EventStream
    const { base } = options
    const { full } = config.settings.checks
    const setup = {
      command: options.setup === undefined ? config.settings.checks.setup.command : options.setup,
    }
    const command = full.command ?? ""
    const say = (record: {
      readonly detail: FullCheckOutcome
      readonly text: Line
      readonly suite?: string
      readonly output?: string
      readonly ticket?: string
    }) => logs.writeWith([record.text], events.emit({ kind: "full_check", ...record }))

    const head = yield* Effect.result(git.revParse(config.repo, base))
    const at = Result.isSuccess(head) ? head.success : ""
    const made = Result.isSuccess(head)
      ? yield* Effect.result(worktrees.addDetached(fullCheckFolderPrefix, at))
      : Result.fail(head.failure)
    if (Result.isFailure(made)) {
      const error = made.failure
      const why =
        error._tag === "GitFailed" || error._tag === "GitTimedOut" ? gitWhy(error) : error.message
      const text = ticketLine(
        Tag.fullCheckNotRun,
      )`'${command}' could not run on ${base}: no worktree for it (${why})`
      yield* say({ detail: "not run", text })
      return { outcome: "not run", at, took: 0, end: [], text } satisfies FullChecked
    }
    const path = made.success
    const began = yield* Clock.currentTimeMillis
    const elapsed = Effect.map(Clock.currentTimeMillis, (now) => now - began)

    const run = Effect.gen(function* () {
      const what =
        setup.command === null ? line`'${command}'` : line`'${setup.command}', then '${command}',`
      yield* logs.write(
        ticketLine(
          Tag.fullCheck,
        )`running ${what} on ${base} at ${short(at)} in ${path} (time limit ${formatDuration(full.timeout)})`,
      )
      const checks = yield* Checks
      if (setup.command !== null) {
        const ran = yield* Effect.scoped(
          Effect.flatMap(outputIn(path, setupLogName), (to) =>
            Effect.result(
              checks.setup({ cwd: path, ...to, before: "full", command: setup.command }),
            ),
          ),
        )
        if (Result.isFailure(ran)) {
          return yield* failed(options, at, yield* elapsed, ran.failure, path, setupLogName)
        }
      }
      const ran = yield* Effect.scoped(
        Effect.flatMap(outputIn(path, fullCheckLogName), (to) =>
          Effect.result(checks.full({ cwd: path, ...to })),
        ),
      )
      const ms = yield* elapsed
      if (Result.isFailure(ran)) {
        return yield* failed(options, at, ms, ran.failure, path, fullCheckLogName)
      }
      const text = ticketLine(
        `${Tag.fullCheck} passed`,
      )`'${command}' on ${base} at ${short(at)} (${took(ms)})`
      yield* say({ detail: "passed", text })
      if (ran.success._tag === "CheckPassed") yield* flaky(command, ran.success)
      return { outcome: "passed", at, took: ms, end: [], text } satisfies FullChecked
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.flatMap(elapsed, (ms) =>
          say({
            detail: "skipped",
            text: ticketLine(
              Tag.fullCheckSkipped,
            )`'${command}' was stopped after ${took(ms)}, as asked`,
          }),
        ),
      ),
    )

    return yield* Effect.ensuring(
      run,
      Effect.catch(worktrees.removeDetached(path), (error) =>
        Effect.gen(function* () {
          const why =
            error._tag === "GitFailed" || error._tag === "GitTimedOut"
              ? gitWhy(error)
              : error.message
          const text = ticketLine(
            Tag.cleanupFailed,
          )`the full check's worktree ${path} is left (${why}); git worktree remove --force ${path} removes it`
          yield* logs.writeWith([text], events.emit({ kind: "warn", text }))
        }),
      ),
    )
  })

/**
 * Where a command run in the full check's worktree writes its whole output: `name` in its
 * .tutti/run/, opened through the symlink guard; /dev/null when it can't be opened, and the log
 * says why.
 */
const outputIn = (
  worktree: string,
  name: string,
): Effect.Effect<
  Pick<RunOptions, "outputFile" | "outputFd">,
  never,
  Worktrees | Log | Scope.Scope
> =>
  Effect.gen(function* () {
    const output = join(worktree, runFolder, name)
    const opened = yield* Effect.result(
      (yield* Worktrees).openRunFile(worktree, name, O.WRONLY | O.CREAT | O.TRUNC),
    )
    if (Result.isSuccess(opened)) return { outputFile: output, outputFd: opened.success }
    yield* (yield* Log).write(
      detail`the full check's whole output can't be kept in ${output}: ${opened.failure.message}`,
    )
    return { outputFile: "/dev/null" }
  })

/** FLAKY warnings for a full check that passed with tests that failed and then passed on a rerun. */
const flaky = (command: string, passed: CheckPassed) =>
  Effect.gen(function* () {
    const logs = yield* Log
    const events = yield* EventStream
    const what = line`the full check '${command}'`
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
    for (const text of warnings) {
      yield* logs.writeWith([text], events.emit({ kind: "warn", text }))
    }
  })

/**
 * Keeps the whole output of the full check that failed, `name` in its worktree's .tutti/run/, in
 * the main checkout's .tutti/run/check-full.log, and says where it is; the log, which has the
 * output's end, when it can't be kept there. Both are opened through the symlink guard, so a link
 * or a named pipe the check left in place of its output is refused, not followed or waited on.
 */
const keepOutput = (worktree: string, name: string) =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const worktrees = yield* Worktrees
    const from = join(worktree, runFolder, name)
    const to = join(config.repo, runFolder, fullCheckLogName)
    const kept = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Effect.mapError(
            worktrees.openRunFile(worktree, name, O.RDONLY),
            (error) => new Error(`${from} can't be read: ${error.message}`),
          )
          const target = yield* worktrees.openRunFile(
            config.repo,
            fullCheckLogName,
            O.WRONLY | O.CREAT | O.TRUNC,
          )
          yield* Effect.try({
            try: () => copyTo(source, target),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          })
        }),
      ),
    )
    if (Result.isSuccess(kept)) return to
    const logs = yield* Log
    yield* logs.write(
      detail`the full check's whole output can't be kept in ${to}: ${kept.failure.message}`,
    )
    return join(config.repo, logFile)
  })

/** The log's lines under a failed full check's: the end of its output, indented; none without one. */
const endLines = (end: ReadonlyArray<string>): ReadonlyArray<Line> =>
  end.length === 0 ? [] : [detail`the end of its output:`, ...end.map((each) => detail`  ${each}`)]

/**
 * Says the full check failed with `error`, its whole output `name` in the worktree's .tutti/run/,
 * and files its ticket.
 */
const failed = (
  options: FullCheckOptions,
  at: string,
  ms: number,
  error: CheckError,
  worktree: string,
  name: string,
): Effect.Effect<FullChecked, never, Env> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const logs = yield* Log
    const events = yield* EventStream
    const { base } = options
    const command = config.settings.checks.full.command ?? ""
    const outcome: FullCheckOutcome = error._tag === "CheckTimedOut" ? "timed out" : "failed"
    const end = error._tag === "CheckNotRun" ? [] : error.lastLines.slice(-fullCheckEnd)
    const how = howFailed(error)
    const output = yield* keepOutput(worktree, name)
    if (error.check === "setup") {
      const filed = "no ticket filed: it is not a suite's failure"
      const text = ticketLine(
        Tag.fullCheckFailed,
      )`the setup '${error.command}', run before '${command}', ${how} on ${base} at ${short(at)}; the whole output is in ${output}; ${filed}`
      yield* logs.writeWith(
        [text, ...endLines(end)],
        events.emit({ kind: "full_check", detail: outcome, output, text }),
      )
      return {
        outcome,
        at,
        took: ms,
        setup: error.command,
        output,
        end,
        filed,
        text,
      } satisfies FullChecked
    }
    const suite = (error._tag === "CheckNotRun" ? null : error.suite) ?? command
    const filing = yield* file({ ...options, at, suite, how, output, said: saidOf(error) })
    const text = ticketLine(
      Tag.fullCheckFailed,
    )`'${command}' ${how} on ${base} at ${short(at)}, in the suite ${suite}; the whole output is in ${output}; ${filing.filed}`
    yield* logs.writeWith(
      [text, ...endLines(end)],
      events.emit({
        kind: "full_check",
        detail: outcome,
        suite,
        output,
        ...(filing.ticket === undefined ? {} : { ticket: filing.ticket }),
        text,
      }),
    )
    return { outcome, at, took: ms, suite, output, end, ...filing, text } satisfies FullChecked
  })

/**
 * Files a P2 bug labelled check-full for `suite`, which the full check failed in, with the lines of
 * its output that say what failed, unless one is open for that suite already, whose notes then say
 * it failed again. The ticket, if any, and what became of it, for a line.
 */
const file = (f: {
  readonly base: string
  readonly started: number
  readonly at: string
  readonly suite: string
  readonly how: string
  readonly output: string
  readonly said: ReadonlyArray<string>
}): Effect.Effect<{ readonly ticket?: string; readonly filed: string }, never, Env> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const beads = yield* Beads
    const logs = yield* Log
    const command = config.settings.checks.full.command ?? ""
    const run = dateClock(f.started)
    const where = `on ${f.base} at ${short(f.at)}, ${suiteSaid(f.suite)} of ${run}`
    // A second ticket is easier to close than a failure nobody hears of.
    const open = yield* Effect.result(beads.list({ labels: [fullCheckLabel] }))
    if (Result.isFailure(open)) {
      yield* logs.write(
        detail`bd can't list the open full check tickets: ${beadsWhy(open.failure)}`,
      )
    }
    const filed = Result.isSuccess(open)
      ? open.success.find((issue) => filedForSuite(issue, f.suite))
      : undefined
    if (filed !== undefined) {
      const noted = yield* Effect.result(
        beads.update(filed.id, {
          appendNotes: `tutti: the full check '${command}' ${f.how} again ${where}; the whole output is in ${f.output}.`,
        }),
      )
      if (Result.isFailure(noted)) {
        yield* logs.write(detail`bd can't add a note to ${filed.id}: ${beadsWhy(noted.failure)}`)
      }
      return { ticket: filed.id, filed: `${filed.id} is open for it already` }
    }
    const description =
      `tutti's full check, '${command}' (checks.full.command in .tutti/settings.json), ${f.how} ` +
      `${where}. Its whole output is in ${f.output}, until the next full check fails; the lines ` +
      `that say what failed:\n\n    ${f.said.join("\n    ")}\n\n` +
      `Get the suite passing on ${f.base}, then run '${command}' again.`
    const created = yield* Effect.result(
      beads.create({
        title: fullCheckTitle(f.suite),
        description,
        type: "bug",
        priority: 2,
        labels: [fullCheckLabel],
      }),
    )
    if (Result.isFailure(created)) {
      return { filed: `no ticket filed: bd failed (${beadsWhy(created.failure)})` }
    }
    return { ticket: created.success.id, filed: `filed ${created.success.id}` }
  })
