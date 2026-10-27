// The startup checks (§ 5 item 1): everything a run needs before it takes the run lock, each
// problem collected so that they are all reported at once, and the run exits 2. A repository
// `tutti init` hasn't set up says so first, in place of the problems that init fixes. In § 5's
// order: git, 2.38 or later; the git repository and its main checkout, on a branch; a clean tree; bd and the Beads
// database, and the ticket --ticket names (open, and work rather than a question); the login probe
// (§ 4.13); organs' provider (§ 6.1); the settings, flags, variables and user config; the MCP names
// (§ 4.6); the worker prompt (§ 4.11). A run that starts notes the project's worker prompt and
// verifier where they are older than tutti's templates (src/init/templates.ts), and README_STALE
// where the README's section on what to install differs from the requires list
// (src/project/requires.ts).
//
// orchestra's run state names workers it left behind, which tutti doesn't adopt (§ 11): a warning,
// not a problem. A run that passes gets what the checks resolved, and its START block from them.
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import { Cause, Effect, Exit, FileSystem, Layer, Option, Result, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { Account, type AccountProbe, billingLine, permissionModeLine } from "../agent/Account.ts"
import { type Claude, resolveClaude } from "../agent/claudeBinary.ts"
import { type ChosenServers, chromeServer, resolveServers } from "../agent/mcp.ts"
import {
  AppConfig,
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  load,
  resolve,
  SetupProblem,
  workerPromptFile,
} from "../cli/AppConfig.ts"
import { noFlags, type RunFlags } from "../cli/flags.ts"
import { templateNotes } from "../init/templates.ts"
import { type OrganProvider, organProvider } from "../organs/AnthropicProvider.ts"
import { formatDuration } from "../project/configFile.ts"
import { loadWorkerPrompt, type WorkerPrompt } from "../project/prompt.ts"
import { readmeStaleLine } from "../project/requires.ts"
import { retiredIn, settingsFile } from "../project/settings.ts"
import { Beads, type BeadsError, HumanLabel, type TicketId } from "../services/Beads.ts"
import { Git, gitTooOld } from "../services/Git.ts"
import { checkoutChanges } from "../services/gitStatus.ts"
import { lenientKey } from "../services/lenient.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { schemeNotices } from "../ui/theme.ts"
import { autoAnswerName } from "./autoAnswer.ts"
import { keepAwakeNotes } from "./keepAwake.ts"
import { type Line, start, Tag } from "./log.ts"
import { aboveCapNote, machineWorkersLabel } from "./machine.ts"
import { readSpec, type Spec } from "./spec.ts"
import type { LiveFetch, SpecFetch } from "./specSource.ts"

/** The exit code of a run that can't start: a setup problem. */
export const exitSetup = 2

/** What a run says first in a repository `tutti init` hasn't set up, before its other problems. */
export const notSetUpMessage =
  "tutti isn't set up in this repository yet. Run this first:\n" +
  "  tutti init\n" +
  "It writes .tutti/ (the worker prompt and settings) and sets up Beads if needed."

/** orchestra's run state in the main checkout, naming the workers it left behind (§ 11). */
export const orchestraStateFile = join(".orchestra", "run", "state.json")

/** How much memory a worker's session takes, about (§ 15.2). */
export const memoryPerWorkerGiB = 1

/** The run can't start: every problem found, and whether the repository wasn't set up. */
export class StartupFailed extends Schema.TaggedError<StartupFailed>()("StartupFailed", {
  /** `tutti init` hasn't set the repository up: notSetUpMessage comes first. */
  notSetUp: Schema.Boolean,
  problems: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return report(this)
  }
}

/** What the startup checks resolved, for the run. */
export interface Started {
  readonly config: AppConfigValue
  /** The branch the main checkout is on, where finished tickets land. */
  readonly base: string
  readonly prompt: WorkerPrompt
  readonly mcp: ChosenServers
  readonly account: AccountProbe
  /**
   * The provider organs use, read once from tutti's environment (TUTTI_ORGAN_PROVIDER): the
   * Anthropic one with the ANTHROPIC_API_KEY it bills, redacted.
   */
  readonly organs: OrganProvider
  /** The spec a spec run builds (--spec), read and checked; none for none. */
  readonly spec?: Spec | null
  /** What the run says once as it starts, but doesn't stop it. */
  readonly warnings: ReadonlyArray<string>
}

/** What the checks read through, besides Git and the file system. */
export interface Checking<R> {
  /** The folder tutti was started in. */
  readonly cwd: string
  /** tutti's environment, where TUTTI_ORGAN_PROVIDER chooses organs' provider. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The configuration of a run in the main checkout `repo`: AppConfig.load under the flags. */
  readonly config: (repo: string) => Effect.Effect<AppConfigValue, SetupProblem, R>
  /** bd in the main checkout `repo`. */
  readonly beads: (repo: string) => Layer.Layer<Beads, never, R>
  /** The Claude Code sessions run, from --claude as given (claudeBinary.ts). */
  readonly claude: (given: string | null) => Effect.Effect<Claude, never, R>
  /** The login probe, under the run's configuration. */
  readonly account: Layer.Layer<Account, never, AppConfig | R>
  /** Files a spec run's setup wrote, which its run commits with the spec: no clean-tree problem. */
  readonly uncommitted?: ReadonlyArray<string>
  /** Fetches a spec at a URL: the run's one fetch, which its setup shares (fetchOnce). */
  readonly fetch?: SpecFetch<LiveFetch>
}

/** The report of a run that can't start, for stderr: the not-set-up message first. */
export const report = (failed: {
  readonly notSetUp: boolean
  readonly problems: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
}): string => {
  const lines: Array<string> = []
  if (failed.notSetUp) lines.push(notSetUpMessage)
  if (failed.problems.length > 0) {
    lines.push(failed.notSetUp ? "\nAlso fix before a run:" : "tutti cannot start:")
    lines.push(...failed.problems.map((problem) => `  - ${problem}`))
  }
  if (failed.warnings.length > 0) {
    lines.push(...(lines.length > 0 ? [""] : []), ...failed.warnings.map((w) => `Warning: ${w}`))
  }
  return lines.join("\n")
}

/** What a defect in the startup check `check` says: its message, or its error's. */
const internalError = (check: string, defect: unknown): string => {
  const message = defect instanceof Error ? defect.message : String(defect)
  return `Internal error in ${check}: ${sanitizeLine(message) || "no message"}. Please report it.`
}

/**
 * The problems of the failures in `cause`, each once: a SetupProblem's each, else its message; a
 * defect in `check` as an internal error. None for a cause that is only interruptions.
 */
export const failures = <E extends { readonly message: string }>(
  cause: Cause.Cause<E>,
  check: string,
) => [
  ...new Set(
    cause.reasons.flatMap((reason) =>
      reason._tag === "Die"
        ? [internalError(check, reason.defect)]
        : reason._tag !== "Fail"
          ? []
          : reason.error instanceof SetupProblem
            ? reason.error.problems
            : [reason.error.message],
    ),
  ),
]

/** The problems `check`, an effect, failed with, or none; its value, if it succeeded. */
const collect = <A, E extends { readonly message: string }, R>(
  check: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isSuccess(exit)
      ? { value: Option.some(exit.value), problems: [] as ReadonlyArray<string> }
      : {
          value: Option.none<A>(),
          // A check that didn't pass always says something, though it was only interrupted.
          problems: Cause.hasInterruptsOnly(exit.cause)
            ? [internalError(check, "it was interrupted")]
            : failures(exit.cause, check),
        },
  )

/** Whether `path` is `dir` or inside it. */
const within = (path: string, dir: string): boolean => {
  const rel = relative(dir, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The path `path` names, following symbolic links when it exists. */
const real = (fs: FileSystem.FileSystem, path: string) =>
  fs.realPath(path).pipe(Effect.orElseSucceed(() => resolvePath(path)))

/**
 * The problem with the git tutti runs from `cwd`, if any: one not installed, or older than
 * `minimumGitVersion`, whose commands would fail on options it doesn't know.
 */
export const checkGit = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const shown = yield* Effect.result(git.version(cwd))
    if (Result.isSuccess(shown)) return Option.fromNullishOr(gitTooOld(shown.success))
    // Another failure is left to the git commands after it, which say what they find.
    return shown.failure._tag === "GitFailed" && shown.failure.exitCode === 127
      ? Option.some("Required command not found: git")
      : Option.none<string>()
  })

/**
 * The main checkout of the repository `cwd` is in, and the linked worktree `cwd` is in instead,
 * if it is in one; or the problem, a git too old among them.
 */
export const findRepository = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const problem = yield* checkGit(cwd)
    if (Option.isSome(problem)) return Result.fail(problem.value)
    const listed = yield* Effect.result(git.worktrees(cwd))
    if (Result.isFailure(listed)) {
      return Result.fail(
        listed.failure._tag === "GitFailed" && listed.failure.exitCode === 127
          ? "Required command not found: git"
          : listed.failure._tag === "GitFailed"
            ? "Not inside a git repository: cd into the project first."
            : `git took too long to list the worktrees of ${cwd}.`,
      )
    }
    const [main, ...linked] = listed.success
    if (main === undefined)
      return Result.fail("Not inside a git repository: cd into the project first.")
    const here = yield* real(fs, cwd)
    // The innermost worktree cwd is in, should one be nested in another.
    let inside: string | null = null
    for (const worktree of linked) {
      if (within(here, yield* real(fs, worktree.path))) {
        if (inside === null || worktree.path.length > inside.length) inside = worktree.path
      }
    }
    return Result.succeed({ repo: main.path, linked: inside })
  })

