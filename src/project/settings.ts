// The project's settings, `.tutti/settings.json` (§ 8.4): committed, so everyone running tutti on
// the project shares them. Every key has a default, orchestra's where the spec's example is silent,
// so a missing file or section decodes to a whole value. Times are strings ("30m"), decoded to
// Durations.
import { join } from "node:path"
import { Schema } from "effect"
import {
  choice,
  choiceOrNull,
  NonNegativeDuration,
  PositiveDuration,
  readConfigFile,
  withDefault,
} from "./configFile.ts"

/** The settings file, relative to the project's top. */
export const settingsFile = join(".tutti", "settings.json")

/** Where the settings file of the project at `repo` is. */
export const settingsPath = (repo: string): string => join(repo, settingsFile)

/** The most workers a run may have at once. */
export const maxConcurrent = 16

/** The effort levels Claude Code takes. */
export const efforts = ["low", "medium", "high", "xhigh", "max"] as const

/**
 * The permission modes workers can be started in. Claude Code's others don't suit a worker, and
 * are refused saying why.
 */
export const permissionModes = ["auto", "default", "acceptEdits"] as const

const unsuitedModes = {
  bypassPermissions:
    "a worker in it would run every command unchecked, where auto has Claude Code's classifier check them",
  plan: "a worker in it only plans, and never changes a file",
}

/**
 * The dependency manifests and lockfiles whose change in a rebase has the setup command run, when
 * the settings name none: orchestra's.
 */
export const defaultSetupFiles = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "requirements*.txt",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "mix.exs",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
]

const Effort = choiceOrNull(efforts)
const Text = Schema.NonEmptyString
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A check's command, none by default, and how long it may run before it is stopped. */
const Check = (timeout: string) =>
  Schema.Struct({
    command: Schema.NullOr(Text).pipe(withDefault(null)),
    timeout: PositiveDuration.pipe(withDefault(timeout)),
  })

/** A single issue type, as `bd ready --exclude-type` takes: bd splits its list at commas. */
const IssueType = Schema.String.check(
  Schema.isPattern(/^[^,\s]+$/u, { expected: `an issue type such as "epic"` }),
)

export const Settings = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  version: Schema.Literal(1).pipe(withDefault(1)),
  /** How many tickets run at once, unless --concurrent says otherwise: 1 by default, as orchestra's. */
  concurrent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxConcurrent })).pipe(
    withDefault(1),
  ),
  checks: Schema.Struct({
    /** The merge check, run on each finished ticket. */
    fast: Check("30m").pipe(withDefault({})),
    /** Every check, run once at the end of a run. */
    full: Check("60m").pipe(withDefault({})),
    /**
     * A worker's check of its own change, such as scripts/check-own.sh: its rules name it as the
     * check to run once, in place of the merge check, which tutti runs itself. tutti never runs it.
     */
    own: Schema.Struct({
      command: Schema.NullOr(Text).pipe(withDefault(null)),
    }).pipe(withDefault({})),
    /** Installs the dependencies in a worktree whose rebase changed one of `files` (globs). */
    setup: Schema.Struct({
      command: Schema.NullOr(Text).pipe(withDefault(null)),
      files: Schema.Array(Text).pipe(withDefault(defaultSetupFiles)),
    }).pipe(withDefault({})),
  }).pipe(withDefault({})),
  workers: Schema.Struct({
    /** The MCP servers workers get, by name; none by default (§ 15, Q5). */
    mcp_servers: Schema.Array(Text).pipe(withDefault([])),
    permission_mode: choice(permissionModes, unsuitedModes).pipe(withDefault("auto")),
    /** high by default, as orchestra's; null: Claude Code's own default. */
    effort: Effort.pipe(withDefault("high")),
    /** null: Claude Code's own default. */
    model: Schema.NullOr(Text).pipe(withDefault(null)),
    /** How long a ticket's worker may go on, from dispatch; null: no limit. */
    ticket_limit: Schema.NullOr(PositiveDuration).pipe(withDefault(null)),
    /** Whether workers get AskUserQuestion (§ 15, Q3). */
    ask_user_question: Schema.Boolean.pipe(withDefault(true)),
  }).pipe(withDefault({})),
  organs: Schema.Struct({
    /** null: each organ's own. */
    effort: Effort.pipe(withDefault(null)),
    /** null: each organ's own. */
    model: Schema.NullOr(Text).pipe(withDefault(null)),
    triage: Schema.Boolean.pipe(withDefault(true)),
    review: Schema.Boolean.pipe(withDefault(true)),
  }).pipe(withDefault({})),
  queue: Schema.Struct({
    /** The issue types never taken from `bd ready`; [] takes every type. */
    exclude_types: Schema.Array(IssueType).pipe(withDefault(["epic"])),
    /** false starts tickets side by side even when their footprints overlap. */
    footprint: Schema.Boolean.pipe(withDefault(true)),
  }).pipe(withDefault({})),
  merge: Schema.Struct({
    /** false sets a finished ticket whose rebase conflicts aside at once. */
    resolve_conflicts: Schema.Boolean.pipe(withDefault(true)),
    /** How long its worker may take to resolve the conflicts. */
    resolve_timeout: PositiveDuration.pipe(withDefault("20m")),
    /** How many times a check failing before a merge is handed back; 0 sets it aside at once. */
    check_hand_backs: Count.pipe(withDefault(2)),
  }).pipe(withDefault({})),
  environment_hold: Schema.Struct({
    /** How many tickets in a row failing at once hold the run; 0 turns the hold off. */
    count: Count.pipe(withDefault(2)),
    /** How soon after dispatch a worker failing counts as failing at once. */
    window: PositiveDuration.pipe(withDefault("2m")),
    /** How long after the hold, once nothing runs, the run probes the machine; "0": no probe. */
    probe: NonNegativeDuration.pipe(withDefault("10m")),
  }).pipe(withDefault({})),
  ui: Schema.Struct({
    /** The project's default colour scheme (§ 7.11); the user config's choice wins over it. */
    colour_scheme: Text.pipe(withDefault("orchestra")),
  }).pipe(withDefault({})),
}).annotate({ title: "tutti settings", description: "a project's .tutti/settings.json" })

export type Settings = typeof Settings.Type

/**
 * The check commands `settings` name: the merge check, the full check and a worker's own. Their
 * files count as no ticket's in footprints, and a worker running one is testing.
 */
export const checkCommands = (settings: Settings): ReadonlyArray<string> =>
  [settings.checks.fast.command, settings.checks.full.command, settings.checks.own.command].filter(
    (command): command is string => command !== null,
  )

/** Reads the settings of the project at `repo`; a missing file gives the defaults. */
export const readSettings = (repo: string) => readConfigFile(Settings, settingsPath(repo))
