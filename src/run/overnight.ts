// --overnight's pre-flight (§ 5, § 8.2; tutti-kkb.46): a run left going through the night can stop
// at 1am on something that could have been settled at 11pm. orchestra 0.9.5's --overnight is the
// reference for what is wanted; this is built in tutti's terms.
//
// It runs once the startup checks have passed and the run holds its lock, before the run's services
// are made (src/main.ts), so that a fix made here (concurrent, the permission mode) reaches the
// services that read AppConfig as they are built, and before the start record, which gives the run
// as its fixes left it. Each check passes, warns or fails: a failure is what would stop the run, or
// every merge, in the night; a warning what would slow the night, cost it tickets or leave something
// for the morning. The checklist is printed whole, then in a terminal each fix tutti can make is
// offered one by one, yes first, and, while a failed check is left without its fix, whether to start
// anyway, no first; the fixes taken are made once every answer is in, so that a cancel changes
// nothing. A failed check left refuses the run (exit 2) unless --force-overnight, or that answer,
// starts it. Without a terminal nothing is asked or fixed. The log keeps the checklist and the fixes.
//
// The checks read the machine through Night (main.ts gives the live readings, a test its own) and
// the run's services: Beads, the usage probe, and Git, Worktrees and Checks for the merge check on
// the base's head, which comes last, being the slow one.
import { join, resolve } from "node:path"
import { Clock, Duration, Effect, type FileSystem, Option, Result } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { AccountProbe } from "../agent/Account.ts"
import { UsageProbe } from "../agent/UsageProbe.ts"
import { type AppConfigValue, defaultUsageLimitWait, workerPromptFile } from "../cli/AppConfig.ts"
import { templateNotes } from "../init/templates.ts"
import { updateTemplates } from "../init/update.ts"
import { O } from "../native/libc.ts"
import { duration } from "../print/organLine.ts"
import { formatDuration } from "../project/configFile.ts"
import { loadWorkerPrompt } from "../project/prompt.ts"
import { Beads, type BeadsError, HumanLabel, type Issue, type TicketId } from "../services/Beads.ts"
import { type CheckError, Checks } from "../services/Checks.ts"
import { Git, type GitError, gitWhy, shortHash } from "../services/Git.ts"
import { runFolder, Worktrees } from "../services/Worktrees.ts"
import { marks } from "../ui/marks.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import type { Theme } from "../ui/theme.ts"
import type { BatteryReading } from "./battery.ts"
import { howFailed, saidOf } from "./check.ts"
import { type KeepAwakePlan, lidNote } from "./keepAwake.ts"
import { busyLoad, type Kernel } from "./load.ts"
import { resetLabel } from "./localTime.ts"
import { Log, line } from "./log.ts"
import { type Registration, workersCount } from "./machine.ts"
import {
  gb,
  heaviest,
  joinAnd,
  largeVMs,
  memoryGB,
  type NamedProcess,
  vmMemory,
} from "./processes.ts"
import { descendants, ready } from "./scope.ts"
import type { Started } from "./startup.ts"
import { limitName } from "./usageLimit.ts"

/** What a check found. */
export type Verdict = "passed" | "warned" | "failed"

/** A fix tutti can make for what a check found, for this run only, before it starts. */
export interface Fix {
  /** Asks whether to make it: `Run without a limit?`. */
  readonly question: string
  /** Says it is made: `the run has no ticket limit`. */
  readonly done: string
  /** Makes it: the run as it then starts, or why it couldn't. */
  readonly apply: (started: Started) => Effect.Effect<Started, string, Env>
}

/** What one check found: its verdict, what it found, and its fix, if tutti can make one. */
export interface Found {
  readonly verdict: Verdict
  /** What it found, and for a warning or a failure what to do about it by hand. */
  readonly text: string
  readonly fix?: Fix
}

/** What the checks read of the machine, given by main.ts, or by a test. */
export interface Night {
  readonly platform: NodeJS.Platform
  readonly cores: number
  /** What the run does to keep the machine awake (keepAwake.ts). */
  readonly awake: KeepAwakePlan
  /** The battery as the run started: null for none, undefined for one that can't be read. */
  readonly battery: BatteryReading | null | undefined
  /** The kernel's figures (load.ts); undefined when they can't be read. */
  readonly kernel: Effect.Effect<Kernel | undefined, never, Machine>
  /** The processes by name (processes.ts); undefined when they can't be listed. */
  readonly processes: Effect.Effect<ReadonlyArray<NamedProcess> | undefined, never, Machine>
  /** The free disk where `dir` is, or will be, in bytes, and the folder read (processes.ts). */
  readonly disk: (
    dir: string,
  ) => Effect.Effect<
    { readonly free: number; readonly where: string },
    { readonly where: string; readonly reason: string }
  >
  /** The machine's other tutti and orchestra runs (machine.ts's otherRuns). */
  readonly otherRuns: Effect.Effect<ReadonlyArray<Registration>, never, Machine>
  /**
   * The login probe under `config`, as the startup checks make it (§ 4.13): what Claude Code says
   * of the account and the permission mode it puts in effect; why, where it can't say.
   */
  readonly probeAccount: (config: AppConfigValue) => Effect.Effect<AccountProbe, string, Machine>
}

