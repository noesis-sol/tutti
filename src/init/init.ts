// tutti init (§ 8.3): sets a project up, as orchestra init does, with its flags. It refuses while
// a run holds the repository's lock, asks what the flags don't answer through init's form (the
// renderer's, or its line-based version; none without a terminal, when it asks nothing), then,
// holding the lock itself (`"init": true`) so that no run starts in a tree it writes into, sets
// Beads up and writes what § 9.1 lists where it is missing:
//
//   .tutti/settings.json      the settings, with the answers; existing ones kept unless changed
//   .tutti/worker-prompt.md   the built-in template; an existing one replaced only with --force
//   .tutti/.gitignore         ignoring the log, the reports and the run's files
//   scripts/check-fast.sh     the runners, in orchestra's format; one there is kept unless its
//   scripts/check-full.sh     flag gives it a command
//
// The setup is written as one (./staged.ts): its files staged as init plans them, then written
// together, the settings last, so that a failure leaves the setup as it was.
//
// In a project with .orchestra/ and no .tutti/, it first offers to import orchestra's settings and
// worker prompt (./import.ts), which then stand in for the template's; the flags still win.
//
// The Checks step (checks.ts) chooses the runners' suites, after the scout, and asks the setup
// command, the ticket prefix and the verifier; init then writes the create-check-suite skill and the
// verifier where they are chosen, and files the test work. It writes the README's section on what
// to install from the requires list, and keeps it in step (./requires.ts). Then it runs the login
// probe, whose account, billing and permission mode its summary reports, and last it checks the
// project's requirements as a run's start does, installing what it can.
import { join } from "node:path"
import {
  Clock,
  Deferred,
  type Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schema,
  type Scope,
} from "effect"
import { Account } from "../agent/Account.ts"
import { chromeServer, definedServers } from "../agent/mcp.ts"
import { AppConfig, type AppConfigValue, type SetupProblem } from "../cli/AppConfig.ts"
import type { Scouting } from "../organs/scout.ts"
import { decodeConfig, formatDuration } from "../project/configFile.ts"
import { builtInWorkerPrompt, withSuites } from "../project/prompt.ts"
import { maxConcurrent, Settings, settingsFile } from "../project/settings.ts"
import settingsTemplate from "../project/templates/settings.json" with { type: "json" }
import gitignoreTemplate from "../project/templates/tutti-gitignore" with { type: "text" }
import { TimeLimit } from "../services/exec.ts"
import { RunLock } from "../services/RunLock.ts"
import type { FormCancelled } from "../ui/questions.ts"
import { schemeNotices } from "../ui/theme.ts"
import {
  applySkill,
  applyVerifier,
  asksChecks,
  type ChecksAnswers,
  type ChecksQuestions,
  fileTestWork,
  findSetup,
  runnersDiffer,
  setupSteps,
  skillState,
  suiteLines,
  testWork,
  usesVerifier,
  verifierPath,
} from "./checks.ts"
import {
  findOrchestra,
  type ImportOffer,
  importOffer,
  importSteps,
  orchestraPromptFile,
  promptChangeSteps,
} from "./import.ts"
import { readmeSteps, requiresSteps } from "./requires.ts"
import {
  checkScript,
  checksNothing,
  fastRunner,
  fastScript,
  fullRunner,
  fullScript,
  isRunner,
  runnerSuites,
  type Suite,
  withoutRunners,
} from "./runners.ts"
import { commitStaged, staging } from "./staged.ts"
import { joinAnd, type Machine, runSteps, type Step, step, stepLine } from "./steps.ts"
import { currentTemplates, keptNote, outdatedTemplates, type Templates } from "./templates.ts"
import {
  applyPrefix,
  applyUnion,
  asksAnything,
  type Consent,
  concurrencyStep,
  findBeadsInstall,
  locateBd,
  markTrusted,
  mcpSteps,
  normalPrefix,
  offersUnion,
  offPath,
  type PrefixPlan,
  planPrefix,
  prefixProblem,
  prefixQuestion,
  probeSteps,
  serverNotes,
  setUpBeads,
  trustDeclined,
  trustExplanation,
  trustKey,
  untrustedIn,
  type WorkersAnswers,
  type WorkersQuestions,
} from "./workers.ts"

/** init's flags: each absent where the command line doesn't give it. */
export interface InitFlags {
  readonly concurrent?: number
  readonly mcp?: ReadonlyArray<string>
  readonly changelogUnion?: boolean
  readonly installBeads?: boolean
  /** The ticket prefix, which bd init takes, or every ticket is renamed to. */
  readonly prefix?: string
  /** The command check-fast.sh runs; "" for a runner that checks nothing. */
  readonly checkFast?: string
  /** The slower suites' command, which check-full.sh runs after check-fast.sh. */
  readonly checkFull?: string
  readonly checkFastTimeout?: Duration.Duration
  readonly checkFullTimeout?: Duration.Duration
  /** The setup command; "" for none. */
  readonly setup?: string
  /** Write the verifier subagent, and have the worker prompt run it. */
  readonly verifier?: boolean
  /** Leave the mouse to the terminal: the form takes keys only (§ 7.3). */
  readonly noMouse?: boolean
  /** Replace an existing .tutti/worker-prompt.md with the template. */
  readonly force: boolean
  /**
   * Bring the worker prompt and the verifier up to date with tutti's templates (./update.ts), and
   * nothing else.
   */
  readonly update?: boolean
}

