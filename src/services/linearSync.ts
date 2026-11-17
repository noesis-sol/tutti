// What Beads' Linear sync (bd linear, bd 1.3.0 and later) gives tutti: a Linear issue's key, read
// from a ticket's external_ref, and what a pull or push printed, read into what it created,
// updated, skipped and failed, by ticket. bd linear sync --json prints only its counts (a
// SyncResult: success, stats, error, warnings); it names a ticket or an issue only in a warning, as
// it fails or skips it (bd's internal/tracker/engine.go). So a ticket's outcome is the warning that
// names it, or else the counts, where they leave one outcome for every ticket no warning names:
// always so for a sync of one ticket. bd wrote all of it, so it is read leniently: what isn't a
// warning tutti knows names nothing, and output that isn't a SyncResult is unreadable.
import { Effect, Option, Schema } from "effect"
import { formatDuration } from "../project/configFile.ts"
import type { BdOutput, BeadsTimedOut } from "./Beads.ts"

/** A Linear issue's key, as NOE-12: its team's key, a dash and its number. */
export const LinearKey = Schema.String.pipe(Schema.brand("LinearKey"))
export type LinearKey = typeof LinearKey.Type

const keyPattern = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/

/** `text` as a Linear key, if it is one (NOE-12): never a flag or anything else bd would read. */
export const linearKey = (text: string): LinearKey | undefined =>
  keyPattern.test(text) ? (text as LinearKey) : undefined

/**
 * The Linear key a ticket's external_ref names: the path segment after `issue/` of a linear.app
 * URL, with the issue's slug after it or not (a push writes it, a pull doesn't), as bd reads it.
 */
export const linearKeyOf = (externalRef: string): LinearKey | undefined => {
  if (!URL.canParse(externalRef.trim())) return undefined
  const url = new URL(externalRef.trim())
  if (url.hostname !== "linear.app" || !/^https?:$/.test(url.protocol)) return undefined
  const segments = url.pathname.split("/")
  const at = segments.indexOf("issue")
  return at < 0 ? undefined : linearKey(segments[at + 1] ?? "")
}

/** What a sync did with a ticket or an issue. */
export type LinearOutcome = "created" | "updated" | "skipped" | "failed"

/** A ticket (pushed) or a Linear issue (pulled), and what the sync did with it. */
export interface LinearItem {
  /** The ticket's ID or the issue's key, as the sync was given it or bd named it. */
  readonly name: string
  /** Absent where bd's output doesn't say: several were given, and the counts mix outcomes. */
  readonly outcome?: LinearOutcome
  /** What bd said of a skip or a failure, in its words. */
  readonly why?: string
}

/** What one bd linear sync did, as it printed it. */
export interface LinearSync {
  readonly created: number
  readonly updated: number
  readonly skipped: number
  readonly failed: number
  /**
   * Each ticket or issue the sync was given, in its order, then any other one bd named (a pull names
   * a ticket it failed to update by the ticket's ID), each with its outcome where bd's output says.
   */
  readonly items: ReadonlyArray<LinearItem>
  /** bd's warnings, as it gave them: a label the team lacks, say, which fails nothing. */
  readonly warnings: ReadonlyArray<string>
}

/** bd refused the sync or failed it as a whole: no configuration, its lock held, Linear down. */
export class LinearRefused extends Schema.TaggedError<LinearRefused>()("LinearRefused", {
  command: Schema.String,
  exitCode: Schema.Number,
  /** What bd said, in a line. */
  reason: Schema.String,
}) {}

/** bd's output didn't read as what the call prints. */
export class LinearUnreadable extends Schema.TaggedError<LinearUnreadable>()("LinearUnreadable", {
  command: Schema.String,
  reason: Schema.String,
  /** The start of the output, for the log. */
  output: Schema.String,
}) {}

/** What a bd linear call fails with: its time limit passed, bd refused it, or its output is unreadable. */
export type LinearError = BeadsTimedOut | LinearRefused | LinearUnreadable

/** What a bd linear call failed of, in a few words. */
export const linearWhy = (error: LinearError): string => {
  switch (error._tag) {
    case "BeadsTimedOut":
      return `bd took longer than ${formatDuration(error.timeLimit)}`
    case "LinearRefused":
      return error.reason
    case "LinearUnreadable":
      return error.reason
  }
}

