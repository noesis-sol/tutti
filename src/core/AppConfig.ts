// AppConfig (§ 3.3): a run's configuration, resolved once into one value by src/run/resolveConfig.ts
// from its flags, its TUTTI_* variables, the user config (§ 8.5), the project's settings (§ 8.4)
// and its defaults. The service, its value and the defaults every layer reads live here, below
// the layers that read them; the resolver, which reads the flags, the files and the colour
// scheme, is the command layer's.

import { join } from "node:path"
import { Context, Duration, Schema } from "effect"
import type { billings } from "../project/flags.ts"
import type { LoadedScheme } from "../project/scheme.ts"
import type { Settings } from "../project/settings.ts"
import type { TicketId } from "../services/Beads.ts"

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

/** The free disk, in GB, --overnight's pre-flight wants by default where the worktrees go. */
export const defaultOvernightFreeDisk = 20

/**
 * How long a worker's permission request waits, with the machine awake, before an overnight run
 * denies it in nobody's name, its turn going on with the refusal (Attention's denyPermissions).
 */
export const overnightDenyAfter: Duration.Duration = Duration.seconds(30)

/** The worker prompt, relative to the project's top (§ 9.1). */
export const workerPromptFile = join(".tutti", "worker-prompt.md")

/** The appearances: auto follows the terminal's background (§ 7.11). */
export const appearances = ["auto", "light", "dark"] as const

/** The variable that overrides the user config's appearance; it has no flag. */
export const appearanceVariable = "TUTTI_APPEARANCE"

/** The variable that, set and not empty, draws every colour role in the default colour. */
export const noColorVariable = "NO_COLOR"

/** The user config's file as the START block names it where its own path isn't given. */
export const defaultUserFile = "~/.config/tutti/config.json"

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
  /** The feature request to talk through in the Interview view (--feature), or null. */
  readonly feature: string | null
  /**
   * The spec to build (--spec, TUTTI_SPEC), as given: a path from the folder tutti was started in,
   * which the startup checks read (src/run/spec.ts's readSpec); null for none.
   */
  readonly spec: string | null
  /** What gave the spec: `--spec` or `TUTTI_SPEC`. */
  readonly specFrom: string
  /** Break the spec down with you (--refine). */
  readonly refine: boolean
  /**
   * The spec's path in the repository once a spec run is scoped to its root epic
   * (src/run/specRun.ts), which the title line and the summary name; null otherwise.
   */
  readonly specPath: string | null
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
   * Whether `worktrees` is tutti's default, `~/.tutti/worktrees/<name>` (src/run/worktreesRoot.ts),
   * no --worktrees or TUTTI_WORKTREES given: the run claims it, and moves the worktrees of the old
   * default, `<repo>-tutti`, into it. A repository holding the home folder has `<repo>-tutti` beside
   * it instead, which isn't the default.
   */
  readonly worktreesDefault: boolean
  /**
   * The folder the machine's tutti and orchestra runs register in (src/services/machine.ts), as
   * orchestra finds it from ORCHESTRA_RUNS_DIR, HOME and XDG_CACHE_HOME; null for none.
   */
  readonly runs: string | null
  /**
   * The most workers across the machine's runs, this one's included, before a ticket starts; 0 for
   * no cap. --machine-workers, TUTTI_MACHINE_WORKERS, ORCHESTRA_MACHINE_WORKERS, else half the
   * cores, at least 2 (src/services/machine.ts's defaultMachineWorkers).
   */
  readonly machineWorkers: number
  /**
   * What gave `machineWorkers`, as the START line says it: `--machine-workers`, the variable's
   * name, or `default: half of 10 cores`.
   */
  readonly machineWorkersFrom: string
  /**
   * Whether the machine is kept from sleeping while the run goes (src/run/keepAwake.ts): with
   * --overnight, always; else keep_awake in the user config, else in the project's settings, else
   * true.
   */
  readonly keepAwake: boolean
  /**
   * The file whose keep_awake false turned keeping awake off, as the START block names it: the user
   * config's or `.tutti/settings.json`; null while the machine is kept awake.
   */
  readonly keepAwakeOffBy: string | null
  /**
   * What the START block says of each retired flag given (src/project/flags.ts's retiredFlags) but a
   * refused one, which is a problem, once each, naming the flag, or its variable where the flag
   * isn't given: none is read. Then each retired organ key the settings or the user config still
   * has (src/project/settings.ts's retiredOrganKeys), naming its file.
   */
  readonly retiredNotes: ReadonlyArray<string>
  /**
   * Whether tutti answers the workers' questions with their recommended option (--auto-answer),
   * and once one has waited how long for the maintainer: Duration.zero at once, null not at all.
   * Chosen for each run (src/run/autoAnswer.ts).
   */
  readonly autoAnswer: Duration.Duration | null
  /**
   * How long a worker's permission request waits before tutti denies it, nobody being there to
   * answer: overnightDenyAfter in an overnight run, null, never, in another (tutti-epza.10).
   */
  readonly denyPermissions: Duration.Duration | null
  /**
   * An overnight run (--overnight): the current tickets, as with --tickets, once the pre-flight
   * (src/run/overnight.ts) has cleared it; it keeps the machine awake whatever keep_awake says, and
   * turns on --auto-answer, which its own flag or variable overrides.
   */
  readonly overnight: boolean
  /** Start an overnight run though a pre-flight check failed (--force-overnight). */
  readonly forceOvernight: boolean
  /** The free disk, in GB, the pre-flight wants where the worktrees go; 0 doesn't check. */
  readonly overnightFreeDisk: number
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