/** The offer to mark an untrusted main checkout trusted: what it explains, and what it would set. */
export interface TrustOffer {
  readonly checkout: string
  /** Why it matters. */
  readonly explanation: string
  /** The user's .claude.json. */
  readonly file: string
  /** The key it would set there. */
  readonly key: string
}

/**
 * init's questions, which its form asks: the renderer's, and the line-based version for TERM=dumb.
 * Each fails with FormCancelled when it is cancelled (Esc, Ctrl+C, Ctrl+D), and init then changes
 * nothing.
 */
export interface InitForm {
  /** The Workers step: the questions `questions` has. */
  readonly workers: (questions: WorkersQuestions) => Effect.Effect<WorkersAnswers, FormCancelled>
  /** The Checks step, which runs the scout: the questions `questions` has. */
  readonly checks: (questions: ChecksQuestions) => Effect.Effect<ChecksAnswers, FormCancelled>
  /** Whether to mark the main checkout trusted, once the probe found it isn't. */
  readonly trust: (offer: TrustOffer) => Effect.Effect<boolean, FormCancelled>
  /** Whether to import orchestra's settings and worker prompt, asked before the Workers step. */
  readonly import: (offer: ImportOffer) => Effect.Effect<boolean, FormCancelled>
  /**
   * Catches Ctrl+C between questions until the scope closes, calling `stop` for each: the
   * renderer's form, whose raw mode takes Ctrl+C as a key, not SIGINT.
   */
  readonly catchStops?: (stop: () => void) => Effect.Effect<void, never, Scope.Scope>
}

/** What init works on, and with. */
export interface InitOptions<R> {
  /** The main checkout. */
  readonly repo: string
  /** Its git folder that every worktree shares, absolute: where the run lock is. */
  readonly commonDir: string
  /** The branch the main checkout is on, for the lock. */
  readonly branch: string
  readonly version: string
  readonly flags: InitFlags
  /** The form; null without a terminal, when init asks nothing. */
  readonly form: InitForm | null
  /** The scout's search for the project's suites, which the form runs: what it found, or why not. */
  readonly scout: Effect.Effect<Scouting, string, R>
  readonly machine: Machine
  /** The configuration of a run in the project, read once init has written its settings. */
  readonly configure: Effect.Effect<AppConfigValue, SetupProblem, R>
  /** The login probe, under that configuration. */
  readonly account: Layer.Layer<Account, never, AppConfig | R>
  /** Claude Code's user config, .claude.json, where the trust key goes. */
  readonly claudeConfig: string
  /**
   * Catches stops once the questions are answered, until init ends, calling `stop` for each: a stop
   * signal, Ctrl+C in the renderer. init then stops after the step under way. None where absent.
   */
  readonly catchStops?: (stop: () => void) => Effect.Effect<void, never, Scope.Scope>
  /** Told the name of each of init's steps as it starts. */
  readonly starting?: (step: string) => Effect.Effect<void>
}

/** What init did: its steps, what's left for you, and whether a run can start. */
export interface InitSummary {
  readonly steps: ReadonlyArray<Step>
  readonly next: ReadonlyArray<string>
  /** Nothing is missing. */
  readonly ready: boolean
}

/** init refused to set the project up, and changed nothing: why. */
export class InitRefused extends Schema.TaggedError<InitRefused>()("InitRefused", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/** init's refusal, saying why. */
export const refused = (reason: string) => new InitRefused({ reason })

/** The worker prompt, from the project's top. */
export const workerPromptPath = join(".tutti", "worker-prompt.md")

/** The .gitignore in .tutti/, from the project's top. */
export const gitignorePath = join(".tutti", ".gitignore")

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The object at `key` in `json`, made there when it isn't one. */
const section = (json: Json, key: string): Json => {
  const value = json[key]
  if (isObject(value)) return value
  const made: Json = {}
  json[key] = made
  return made
}

/**
 * The settings file's JSON and text as they are, null when there is none, and the settings they
 * hold; refused when they aren't settings.
 */
export const readSettingsJson = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = join(repo, settingsFile)
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(refused(`${settingsFile} can't be read: ${error.message}`)),
      ),
    )
    if (Option.isNone(text)) {
      const defaults = decodeConfig(Settings, file, {})
      if (Exit.isFailure(defaults)) return yield* refused("tutti's default settings don't decode")
      return { json: null, text: null, settings: defaults.value }
    }
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text.value),
      catch: (error) =>
        refused(
          `${settingsFile} isn't valid JSON: ${error instanceof Error ? error.message : error}`,
        ),
    })
    const decoded = decodeConfig(Settings, file, json)
    if (Exit.isFailure(decoded)) {
      return yield* refused(
        [
          `${settingsFile} has problems; fix them, then run tutti init again:`,
          ...decoded.cause.reasons.flatMap((reason) =>
            reason._tag === "Fail"
              ? reason.error.problems.map(
                  (problem) =>
                    `  ${problem.path === "" ? "" : `${problem.path}: `}${problem.message}`,
                )
              : [],
          ),
        ].join("\n"),
      )
    }
    return { json: json as Json, text: text.value, settings: decoded.value }
  })