/** The branch the main checkout is on, or the problem. */
const checkBranch = (repo: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const branch = yield* Effect.result(git.currentBranch(repo))
    if (Result.isFailure(branch)) {
      const error = branch.failure
      return Result.fail(
        `Could not read the main checkout's branch: ${error._tag === "GitFailed" ? error.stderr.trim() : `git took longer than ${formatDuration(error.timeLimit)}`}.`,
      )
    }
    return Option.match(branch.success, {
      onNone: () =>
        Result.fail(
          "The main checkout is on a detached HEAD. Check out the branch finished tickets should land on.",
        ),
      onSome: (name) => Result.succeed(name),
    })
  })

/** The most changed files a clean-tree problem names. */
const shownFiles = 5

/** The problem with uncommitted changes in the main checkout (`checkoutChanges`). */
const checkCleanTree = (repo: string, except: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const git = yield* Git
    const status = yield* Effect.result(git.status(repo))
    if (Result.isFailure(status)) {
      const error = status.failure
      return [
        `Could not read the main checkout's changes: ${error._tag === "GitFailed" ? error.stderr.trim() : `git took longer than ${formatDuration(error.timeLimit)}`}.`,
      ]
    }
    // A spec run's spec may be left uncommitted: the run commits it.
    const changed = checkoutChanges(status.success).filter((path) => !except.includes(path))
    if (changed.length === 0) return []
    const named = changed.slice(0, shownFiles).map(sanitizeLine).join(", ")
    const more = changed.length > shownFiles ? ` and ${changed.length - shownFiles} more` : ""
    return [
      `The main checkout has uncommitted changes (${named}${more}). Commit or stash them first: finished tickets merge into it. Inspect with: git status`,
    ]
  })

