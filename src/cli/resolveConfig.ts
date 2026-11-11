// The resolver of AppConfig (§ 3.3, src/core/AppConfig.ts): a run's configuration, resolved once
// into one value. Each setting comes from the first of these that gives it: its flag, its TUTTI_*
// variable, the user config (§ 8.5), the project's settings (§ 8.4), and its default. Every problem
// with any of them is collected into one SetupProblem, so a run reports them all at once.
//
// A variable's problem counts only when no flag overrides it, as in orchestra: a flag fixes a bad
// standing choice for one run. An empty variable is unset.
//
// A relative path in a flag (--prompt, --worktrees, --claude) is taken from the folder tutti was
// started in, as a shell's completion offers it; in a variable, which stands for every run of the
// project, it is taken from the main checkout's top level, as the settings' are.

import { availableParallelism, homedir } from "node:os"
import { resolve as resolvePath } from "node:path"
import { Config, Duration, Effect, Exit, Layer, Option, Result, type Schema } from "effect"
import {
  AppConfig,
  type AppConfigValue,
  appearances,
  appearanceVariable,
  defaultOvernightFreeDisk,
  defaultUsageLimitWait,
  defaultUserFile,
  noColorVariable,
  overnightDenyAfter,
  SetupProblem,
  workerPromptFile,
} from "../core/AppConfig.ts"
import { type ConfigFileInvalid, type ConfigProblem, decodeConfig } from "../project/configFile.ts"
import { readSettings, retiredOrganNotes, Settings, settingsFile } from "../project/settings.ts"
import { currentHome, readUserConfig, UserConfig, userConfigShown } from "../project/userConfig.ts"
import {
  defaultMachineWorkers,
  defaultMachineWorkersFrom,
  orchestraMachineWorkersVariable,
  runsDir,
  runsDirVariables,
} from "../run/machine.ts"
import { findRoot, oldDefaultRoot, plainRoot, within } from "../run/worktreesRoot.ts"
import { loadScheme, orchestraLoaded, schemeFolders } from "../ui/theme.ts"
import {
  oneOf,
  type Reader,
  type RetiredFlag,
  type RetiredFlagName,
  type RunFlag,
  type RunFlagName,
  type RunFlags,
  retiredFlags,
  runFlags,
} from "./flags.ts"

/** What a run's configuration is resolved from. */
export interface Sources {
  readonly repo: string
  /** The folder tutti was started in, which a flag's relative path is taken from; `repo` if not given. */
  readonly cwd?: string
  readonly flags: RunFlags
  /** An environment variable's value, undefined when it is unset. */
  readonly env: (name: string) => string | undefined
  readonly user: UserConfig
  /** The user config's file, as the START block names it; `~/.config/tutti/config.json` if not given. */
  readonly userFile?: string
  readonly settings: Settings
  /** The machine's cores, for the default --machine-workers; availableParallelism() when not given. */
  readonly cores?: number
  /**
   * The default folder for the worktrees, as found on disk (src/run/worktreesRoot.ts's findRoot);
   * `~/.tutti/worktrees/<the repository's folder name>` when not given.
   */
  readonly worktreesDefault?: string
}

