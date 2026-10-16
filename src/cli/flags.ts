// The run flags (§ 8.2), parsed with effect/cli. Each flag is read as its text, and its reader, which
// its TUTTI_* variable shares, turns that text into a value or a problem. effect/cli stops at the
// first value it can't take, while a run reports every problem at once (§ 3.3), so the values are
// read by AppConfig, not by the parser.
//
// A flag's variable is TUTTI_ and its name in capitals, with "-" as "_": TUTTI_CONCURRENT,
// TUTTI_NO_MOUSE. An on-or-off flag takes 1, true, yes or on, or 0, false, no or off, as its
// variable does: `--triage=false`, `TUTTI_TRIAGE=0`; given alone (`--plain`), it is on. orchestra's
// unprefixed variables (LIMIT, NOTIFY, WT_ROOT, …) are not read (D5).
import { Duration, Option, Result } from "effect"
import { Flag } from "effect/cli"
import { parseDuration } from "../project/configFile.ts"
import { efforts, maxConcurrent } from "../project/settings.ts"

/** Reads a flag's or a variable's text: its value, or what is wrong with it, after "--name ". */
export type Reader<A> = (text: string) => Result.Result<A, string>

export interface RunFlag<A> {
  /** The flag's name, without its dashes. */
  readonly name: string
  /** The environment variable that gives the flag's value when the flag isn't given. */
  readonly variable: string
  readonly read: Reader<A>
  /** The flag for effect/cli: its text, if given. */
  readonly flag: Flag.Flag<Option.Option<string>>
}

/** A flag's environment variable: TUTTI_ and its name in capitals, with "-" as "_". */
export const variableOf = (name: string): string =>
  `TUTTI_${name.toUpperCase().replaceAll("-", "_")}`

const got = (text: string) => `(got '${text}')`

/** A whole number from `min` to `max`. */
export const count =
  (min: number, max = Number.MAX_SAFE_INTEGER): Reader<number> =>
  (text) => {
    const n = /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (n >= min && n <= max) return Result.succeed(n)
    const range =
      max === Number.MAX_SAFE_INTEGER
        ? min === 0
          ? "a whole number"
          : `a whole number from ${min}`
        : `a whole number from ${min} to ${max}`
    return Result.fail(`must be ${range} ${got(text)}`)
  }

/** 1, true, yes or on; 0, false, no or off; in any case, as orchestra reads them. */
export const onOff: Reader<boolean> = (text) => {
  switch (text.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return Result.succeed(true)
    case "0":
    case "false":
    case "no":
    case "off":
      return Result.succeed(false)
  }
  return Result.fail(`must be 1 or 0, true or false, yes or no, or on or off ${got(text)}`)
}

/** A time such as "30m", "2h" or "1h30m"; `zero` says whether "0" is one, and reads it as. */
const time =
  <Z>(zero: { readonly allowed: false } | { readonly allowed: true; readonly as: Z }) =>
  (text: string): Result.Result<Duration.Duration | Z, string> =>
    Option.match(parseDuration(text), {
      onNone: () =>
        Result.fail(`must be a time such as 30m or 2h${zero.allowed ? ", or 0" : ""} ${got(text)}`),
      onSome: (duration) =>
        Duration.isGreaterThan(duration, Duration.zero)
          ? Result.succeed(duration)
          : zero.allowed
            ? Result.succeed(zero.as)
            : Result.fail(`must be a time longer than 0, such as 30m ${got(text)}`),
    })

/** A time longer than 0, such as "30m". */
export const positiveTime: Reader<Duration.Duration> = time({ allowed: false })

/** A time such as "6h", or "0". */
export const time0: Reader<Duration.Duration> = time({ allowed: true, as: Duration.zero })

/** A time such as "2h", or "0" for none: null. */
export const timeOrNone: Reader<Duration.Duration | null> = time({ allowed: true, as: null })

/** One of `choices`. */
export const oneOf =
  <const L extends ReadonlyArray<string>>(choices: L): Reader<L[number]> =>
  (text) =>
    choices.includes(text)
      ? Result.succeed(text as L[number])
      : Result.fail(`must be ${choices.slice(0, -1).join(", ")} or ${choices.at(-1)} ${got(text)}`)

/** Any text but blank space, trimmed. */
export const text =
  (what: string): Reader<string> =>
  (given) => {
    const trimmed = given.trim()
    return trimmed === "" ? Result.fail(`needs ${what}`) : Result.succeed(trimmed)
  }

const runFlag = <A>(
  name: string,
  read: Reader<A>,
  options: {
    readonly description: string
    readonly metavar?: string
    readonly alias?: string
    /** Given alone, the flag is on. */
    readonly onOff?: true
  },
): RunFlag<A> => {
  const variable = variableOf(name)
  let flag = Flag.String(name).pipe(
    Flag.withDescription(`${options.description} [${variable}]`),
    Flag.withMetavar(options.metavar ?? (options.onOff ? "on|off" : "value")),
  )
  if (options.onOff) flag = Flag.withOptionalValue(flag, "true")
  if (options.alias !== undefined) flag = Flag.withAlias(flag, options.alias)
  return { name, variable, read, flag: Flag.optional(flag) }
}

/** The billing choices: api keeps ANTHROPIC_API_KEY beside a subscription login (§ 4.13). */
export const billings = ["subscription", "api"] as const