/** What a failed read of bd says. */
const beadsReason = (error: BeadsError): string => {
  switch (error._tag) {
    case "BeadsFailed":
      return error.stderr.trim().split("\n")[0] || `exit code ${error.exitCode}`
    case "BeadsTimedOut":
      return `bd took longer than ${formatDuration(error.timeLimit)}`
    case "BeadsUnreadable":
      return error.reason
  }
}

/**
 * Why a run can't be scoped to ticket `id` (--ticket), or null: the ticket must be one bd shows,
 * open, and work rather than a question for the maintainer, as orchestra's scopeProblem has it.
 */
const scopeProblem = (id: TicketId) =>
  Effect.gen(function* () {
    const bd = yield* Beads
    const shown = yield* Effect.result(bd.show(id))
    const named = sanitizeLine(id)
    if (Result.isFailure(shown)) {
      const error = shown.failure
      const reason =
        error._tag === "BeadsFailed" && error.noSuchIssue
          ? "bd has no ticket by that ID"
          : beadsReason(error)
      return `Cannot read ticket ${named} (--ticket): ${sanitizeLine(reason)}`
    }
    const ticket = shown.success
    if (ticket.status === "closed") {
      return `Ticket ${named} (--ticket) is closed: nothing to run. Reopen it with: bd update ${named} --status open`
    }
    if (ticket.labels.includes(HumanLabel)) {
      return `Ticket ${named} (--ticket) is a question for you (label ${HumanLabel}), not work. Answer it with: bd human respond ${named}`
    }
    return null
  })

