// The tools Claude Code describes in every request a worker makes that workers never call (§ 4.1).
// orchestra's workers called none of them in 484 sessions, and their descriptions, Artifact's above
// all, came to about 28k tokens a call: a worker's first call opened with 11.9k tokens rather than
// 39.2k once they were left out (Claude Code 2.1.303). The SDK runs the same Claude Code. A worker
// keeps the rest, and any tool a later Claude Code adds: Bash, Read, Edit and Write; Agent, which
// runs the verifier; ToolSearch, which loads its MCP servers' tools; the task tools, and the other
// deferred tools such as Monitor; AskUserQuestion unless workers.ask_user_question is off.
//
// Skill goes too, and the listing of the user's skills with it, unless the project has skills of
// its own or enables plugins (projectHasSkills): a worker reaches those only through Skill.
import { join } from "node:path"
import { Effect, FileSystem } from "effect"

/** The tools workers never call, denied to every worker's session. */
export const unusedTools: ReadonlyArray<string> = [
  "Artifact",
  "ListAgents",
  "ReportFindings",
  "ScheduleWakeup",
  "SendFeedback",
  "Workflow",
]

/** The tool that runs skills, denied with the rest when the project has none (projectHasSkills). */
export const skillTool = "Skill"

/** The folders, in the main checkout, whose entries Claude Code lists and runs as skills. */
export const skillFolders: ReadonlyArray<string> = [".claude/skills", ".claude/commands"]

/** The project's Claude settings files, in the main checkout, whose enabledPlugins count. */
export const projectSettingsFiles: ReadonlyArray<string> = [
  ".claude/settings.json",
  ".claude/settings.local.json",
]

/**
 * Whether the project in `repo` has skills for Claude Code: anything in .claude/skills, or in
 * .claude/commands, whose commands Claude Code runs as skills, or a plugin its Claude settings
 * enable (enablesPlugins): .claude/settings.json's or settings.local.json's, both read from the main
 * checkout through projectConfigRoot. A folder or file missing or unreadable has none.
 */
export const projectHasSkills = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const folder of skillFolders) {
      const entries = yield* fs
        .readDirectory(join(repo, folder))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
      if (entries.length > 0) return true
    }
    for (const file of projectSettingsFiles) {
      const settings = yield* fs
        .readFileString(join(repo, file))
        .pipe(Effect.orElseSucceed(() => ""))
      if (enablesPlugins(settings)) return true
    }
    return false
  })

/**
 * Whether `settings`, the text of one of the project's Claude settings files, enables a plugin: an
 * entry of `enabledPlugins` not set to false. Each counts as having skills, as finding a plugin's
 * own would mean finding its marketplace. Text that isn't a JSON object enables none.
 */
export const enablesPlugins = (settings: string): boolean => {
  let json: unknown
  try {
    json = JSON.parse(settings)
  } catch {
    return false
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return false
  const plugins: unknown = (json as { enabledPlugins?: unknown }).enabledPlugins
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return false
  return Object.values(plugins).some((value) => value !== false)
}

/** The tools a worker's session is denied: the unused ones, and Skill when `skills` is false. */
export const deniedTools = (skills: boolean): ReadonlyArray<string> =>
  skills ? unusedTools : [...unusedTools, skillTool]