// The warnings that name a ticket or an issue: `{name}` is it, `{why}` what bd said, and the
// outcome is what bd did with it. "Linear" is bd's DisplayName for the tracker.
const named: ReadonlyArray<{ readonly pattern: RegExp; readonly outcome: LinearOutcome }> = [
  { pattern: /^Failed to (?:push|create|update) (\S+) in Linear: (.*)$/s, outcome: "failed" },
  { pattern: /^Failed to update external_ref for (\S+): (.*)$/s, outcome: "failed" },
  { pattern: /^Failed to create issue for (\S+): (.*)$/s, outcome: "failed" },
  {
    // bd fails to update its own last_sync too, which is no ticket.
    pattern: /^Failed to (?:fetch|update(?! last_sync:)|prepare|generate ID for) (\S+): (.*)$/s,
    outcome: "failed",
  },
  { pattern: /^Issue (\S+) (not found in Linear)$/s, outcome: "skipped" },
  {
    pattern: /^(?:No external ref found for local issue) (\S+), (skipping pull)$/s,
    outcome: "skipped",
  },
  {
    pattern: /^External ref .* of local issue (\S+) (is not an issue .*), skipping pull$/s,
    outcome: "skipped",
  },
]

/** The ticket or issue a warning of bd's names, with what bd did and why; undefined for any other. */
export const namedIn = (warning: string): Required<LinearItem> | undefined => {
  for (const { pattern, outcome } of named) {
    const match = pattern.exec(warning)
    if (match !== null) return { name: match[1] ?? "", outcome, why: (match[2] ?? "").trim() }
  }
  return undefined
}

const Count = Schema.optionalKey(Schema.NullOr(Schema.Number))

const SyncResult = Schema.Struct({
  success: Schema.Boolean,
  stats: Schema.Struct({ created: Count, updated: Count, skipped: Count, errors: Count }),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  warnings: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
})
type SyncResult = typeof SyncResult.Type

/** bd's JSON error, as bd linear prints a refusal with --json. */
const JsonError = Schema.Struct({ error: Schema.String })

const Json = Schema.fromJsonString(Schema.Unknown)

/**
 * The JSON bd printed on stdout: the whole of it, or else from its first line that opens an object,
 * as bd's engine prints a message (indented) before it on a dry run or a conflict.
 */