/** What the live readings run on. */
export type Machine = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

/** The services the checks and the fixes use. */
export type Env = Beads | UsageProbe | Git | Worktrees | Checks | Log | Machine

/** What the pre-flight asks in a terminal: a yes or no, `initial` the answer Enter gives. */
export type Ask = (question: string, initial: boolean) => Effect.Effect<boolean, Cancelled>

/** The question was cancelled (Esc, Ctrl+C or the end of input): nothing changes. */
export interface Cancelled {
  readonly _tag: "FormCancelled"
}

/** How the pre-flight ended. */
export type Cleared =
  /** The run starts, as its fixes left it. */
  | { readonly _tag: "Cleared"; readonly started: Started }
  /** A failed check was left: the run doesn't start, exit 2. */
  | { readonly _tag: "Refused"; readonly failed: number }
  /** A question was cancelled: the run doesn't start, nothing changed, exit 130. */
  | { readonly _tag: "Cancelled" }

/** Where the checklist and what the pre-flight says go. */
export interface Say {
  /** Prints whole lines. */
  readonly print: (text: string) => Effect.Effect<void>
  /** An organ's line: `◆ text`. */
  readonly say: (text: string) => Effect.Effect<void>
  /** A warning: `◆ text` in the notice colour. */
  readonly warn: (text: string) => Effect.Effect<void>
  /** A slow step's spinner, ended by `done`. */
  readonly organ: (text: string) => Effect.Effect<{
    readonly done: (text: string) => Effect.Effect<void>
  }>
  /** The styles the checklist's marks are drawn in. */
  readonly theme: Theme
}

/** The ticket limit the pre-flight offers a run without one. */
export const overnightTicketLimit: Duration.Duration = Duration.hours(2)

/** How long the account's session limit takes to reset: a shorter wait would stop the run. */
export const sessionLimit: Duration.Duration = Duration.hours(5)

/** The permission modes in which a worker doesn't stop to ask before a tool. */
export const neverAsks: ReadonlyArray<string> = [
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
]

/** The file in the main checkout's .tutti/run/ that keeps the merge check's output on the base. */
export const baseCheckLogName = "check-base.log"

/** How the merge check's worktree's folder name starts, under the worktrees' folder. */
export const baseCheckFolderPrefix = "check-base-"

/** The message of the commit that brings the worker prompt and the verifier up to date. */
export const updateTemplatesMessage =
  "Bring the worker prompt and the verifier up to date with tutti's templates\n\ntutti --overnight's pre-flight ran what tutti init --update does, as answered."

const passed = (text: string): Found => ({ verdict: "passed", text })
const warned = (text: string, fix?: Fix): Found => ({
  verdict: "warned",
  text,
  ...(fix === undefined ? {} : { fix }),
})
const failed = (text: string, fix?: Fix): Found => ({
  verdict: "failed",
  text,
  ...(fix === undefined ? {} : { fix }),
})

/** `1 ticket` or `<n> tickets`. */
export const ticketCount = (n: number): string => (n === 1 ? "1 ticket" : `${n} tickets`)

/** `1 check failed` or `<n> checks failed`. */
export const checksFailed = (n: number): string =>
  n === 1 ? "1 check failed" : `${n} checks failed`

/** `text` on one line, its runs of white space each a space. */
const oneLine = (text: string): string => sanitizeLine(text.split(/\s+/).join(" ").trim())

/** `started` with `config` changed by `change`. */
const withConfig = (
  started: Started,
  change: (config: AppConfigValue) => AppConfigValue,
): Started => ({ ...started, config: change(started.config) })

// ---------------------------------------------------------------------------------------------
// The checks, in the checklist's order.

/** A ticket limit (--limit) would stop the run early: it fails, and offers to run without one. */
export const limitCheck = (config: AppConfigValue): Found =>
  config.limit === null
    ? passed("no ticket limit")
    : failed(
        `--limit ${config.limit} is set: the run would stop after ${ticketCount(config.limit)}`,
        {
          question: "Run without a limit?",
          done: "the run has no ticket limit",
          apply: (started) => Effect.succeed(withConfig(started, (c) => ({ ...c, limit: null }))),
        },
      )

/**
 * How many tickets at a time the concurrency check offers on a machine of `cores` cores whose runs
 * may have `machineWorkers` workers between them (0 for no cap): one for each 4 cores, from 2 to 4,
 * within the cap; a cap under 2 leaves fewer, which is no fix.
 */
