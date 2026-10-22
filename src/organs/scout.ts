// The scout (§ 6.3, § 5 item 13): the organ that finds the checks a project already has, its test
// suites, lints, type checks and builds, for tutti init to choose from, as orchestra v0.7.7's scout
// does. Unlike the other organs, which read only the evidence tutti gathers, it reads the
// repository itself: package scripts, Makefiles, CI workflows, test configs and the project's own
// scripts are too many and too varied to gather. So it is the one organ with tools, and only
// read-only ones, Read, Glob and Grep, listed explicitly, in the repository's root. Its prompt
// (prompts/scout.md) is orchestra's, adapted, and ends with the evidence rule for files it reads.
//
// It is confined to the repository by a PreToolUse hook, which hooks being first in the SDK's
// evaluation order holds whatever the settings allow, as orchestra's --restricted did: a call
// whose path argument, resolved from the root with `~` expanded and then through realpath, lies
// outside the repository is denied, so a symlink inside that points out is denied too. A call the
// hook can't read, or a tool it doesn't know, is denied as well, except StructuredOutput, the tool
// outputFormat adds, which the scout answers with. permissionPrompts none (§ 6.1) denies whatever
// would prompt. It spends at most $2.00, for at most 5 minutes, and keeps no
// transcript. It runs nothing and changes nothing; what becomes of its answer is init's.
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import type { HookCallback, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Schema } from "effect"
import type { OrganReads } from "./AgentSdkLanguageModel.ts"
import { type Organ, type OrganError, OrganFailed, Organs, organDefaults } from "./Organs.ts"
import prompt from "./prompts/scout.md" with { type: "text" }

// ---------------------------------------------------------------------------------------------
// The answer

/** What a suite checks. */
export const suiteKinds = [
  "unit",
  "integration",
  "e2e",
  "lint",
  "typecheck",
  "build",
  "other",
] as const

/** When a suite runs: fast on every merge, full at the end of a run. */
export const tiers = ["fast", "full"] as const

/** One check the scout found. */
export const Suite = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(suiteKinds),
  /** As the project runs it, from the repository's root. */
  command: Schema.String,
  /**
   * Runs the suite on part of the project, a <placeholder> for the part, such as
   * "go test ./<package>/..." or "pytest <paths>"; "" where its tool can only run it whole.
   */
  targeted: Schema.String,
  /** Where it is defined, as `path:line`. */
  found_in: Schema.String,
  tier: Schema.Literals(tiers),
  /**
   * A full suite that runs everything the fast suites do and more, as a slow-mode flag on the same
   * runner does: the full check runs it alone, not after the fast ones, so each test runs once.
   */
  covers_fast: Schema.Boolean,
  /** A build or packaging step found only in CI (a release compile, a docker build). */
  ci_build: Schema.Boolean,
  /** What running it costs where that is much, such as "a 340 MB compile"; "" otherwise. */
  cost: Schema.String,
  /** False for a fixed port, a shared database and the like. */
  parallel_safe: Schema.Boolean,
  /** Services, a browser, credentials; empty for none. */
  needs: Schema.Array(Schema.String),
})
export type Suite = typeof Suite.Type

/** The scout's answer: orchestra's schema. */
export const ScoutAnswer = Schema.Struct({
  /** Empty when none was found. */
  suites: Schema.Array(Suite),
  /** The languages, frameworks and tools, such as "Go 1.26"; may be empty. */
  stack: Schema.Array(Schema.String),
  /** With no suites, what the scout looked at. */
  note: Schema.String,
})
export type Scouting = typeof ScoutAnswer.Type

/**
 * Whether a suite's command for part of the project has a placeholder for the part, such as
 * <paths> or ./<package>/...: without one it would run the whole suite, or nothing a worker can
 * fill in.
 */
export const hasPlaceholder = (command: string): boolean => /<[^<>]*\S[^<>]*>/.test(command)

/**
 * The answer tidied, as orchestra's: names, commands, places and costs trimmed, a command for part
 * of the project without a placeholder dropped, covers_fast kept only on a full suite, blank needs
 * and stack items dropped, stack items' spaces
 * collapsed and duplicates dropped. A suite with no name or no command is the reason it can't be
 * used.
 */
export const tidy = (answer: Scouting): Scouting | string => {
  const suites: Array<Suite> = []
  for (const suite of answer.suites) {
    const name = suite.name.trim()
    const command = suite.command.trim()
    if (name === "" || command === "") {
      return `a suite with no name or no command: ${JSON.stringify(suite)}`
    }
    const targeted = suite.targeted.trim()
    suites.push({
      ...suite,
      name,
      command,
      targeted: hasPlaceholder(targeted) ? targeted : "",
      found_in: suite.found_in.trim(),
      // Only a full suite stands for the fast ones.
      covers_fast: suite.covers_fast && suite.tier === "full",
      cost: suite.cost.trim(),
      needs: suite.needs.map((need) => need.trim()).filter((need) => need !== ""),
    })
  }
  const stack: Array<string> = []
  for (const item of answer.stack) {
    const words = item.trim().split(/\s+/).join(" ")
    if (words !== "" && !stack.includes(words)) stack.push(words)
  }
  return { suites, stack, note: answer.note.trim() }
}