const jsonIn = (stdout: string): Option.Option<unknown> => {
  const whole = Schema.decodeUnknownOption(Json)(stdout)
  if (Option.isSome(whole)) return whole
  const start = stdout.search(/^\{/m)
  return start < 0 ? Option.none() : Schema.decodeUnknownOption(Json)(stdout.slice(start))
}

/** The payload, out of bd's v2 envelope when it has one. */
const payload = (json: unknown): unknown =>
  typeof json === "object" && json !== null && "data" in json && "schema_version" in json
    ? json.data
    : json

/** At most `max` characters of text. */
const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value

/** What bd said as it refused: its JSON error or failed sync's, else stderr's Error: line. */
const refusal = (output: BdOutput, json: Option.Option<unknown>): string => {
  const said = Option.flatMap(json, (json) => {
    const data = payload(json)
    const error = Schema.decodeUnknownOption(JsonError)(data)
    if (Option.isSome(error)) return Option.some(error.value.error)
    const result = Schema.decodeUnknownOption(SyncResult)(data)
    return Option.isSome(result) && result.value.error
      ? Option.some(result.value.error)
      : Option.none()
  })
  if (Option.isSome(said)) return clip(said.value.trim().split("\n")[0] ?? "", 500)
  const lines = output.stderr.split("\n").map((line) => line.trim())
  const error = lines.find((line) => line.startsWith("Error: "))
  return clip(
    (error ?? lines.filter((line) => line !== "").at(-1) ?? "").replace(/^Error: /, "") ||
      `exit code ${output.exitCode}`,
    500,
  )
}

/**
 * Each of `asked`, in its order, and then each other name the warnings give, with its outcome: the
 * warning's that names it, or for those none names the one outcome the counts left for them all.
 */
const itemsOf = (
  asked: ReadonlyArray<string>,
  counts: Readonly<Record<LinearOutcome, number>>,
  warned: ReadonlyArray<Required<LinearItem>>,
): ReadonlyArray<LinearItem> => {
  const byName = new Map<string, Required<LinearItem>>()
  for (const item of warned) if (!byName.has(item.name)) byName.set(item.name, item)
  const unnamed = asked.filter((name, at) => !byName.has(name) && asked.indexOf(name) === at)
  // The counts but those of the warned: a skip or failure bd named is one it counted (mostly).
  const left: Record<LinearOutcome, number> = { ...counts }
  for (const item of byName.values()) left[item.outcome] = Math.max(0, left[item.outcome] - 1)
  const outcomes = (Object.keys(left) as Array<LinearOutcome>).filter((key) => left[key] > 0)
  const only = outcomes.length === 1 && left[outcomes[0] as LinearOutcome] === unnamed.length
  const fallback: LinearOutcome | undefined =
    unnamed.length === 0
      ? undefined
      : only
        ? outcomes[0]
        : // bd counted and named nothing: it had nothing to do (a ticket it filters out of a push).
          Object.values(counts).every((each) => each === 0) && byName.size === 0
          ? "skipped"
          : undefined
  const seen = new Set<string>()
  const items: Array<LinearItem> = []
  for (const name of [...asked, ...byName.keys()]) {
    if (seen.has(name)) continue
    seen.add(name)
    const warnedOf = byName.get(name)
    items.push(warnedOf ?? (fallback === undefined ? { name } : { name, outcome: fallback }))
  }
  return items
}

const count = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/** What the SyncResult says the sync did with each of `asked`. */
const syncOf = (asked: ReadonlyArray<string>, result: SyncResult): LinearSync => {
  const counts = {
    created: count(result.stats.created),
    updated: count(result.stats.updated),
    skipped: count(result.stats.skipped),
    failed: count(result.stats.errors),
  }
  const warnings = result.warnings ?? []
  const warned = warnings.flatMap((warning) => namedIn(warning) ?? [])
  return { ...counts, items: itemsOf(asked, counts, warned), warnings }
}

/**
 * Judges what `bd linear sync --json` printed, given `asked`, the tickets or issues it was given: a
 * sync bd exited 0 from with a SyncResult is what it did; one it exited otherwise from is refused,
 * with what it said; one that exited 0 with anything else is unreadable.
 */
export const judgeSync = (
  command: string,
  asked: ReadonlyArray<string>,
  output: BdOutput,
): Effect.Effect<LinearSync, LinearRefused | LinearUnreadable> => {
  const json = jsonIn(output.stdout)
  if (output.exitCode !== 0) {
    return Effect.fail(
      new LinearRefused({ command, exitCode: output.exitCode, reason: refusal(output, json) }),
    )
  }
  const result = Option.flatMap(json, (json) =>
    Schema.decodeUnknownOption(SyncResult)(payload(json)),
  )
  if (Option.isNone(result)) {
    return Effect.fail(unreadable(command, "a Linear sync's result", output.stdout))
  }
  if (!result.value.success) {
    return Effect.fail(new LinearRefused({ command, exitCode: 0, reason: refusal(output, json) }))
  }
  return Effect.succeed(syncOf(asked, result.value))
}

/** bd linear status, as tutti reads it. */
export interface LinearStatus {
  /** Credentials and a team, from bd's configuration or the environment it was given. */
  readonly configured: boolean
  /** How bd would sign in: oauth, api_key or none. */
  readonly authMode: string
  readonly teamIds: ReadonlyArray<string>
  /** When bd last synced, RFC 3339; absent if never. */
  readonly lastSync?: string
  /** How many tickets have a Linear external_ref. */
  readonly linked: number
  /** How many tickets have no external_ref. */
  readonly unlinked: number
}

const Status = Schema.Struct({
  configured: Schema.Boolean,
  auth_mode: Schema.optionalKey(Schema.NullOr(Schema.String)),
  team_ids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  last_sync: Schema.optionalKey(Schema.NullOr(Schema.String)),
  with_linear_ref: Count,
  pending_push: Count,
})

/** Judges what `bd linear status --json` printed. */
export const judgeStatus = (
  command: string,
  output: BdOutput,
): Effect.Effect<LinearStatus, LinearRefused | LinearUnreadable> => {
  const json = jsonIn(output.stdout)
  if (output.exitCode !== 0) {
    return Effect.fail(
      new LinearRefused({ command, exitCode: output.exitCode, reason: refusal(output, json) }),
    )
  }
  const status = Option.flatMap(json, (json) => Schema.decodeUnknownOption(Status)(payload(json)))
  if (Option.isNone(status)) {
    return Effect.fail(unreadable(command, "bd linear status", output.stdout))
  }
  const { value } = status
  return Effect.succeed({
    configured: value.configured,
    authMode: value.auth_mode ?? "none",
    teamIds: value.team_ids ?? [],
    ...(value.last_sync ? { lastSync: value.last_sync } : {}),
    linked: count(value.with_linear_ref),
    unlinked: count(value.pending_push),
  })
}

const unreadable = (command: string, what: string, stdout: string): LinearUnreadable =>
  new LinearUnreadable({ command, reason: `not ${what}`, output: clip(stdout.trim(), 200) })