export const offeredConcurrency = (cores: number, machineWorkers: number): number => {
  const n = Math.min(Math.max(Math.floor(cores / 4), 2), 4)
  return machineWorkers > 0 ? Math.min(n, machineWorkers) : n
}

/** One ticket at a time, where one slow ticket holds up the night: it fails, and offers more. */
export const concurrencyCheck = (config: AppConfigValue, cores: number): Found => {
  const concurrent = config.settings.concurrent
  if (concurrent >= 2) return passed(`${ticketCount(concurrent)} at a time`)
  const n = offeredConcurrency(cores, config.machineWorkers)
  const text = `${ticketCount(concurrent)} at a time (concurrent in .tutti/settings.json, --concurrent): one slow ticket would hold up the night`
  // A cap on the machine's workers under 2 leaves nothing to offer.
  if (n < 2) {
    return failed(`${text}, and --machine-workers ${config.machineWorkers} allows no more`)
  }
  return failed(text, {
    question: `Run ${ticketCount(n)} at a time?`,
    done: `the run works on ${ticketCount(n)} at a time`,
    apply: (started) =>
      Effect.succeed(
        withConfig(started, (c) => ({ ...c, settings: { ...c.settings, concurrent: n } })),
      ),
  })
}

/**
 * Workers in a permission mode that asks would wait on a prompt, with nobody to answer it: it fails,
 * and offers auto, where the mode asked for is default; where auto isn't in effect though asked
 * for, there is nothing tutti can do. The fix asks Claude Code again, with `probe`, which mode it
 * puts in effect once auto is asked for: one where auto isn't available fixes nothing.
 */
export const permissionCheck = (account: AccountProbe, probe: Night["probeAccount"]): Found => {
  const { requested, inEffect } = account.permissionMode
  if (neverAsks.includes(inEffect)) {
    return passed(`workers start in ${inEffect} permission mode, which doesn't stop to ask`)
  }
  const asks = `workers start in ${inEffect} permission mode, whose permission prompts wait for someone: a worker would wait on one all night`
  if (requested !== "default") {
    return failed(`${asks} (${requested} mode isn't available here)`)
  }
  return failed(`${asks} (workers.permission_mode in .tutti/settings.json)`, {
    question: "Start workers in auto permission mode?",
    done: "workers start in auto permission mode",
    apply: (started) =>
      Effect.gen(function* () {
        const fixed = withConfig(started, (c) => ({
          ...c,
          settings: { ...c.settings, workers: { ...c.settings.workers, permission_mode: "auto" } },
        }))
        const probed = yield* probe(fixed.config).pipe(
          Effect.mapError((why) => `Claude Code couldn't say which mode it puts in effect: ${why}`),
        )
        const { inEffect } = probed.permissionMode
        if (!neverAsks.includes(inEffect)) {
          return yield* Effect.fail(
            `workers would still start in ${inEffect} permission mode: auto mode isn't available here`,
          )
        }
        return { ...fixed, account: probed }
      }),
  })
}

/**
 * Claude Code logged in: the startup checks refuse to start the run without it, so it passes here,
 * with the account, for the checklist to be complete.
 */
export const loginCheck = (account: AccountProbe): Found => {
  const who = [account.account.email, account.account.subscriptionType].filter(
    (each): each is string => each !== null,
  )
  return passed(`claude is logged in${who.length === 0 ? "" : ` (${who.join(", ")})`}`)
}

/**
 * What the pre-flight says of the account at its usage limit at `now`: `limit`, reset at `resetsAt`
 * where Claude Code said, and whether the run, waiting `wait` for it, would stop first.
 */
export const limitedNow = (
  limit: string | null,
  resetsAt: number | null,
  wait: Duration.Duration,
  now: number,
): string => {
  const text = `the account is at its ${limitName(limit)} limit now: no ticket starts until it resets`
  if (resetsAt === null) return text
  const minutes = Math.max(Math.round((resetsAt - now) / 60_000), 0)
  const after =
    resetsAt > now + Duration.toMillis(wait)
      ? `, after the run's wait for it (--usage-limit-wait ${formatDuration(wait)}) runs out: the run would stop`
      : ""
  return `${text}, at ${resetLabel(resetsAt, now)}, in ${formatDuration(Duration.minutes(minutes))}${after}`
}

/**
 * The account at its usage limit now, as the smallest call at the workers' model answers: a warning,
 * saying when it resets.
 */
export const usageNowCheck = (config: AppConfigValue) =>
  Effect.gen(function* () {
    const probe = yield* UsageProbe
    const answer = yield* probe.probe(null, config.settings.workers.model)
    switch (answer._tag) {
      case "Allowed":
        return passed("the account isn't at its usage limit now")
      case "Unanswered":
        return warned(
          `tutti couldn't tell whether the account is at its usage limit now: ${oneLine(answer.reason)}`,
        )
      case "Refused":
        return warned(
          limitedNow(
            answer.limit,
            answer.resetsAt,
            config.usageLimitWait,
            yield* Clock.currentTimeMillis,
          ),
        )
    }
  })