/** The object `over` laid over `base`, section by section: a new object. */
const laidOver = (base: Json, over: Json): Json => {
  const json: Json = structuredClone(base)
  for (const [key, value] of Object.entries(over)) {
    const under = json[key]
    json[key] = isObject(value) && isObject(under) ? laidOver(under, value) : value
  }
  return json
}

/**
 * The settings imported from orchestra, `imported` laid over the template, as readSettingsJson
 * gives them for a project with none yet; refused when they don't decode together.
 */
const importedSettings = (repo: string, imported: Json) =>
  Effect.gen(function* () {
    const json = laidOver(settingsTemplate as Json, imported)
    const decoded = decodeConfig(Settings, join(repo, settingsFile), json)
    if (Exit.isFailure(decoded)) {
      return yield* refused(
        `the settings imported from orchestra have problems: ${String(decoded.cause)}`,
      )
    }
    return { json, text: null, settings: decoded.value }
  })

/** What init changes in the settings: each absent where it keeps what is there. */
interface SettingsChanges {
  readonly concurrent: number | null
  readonly mcp: ReadonlyArray<string> | null
  readonly checkFastTimeout?: Duration.Duration
  readonly checkFullTimeout?: Duration.Duration
  readonly setup?: string
  /** --check-fast or --check-full was given: the runner is the check. */
  readonly fastRunnerChecks: boolean
  readonly fullRunnerChecks: boolean
  /** The files init wrote from tutti's templates now, whose versions the settings record. */
  readonly fromTemplates: { readonly prompt: boolean; readonly verifier: boolean }
}

/**
 * Writes .tutti/settings.json: the one there, or the template, with `changes` and the defaults it
 * lacks (the runners as the checks, their time limits): the settings it holds now, and the step.
 */
const writeSettings = (
  repo: string,
  existing: { readonly json: Json | null; readonly text: string | null },
  changes: SettingsChanges,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const json: Json = structuredClone(existing.json ?? (settingsTemplate as Json))
    const changed: Array<string> = []
    const set = (holder: Json, key: string, value: unknown, name: string) => {
      if (JSON.stringify(holder[key]) === JSON.stringify(value)) return
      holder[key] = value
      changed.push(name)
    }
    if (changes.concurrent !== null) set(json, "concurrent", changes.concurrent, "concurrent")
    if (changes.mcp !== null) {
      set(section(json, "workers"), "mcp_servers", [...changes.mcp], "workers.mcp_servers")
    }
    const checks = section(json, "checks")
    const checkDefaults = [
      ["fast", fastRunner, changes.fastRunnerChecks, changes.checkFastTimeout, "30m"],
      ["full", fullRunner, changes.fullRunnerChecks, changes.checkFullTimeout, "60m"],
    ] as const
    for (const [name, runner, given, timeout, fallback] of checkDefaults) {
      const check = section(checks, name)
      if (given || check.command === undefined || check.command === null) {
        set(check, "command", runner, `checks.${name}.command`)
      }
      if (timeout !== undefined) {
        set(check, "timeout", formatDuration(timeout), `checks.${name}.timeout`)
      } else if (check.timeout === undefined) {
        set(check, "timeout", fallback, `checks.${name}.timeout`)
      }
    }
    if (changes.setup !== undefined) {
      const setup = section(checks, "setup")
      set(setup, "command", changes.setup === "" ? null : changes.setup, "checks.setup.command")
    }
    if (changes.fromTemplates.prompt) {
      const templates = section(json, "templates")
      set(templates, "worker_prompt", currentTemplates.worker_prompt, "templates.worker_prompt")
    }
    if (changes.fromTemplates.verifier) {
      const templates = section(json, "templates")
      set(templates, "verifier", currentTemplates.verifier, "templates.verifier")
    }
    const file = join(repo, settingsFile)
    const decoded = decodeConfig(Settings, file, json)
    if (Exit.isFailure(decoded)) {
      return yield* refused(`the settings init would write have problems: ${String(decoded.cause)}`)
    }
    const settings = decoded.value
    if (existing.text !== null && changed.length === 0) {
      return { settings, step: step("kept", "settings", `${settingsFile} is there; left as it is`) }
    }
    yield* fs.makeDirectory(join(repo, ".tutti"), { recursive: true })
    yield* fs.writeFileString(file, `${JSON.stringify(json, null, 2)}\n`)
    return {
      settings,
      step:
        existing.text === null
          ? step("done", "settings", `wrote ${settingsFile}`, [settingsFile])
          : step("done", "settings", `updated ${settingsFile}: ${joinAnd(changed)}`, [
              settingsFile,
            ]),
    }
  })