/**
 * The problems with bd and the Beads database in `repo`, init setting the database up, and with
 * the ticket the run is scoped to, if any.
 */
const checkBeads = <R>(
  repo: string,
  beads: Layer.Layer<Beads, never, R>,
  notSetUp: boolean,
  ticket: TicketId | null,
) =>
  Effect.gen(function* () {
    const read = yield* Effect.result(
      Effect.flatMap(Beads, (bd) => bd.ready()).pipe(Effect.provide(beads)),
    )
    if (Result.isSuccess(read)) {
      if (ticket === null) return []
      const problem = yield* scopeProblem(ticket).pipe(Effect.provide(beads))
      return problem === null ? [] : [problem]
    }
    const error = read.failure
    if (error._tag === "BeadsFailed" && error.exitCode === 127) {
      return ["Required command not found: bd (Beads). Install it, or let tutti init offer to."]
    }
    const fs = yield* FileSystem.FileSystem
    const database = yield* fs.exists(join(repo, ".beads")).pipe(Effect.orElseSucceed(() => true))
    if (!database) return notSetUp ? [] : [`No Beads database in ${repo}. Run: bd init`]
    return [`Cannot read the Beads database in ${repo}: ${beadsReason(error)}`]
  })

/**
 * Whether `tutti init` has set up the repository: it wrote the settings, which it writes after the
 * rest of its files (src/init/staged.ts). A worker prompt without them is a setup init didn't finish.
 */
const setUp = (repo: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.exists(join(repo, settingsFile)).pipe(Effect.orElseSucceed(() => true)),
  )

/** What tutti reads of orchestra's run state: its workers' tickets, a worker it can't read without. */
const OrchestraState = Schema.fromJsonString(
  Schema.Struct({
    workers: lenientKey(
      Schema.Array(
        Schema.Struct({ ticket: lenientKey(Schema.String) }).pipe(
          Schema.catchDecoding(() => Effect.succeedSome({})),
        ),
      ),
    ),
  }),
)

/**
 * The tickets of the workers orchestra's run state names in `repo`: none when it has no state, or
 * one tutti can't read, since the file is orchestra's.
 */
export const orchestraWorkers = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(join(repo, orchestraStateFile))
      .pipe(Effect.orElseSucceed(() => ""))
    const state = Schema.decodeUnknownOption(OrchestraState)(text)
    const workers = Option.isSome(state) ? (state.value.workers ?? []) : []
    const tickets = workers.flatMap(({ ticket }) =>
      ticket === undefined || ticket === "" ? [] : [sanitizeLine(ticket)],
    )
    return [...new Set(tickets)]
  })

/** The warning when orchestra left workers on `tickets` (§ 11). */
export const orchestraWarning = (tickets: ReadonlyArray<string>): string =>
  `orchestra left workers on ${tickets.join(", ")}; finish them with orchestra first`

/**
 * A run's configuration as no flag, variable or config file would give it, for the checks that
 * still run when the configuration has problems: those problems are reported beside theirs.
 */
const fallbackConfig = (repo: string): AppConfigValue => {
  const resolved = resolve({
    repo,
    flags: noFlags,
    env: () => undefined,
    user: defaultUserConfig,
    settings: defaultSettings,
  })
  if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
  return resolved.success
}

/**
 * Runs the startup checks from `checking.cwd`: what they resolved, or every problem at once. The
 * caller reports a failure (`report`) and exits with `exitSetup`.
 */