/** A wait for the usage limit shorter than the session limit's: a warning, offering 6h. */
export const usageWaitCheck = (config: AppConfigValue): Found => {
  const wait = config.usageLimitWait
  if (Duration.isGreaterThanOrEqualTo(wait, sessionLimit)) {
    return passed(
      `the run waits up to ${formatDuration(wait)} for the account's usage limit to reset`,
    )
  }
  const six = formatDuration(defaultUsageLimitWait)
  return warned(
    Duration.isZero(wait)
      ? "--usage-limit-wait is 0: the account's usage limit, reached in the night, would stop the run"
      : `--usage-limit-wait is ${formatDuration(wait)}, under the ${formatDuration(sessionLimit)} the session limit takes to reset: the limit, reached in the night, would stop the run`,
    {
      question: `Wait up to ${six} for the usage limit to reset?`,
      done: `the run waits up to ${six} for the usage limit to reset`,
      apply: (started) =>
        Effect.succeed(
          withConfig(started, (c) => ({ ...c, usageLimitWait: defaultUsageLimitWait })),
        ),
    },
  )
}

/** No ticket time limit, where a hung worker holds its slot all night: a warning, offering 2h. */
export const ticketLimitCheck = (config: AppConfigValue): Found => {
  const limit = config.settings.workers.ticket_limit
  if (limit !== null) return passed(`each ticket's worker has ${formatDuration(limit)}`)
  const two = formatDuration(overnightTicketLimit)
  return warned(
    "no ticket time limit (--ticket-limit, workers.ticket_limit in .tutti/settings.json): a hung worker would hold its slot all night",
    {
      question: `Give each ticket's worker ${two}?`,
      done: `each ticket's worker has ${two}`,
      apply: (started) =>
        Effect.succeed(
          withConfig(started, (c) => ({
            ...c,
            settings: {
              ...c.settings,
              workers: { ...c.settings.workers, ticket_limit: overnightTicketLimit },
            },
          })),
        ),
    },
  )
}

/**
 * The machine kept awake: --keep-awake turned off fails, as the night's merge checks time out while
 * the Mac sleeps; where tutti can't keep it awake, a warning to set it not to sleep.
 */
export const keepAwakeCheck = (config: AppConfigValue, awake: KeepAwakePlan): Found => {
  if (!config.keepAwake) {
    return failed(
      "--keep-awake is off: the machine would sleep in the night, and the run with it, its merge checks timing out",
    )
  }
  switch (awake._tag) {
    case "Command":
      return passed(`the machine is kept awake while the run goes (${awake.command.command})`)
    case "Missing":
      return warned(awake.warning)
    case "Off":
      // --keep-awake on gives a command or says why it can't.
      return passed("the machine is kept awake while the run goes")
  }
}

/** Too little free disk where the worktrees go, each holding its own dependencies, fails. */
export const diskCheck = (config: AppConfigValue, night: Night) =>
  Effect.gen(function* () {
    const want = config.overnightFreeDisk
    if (want === 0) return passed("free disk isn't checked (--overnight-free-disk 0)")
    const read = yield* Effect.result(night.disk(config.worktrees))
    if (Result.isFailure(read)) {
      return warned(
        `tutti couldn't tell how much disk is free in ${read.failure.where}: ${oneLine(read.failure.reason)}`,
      )
    }
    const free = Math.floor(read.success.free / gb)
    if (read.success.free < want * gb) {
      return failed(
        `${free} GB free in ${read.success.where}, where the worktrees go, under the ${want} GB an overnight run wants (--overnight-free-disk): each worktree holds its own dependencies, and a full disk would stop the run. Free some space`,
      )
    }
    return passed(`${free} GB free where the worktrees go, ${want} GB wanted`)
  })

/** Another run on the machine, whose workers and checks share it all night: a warning. */
export const otherRunsCheck = (runs: ReadonlyArray<Registration>): Found => {
  if (runs.length === 0) return passed("no other tutti or orchestra run on the machine")
  const named = runs.map(
    (reg) =>
      `a ${reg.tool} run in ${reg.repo} (PID ${reg.pid}, ${workersCount(reg.running)} running, ${ticketCount(reg.concurrent)} at a time)`,
  )
  return warned(
    `${runs.length === 1 ? "another run is" : `${runs.length} other runs are`} going on the machine, ${joinAnd(named)}: their workers and checks share the machine with the run's, and slow each other down`,
  )
}

/**
 * A machine already busy: a 1-minute load past busyLoad per core, or memory pressure at warn or
 * worse, naming the 3 processes using the most: a warning.
 */