/** The run flags of § 8.2, by the name AppConfig reads them under. */
export const runFlags = {
  concurrent: runFlag("concurrent", count(1, maxConcurrent), {
    alias: "c",
    metavar: "N",
    description: `tickets to work on at the same time, 1 to ${maxConcurrent} (default: .tutti/settings.json, else 1)`,
  }),
  tickets: runFlag("tickets", onOff, {
    onOff: true,
    description: "run the current tickets without first asking whether to plan a new feature",
  }),
  ticket: runFlag("ticket", text("a ticket ID"), {
    metavar: "id",
    description: "work on this ticket and its subtickets only",
  }),
  feature: runFlag("feature", text('the request: --feature "<what to build>"'), {
    metavar: "request",
    description: "plan this feature request as an epic and its tickets, then run them",
  }),
  yes: runFlag("yes", onOff, {
    onOff: true,
    description: "with --feature, file the plan without asking",
  }),
  ticketLimit: runFlag("ticket-limit", timeOrNone, {
    metavar: "time",
    description:
      "stop the run when a ticket's worker is still going this long after dispatch, e.g. 2h; 0 for none (default: .tutti/settings.json, else none)",
  }),
  limit: runFlag("limit", count(0), {
    metavar: "N",
    description: "the most tickets this run starts (default: 40)",
  }),
  workerEffort: runFlag("worker-effort", oneOf(efforts), {
    metavar: "level",
    description: `the effort workers start at: ${efforts.join(", ")} (default: .tutti/settings.json, else Claude Code's)`,
  }),
  workerModel: runFlag("worker-model", text("a model"), {
    metavar: "model",
    description: "the model workers run (default: .tutti/settings.json, else Claude Code's)",
  }),
  organModel: runFlag("organ-model", text("a model"), {
    metavar: "model",
    description: "the model every organ runs (default: .tutti/settings.json, else each organ's)",
  }),
  organEffort: runFlag("organ-effort", oneOf(efforts), {
    metavar: "level",
    description: `the effort every organ runs at: ${efforts.join(", ")} (default: .tutti/settings.json, else each organ's)`,
  }),
  triage: runFlag("triage", onOff, {
    onOff: true,
    description:
      "have the triage organ note a recommendation on each deferred ticket (default: on)",
  }),
  review: runFlag("review", onOff, {
    onOff: true,
    description: "have the reviewer organ write a run report at the end (default: on)",
  }),
  notify: runFlag("notify", onOff, {
    onOff: true,
    description: "desktop notifications (default: the user config, else on)",
  }),
  checkTimeout: runFlag("check-timeout", positiveTime, {
    metavar: "time",
    description:
      "stop the merge check on a ticket after this long, e.g. 30m (default: .tutti/settings.json, else 30m)",
  }),
  checkFullTimeout: runFlag("check-full-timeout", positiveTime, {
    metavar: "time",
    description:
      "stop the full check after this long, e.g. 60m (default: .tutti/settings.json, else 60m)",
  }),
  resolveConflicts: runFlag("resolve-conflicts", onOff, {
    onOff: true,
    description:
      "have a finished ticket's worker resolve its rebase's conflicts before setting it aside (default: .tutti/settings.json, else on)",
  }),
  plain: runFlag("plain", onOff, {
    onOff: true,
    description: "print plain log lines instead of the dashboard",
  }),
  noMouse: runFlag("no-mouse", onOff, {
    onOff: true,
    description:
      "leave the mouse to the terminal (default: the user config, else the dashboard takes it)",
  }),
  prompt: runFlag("prompt", text("a file"), {
    metavar: "file",
    description: "the worker prompt, TICKET_ID its placeholder (default: .tutti/worker-prompt.md)",
  }),
  worktrees: runFlag("worktrees", text("a folder"), {
    metavar: "dir",
    description:
      "the folder for the tickets' worktrees, outside the repository (default: <repo>-tutti beside it)",
  }),
  billing: runFlag("billing", oneOf(billings), {
    metavar: "api|subscription",
    description:
      "api keeps ANTHROPIC_API_KEY for workers and organs beside a subscription login (default: the user config, else subscription)",
  }),
  usageLimitWait: runFlag("usage-limit-wait", time0, {
    metavar: "time",
    description:
      "the longest a run with nothing else to do waits for the usage limit to reset, e.g. 6h (default: 6h)",
  }),
  claude: runFlag("claude", text("a path"), {
    metavar: "path",
    description: "run workers with this Claude Code instead of the embedded one",
  }),
  colourScheme: runFlag("colour-scheme", text("a scheme's name"), {
    metavar: "name",
    description:
      "the colour scheme (default: the user config, else .tutti/settings.json, else orchestra)",
  }),
} as const

export type RunFlagName = keyof typeof runFlags

/** The flags' texts as effect/cli parses them, each none when the flag isn't given. */
export type RunFlags = { readonly [K in RunFlagName]: Option.Option<string> }

/** The run flags for effect/cli's Command.make. */
export const cliFlags = Object.fromEntries(
  Object.entries(runFlags).map(([key, { flag }]) => [key, flag]),
) as { readonly [K in RunFlagName]: Flag.Flag<Option.Option<string>> }

/** No flags given. */
export const noFlags: RunFlags = Object.fromEntries(
  Object.keys(runFlags).map((key) => [key, Option.none()]),
) as RunFlags