/** Writes `text` to `path` in `repo` where it is missing: whether it wrote it. */
const writeIfMissing = (repo: string, path: string, text: string, replace = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = join(repo, path)
    const there = yield* fs.exists(file)
    if (there && !replace) return "kept" as const
    yield* fs.makeDirectory(join(file, ".."), { recursive: true })
    yield* fs.writeFileString(file, text)
    return there ? ("replaced" as const) : ("wrote" as const)
  })

/**
 * The worker prompt's steps: the built-in template where none is there, or with --force, with
 * `suites`, the lines on how to run each suite on part of the project where init knows the suites
 * ("" where it doesn't); or orchestra's `imported` prompt, then the changes § 4.11 needs in it. And
 * whether it wrote the template, whose version the settings then record.
 */
const writePrompt = (repo: string, force: boolean, imported: string | null, suites: string) =>
  Effect.map(
    writeIfMissing(
      repo,
      workerPromptPath,
      imported ?? withSuites(builtInWorkerPrompt, suites),
      force,
    ),
    (did): { readonly steps: ReadonlyArray<Step>; readonly fromTemplate: boolean } => ({
      fromTemplate: did !== "kept" && imported === null,
      steps: promptSteps(did, imported, suites),
    }),
  )

/** The worker prompt's steps, as writePrompt `did` it. */
const promptSteps = (
  did: "kept" | "wrote" | "replaced",
  imported: string | null,
  suites: string,
): ReadonlyArray<Step> =>
  did === "kept"
    ? [
        step(
          "kept",
          "worker prompt",
          `${workerPromptPath} is there; left as it is (--force replaces it with the template)`,
        ),
      ]
    : imported === null
      ? [
          step(
            "done",
            "worker prompt",
            `${did} ${workerPromptPath} from the built-in template${suites === "" ? "" : ", with how to run each suite on part of the project"}`,
            [workerPromptPath],
          ),
        ]
      : [
          step(
            "done",
            "worker prompt",
            `imported ${orchestraPromptFile} to ${workerPromptPath}, with your changes`,
            [workerPromptPath],
          ),
          ...promptChangeSteps(imported, workerPromptPath),
        ]

/**
 * The caution init gives for each of the project's worker prompt and verifier that is older than
 * tutti's templates, as the settings will record their versions (`recorded`): the files it keeps,
 * and an imported prompt, never one it just wrote from the template.
 */
const templateSteps = (repo: string, recorded: Templates) =>
  Effect.map(outdatedTemplates(repo, recorded), (outdated) =>
    outdated.map((each) => step("caution", "templates", keptNote(each))),
  )

/** The .gitignore's step: written where it is missing. */
const writeGitignore = (repo: string) =>
  Effect.map(writeIfMissing(repo, gitignorePath, gitignoreTemplate), (did) =>
    did === "kept"
      ? step("kept", ".gitignore", `${gitignorePath} is there; left as it is`)
      : step(
          "done",
          ".gitignore",
          `wrote ${gitignorePath}: the log, the reports and the run's files`,
          [gitignorePath],
        ),
  )

/** What init writes in a runner: its suites, null to keep the one there; and whether it replaces one that differs. */
interface RunnerPlan {
  readonly suites: ReadonlyArray<Suite> | null
  readonly replace: boolean
}

/**
 * Writes the runners, mode 755: a runner the plan gives suites, and one that is missing; one that
 * is there is kept, as is one that differs from what the plan writes unless it replaces it. A
 * missing check-fast.sh calls an existing scripts/check.sh as its suite.
 */