export const loadCheck = (
  kernel: Kernel | undefined,
  processes: ReadonlyArray<NamedProcess> | undefined,
): Found => {
  if (kernel === undefined) return warned("tutti couldn't read the machine's load")
  const busy = kernel.cores > 0 && kernel.load1 > busyLoad * kernel.cores
  const pressed = kernel.pressure === "warn" || kernel.pressure === "critical"
  const figures = [
    ...(kernel.load1 >= 0 && kernel.cores > 0
      ? [`a load of ${kernel.load1.toFixed(1)} on ${kernel.cores} cores`]
      : []),
    ...(kernel.pressure === "unknown" ? [] : [`memory pressure ${kernel.pressure}`]),
  ].join(", ")
  if (!busy && !pressed) {
    return passed(`the machine isn't busy${figures === "" ? "" : `: ${figures}`}`)
  }
  const found: Array<string> = []
  const all = processes ?? []
  if (busy) {
    const top = heaviest(
      all,
      3,
      (p) => p.cpu,
      (p) => `${p.name} ${p.cpu.toFixed(0)}%`,
    )
    found.push(
      `the machine is busy, ${figures}${top.length === 0 ? "" : ` (most of it ${joinAnd(top)})`}`,
    )
  }
  if (pressed) {
    const top = heaviest(
      all,
      3,
      (p) => p.memory,
      (p) => `${p.name} ${memoryGB(p.memory)}`,
    )
    found.push(
      `memory is short (the kernel's memory pressure is ${kernel.pressure})${top.length === 0 ? "" : `, most of it held by ${joinAnd(top)}`}`,
    )
  }
  return warned(
    `${found.join("; ")}: the workers and their checks would run slowly. Quit what the run doesn't need`,
  )
}

/** A virtual machine holding over 4 GB, which the workers and their checks go without: a warning. */
export const vmCheck = (processes: ReadonlyArray<NamedProcess> | undefined): Found => {
  if (processes === undefined) {
    return warned("tutti couldn't list the machine's processes for a large virtual machine")
  }
  const vms = largeVMs(processes)
  if (vms.length === 0) {
    return passed(`no virtual machine holds more than ${memoryGB(vmMemory)} of memory`)
  }
  return warned(
    `${vms.join("; ")}: the workers and their checks get only what it leaves. Stop it, or give it less memory, if the run doesn't need it`,
  )
}

/** On battery, it would run flat or sleep in the night: a warning, with the lid's note. */
export const batteryCheck = (
  battery: BatteryReading | null | undefined,
  platform: NodeJS.Platform,
): Found => {
  if (battery === undefined) {
    return warned(
      "tutti couldn't tell whether the machine runs on battery: plug it in for the night",
    )
  }
  if (battery === null) return passed("the machine has no battery")
  if (!battery.discharging) return passed(`the machine is plugged in (${battery.level}%)`)
  const lid = lidNote(platform)
  return warned(
    `on battery (${battery.level}%): plug it in, or the run goes only as long as the battery${lid === null ? "" : `; ${lid}`}`,
  )
}

/**
 * Brings the worker prompt and the verifier up to date as tutti init --update does and commits what
 * changed on the branch the main checkout has checked out, the run's base: the run won't start on
 * uncommitted changes, and its workers then follow the prompt committed, read again.
 */
export const updateAndCommit = (started: Started): Effect.Effect<Started, string, Env> =>
  Effect.gen(function* () {
    const { config } = started
    const git = yield* Git
    // The START block's notes of them, which the update takes.
    const own = config.prompt !== resolve(config.repo, workerPromptFile)
    const notes = new Set(yield* templateNotes(config.repo, config.settings.templates, !own))
    const updated = yield* updateTemplates(config.repo).pipe(
      Effect.mapError((error) => oneLine(error.message)),
    )
    const paths = [...new Set(updated.steps.flatMap((step) => step.commit ?? []))]
    // Those git tracks and that changed: an ignored file is up to date, with nothing to commit.
    const changed =
      paths.length === 0
        ? []
        : (yield* git.status(config.repo, paths).pipe(Effect.mapError(gitWhy)))
            .filter((entry) => entry.code !== "??")
            .map((entry) => entry.path)
    if (changed.length > 0) {
      yield* git
        .commitPaths(config.repo, updateTemplatesMessage, changed)
        .pipe(Effect.mapError((error: GitError) => `committing them failed: ${gitWhy(error)}`))
    }
    const prompt = yield* loadWorkerPrompt(config).pipe(
      Effect.mapError(
        (error) =>
          `committed, but the worker prompt could not be read again, so the run gives its workers the one it read before: ${oneLine(error.message)}`,
      ),
    )
    return {
      ...started,
      prompt,
      warnings: started.warnings.filter((warning) => !notes.has(warning)),
    }
  })

/**
 * The worker prompt or verifier older than tutti's templates, which the workers would follow all
 * night: a warning, offering to bring them up to date and commit that.
 */