export const check = <R>(checking: Checking<R>) =>
  Effect.gen(function* () {
    const found = yield* findRepository(checking.cwd)
    if (Result.isFailure(found)) {
      return yield* new StartupFailed({ notSetUp: false, problems: [found.failure], warnings: [] })
    }
    const { repo, linked } = found.success
    const configured = yield* collect("the configuration", checking.config(repo))
    const given = Option.getOrElse(configured.value, () => fallbackConfig(repo))
    // Sessions, the probe's first, run the Claude Code this resolves: in a compiled build, the
    // embedded one, extracted.
    const claude = yield* checking.claude(given.claude)
    const config: AppConfigValue = { ...given, claude: claude.path }
    const organs = organProvider(checking.env)
    // A worker prompt of its own (--prompt) is enough to run in a project init hasn't set up, as
    // in orchestra; without one, such a project has no worker prompt to check.
    const ownPrompt = config.prompt !== resolvePath(repo, workerPromptFile)
    const notSetUp = !ownPrompt && !(yield* setUp(repo))
    // A spec run's spec (§ 4.14): read before the tree is checked, which it may be uncommitted in.
    const spec =
      config.spec === null
        ? Result.succeed(null)
        : yield* readSpec(config.spec, config.specFrom, checking.cwd, repo, checking.fetch)
    const specPath = [
      ...(Result.isSuccess(spec) && spec.success !== null ? [spec.success.path] : []),
      ...(checking.uncommitted ?? []),
    ]

    const [branch, tree, beads, account, mcp, prompt, leftWorkers] = yield* Effect.all(
      [
        checkBranch(repo),
        checkCleanTree(repo, specPath),
        checkBeads(repo, checking.beads(repo), notSetUp, config.ticket),
        collect(
          "the login probe",
          // Built in the caller's Scope, which awaits the probe's Claude Code's exit, so the
          // checks don't wait out its exit flush (§ 4.13).
          Layer.build(Layer.provide(checking.account, Layer.succeed(AppConfig, config))).pipe(
            Effect.flatMap((built) =>
              Effect.provideContext(
                Effect.flatMap(Account, (account) => account.probe),
                built,
              ),
            ),
          ),
        ),
        collect("the MCP servers", resolveServers(repo, config.settings.workers.mcp_servers)),
        notSetUp
          ? Effect.succeed({ value: Option.none<WorkerPrompt>(), problems: [] })
          : collect("the worker prompt", loadWorkerPrompt(config)),
        orchestraWorkers(repo),
      ],
      { concurrency: "unbounded" },
    )

    const problems = [
      ...(linked === null
        ? []
        : [`${linked} is a linked worktree. Run this from the main checkout.`]),
      ...(Result.isFailure(branch) ? [branch.failure] : []),
      ...tree,
      ...(Result.isFailure(spec) ? [spec.failure] : []),
      ...beads,
      ...claude.problems,
      ...account.problems,
      ...(Result.isFailure(organs) ? [organs.failure] : []),
      ...configured.problems,
      ...mcp.problems,
      ...prompt.problems,
    ]
    const warnings = [
      ...claude.warnings,
      ...(leftWorkers.length > 0 ? [orchestraWarning(leftWorkers)] : []),
      ...retiredIn(given.settings),
      ...keepAwakeNotes(given),
    ]
    if (
      notSetUp ||
      problems.length > 0 ||
      Result.isFailure(branch) ||
      Result.isFailure(organs) ||
      Result.isFailure(spec) ||
      Option.isNone(configured.value) ||
      Option.isNone(account.value) ||
      Option.isNone(mcp.value) ||
      Option.isNone(prompt.value)
    ) {
      return yield* new StartupFailed({ notSetUp, problems, warnings })
    }
    // The project's worker prompt and verifier where they are older than tutti's templates: notes,
    // which `tutti init --update` takes.
    const settings = configured.value.value.settings
    const templates = yield* templateNotes(repo, settings.templates, !ownPrompt)
    // The README's section on what to install where it differs from the requires list: a note,
    // which `tutti requires --readme` takes.
    const readme = yield* readmeStaleLine(repo, settings.requires)
    return {
      config: { ...configured.value.value, claude: claude.path },
      base: branch.success,
      prompt: prompt.value.value,
      mcp: mcp.value.value,
      account: account.value.value,
      organs: organs.success,
      spec: spec.success,
      warnings: [
        ...warnings,
        ...templates,
        ...(readme === null ? [] : [`${Tag.readmeStale}: ${readme}`]),
      ],
    } satisfies Started
  })

