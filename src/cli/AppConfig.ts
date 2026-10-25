// AppConfig (§ 3.3): a run's configuration, resolved once into one value. Each setting comes from
// the first of these that gives it: its flag, its TUTTI_* variable, the user config (§ 8.5), the
// project's settings (§ 8.4), and its default. Every problem with any of them is collected into one
// SetupProblem, so a run reports them all at once.
//
// A variable's problem counts only when no flag overrides it, as in orchestra: a flag fixes a bad
// standing choice for one run. An empty variable is unset.
//
// A relative path in a flag (--prompt, --worktrees, --claude) is taken from the folder tutti was
// started in, as a shell's completion offers it; in a variable, which stands for every run of the
// project, it is taken from the main checkout's top level, as the settings' are.

import { availableParallelism } from "node:os"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path"
import { Config, Context, Duration, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { type ConfigFileInvalid, type ConfigProblem, decodeConfig } from "../project/configFile.ts"
import { readSettings, Settings, settingsFile } from "../project/settings.ts"
import { readUserConfig, UserConfig } from "../project/userConfig.ts"
import {
  defaultMachineWorkers,
  defaultMachineWorkersFrom,
  orchestraMachineWorkersVariable,
  runsDir,
  runsDirVariables,
} from "../run/machine.ts"
import type { TicketId } from "../services/Beads.ts"
import { type LoadedScheme, loadScheme, orchestraLoaded, schemeFolders } from "../ui/theme.ts"
import {
  type billings,
  oneOf,
  type Reader,
  type RunFlag,
  type RunFlagName,
  type RunFlags,
  runFlags,
} from "./flags.ts"

/** Every problem with a run's flags, variables, user config and settings, each a sentence. */
export class SetupProblem extends Schema.TaggedError<SetupProblem>()("SetupProblem", {
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return this.problems.join("\n")
  }
}

/** How long a run with nothing else to do waits for the usage limit to reset (§ 4.12). */
export const defaultUsageLimitWait: Duration.Duration = Duration.hours(6)

/** The worker prompt, relative to the project's top (§ 9.1). */
export const workerPromptFile = join(".tutti", "worker-prompt.md")

/** The appearances: auto follows the terminal's background (§ 7.11). */
export const appearances = ["auto", "light", "dark"] as const

/** The variable that overrides the user config's appearance; it has no flag. */
export const appearanceVariable = "TUTTI_APPEARANCE"

/** The variable that, set and not empty, draws every colour role in the default colour. */
export const noColorVariable = "NO_COLOR"

/** The default folder for the worktrees: `<repo>-tutti` beside the repository (§ 11). */
export const defaultWorktrees = (repo: string): string =>
  join(dirname(repo), `${basename(repo)}-tutti`)

export interface AppConfigValue {
  /** The main checkout's top level. */
  readonly repo: string
  /**
   * The project's settings, with the flags and variables that override them applied:
   * `concurrent`, `checks.fast.timeout`, `checks.full.timeout`, `workers.effort`, `workers.model`,
   * `workers.ticket_limit`, `organs.*`, `merge.resolve_conflicts`. Its `ui.colour_scheme` is the
   * project's; `colourScheme` is the one in use.
   */
  readonly settings: Settings
  /** Run the current tickets without asking (--tickets). */
  readonly tickets: boolean
  /** The ticket the run is scoped to (--ticket), or null for the whole backlog. */
  readonly ticket: TicketId | null
  /** The feature request to plan (--feature), or null. */
  readonly feature: string | null
  /** File a --feature plan without asking (--yes). */
  readonly yes: boolean
  /** The most tickets this run starts (--limit), or null for no limit. */
  readonly limit: number | null
  readonly notify: boolean
  /** The dashboard as plain log lines (--plain); a terminal that can't show it also gets them. */
  readonly plain: boolean
  /** Whether the dashboard takes the mouse (--no-mouse turns it off). */
  readonly mouse: boolean
  /** The worker prompt's file, absolute. */
  readonly prompt: string
  /** The folder for the tickets' worktrees, absolute and outside the repository. */
  readonly worktrees: string
  /**
   * The folder the machine's tutti and orchestra runs register in (src/run/machine.ts), as
   * orchestra finds it from ORCHESTRA_RUNS_DIR, HOME and XDG_CACHE_HOME; null for none.
   */
  readonly runs: string | null
  /**
   * The most workers across the machine's runs, this one's included, before a ticket starts; 0 for
   * no cap. --machine-workers, TUTTI_MACHINE_WORKERS, ORCHESTRA_MACHINE_WORKERS, else half the
   * cores, at least 2 (src/run/machine.ts's defaultMachineWorkers).
   */
  readonly machineWorkers: number
  /**
   * What gave `machineWorkers`, as the START line says it: `--machine-workers`, the variable's
   * name, or `default: half of 10 cores`.
   */
  readonly machineWorkersFrom: string
  /**
   * Whether the machine is kept from sleeping while the run goes (--keep-awake): chosen for each
   * run, not in the project's settings (src/run/keepAwake.ts).
   */
  readonly keepAwake: boolean
  /**
   * Whether tutti answers the workers' questions with their recommended option (--auto-answer),
   * and once one has waited how long for the maintainer: Duration.zero at once, null not at all.
   * Chosen for each run, as --keep-awake is (src/run/autoAnswer.ts).
   */
  readonly autoAnswer: Duration.Duration | null
  readonly billing: (typeof billings)[number]
  readonly usageLimitWait: Duration.Duration
  /**
   * The Claude Code sessions run (--claude): a command name as given, a path made absolute, until
   * the startup checks resolve it
   * (src/agent/claudeBinary.ts) into the executable they pass as `pathToClaudeCodeExecutable`, the
   * embedded one extracted in a compiled build; null for the SDK's own.
   */
  readonly claude: string | null
  /** The colour scheme's name, in § 7.11's order. */
  readonly colourScheme: string
  /**
   * The colour scheme in use: `colourScheme` loaded at startup, or orchestra with the reason it
   * isn't. `resolve` reads no files, and leaves it orchestra; `load` loads it.
   */
  readonly scheme: LoadedScheme
  readonly appearance: (typeof appearances)[number]
  /** NO_COLOR is set: every colour role is the terminal's default colour (§ 7.11). */
  readonly noColor: boolean
}

export class AppConfig extends Context.Service<AppConfig, AppConfigValue>()(
  "tutti/cli/AppConfig",
) {}

/** What a run's configuration is resolved from. */
export interface Sources {
  readonly repo: string
  /** The folder tutti was started in, which a flag's relative path is taken from; `repo` if not given. */
  readonly cwd?: string
  readonly flags: RunFlags
  /** An environment variable's value, undefined when it is unset. */
  readonly env: (name: string) => string | undefined
  readonly user: UserConfig
  readonly settings: Settings
  /** The machine's cores, for the default --machine-workers; availableParallelism() when not given. */
  readonly cores?: number
}

/** A config file's problem as a sentence: `<file>: <key path>: <message>`. */
export const showConfigProblem = (problem: ConfigProblem): string =>
  problem.path === ""
    ? `${problem.file}: ${problem.message}`
    : `${problem.file}: ${problem.path}: ${problem.message}`

/** Whether `path` is `dir` or inside it, ignoring case on macOS, whose filesystems usually do. */
const within = (path: string, dir: string): boolean => {
  const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p)
  const rel = relative(fold(dir), fold(path))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolves a run's configuration from its sources, or returns every problem with them. It reads
 * nothing itself, so each layer's precedence can be tested on its own.
 */
export const resolve = (sources: Sources): Result.Result<AppConfigValue, ReadonlyArray<string>> => {
  const { value, problems } = resolveAll(sources)
  return problems.length === 0 ? Result.succeed(value) : Result.fail(problems)
}

/**
 * The configuration `resolve` gives, beside every problem with its sources: where a source has
 * one, the next in the order stands in for it. A command that only reads part of the
 * configuration (tutti login, tutti colours) runs on it.
 */
export const resolveAll = (
  sources: Sources,
): { readonly value: AppConfigValue; readonly problems: ReadonlyArray<string> } => {
  const { repo, flags, env, user, settings } = sources
  const problems: Array<string> = []

  /** A value read with `read` from `text`, or none, noting its problem under `from`. */
  const readAs = <A>(read: Reader<A>, text: string, from: string) => {
    const result = read(text)
    if (Result.isSuccess(result)) return Option.some(result.success)
    problems.push(`${from} ${result.failure}.`)
    return Option.none<A>()
  }

  /** The variable's text, when it is set and not empty. */
  const variable = (name: string) => {
    const value = env(name)
    return value === undefined || value === "" ? Option.none() : Option.some(value)
  }

  // Each flag's value, else its variable's, read in § 8.2's order so its problems are listed so.
  const read = new Map<RunFlagName, Option.Option<unknown>>()
  for (const [key, flag] of Object.entries(runFlags) as Array<[RunFlagName, RunFlag<unknown>]>) {
    const text = flags[key]
    const value = Option.isSome(text)
      ? readAs(flag.read, text.value, `--${flag.name}`)
      : Option.flatMap(variable(flag.variable), (value) => readAs(flag.read, value, flag.variable))
    read.set(key, value)
  }

  /**
   * The flag's value, else its variable's, else `fallback`: the user config's, the settings' or
   * the default. A value with a problem was noted, and the run won't start; `fallback` stands in.
   */
  const pick = <K extends RunFlagName, B>(
    key: K,
    fallback: B,
  ): (typeof runFlags)[K] extends RunFlag<infer A> ? A | B : never =>
    Option.getOrElse(read.get(key) ?? Option.none(), () => fallback) as never

  /** Whether the flag itself was given on the command line. */
  const flagGiven = (key: RunFlagName) => Option.isSome(flags[key])

  const ticket = pick("ticket", null)
  const feature = pick("feature", null)
  const tickets = pick("tickets", false)
  const yes = pick("yes", false)
  if (feature !== null && ticket !== null) {
    problems.push(
      "--feature can't be combined with --ticket (or TUTTI_TICKET): a feature run is scoped to the epic it files.",
    )
  }
  if (feature !== null && flagGiven("tickets") && tickets) {
    problems.push(
      "--feature can't be combined with --tickets: one runs a new feature, the other the current tickets.",
    )
  }
  if (feature === null && flagGiven("yes") && yes) {
    problems.push("--yes only applies with --feature.")
  }
  const limit = pick("limit", null)
  if (feature !== null && limit === 0) {
    // The run would end at once, the plan filed and none of it started.
    problems.push(
      "--feature would file a plan and run none of it: --limit (or TUTTI_LIMIT) is 0. Raise --limit.",
    )
  }

  // --machine-workers, else TUTTI_MACHINE_WORKERS, else orchestra's ORCHESTRA_MACHINE_WORKERS, as
  // the cap is the machine's, else half the cores.
  const machine = runFlags.machineWorkers
  const cores = sources.cores ?? availableParallelism()
  const orchestraMachine =
    flagGiven("machineWorkers") || Option.isSome(variable(machine.variable))
      ? Option.none<number>()
      : Option.flatMap(variable(orchestraMachineWorkersVariable), (value) =>
          readAs(machine.read, value, orchestraMachineWorkersVariable),
        )
  const machineWorkersFrom = flagGiven("machineWorkers")
    ? `--${machine.name}`
    : Option.isSome(variable(machine.variable))
      ? machine.variable
      : Option.isSome(variable(orchestraMachineWorkersVariable))
        ? orchestraMachineWorkersVariable
        : defaultMachineWorkersFrom(cores)
  const machineWorkers = pick(
    "machineWorkers",
    Option.getOrElse(orchestraMachine, () => defaultMachineWorkers(cores)),
  )

  /** A path setting absolute: a flag's from the folder tutti was started in, else from `repo`. */
  const pathOf = (key: RunFlagName, path: string) =>
    resolvePath(flagGiven(key) ? (sources.cwd ?? repo) : repo, path)

  const prompt = pick("prompt", workerPromptFile)
  const worktrees = pick("worktrees", null)
  const worktreesPath = worktrees === null ? defaultWorktrees(repo) : pathOf("worktrees", worktrees)
  // A --claude with no `/` is a command name, which the startup checks look up on PATH.
  const claude = pick("claude", null)
  if (within(worktreesPath, repo)) {
    problems.push(
      `--worktrees (or TUTTI_WORKTREES) (${worktreesPath}) must be outside the repository, or git sees the worktrees as untracked files.`,
    )
  }

  const appearance = Option.match(variable(appearanceVariable), {
    onNone: () => user.appearance,
    onSome: (text) =>
      Option.getOrElse(readAs(oneOf(appearances), text, appearanceVariable), () => user.appearance),
  })

  const value: AppConfigValue = {
    repo,
    settings: {
      ...settings,
      concurrent: pick("concurrent", settings.concurrent),
      checks: {
        ...settings.checks,
        fast: {
          ...settings.checks.fast,
          timeout: pick("checkTimeout", settings.checks.fast.timeout),
        },
        full: {
          ...settings.checks.full,
          timeout: pick("checkFullTimeout", settings.checks.full.timeout),
        },
      },
      workers: {
        ...settings.workers,
        effort: pick("workerEffort", settings.workers.effort),
        model: pick("workerModel", settings.workers.model),
        ticket_limit: pick("ticketLimit", settings.workers.ticket_limit),
      },
      organs: {
        effort: pick("organEffort", settings.organs.effort),
        model: pick("organModel", settings.organs.model),
        triage: pick("triage", settings.organs.triage),
        review: pick("review", settings.organs.review),
      },
      merge: {
        ...settings.merge,
        resolve_conflicts: pick("resolveConflicts", settings.merge.resolve_conflicts),
      },
    },
    tickets,
    ticket,
    feature,
    yes,
    limit,
    notify: pick("notify", user.notify),
    plain: pick("plain", false),
    mouse: !pick("noMouse", !user.mouse),
    prompt: pathOf("prompt", prompt),
    worktrees: worktreesPath,
    runs: runsDir(env),
    machineWorkers,
    machineWorkersFrom,
    keepAwake: pick("keepAwake", false),
    autoAnswer: pick("autoAnswer", null),
    billing: pick("billing", user.billing),
    usageLimitWait: pick("usageLimitWait", defaultUsageLimitWait),
    claude: claude === null || !claude.includes("/") ? claude : pathOf("claude", claude),
    // § 7.11: the flag, TUTTI_COLOUR_SCHEME, the user config, the settings, orchestra. The
    // settings' own default is orchestra too.
    colourScheme: pick("colourScheme", user.colour_scheme ?? settings.ui.colour_scheme),
    scheme: orchestraLoaded,
    appearance,
    noColor: Option.isSome(variable(noColorVariable)),
  }
  return { value, problems }
}

/** A config file's value, or its defaults beside its problems. */
const orDefaults = <A>(
  exit: Exit.Exit<A, ConfigFileInvalid>,
  defaults: A,
  problems: Array<string>,
): A => {
  if (Exit.isSuccess(exit)) return exit.value
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (failure === undefined) throw new Error(`unexpected failure: ${exit.cause}`)
  problems.push(...failure.error.problems.map(showConfigProblem))
  return defaults
}

const defaultsOf = <A>(schema: Schema.Decoder<A>, file: string): A => {
  const exit = decodeConfig(schema, file, {})
  if (Exit.isFailure(exit)) throw new Error(`${file}'s defaults don't decode: ${exit.cause}`)
  return exit.value
}

/** The settings as a missing `.tutti/settings.json` gives them. */
export const defaultSettings: Settings = defaultsOf(Settings, settingsFile)

/** The user config as a missing file gives it. */
export const defaultUserConfig: UserConfig = defaultsOf(UserConfig, "config.json")

/** Every flag's variable, TUTTI_APPEARANCE, NO_COLOR and orchestra's it reads, as they are set. */
const readVariables = Effect.gen(function* () {
  const names = [
    ...Object.values(runFlags).map((flag) => flag.variable),
    appearanceVariable,
    noColorVariable,
    orchestraMachineWorkersVariable,
    ...runsDirVariables,
  ]
  const values = new Map<string, string>()
  for (const name of names) {
    const value = yield* Config.option(Config.String(name))
    if (Option.isSome(value)) values.set(name, value.value)
  }
  return values
}).pipe(Effect.orDie)

/**
 * Reads the TUTTI_* variables, the user config and the project's settings, and resolves them under
 * `flags` for the project at `repo`, the main checkout's top level, a flag's relative path taken
 * from `cwd`. Then it loads the colour scheme, which never fails: one that can't be used gives
 * orchestra and says why.
 */
export const load = (flags: RunFlags, repo: string, cwd: string = repo) =>
  Effect.gen(function* () {
    const read = yield* loadLenient(flags, repo, undefined, cwd)
    const problems = [...read.problems, ...read.userProblems, ...read.settingsProblems]
    if (problems.length === 0) return yield* withScheme(read.value)
    return yield* new SetupProblem({ problems })
  })

/**
 * The configuration `load` reads, without failing, beside its problems: the flags' and variables'
 * (`problems`), the user config's (`userProblems`) and the settings' (`settingsProblems`), a
 * file with problems giving its defaults. With `only`, it reads only those variables, as though
 * the others were unset. A flag's relative path is taken from `cwd`. It leaves the colour scheme
 * orchestra; `withScheme` loads it.
 */
export const loadLenient = (
  flags: RunFlags,
  repo: string,
  only?: ReadonlyArray<string>,
  cwd: string = repo,
) =>
  Effect.gen(function* () {
    const userProblems: Array<string> = []
    const settingsProblems: Array<string> = []
    const variables = yield* readVariables
    const user = orDefaults(yield* Effect.exit(readUserConfig), defaultUserConfig, userProblems)
    const settings = orDefaults(
      yield* Effect.exit(readSettings(repo)),
      defaultSettings,
      settingsProblems,
    )
    const env = (name: string) =>
      only === undefined || only.includes(name) ? variables.get(name) : undefined
    const { value, problems } = resolveAll({ repo, cwd, flags, env, user, settings })
    return {
      value,
      problems,
      userProblems: userProblems as ReadonlyArray<string>,
      settingsProblems: settingsProblems as ReadonlyArray<string>,
    }
  })

/**
 * `config` with its colour scheme loaded, which never fails: one that can't be used gives
 * orchestra and says why.
 */
export const withScheme = (config: AppConfigValue) =>
  Effect.gen(function* () {
    const folders = yield* schemeFolders(config.repo)
    const scheme = yield* loadScheme(config.colourScheme, folders)
    return { ...config, scheme }
  })

/**
 * The live layer: the configuration of the run `flags` start in the project at `repo`, from the
 * folder `cwd`.
 */
export const layer = (flags: RunFlags, repo: string, cwd: string = repo) =>
  Layer.effect(AppConfig, load(flags, repo, cwd))