export const templatesCheck = (started: Started) =>
  Effect.gen(function* () {
    const { config, base } = started
    const own = config.prompt !== resolve(config.repo, workerPromptFile)
    const notes = yield* templateNotes(config.repo, config.settings.templates, !own)
    if (notes.length === 0) {
      return passed(
        own
          ? "the verifier is up to date with tutti's templates; the worker prompt is the run's own (--prompt)"
          : "the worker prompt and the verifier are up to date with tutti's templates",
      )
    }
    return warned(notes.map((note) => note.replace(/^templates: /, "")).join("; "), {
      question: `Bring them up to date as tutti init --update does, and commit that on ${base}?`,
      done: `the worker prompt and the verifier are up to date with tutti's templates, committed on ${base} (git show reads the change)`,
      apply: updateAndCommit,
    })
  })

/**
 * Whether `ticket`, as bd show gives it, is one the run would take but waits on its blockers, each
 * not closed an open question.
 */
export const waitsOnlyOnQuestions = (ticket: Issue): boolean => {
  if (
    (ticket.status !== "open" && ticket.status !== "blocked") ||
    ticket.labels.includes(HumanLabel)
  ) {
    return false
  }
  let waits = false
  for (const dependency of ticket.dependencies) {
    if (dependency.type !== "blocks" || dependency.issue?.status === "closed") continue
    if (dependency.issue?.labels.includes(HumanLabel) !== true) return false
    waits = true
  }
  return waits
}

/** How many tickets in `scope` (null: all) wait only on open questions. */
export const waitingOnQuestions = (
  scope: TicketId | null,
): Effect.Effect<number, BeadsError, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const questions = yield* beads.questions()
    const inScope =
      scope === null
        ? null
        : new Set([scope, ...(yield* descendants(beads, scope)).map((issue) => issue.id)])
    const seen = new Set<TicketId>()
    let n = 0
    for (const question of questions) {
      const shown = yield* beads.show(question.id, { dependents: true })
      for (const dependent of shown.dependents ?? []) {
        if (dependent.type !== "blocks" || seen.has(dependent.id)) continue
        if (inScope !== null && !inScope.has(dependent.id)) continue
        seen.add(dependent.id)
        const ticket = yield* Effect.result(beads.show(dependent.id))
        if (Result.isFailure(ticket)) {
          // A ticket deleted meanwhile waits on nothing.
          if (ticket.failure._tag === "BeadsFailed" && ticket.failure.noSuchIssue) continue
          return yield* Effect.fail(ticket.failure)
        }
        if (waitsOnlyOnQuestions(ticket.success)) n++
      }
    }
    return n
  })

/** What a failed read of bd says. */
const beadsWhy = (error: BeadsError): string =>
  error._tag === "BeadsFailed"
    ? oneLine(error.stderr.split("\n")[0] || `exit code ${error.exitCode}`)
    : error._tag === "BeadsTimedOut"
      ? `bd took longer than ${formatDuration(error.timeLimit)}`
      : oneLine(error.reason)

/**
 * How many tickets in the run's scope are ready, and how many more wait only on open questions: a
 * warning where none is ready, the run then ending at once.
 */
export const readyCheck = (config: AppConfigValue) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const filter = { excludeTypes: config.settings.queue.exclude_types }
    const found = yield* Effect.result(ready(beads, config.ticket, filter))
    if (Result.isFailure(found)) {
      return warned(`tutti couldn't read which tickets are ready: ${beadsWhy(found.failure)}`)
    }
    const n = found.success.length
    const waiting = yield* Effect.result(waitingOnQuestions(config.ticket))
    if (Result.isFailure(waiting)) {
      return warned(
        `${ticketCount(n)} ${n === 1 ? "is" : "are"} ready; tutti couldn't read which wait on questions: ${beadsWhy(waiting.failure)}`,
      )
    }
    const w = waiting.success
    const more =
      w === 0
        ? ""
        : `, and ${w} more ${w === 1 ? "waits" : "wait"} only on questions, to be ready once ${w === 1 ? "it is" : "they are"} answered`
    if (n > 0) return passed(`${ticketCount(n)} ${n === 1 ? "is" : "are"} ready${more}`)
    return warned(
      w === 0
        ? "no ticket is ready: with nothing to work on, the run would end at once"
        : `no ticket is ready${more}: unless they are answered first (tutti answer), the run would end at once`,
    )
  })

/** What the merge check on the base said of its failure, for the checklist: its first 3 lines. */
const saidShort = (error: CheckError): string => {
  const said = saidOf(error)
    .map((each) => oneLine(each))
    .filter((each) => each !== "")
    .slice(0, 3)
  return said.length === 0 ? "" : `: ${said.join("; ")}`
}

/**
 * The merge check failing on the base's head, where every merge would fail too: run once in a
 * worktree of its own on the head, the setup first, within the merge check's time limit, its whole
 * output in the main checkout's .tutti/run/check-base.log. It fails where the check fails there.
 */