// ---------------------------------------------------------------------------------------------
// Confinement

/** The scout's tools, listed explicitly: native builds may otherwise search with Bash. */
export const scoutTools = ["Read", "Glob", "Grep"] as const

/** The tool the SDK's outputFormat adds, which an organ gives its answer with. */
export const answerTool = "StructuredOutput"

/** The most the scout may spend, in US dollars. */
export const scoutBudget = 2.0

/**
 * `path` as a tool names it, made absolute from `cwd` with a leading `~` as `home`, and then real:
 * its longest part that exists through realpath, the rest after it.
 */
export const realPath = (path: string, cwd: string, home: string): string => {
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path
  let head = resolve(cwd, expanded)
  const rest: Array<string> = []
  for (;;) {
    try {
      return join(realpathSync(head), ...rest)
    } catch {
      const up = dirname(head)
      if (up === head) return join(head, ...rest)
      rest.unshift(head.slice(up.length).replace(/^[/\\]+/, ""))
      head = up
    }
  }
}

/** Whether `path`, real, lies in `root`, real. */
export const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

// A glob segment's special characters.
const globChars = /[*?[\]{}!]/

/** The part of a glob pattern before its first segment with a glob character: `src/`'s `src`. */
export const globBase = (pattern: string): string => {
  const segments = pattern.split("/")
  const at = segments.findIndex((segment) => globChars.test(segment))
  const base = (at === -1 ? segments : segments.slice(0, at)).join("/")
  return base === "" && pattern.startsWith("/") ? "/" : base === "" ? "." : base
}

/** Why the call `input` is denied, or undefined to let it be: its tool and path arguments. */
export const outside = (
  root: string,
  home: string,
  tool: string,
  input: unknown,
): string | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return `${tool}'s input can't be read`
  }
  const args = input as Record<string, unknown>
  const pathOf = (key: string, required: boolean): string | undefined | null => {
    const value = args[key]
    if (value === undefined && !required) return undefined
    return typeof value === "string" ? value : null
  }
  const check = (value: string | undefined | null, key: string): string | undefined => {
    if (value === null) return `${tool}'s ${key} isn't a path`
    if (value === undefined) return undefined
    return inside(root, realPath(value, root, home))
      ? undefined
      : `${tool}'s ${key} ${JSON.stringify(value)} lies outside the repository`
  }
  switch (tool) {
    case "Read":
      return check(pathOf("file_path", true), "file_path")
    case "Grep":
      return check(pathOf("path", false), "path")
    case "Glob": {
      // The pattern may be absolute, or go up from the path: its base is checked, from the path.
      const path = pathOf("path", false)
      const pattern = pathOf("pattern", true)
      if (typeof pattern !== "string") return check(null, "pattern")
      if (pattern.split("/").includes("..")) return "Glob's pattern goes up with .."
      const base = globBase(pattern)
      const from = isAbsolute(base) || base.startsWith("~") ? base : join(path ?? ".", base)
      return check(path, "path") ?? check(from, "pattern")
    }
    // The tool outputFormat adds, which the scout answers with: it reads nothing.
    case answerTool:
      return undefined
    default:
      return `${tool} isn't one of the scout's tools`
  }
}

/** What the confinement hook returns for `input`: a denial with its reason, or no decision. */
export const confinement = (root: string, home: string, input: HookInput): HookJSONOutput => {
  let reason: string | undefined
  try {
    if (input.hook_event_name !== "PreToolUse") return {}
    reason = outside(root, home, input.tool_name, input.tool_input)
  } catch (error) {
    // A call the hook can't decide on is denied.
    reason = `the scout's confinement failed: ${error instanceof Error ? error.message : error}`
  }
  if (reason === undefined) return {}
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `The scout reads only inside the repository: ${reason}.`,
    },
  }
}

/** The scout's tools, in `root`, confined to it. */
export const scoutReads = (root: string, home: string = homedir()): OrganReads => {
  const hook: HookCallback = async (input) => confinement(root, home, input)
  return {
    tools: scoutTools,
    cwd: root,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    maxBudgetUsd: scoutBudget,
  }
}

// ---------------------------------------------------------------------------------------------
// The organ

/** The scout's input: it reads the rest itself. */
export const scoutInput = "Find the checks of the repository in your working directory."

/** The scout of the repository at `root`, a real path. */
export const scout = (root: string, home?: string): Organ<Scouting> => ({
  name: "scout",
  system: prompt.trimEnd(),
  answer: ScoutAnswer,
  ...organDefaults.scout,
  reads: scoutReads(root, home),
})

/** The real path of `root`, or `root` itself when it has none. */
const real = (root: string): string => {
  try {
    return realpathSync(root)
  } catch {
    return resolve(root)
  }
}

/** The checks of the repository at `root`, as the scout finds them, tidied. */
export const scoutChecks = (root: string): Effect.Effect<Scouting, OrganError, Organs> =>
  Effect.gen(function* () {
    const organ = scout(real(root))
    const answer = tidy(yield* (yield* Organs).ask(organ, [scoutInput]))
    if (typeof answer === "string") {
      return yield* new OrganFailed({ organ: organ.name, subtype: null, reason: answer })
    }
    return answer
  })
