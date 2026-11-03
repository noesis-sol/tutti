// --overnight's check of the ask rules (tutti-epza.10): in auto mode, a call a `permissions.ask`
// rule names still reaches tutti as a permission request, which an overnight run denies after 30 s
// (Attention's denyPermissions), nobody being there to answer. A rule on something every ticket
// does (git push, a bd write) would have every worker refused it all night: the pre-flight warns
// of the rules in the Claude settings the workers load (agent/options.ts's settingSources), the
// user's and the project's two, read from the main checkout as projectConfigRoot has them read.
import { join } from "node:path"
import { Config, type Duration, Effect, FileSystem, Option, Predicate } from "effect"
import { projectSettingsFiles } from "../agent/unusedTools.ts"
import { formatDuration } from "../project/configFile.ts"
import { accountHome } from "../project/userConfig.ts"
import type { Found } from "./overnight.ts"

/** A Claude settings file the workers load, and the `permissions.ask` rules it has. */
export interface AskRules {
  readonly file: string
  readonly rules: ReadonlyArray<string>
}

/**
 * Where Claude Code keeps the user's settings: `settings.json` in CLAUDE_CONFIG_DIR, or in the home
 * directory's `.claude` when that is unset or empty, the home directory as mcp.ts's
 * claudeConfigFile reads it.
 */
export const claudeUserSettingsFile = Effect.gen(function* () {
  const dir = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR"))
  const home = yield* Config.option(Config.String("HOME"))
  const nonEmpty = (value: string) => value !== ""
  return Option.filter(dir, nonEmpty).pipe(
    Option.map((set) => join(set, "settings.json")),
    Option.orElse(() => Option.map(Option.filter(home, nonEmpty), (h) => claudeDir(h))),
    Option.getOrElse(() => claudeDir(accountHome())),
  )
}).pipe(Effect.orDie)

const claudeDir = (home: string) => join(home, ".claude", "settings.json")

/** The settings files the workers load: the user's `user`, then the project's in `repo`. */
export const workerSettingsFiles = (user: string, repo: string): ReadonlyArray<string> => [
  user,
  ...projectSettingsFiles.map((file) => join(repo, file)),
]

/**
 * The `permissions.ask` rules of `settings`, a Claude settings file's text, in its order: none
 * where it isn't a JSON object with a list of them; an entry that isn't a non-empty string is left
 * out.
 */
export const askRulesOf = (settings: string): ReadonlyArray<string> => {
  let json: unknown
  try {
    json = JSON.parse(settings)
  } catch {
    return []
  }
  if (!Predicate.isObject(json)) return []
  const permissions = json.permissions
  if (!Predicate.isObject(permissions)) return []
  const ask = permissions.ask
  if (!Array.isArray(ask)) return []
  return ask.filter((rule): rule is string => typeof rule === "string" && rule.trim() !== "")
}

/** The ask rules of each of `files` that has some; a file missing or unreadable has none. */
export const readAskRules = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const found: Array<AskRules> = []
    for (const file of files) {
      const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
      const rules = askRulesOf(text)
      if (rules.length > 0) found.push({ file, rules })
    }
    return found
  })

/** How many of a file's rules the check names, the rest counted. */
const named = 3

/**
 * The pre-flight's check of `found`, the ask rules in the workers' settings: it warns of each file
 * with some, naming them, as each such request is denied `after` (30s) overnight.
 */
export const askRulesCheck = (found: ReadonlyArray<AskRules>, after: string): Found => {
  if (found.length === 0) {
    return { verdict: "passed", text: "no permissions.ask rules in the settings workers load" }
  }
  const each = found.map(({ file, rules }) => {
    const shown = rules.slice(0, named).join(", ")
    const more = rules.length > named ? `, and ${rules.length - named} more` : ""
    return `${file} (${shown}${more})`
  })
  return {
    verdict: "warned",
    text: `permissions.ask rules in ${each.join("; ")} make a worker ask, even in auto mode: overnight, tutti denies each such request after ${after}, nobody being there to answer, and a ticket that needs one is left undone. Move the rules a ticket needs to permissions.allow for the night`,
  }
}

/** The check, reading `files`, the settings files the workers load. */
export const askRulesFound = (files: ReadonlyArray<string>, after: Duration.Duration) =>
  Effect.map(readAskRules(files), (found) => askRulesCheck(found, formatDuration(after)))