/**
 * The checks as a run makes them: the flags' configuration, bd, and the Agent SDK's probe; the
 * embedded Claude Code extracted under `unpacking` (src/run/gettingReady.ts).
 */
export const live = (
  cwd: string,
  flags: RunFlags,
  unpacking?: (extracting: Effect.Effect<string>) => Effect.Effect<string>,
  uncommitted: ReadonlyArray<string> = [],
  fetch?: SpecFetch<LiveFetch>,
) =>
  ({
    cwd,
    uncommitted,
    ...(fetch === undefined ? {} : { fetch }),
    env: process.env,
    config: (repo) => load(flags, repo, cwd),
    beads: (repo) => Beads.layer({ cwd: repo }),
    claude: (given) => resolveClaude(given, cwd, unpacking),
    account: Account.layer,
  }) satisfies Checking<FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>

/** The memory `concurrency` workers take, about, for the START block (§ 15.2). */
export const memoryEstimate = (concurrency: number): string =>
  `about ${concurrency * memoryPerWorkerGiB} GiB of memory, about ${memoryPerWorkerGiB} GiB per worker`

/**
 * The START block of a run that passed its checks: `START tutti <version> in <repo> on <base>`,
 * its scope, ` · overnight` for an overnight run, its settings, ` · auto-answer` with --auto-answer, then its billing, its permission mode in effect, its MCP servers when it
 * has none, its `concurrent` above the cap on the machine's workers, the memory its workers take, why its colour scheme isn't used (a line per notice), and
 * its warnings.
 */
export const startBlock = (started: Started, version: string): ReadonlyArray<Line> => {
  const { config } = started
  const spec = started.spec ?? null
  const concurrency = config.settings.concurrent
  const ticketLimit = config.settings.workers.ticket_limit
  const servers = [
    ...started.mcp.servers.map((server) => server.name),
    ...(started.mcp.chrome === true ? [chromeServer] : []),
  ]
  return start({
    version,
    repo: config.repo,
    base: started.base,
    // A --feature run is scoped to the epic it filed, as orchestra's ScopeLabel says; a spec run is
    // named by its spec, its root epic in a note.
    ...(spec !== null
      ? { scope: `spec ${spec.path}${spec.url === undefined ? "" : ` from ${spec.url}`}` }
      : config.ticket === null
        ? {}
        : { scope: `${config.feature === null ? "ticket" : "feature"} ${config.ticket}` }),
    ...(config.overnight ? { overnight: true } : {}),
    settings: [
      ["limit", config.limit === null ? "none" : String(config.limit)],
      ["concurrent", String(concurrency)],
      ["machine workers", machineWorkersLabel(config.machineWorkers, config.machineWorkersFrom)],
      ["ticket limit", ticketLimit === null ? "none" : formatDuration(ticketLimit)],
      ["check timeout", formatDuration(config.settings.checks.fast.timeout)],
      ["worktrees", config.worktrees],
      ...(servers.length === 0 ? [] : [["MCP servers", servers.join(", ")] as const]),
    ],
    // --auto-answer, at the line's end, as orchestra has nothing there.
    ...(config.autoAnswer === null
      ? {}
      : { ends: autoAnswerName(config.autoAnswer, formatDuration(config.autoAnswer)) }),
    notes: [
      ...(spec === null || config.ticket === null
        ? []
        : [`spec: epic ${config.ticket}, broken down from: ${spec.path}`]),
      billingLine(started.account.billing, started.organs._tag === "Anthropic"),
      permissionModeLine(started.account.permissionMode),
      ...(started.mcp.note === null ? [] : [started.mcp.note]),
      ...(config.machineWorkers > 0 && concurrency > config.machineWorkers
        ? [aboveCapNote(concurrency, config.machineWorkers)]
        : []),
      `memory: ${memoryEstimate(concurrency)}`,
      ...schemeNotices(config.scheme),
      ...started.warnings,
    ],
  })
}