export const baseCheck = (started: Started, say: Say) =>
  Effect.gen(function* () {
    const { config, base } = started
    const command = config.settings.checks.fast.command
    if (command === null) {
      return passed(`no merge check (checks.fast.command) to run on ${base}`)
    }
    const git = yield* Git
    const worktrees = yield* Worktrees
    const checks = yield* Checks
    const logs = yield* Log
    const busy = yield* say.organ(`Running the merge check on ${base}…`)
    const ended = (found: Found) => Effect.as(busy.done(`Ran the merge check on ${base}`), found)
    // The worktrees a pre-flight stopped while its check ran (kill -9) left behind.
    const left = yield* Effect.result(worktrees.leftDetached(baseCheckFolderPrefix))
    if (Result.isSuccess(left)) {
      for (const path of left.success) yield* Effect.ignore(worktrees.removeDetached(path))
    }
    const head = yield* Effect.result(git.revParse(config.repo, base))
    if (Result.isFailure(head)) {
      return yield* ended(
        failed(`the merge check '${command}' couldn't run on ${base}: ${gitWhy(head.failure)}`),
      )
    }
    const at = shortHash(head.success)
    const made = yield* Effect.result(worktrees.addDetached(baseCheckFolderPrefix, head.success))
    if (Result.isFailure(made)) {
      const error = made.failure
      const why =
        error._tag === "GitFailed" || error._tag === "GitTimedOut" ? gitWhy(error) : error.message
      return yield* ended(
        failed(`the merge check '${command}' couldn't run on ${base}: no worktree for it (${why})`),
      )
    }
    const path = made.success
    const outputFile = join(config.repo, runFolder, baseCheckLogName)
    const began = yield* Clock.currentTimeMillis
    const ran = Effect.scoped(
      Effect.gen(function* () {
        const fd = yield* worktrees.openRunFile(
          config.repo,
          baseCheckLogName,
          O.WRONLY | O.CREAT | O.TRUNC,
        )
        const to = { cwd: path, outputFile, outputFd: fd }
        const setup = config.settings.checks.setup.command
        if (setup !== null) {
          const set = yield* Effect.result(checks.setup({ ...to, before: "fast" }))
          if (Result.isFailure(set)) return { what: `the setup '${setup}'`, error: set.failure }
        }
        const checked = yield* Effect.result(checks.fast(to))
        return Result.isFailure(checked)
          ? { what: `the merge check '${command}'`, error: checked.failure }
          : null
      }),
    )
    const outcome = yield* Effect.result(ran).pipe(
      Effect.ensuring(
        Effect.catch(worktrees.removeDetached(path), (error) =>
          logs.write(
            line`overnight pre-flight: the merge check's worktree ${path} is left (${error.message}); git worktree remove --force ${path} removes it`,
          ),
        ),
      ),
    )
    if (Result.isFailure(outcome)) {
      return yield* ended(
        failed(
          `the merge check '${command}' couldn't run on ${base}: its output can't be kept in ${outputFile} (${outcome.failure.message})`,
        ),
      )
    }
    const took = duration((yield* Clock.currentTimeMillis) - began)
    if (outcome.success === null) {
      return yield* ended(
        passed(`the merge check '${command}' passes on ${base} at ${at} (${took})`),
      )
    }
    const { what, error } = outcome.success
    return yield* ended(
      failed(
        `${what} ${howFailed(error)} on ${base} at ${at}, so every ticket's merge would fail${saidShort(error)} (the whole output: ${outputFile}). Fix it on ${base} first`,
      ),
    )
  })

/** Every check of the pre-flight, in the checklist's order, the merge check on the base last. */
export const checks = (started: Started, night: Night, say: Say) =>
  Effect.gen(function* () {
    const { config, account } = started
    const usage = yield* say.organ("Asking the account whether it is at its usage limit…")
    const usageNow = yield* usageNowCheck(config)
    yield* usage.done("Asked the account whether it is at its usage limit")
    const processes = yield* night.processes
    return [
      limitCheck(config),
      concurrencyCheck(config, night.cores),
      permissionCheck(account, night.probeAccount),
      loginCheck(account),
      usageNow,
      usageWaitCheck(config),
      ticketLimitCheck(config),
      keepAwakeCheck(config, night.awake),
      yield* diskCheck(config, night),
      otherRunsCheck(yield* night.otherRuns),
      loadCheck(yield* night.kernel, processes),
      vmCheck(processes),
      batteryCheck(night.battery, night.platform),
      yield* templatesCheck(started),
      yield* readyCheck(config),
      yield* baseCheck(started, say),
    ] satisfies ReadonlyArray<Found>
  })

// ---------------------------------------------------------------------------------------------
// The checklist, the fixes and the refusal.