/** A config file's problem as a sentence: `<file>: <key path>: <message>`. */
export const showConfigProblem = (problem: ConfigProblem): string =>
  problem.path === ""
    ? `${problem.file}: ${problem.message}`
    : `${problem.file}: ${problem.path}: ${problem.message}`

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
  const flagGiven = (key: RunFlagName | RetiredFlagName) => Option.isSome(flags[key])

  const ticket = pick("ticket", null)
  const feature = pick("feature", null)
  const overnight = pick("overnight", false)
  const forceOvernight = pick("forceOvernight", false)
  // An overnight run never asks what to work on: the current tickets, as --tickets runs them.
  const tickets = pick("tickets", false) || overnight
  if (overnight && feature !== null) {
    problems.push(
      "--overnight can't be combined with --feature: an overnight run works on the current tickets, or --ticket's.",
    )
  }
  if (!overnight && forceOvernight) {
    problems.push("--force-overnight only applies with --overnight.")
  }
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
  const spec = pick("spec", null)
  const refine = pick("refine", false)
  if (spec !== null) {
    const from = flagGiven("spec") ? "--spec" : runFlags.spec.variable
    if (feature !== null) {
      problems.push(
        `${from} can't be combined with --feature: one builds a spec, the other a feature request.`,
      )
    }
    if (ticket !== null) {
      problems.push(
        `${from} can't be combined with --ticket (or TUTTI_TICKET): a spec run is scoped to the root epic of its tree.`,
      )
    }
    if (flagGiven("tickets") && tickets) {
      problems.push(
        `${from} can't be combined with --tickets: one builds a spec, the other runs the current tickets.`,
      )
    }
    if (overnight) {
      problems.push(
        `${from} can't be combined with --overnight: an overnight run works on the current tickets, or --ticket's.`,
      )
    }
  } else if (refine && feature === null) {
    // --feature talks the feature through with you already: --refine changes nothing there.
    problems.push("--refine only applies with --spec.")
  }
  const limit = pick("limit", null)
  if (spec !== null && limit === 0) {
    problems.push(
      "--spec would break the spec down and run none of it: --limit (or TUTTI_LIMIT) is 0. Raise --limit.",
    )
  }
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
  // A repository holding the home folder, as one of dotfiles can, would hold ~/.tutti/worktrees:
  // its worktrees go beside it, as they did before tutti-omox.
  const homeRoot = sources.worktreesDefault ?? plainRoot(homedir(), repo)
  const worktreesDefault = worktrees === null && !within(homeRoot, repo)
  const worktreesPath = worktreesDefault
    ? homeRoot
    : worktrees === null
      ? oldDefaultRoot(repo)
      : pathOf("worktrees", worktrees)
  // A --claude with no `/` is a command name, which the startup checks look up on PATH.
  const claude = pick("claude", null)
  if (worktrees !== null && within(worktreesPath, repo)) {
    problems.push(
      `--worktrees (or TUTTI_WORKTREES) (${worktreesPath}) must be outside the repository, or git sees the worktrees as untracked files.`,
    )
  }

  // Keeping awake is the default: the user config's keep_awake, else the project's, turns it off.
  // --overnight keeps the machine awake whatever they say. A retired flag is taken and not read.
  const keepAwake = overnight || (user.keep_awake ?? settings.keep_awake)
  const keepAwakeOffBy = keepAwake
    ? null
    : user.keep_awake !== null
      ? (sources.userFile ?? defaultUserFile)
      : settingsFile
  // A refused one stops the run, saying so as a problem.
  const retiredNotes: Array<string> = []
  for (const [key, flag] of Object.entries(retiredFlags) as Array<[RetiredFlagName, RetiredFlag]>) {
    const given = flagGiven(key)
      ? `--${flag.name}`
      : Option.isSome(variable(flag.variable))
        ? flag.variable
        : null
    if (given === null) continue
    const said = `${given} is no longer read: ${flag.instead}`
    if (flag.refused) problems.push(`${said}.`)
    else retiredNotes.push(said)
  }
  // The organs' keys that went with their organs, read and ignored.
  retiredNotes.push(
    ...retiredOrganNotes(settings.organs, settingsFile),
    ...retiredOrganNotes(user.organs ?? {}, sources.userFile ?? defaultUserFile),
  )

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
        critic: settings.organs.critic,
        critic_every: settings.organs.critic_every,
        critic_tickets: settings.organs.critic_tickets,
        auditor: settings.organs.auditor,
      },
      merge: {
        ...settings.merge,
        resolve_conflicts: pick("resolveConflicts", settings.merge.resolve_conflicts),
      },
      spec: {
        timeout: pick("specTimeout", settings.spec.timeout),
        effort: pick("specEffort", settings.spec.effort),
      },
    },
    tickets,
    ticket,
    feature,
    spec,
    specFrom: flagGiven("spec") ? "--spec" : runFlags.spec.variable,
    refine,
    specPath: null,
    limit,
    notify: pick("notify", user.notify),
    plain: pick("plain", false),
    mouse: !pick("noMouse", !user.mouse),
    prompt: pathOf("prompt", prompt),
    worktrees: worktreesPath,
    worktreesDefault,
    runs: runsDir(env),
    machineWorkers,
    machineWorkersFrom,
    keepAwake,
    keepAwakeOffBy,
    retiredNotes,
    // --overnight turns it on; its own flag or variable, given, says otherwise.
    autoAnswer: pick("autoAnswer", overnight ? Duration.zero : null),
    denyPermissions: overnight ? overnightDenyAfter : null,
    overnight,
    forceOvernight,
    overnightFreeDisk: pick("overnightFreeDisk", defaultOvernightFreeDisk),
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
    ...Object.values(retiredFlags).map((flag) => flag.variable),
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
    const userFile = yield* userConfigShown
    const worktreesDefault = yield* findRoot(yield* currentHome, repo)
    const { value, problems } = resolveAll({
      repo,
      cwd,
      flags,
      env,
      user,
      userFile,
      settings,
      worktreesDefault,
    })
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