const writeRunners = (
  repo: string,
  plan: { readonly fast: RunnerPlan; readonly full: RunnerPlan },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = (path: string) => fs.exists(join(repo, path))
    const steps: Array<Step> = []
    const fastGiven = plan.fast.suites
    const fullGiven = plan.full.suites
    let fastSuites: ReadonlyArray<Suite> | null = fastGiven
    if (fastSuites === null && !(yield* exists(fastRunner))) {
      fastSuites = (yield* exists(checkScript))
        ? [
            {
              name: "the project's own check",
              command: checkScript,
              foundIn: checkScript,
              serial: false,
            },
          ]
        : []
    }
    const fastEmpty = fastSuites !== null && withoutRunners(fastSuites).kept.length === 0
    const fullSuites = fullGiven ?? ((yield* exists(fullRunner)) ? null : [])
    const runners = [
      ["check-fast", fastRunner, "--check-fast", fastSuites, fastScript, plan.fast] as const,
      [
        "check-full",
        fullRunner,
        "--check-full",
        fullSuites,
        (suites: ReadonlyArray<Suite>) => fullScript(suites, fastEmpty),
        plan.full,
      ] as const,
    ]
    for (const [label, path, flag, suites, script, planned] of runners) {
      const file = join(repo, path)
      const there = yield* fs.readFileString(file).pipe(Effect.option)
      if (suites === null) {
        steps.push(
          Option.isSome(there)
            ? step("kept", label, `${path} is there; left as it is`)
            : step("missing", label, `${path} is missing`),
        )
        continue
      }
      const text = script(suites)
      if (Option.isSome(there) && there.value === text) {
        steps.push(step("kept", label, `${path} is there; left as it is`))
        continue
      }
      if (Option.isSome(there) && !planned.replace) {
        steps.push(
          step(
            "caution",
            label,
            `${path} differs from what init would write; kept (tutti init ${flag} "<command>" replaces it)`,
          ),
        )
        continue
      }
      yield* fs.makeDirectory(join(repo, "scripts"), { recursive: true })
      yield* fs.writeFileString(file, text)
      yield* fs.chmod(file, 0o755)
      const did = Option.isSome(there) ? "replaced" : "wrote"
      const nothing = checksNothing(text)
        ? `: it checks nothing yet (${flag} "<command>" gives it one)`
        : ""
      steps.push(step("done", label, `${did} ${path}${nothing}`, [path]))
      for (const left of withoutRunners(suites).left) {
        steps.push(
          step(
            "caution",
            label,
            `left out '${left.command.trim()}' (from ${left.foundIn}): it runs a runner, and ${path} would run itself until fork fails`,
          ),
        )
      }
    }
    return steps
  })

/** What tutti needs and whether it is there: bd on the PATH, and Beads set up. */
const prerequisites = (repo: string, machine: Machine) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bd = locateBd(machine)
    return [
      bd.onPath
        ? step("done", "bd", "")
        : step("missing", "bd", bd.path === null ? "install Beads" : offPath(bd.path)),
      (yield* fs.exists(join(repo, ".beads")))
        ? step("done", "Beads", "")
        : step("missing", "Beads", "set it up here: bd init"),
    ]
  })

/** What's left for you, in order: the first thing missing, the prompt to read, what to commit. */
const nextSteps = (repo: string, machine: Machine, steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const next: Array<string> = []
    const missing = steps.find((each) => each.kind === "missing")
    if (missing !== undefined) {
      next.push(`Fix what's missing above (${missing.label}: ${missing.detail}).`)
    }
    if (steps.some((each) => each.label === "templates")) {
      next.push("Take the templates' changes with: tutti init --update")
    }
    if (steps.some((each) => each.label === "worker prompt" && each.kind === "caution")) {
      next.push(`Make the changes to ${workerPromptPath} listed above.`)
    } else if (steps.some((each) => each.label === "worker prompt" && each.kind === "done")) {
      next.push(`Read ${workerPromptPath} and adjust it to the project.`)
    }
    // Advice: a git status that fails only leaves out the commit step.
    const status = yield* machine
      .run(
        "git",
        [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          ".tutti",
          "scripts",
          ".gitattributes",
        ],
        repo,
        TimeLimit.read,
      )
      .pipe(Effect.orElseSucceed(() => ""))
    const changed = status
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3))
    const commit: Array<string> = []
    const add = (path: string) => {
      if (!commit.includes(path)) commit.push(path)
    }
    if (changed.some((path) => path.startsWith(".tutti/"))) add(".tutti/")
    for (const path of changed) if (!path.startsWith(".tutti/")) add(path)
    for (const each of steps)
      for (const path of each.commit ?? []) {
        add(path.startsWith(".tutti/") ? ".tutti/" : path)
      }
    if (commit.length > 0) next.push(`Commit ${joinAnd(commit)}.`)
    next.push(
      "Start a run from the main checkout, on the branch finished tickets should land on:\ntutti",
    )
    return next
  })

/** The probe's steps, offering to mark an untrusted main checkout trusted where the form can ask. */
const probe = <R>(options: InitOptions<R>, config: AppConfigValue) =>
  Effect.gen(function* () {
    const run = Effect.exit(
      Effect.flatMap(Account, (account) => account.probe).pipe(
        Effect.provide(Layer.provide(options.account, Layer.succeed(AppConfig, config))),
      ),
    )
    const probed = yield* run
    const untrusted = untrustedIn(probed)
    if (Option.isNone(untrusted) || options.form === null) return probeSteps(probed)
    const checkout = untrusted.value.checkout
    const offer: TrustOffer = {
      checkout,
      explanation: trustExplanation(checkout),
      file: options.claudeConfig,
      key: trustKey(checkout),
    }
    const yes = yield* options.form.trust(offer).pipe(Effect.orElseSucceed(() => false))
    if (!yes)
      return [...probeSteps(probed, false), step("missing", "trust", trustDeclined(checkout))]
    const marked = yield* Effect.result(markTrusted(options.claudeConfig, checkout))
    if (marked._tag === "Failure") {
      return [...probeSteps(probed, false), step("missing", "trust", marked.failure)]
    }
    // The probe again, to confirm Claude Code trusts it now.
    const again = yield* run
    return [step("done", "trust", `set ${offer.key} in ${offer.file}`), ...probeSteps(again)]
  })