/** The checklist's first line: `Overnight pre-flight: 1 failed, 2 warnings, 8 passed`. */
export const headline = (found: ReadonlyArray<Found>): string => {
  const count = (verdict: Verdict) => found.filter((each) => each.verdict === verdict).length
  const [f, w, p] = [count("failed"), count("warned"), count("passed")]
  return `Overnight pre-flight: ${[
    ...(f > 0 ? [`${f} failed`] : []),
    ...(w > 0 ? [`${w} ${w === 1 ? "warning" : "warnings"}`] : []),
    ...(p > 0 ? [`${p} passed`] : []),
  ].join(", ")}`
}

/** The mark of a verdict: ✓, ! or ✗. */
export const markOf = (verdict: Verdict): string =>
  verdict === "passed" ? marks.done : verdict === "warned" ? marks.caution : marks.missing

/** A check's line of the checklist, in `theme`: `  ✓ no ticket limit`. */
export const checklistLine = (found: Found, theme: Theme): string => {
  const { closed, deferred, stop, say } = theme.styles
  const mark = markOf(found.verdict)
  const painted =
    found.verdict === "passed"
      ? closed.paint(mark)
      : found.verdict === "warned"
        ? deferred.paint(mark)
        : stop.paint(mark)
  return `  ${painted} ${say.paint(sanitizeLine(found.text))}`
}

/** The log's line for a check: `overnight pre-flight: failed: --limit 10 is set: …`. */
export const logLine = (found: Found) => line`overnight pre-flight: ${found.verdict}: ${found.text}`

/** What a run refused by its pre-flight says on stderr. */
export const refusal = (failedLeft: number): string =>
  `tutti --overnight cannot start: ${checksFailed(failedLeft)}. Fix what the checklist says, or start anyway with --force-overnight.`

/**
 * The pre-flight of the overnight run `started`: its checks, their checklist printed through `say`
 * and written to the log, then, with `ask` (a terminal), each fix offered and, while a failed check
 * is left, whether to start anyway; the fixes taken made once every answer is in. A failed check
 * left refuses the run unless `force` (--force-overnight) or the answer starts it.
 */
export const preflight = (options: {
  readonly started: Started
  readonly night: Night
  readonly say: Say
  readonly ask: Option.Option<Ask>
  readonly force: boolean
}): Effect.Effect<Cleared, never, Env> =>
  Effect.gen(function* () {
    const { night, say, force } = options
    const logs = yield* Log
    const found = yield* checks(options.started, night, say)
    yield* say.say(headline(found))
    yield* say.print(found.map((each) => checklistLine(each, say.theme)).join("\n"))
    yield* logs.write(
      line`overnight pre-flight: ${headline(found).replace(/^Overnight pre-flight: /, "")}`,
      ...found.map(logLine),
    )

    // The answers first, so that a cancel changes nothing.
    const taken: Array<Found & { readonly fix: Fix }> = []
    let startAnyway = false
    if (Option.isSome(options.ask)) {
      const ask = options.ask.value
      for (const each of found) {
        if (each.fix === undefined) continue
        const yes = yield* Effect.result(ask(each.fix.question, true))
        if (Result.isFailure(yes)) return { _tag: "Cancelled" } as const
        if (yes.success) taken.push(each as Found & { readonly fix: Fix })
      }
      const left = found.filter(
        (each) => each.verdict === "failed" && !taken.includes(each as never),
      ).length
      if (left > 0 && !force) {
        const yes = yield* Effect.result(
          ask(`Start the run anyway, with ${checksFailed(left)}?`, false),
        )
        if (Result.isFailure(yes)) return { _tag: "Cancelled" } as const
        startAnyway = yes.success
      }
    }

    let started = options.started
    const fixed = new Set<Found>()
    for (const each of taken) {
      const made = yield* Effect.result(each.fix.apply(started))
      if (Result.isSuccess(made)) {
        started = made.success
        fixed.add(each)
        yield* say.say(`Fixed: ${each.fix.done}`)
        yield* logs.write(line`overnight pre-flight: fixed: ${each.fix.done}`)
      } else {
        const text = `overnight pre-flight: couldn't fix ${oneLine(each.text)}: ${made.failure}`
        yield* say.warn(text)
        yield* logs.write(line`${text}`)
      }
    }

    const left = found.filter((each) => each.verdict === "failed" && !fixed.has(each)).length
    if (left === 0) return { _tag: "Cleared", started } as const
    if (force || startAnyway) {
      const text = `overnight pre-flight: starting with ${checksFailed(left)} (${force ? "--force-overnight" : "as answered"})`
      yield* say.warn(text)
      yield* logs.write(line`${text}`)
      return { _tag: "Cleared", started } as const
    }
    yield* logs.write(line`overnight pre-flight: ${checksFailed(left)}: the run doesn't start`)
    return { _tag: "Refused", failed: left } as const
  })