/**
 * tutti init in the project at `options.repo`: its summary, or why it refused, having changed
 * nothing; FormCancelled when the form was cancelled, having changed nothing either.
 */
export const init = <R>(options: InitOptions<R>) =>
  Effect.gen(function* () {
    const { repo, flags, form, machine } = options
    const lock = yield* RunLock
    const started = new Date(yield* Clock.currentTimeMillis).toISOString()
    const request = {
      repo,
      commonDir: options.commonDir,
      holder: {
        pid: process.pid,
        started,
        version: options.version,
        branch: options.branch,
        init: true as const,
      },
    }
    const lockRefusal = (error: { readonly message: string }) =>
      refused(
        `${error.message}. init changes files and tickets a run works from, which would stop it: set up between runs.`,
      )
    // Refused while a run holds the lock: checked before asking, and again once answered.
    yield* Effect.scoped(lock.acquire(request)).pipe(Effect.mapError(lockRefusal))

    const read = yield* readSettingsJson(repo)
    // orchestra's settings and prompt, offered before the questions whose answers they start from.
    const found = Option.getOrNull(yield* findOrchestra(repo))
    const importConsent: Consent =
      found === null ? false : form === null ? "unasked" : yield* form.import(importOffer(found))
    const importing = found !== null && importConsent === true
    const existing =
      importing && found.settings !== null
        ? yield* importedSettings(repo, found.settings.json)
        : read
    const current = existing.settings
    const located = locateBd(machine)
    const install = findBeadsInstall(machine)
    const union = yield* offersUnion(machine, repo)
    const chosenNow = current.workers.mcp_servers
    const defined = yield* definedServers(repo).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    )
    const available = [...new Set([...defined, ...chosenNow])]
    const prefixGiven: PrefixPlan | null =
      flags.prefix === undefined
        ? null
        : yield* planPrefix(machine, repo, flags.prefix).pipe(Effect.mapError(refused))

    const questions: WorkersQuestions = {
      installBeads:
        flags.installBeads === undefined &&
        located.path === null &&
        install.method !== null &&
        install.command !== null
          ? { method: install.method, command: install.command }
          : null,
      concurrent:
        flags.concurrent === undefined ? { initial: current.concurrent, max: maxConcurrent } : null,
      mcp:
        flags.mcp === undefined && available.length > 0
          ? { available, chosen: chosenNow, notes: serverNotes(available, defined) }
          : null,
      changelogUnion: flags.changelogUnion === undefined && union,
    }
    const answers: WorkersAnswers =
      form !== null && asksAnything(questions) ? yield* form.workers(questions) : {}
    const consent = (
      flag: boolean | undefined,
      asked: boolean,
      answer: boolean | undefined,
    ): Consent => flag ?? (!asked ? false : form === null ? "unasked" : (answer ?? true))
    const installConsent = consent(
      flags.installBeads,
      questions.installBeads !== null,
      answers.installBeads,
    )
    const unionConsent = consent(
      flags.changelogUnion,
      questions.changelogUnion,
      answers.changelogUnion,
    )
    const concurrent = flags.concurrent ?? answers.concurrent ?? null
    const mcp = flags.mcp ?? answers.mcp ?? null

    // The Checks step.
    const fs = yield* FileSystem.FileSystem
    const readThere = (path: string) =>
      fs.readFileString(join(repo, path)).pipe(Effect.option, Effect.map(Option.getOrNull))
    const fastThere = yield* readThere(fastRunner)
    const hasCheckScript = yield* fs.stat(join(repo, checkScript)).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    )
    const currentFast = current.checks.fast.command
    const manualCommand =
      currentFast !== null && !isRunner(currentFast, fastRunner)
        ? currentFast
        : fastThere === null && hasCheckScript
          ? checkScript
          : ""
    const setupWas = current.checks.setup.command
    const setupFound = yield* findSetup(repo)
    const promptNow = flags.force ? null : yield* readThere(workerPromptPath)
    const verifierThere = yield* fs.exists(join(repo, verifierPath))
    const checksQuestions: ChecksQuestions = {
      checks:
        flags.checkFast === undefined && flags.checkFull === undefined
          ? {
              scout: Effect.provideContext(options.scout, yield* Effect.context<R>()),
              checkScript: hasCheckScript,
              command: manualCommand,
              keepsRunner: fastThere !== null,
              runners: { fast: fastThere, full: yield* readThere(fullRunner) },
              skill: yield* skillState(repo),
            }
          : null,
      setup:
        flags.setup === undefined && setupWas === null && setupFound.offer !== ""
          ? setupFound
          : null,
      // Asked where bd is there or init offers to install it, and the prefix can be read.
      prefix:
        form !== null &&
        flags.prefix === undefined &&
        (located.onPath || questions.installBeads !== null)
          ? yield* prefixQuestion(machine, repo, located.onPath)
          : null,
      verifier:
        flags.verifier === undefined &&
        (!verifierThere || promptNow === null || !usesVerifier(promptNow)),
    }
    const checked: ChecksAnswers =
      form !== null && asksChecks(checksQuestions) ? yield* form.checks(checksQuestions) : {}
    const choice = checked.checks
    const prefixAnswer =
      checked.prefix === undefined || checksQuestions.prefix === null
        ? null
        : normalPrefix(checked.prefix)
    if (prefixAnswer !== null) {
      const problem = prefixProblem(prefixAnswer)
      if (problem !== null) return yield* refused(`the ticket prefix ${problem}`)
    }
    const prefix: PrefixPlan | null =
      prefixGiven ??
      (prefixAnswer === null ||
      checksQuestions.prefix === null ||
      prefixAnswer === checksQuestions.prefix.current
        ? null
        : {
            prefix: prefixAnswer,
            was: checksQuestions.prefix.isNew ? null : checksQuestions.prefix.current,
            tickets: checksQuestions.prefix.tickets,
          })
    const fromForm = "tutti init's form"
    const fastPlan: RunnerPlan =
      flags.checkFast !== undefined
        ? { suites: runnerSuites(flags.checkFast, "--check-fast", fastRunner), replace: true }
        : choice?.kind === "found"
          ? { suites: choice.fast, replace: checked.replaceFast ?? false }
          : choice?.kind === "scratch"
            ? { suites: [], replace: checked.replaceFast ?? false }
            : choice?.kind === "manual" && choice.command.trim() !== manualCommand
              ? { suites: runnerSuites(choice.command, fromForm, fastRunner), replace: true }
              : { suites: null, replace: false }
    const fullPlan: RunnerPlan =
      flags.checkFull !== undefined
        ? { suites: runnerSuites(flags.checkFull, "--check-full", fullRunner), replace: true }
        : choice?.kind === "found"
          ? { suites: choice.full, replace: checked.replaceFull ?? false }
          : choice?.kind === "scratch"
            ? { suites: [], replace: checked.replaceFull ?? false }
            : { suites: null, replace: false }
    // How to run each suite on part of the project, for the worker prompt, where the runners are
    // written from the suites found: none where a runner there that differs from them is kept.
    const differ =
      choice?.kind === "found" && checksQuestions.checks !== null
        ? runnersDiffer(checksQuestions.checks.runners, choice)
        : { fast: false, full: false }
    const promptSuites =
      choice?.kind === "found" &&
      (!differ.fast || checked.replaceFast === true) &&
      (!differ.full || checked.replaceFull === true)
        ? suiteLines(choice.fast, choice.full)
        : ""
    const setup = flags.setup ?? checked.setup
    const verifierConsent = consent(flags.verifier, checksQuestions.verifier, checked.verifier)

    /**
     * The setup, planned as one group: the worker prompt, the runners, the skill and the verifier,
     * the settings, the README's section, the .gitignore and the changelog's merge.
     */
    const planSetup = Effect.gen(function* () {
      const steps: Array<Step> = []
      if (found !== null) steps.push(...importSteps(found, importConsent))
      const prompt = yield* writePrompt(
        repo,
        flags.force,
        importing ? found.prompt : null,
        promptSuites,
      )
      steps.push(...prompt.steps)
      steps.push(...(yield* writeRunners(repo, { fast: fastPlan, full: fullPlan })))
      steps.push(...(yield* applySkill(repo, choice, checked.replaceSkill ?? false)))
      const verifier = yield* applyVerifier(
        repo,
        workerPromptPath,
        verifierConsent,
        checked.stack ?? [],
      )
      steps.push(...verifier)
      const fromTemplates = {
        prompt: prompt.fromTemplate,
        verifier: verifier.some((each) => each.commit?.includes(verifierPath) === true),
      }
      const written = yield* writeSettings(repo, existing, {
        concurrent,
        mcp,
        ...(flags.checkFastTimeout === undefined
          ? {}
          : { checkFastTimeout: flags.checkFastTimeout }),
        ...(flags.checkFullTimeout === undefined
          ? {}
          : { checkFullTimeout: flags.checkFullTimeout }),
        ...(setup === undefined ? {} : { setup: setup.trim() }),
        fastRunnerChecks: flags.checkFast !== undefined || fastPlan.suites !== null,
        fullRunnerChecks: flags.checkFull !== undefined || fullPlan.suites !== null,
        fromTemplates,
      })
      steps.push(written.step)
      steps.push(...(yield* readmeSteps(repo, written.settings.requires)))
      steps.push(...(yield* templateSteps(repo, written.settings.templates)))
      steps.push(
        ...setupSteps({
          command: written.settings.checks.setup.command,
          was: setupWas,
          offer: setupFound.offer,
          lockfiles: setupFound.lockfiles,
          unasked: form === null && checksQuestions.setup !== null,
        }),
      )
      steps.push(yield* writeGitignore(repo))
      steps.push(...(yield* applyUnion(machine, repo, unionConsent)))
      steps.push(concurrencyStep(written.settings.concurrent, concurrent !== null))
      steps.push(
        ...mcpSteps(
          written.settings.workers.mcp_servers,
          available,
          defined.includes(chromeServer),
        ),
      )
      return steps
    })

    /**
     * The setup, written as one group so that a run never takes it half written: its files staged
     * as planSetup writes them, then written together, the settings last (./staged.ts).
     */
    const writeSetup = Effect.gen(function* () {
      const staged = staging(fs)
      const steps = yield* Effect.provideService(planSetup, FileSystem.FileSystem, staged.fs)
      yield* commitStaged(fs, repo, staged.writes(), join(repo, settingsFile))
      return steps
    })

    /** The project's configuration as a run reads it, then the login probe under it. */
    const probeAll = Effect.gen(function* () {
      const configured = yield* Effect.result(options.configure)
      if (configured._tag === "Failure") {
        return configured.failure.problems.map((problem) => step("missing", "settings", problem))
      }
      return [
        ...(yield* probe(options, configured.success)),
        ...schemeNotices(configured.success.scheme).map((notice) =>
          step("caution", "colour scheme", notice),
        ),
      ]
    })

    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Held until init ends: no run starts in a tree init writes into, on tickets it renames.
        yield* lock.acquire(request).pipe(Effect.mapError(lockRefusal))
        // From here a stop (a stop signal, Ctrl+C in the renderer) ends init after the step under
        // way, rather than between two of the files it writes.
        const stop = yield* Deferred.make<void>()
        if (options.catchStops !== undefined) {
          yield* options.catchStops(() => Deferred.doneUnsafe(stop, Effect.void))
        }
        const filesTests = testWork(choice, options.branch).length > 0
        const beforeSetup = " before writing .tutti/"
        const taken = [
          {
            name: "Beads",
            run: setUpBeads(machine, repo, { install, consent: installConsent, prefix }),
            whole: false,
            stopped: (took: ReadonlyArray<Step> | null) =>
              took === null ? ` while setting Beads up,${beforeSetup}` : beforeSetup,
          },
          ...(prefix === null
            ? []
            : [
                {
                  name: "the ticket prefix",
                  run: applyPrefix(machine, repo, prefix),
                  whole: true,
                  stopped: () => ` once it had renamed the tickets,${beforeSetup}`,
                },
              ]),
          {
            name: "the setup",
            run: writeSetup,
            whole: true,
            stopped: () =>
              filesTests
                ? " once it had written the files above, before filing the test work: tutti init again files it"
                : " once it had written the files above",
          },
          ...(filesTests
            ? [
                {
                  name: "the test work",
                  run: fileTestWork(choice, options.branch),
                  whole: false,
                  stopped: () =>
                    " while filing the test work: tutti init again files what is missing",
                },
              ]
            : []),
          {
            name: "the login probe",
            run: probeAll,
            whole: false,
            stopped: () => " during the login probe, once it had written the files above",
          },
          {
            name: "the requirements",
            run: requiresSteps(repo),
            whole: false,
            stopped: () =>
              " while checking the project's requirements, once it had written the files above",
          },
        ]
        const steps = [...(yield* runSteps(taken, stop, options.starting))]
        steps.push(...(yield* prerequisites(repo, machine)))
        const next = yield* nextSteps(repo, machine, steps)
        return {
          steps,
          next,
          ready: !steps.some((each) => each.kind === "missing"),
        } satisfies InitSummary
      }),
    )
  })

/** The summary's last line: whether a run can start. */
export const signOff = (ready: boolean): string =>
  ready ? "♪ tutti is ready." : "♪ Almost ready: fix what's missing above."

/** What init says when its form was cancelled. */
export const cancelledLine = "Cancelled; nothing was changed."

/** The summary as plain lines: the steps, then what's left for you, then the sign-off. */
export const summaryLines = (summary: InitSummary): ReadonlyArray<string> => [
  ...summary.steps.map(stepLine),
  ...(summary.next.length === 0
    ? []
    : [
        "",
        "Next:",
        ...summary.next.flatMap((line) => line.split("\n").map((part) => `  ${part}`)),
      ]),
  "",
  signOff(summary.ready),
]
