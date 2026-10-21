// tutti init's import (§ 8.3): in a project with .orchestra/ and no .tutti/, init offers to import
// orchestra's worker prompt and the settings tutti understands, from orchestra 0.7.7's
// .orchestra/settings.json (flat keys: check_fast, concurrent, environment_hold, …). Each understood
// key maps to tutti's (§ 8.4) where its value decodes there; the rest are named with why they
// aren't imported. An imported worker prompt is copied as it is, keeping the project's changes, and
// the changes § 4.11 needs in it are listed: tabs, .orchestra paths, wt/ branches, the orchestrator,
// the time and --ticket lines, and the rules tutti words differently. Nothing here writes, so
// .orchestra/ is left as it is.
import { join } from "node:path"
import { Effect, Exit, FileSystem, Option } from "effect"
import { decodeConfig } from "../project/configFile.ts"
import { ticketIdPlaceholder } from "../project/prompt.ts"
import { Settings, settingsFile } from "../project/settings.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { joinAnd, type Step, step } from "./steps.ts"

/** orchestra's folder, from the project's top. */
export const orchestraDir = ".orchestra"

/** orchestra's settings, from the project's top. */
export const orchestraSettingsFile = join(orchestraDir, "settings.json")

/** orchestra's worker prompt, from the project's top. */
export const orchestraPromptFile = join(orchestraDir, "worker-prompt.md")

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** An orchestra setting imported: its key, and the tutti key it went to. */
export interface Imported {
  readonly key: string
  readonly to: string
}

/** An orchestra setting left out: its key, as the summary shows it with its value, and why. */
export interface LeftOut {
  readonly key: string
  readonly why: string
}

/** What importing orchestra's settings gives: tutti's settings JSON, and what went where. */
export interface SettingsImport {
  /** The imported keys as tutti's settings JSON: only those, each section as deep as it goes. */
  readonly json: Json
  readonly imported: ReadonlyArray<Imported>
  readonly leftOut: ReadonlyArray<LeftOut>
  /** orchestra's settings don't choose the MCP servers, which there means every one defined. */
  readonly mcpUnset: boolean
}

/** A key and its value as the summary shows them: `terminal ("tmux")`. */
const shown = (key: string, value: unknown): string => {
  const json = JSON.stringify(value) ?? String(value)
  return sanitizeLine(`${key} (${json.length > 60 ? `${json.slice(0, 57)}...` : json})`)
}

/** Sets `value` at `path` in `json`, making the sections on the way. */
const setPath = (json: Json, path: ReadonlyArray<string>, value: unknown) => {
  let holder = json
  for (const key of path.slice(0, -1)) {
    const next = holder[key]
    if (isObject(next)) holder = next
    else {
      const made: Json = {}
      holder[key] = made
      holder = made
    }
  }
  holder[path.at(-1) as string] = value
}

/** Where each understood orchestra key goes in tutti's settings; environment_hold is its own. */
const mapped: Readonly<Record<string, ReadonlyArray<string>>> = {
  check_fast: ["checks", "fast", "command"],
  check_full: ["checks", "full", "command"],
  check_own: ["checks", "own", "command"],
  check_fast_timeout: ["checks", "fast", "timeout"],
  check_full_timeout: ["checks", "full", "timeout"],
  setup: ["checks", "setup", "command"],
  setup_files: ["checks", "setup", "files"],
  concurrent: ["concurrent"],
  ticket_limit: ["workers", "ticket_limit"],
  mcp_servers: ["workers", "mcp_servers"],
  worker_effort: ["workers", "effort"],
  organ_effort: ["organs", "effort"],
  exclude_types: ["queue", "exclude_types"],
  footprint: ["queue", "footprint"],
  resolve_conflicts: ["merge", "resolve_conflicts"],
  resolve_timeout: ["merge", "resolve_timeout"],
  check_hand_backs: ["merge", "check_hand_backs"],
  merge_train: ["merge", "train"],
}

/** orchestra's old names, read as their new ones where those aren't set, as orchestra reads them. */
const oldNames: Readonly<Record<string, string>> = {
  check: "check_fast",
  check_timeout: "check_fast_timeout",
}

/** orchestra settings tutti knows and has no place for: why. */
const unplaced: Readonly<Record<string, string>> = {
  terminal: "tutti has no terminals; its workers run inside it",
  templates: "the versions of orchestra's templates; tutti records those of its own",
}

const environmentHoldKeys = ["count", "window", "probe"]

/** `record`'s own value at `key`: none for a key it only inherits, such as "constructor". */
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

/**
 * A value orchestra reads as unset, so that its default applies: an empty text (its omitempty
 * fields), a concurrency of 0, null.
 */
const unset = (key: string, value: unknown): boolean =>
  value === null || value === "" || (key === "concurrent" && value === 0)

/** The value tutti's key takes for orchestra's: its ticket limit "0" is no limit, tutti's null. */
const converted = (key: string, value: unknown): unknown =>
  key === "ticket_limit" && value === "0" ? null : value

/** Why `fragment` doesn't decode as tutti's settings, or null when it does. */
const problemWith = (fragment: Json): string | null => {
  const decoded = decodeConfig(Settings, settingsFile, fragment)
  if (Exit.isSuccess(decoded)) return null
  const problems = decoded.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail"
      ? reason.error.problems.map(
          (problem) => `${problem.path === "" ? "" : `${problem.path}: `}${problem.message}`,
        )
      : [],
  )
  return problems.length === 0
    ? "tutti's settings can't take it"
    : sanitizeLine(problems.join("; "))
}

/**
 * Imports orchestra's settings, `orchestra` as .orchestra/settings.json parses: each understood key
 * whose value tutti's settings take, and every other key named with why it isn't imported.
 */
export const importSettings = (orchestra: unknown): SettingsImport => {
  if (!isObject(orchestra)) {
    return {
      json: {},
      imported: [],
      leftOut: [{ key: orchestraSettingsFile, why: "isn't a JSON object" }],
      mcpUnset: false,
    }
  }
  const json: Json = {}
  const imported: Array<Imported> = []
  const leftOut: Array<LeftOut> = []
  /** Imports `value` to `path` if tutti's settings take it there; else names `key`. */
  const take = (key: string, value: unknown, path: ReadonlyArray<string>) => {
    const fragment: Json = {}
    setPath(fragment, path, value)
    const problem = problemWith(fragment)
    if (problem !== null) {
      leftOut.push({ key: shown(key, value), why: `tutti can't take it: ${problem}` })
      return
    }
    setPath(json, path, value)
    imported.push({ key, to: path.join(".") })
  }
  for (const [key, value] of Object.entries(orchestra)) {
    const target = own(mapped, key)
    if (target !== undefined) {
      if (!unset(key, value)) take(key, converted(key, value), target)
      continue
    }
    const newName = own(oldNames, key)
    if (newName !== undefined) {
      if (unset(key, value)) continue
      const replaced = own(orchestra, newName)
      if (replaced !== undefined && !unset(newName, replaced)) {
        leftOut.push({
          key: shown(key, value),
          why: `orchestra's old name for ${newName}, set too`,
        })
      } else {
        take(key, value, mapped[newName] as ReadonlyArray<string>)
      }
      continue
    }
    if (key === "environment_hold") {
      if (value === null) continue
      if (!isObject(value)) {
        leftOut.push({ key: shown(key, value), why: "isn't an object" })
        continue
      }
      for (const [inner, innerValue] of Object.entries(value)) {
        const name = `${key}.${inner}`
        if (!environmentHoldKeys.includes(inner)) {
          leftOut.push({
            key: shown(name, innerValue),
            why: "not an orchestra setting tutti knows",
          })
        } else if (!(innerValue === null || innerValue === "")) {
          take(name, innerValue, [key, inner])
        }
      }
      continue
    }
    leftOut.push({
      key: shown(key, value),
      why: own(unplaced, key) ?? "not an orchestra setting tutti knows",
    })
  }
  return {
    json,
    imported,
    leftOut,
    mcpUnset: unset("mcp_servers", own(orchestra, "mcp_servers") ?? null),
  }
}

/** A change § 4.11 needs in an imported worker prompt: on which line (null: the whole), and what. */
export interface PromptChange {
  readonly line: number | null
  readonly change: string
}

/** Each line rule: what on a line needs a change, and the change. */
const lineRules: ReadonlyArray<{ readonly test: RegExp; readonly change: string }> = [
  {
    test: /\btabs?\b|\b(?:herdr|tmux|cmux)\b/i,
    change: "tutti has no tabs or terminals: its workers run inside it",
  },
  { test: /\.orchestra\b/, change: ".orchestra/ is .tutti/ for tutti" },
  { test: /\bwt\//, change: "wt/<id> is tutti/<id>: tutti's branches" },
  { test: /(?<![.\w-])orchestra(?:tor)?\b/i, change: "the orchestrator is tutti" },
  {
    test: /\byou have about\b.*\bfor this ticket\b|--ticket-limit\b|\bticket[_ ]limit\b/i,
    change: "the time a worker has goes in its first message, so remove it",
  },
  {
    test: /\band its subtickets only\b|--ticket\b(?!-)/i,
    change: "the --ticket line goes in the first message, so remove it",
  },
  {
    test: /\byou look idle\b|\bstops the run to ask whether you need an answer\b/i,
    change:
      "checks in the foreground have tutti's reason: a worker waiting on a background command holds its place in the run doing nothing, and its ticket can't merge until the command ends",
  },
  {
    test: /\bholds such a removal for a person\b/i,
    change:
      "a removal the safety check holds has tutti's reason: it is refused unless a person approves it, and in auto mode refused outright",
  },
]

/**
 * The changes § 4.11 needs in `prompt`, an orchestra worker prompt: each line's, in order, then
 * those to the whole. Each change appears once per line it is needed on.
 */
export const promptChanges = (prompt: string): ReadonlyArray<PromptChange> => {
  const changes: Array<PromptChange> = []
  prompt.split("\n").forEach((text, index) => {
    for (const rule of lineRules) {
      if (rule.test.test(text)) changes.push({ line: index + 1, change: rule.change })
    }
  })
  if (!prompt.includes(ticketIdPlaceholder)) {
    changes.push({
      line: null,
      change: `add ${ticketIdPlaceholder}, which tutti replaces with the ticket's ID`,
    })
  }
  if (!prompt.includes("AskUserQuestion")) {
    changes.push({
      line: null,
      change:
        "questions: a decision that blocks the ticket and can wait is a human question ticket; a quick choice the maintainer is likely there to make is AskUserQuestion (tutti's built-in prompt words it)",
    })
  }
  if (!/\bsends? you a message\b/i.test(prompt)) {
    changes.push({
      line: null,
      change:
        "working unattended: the maintainer may sometimes send a message; follow it, then carry on with the ticket",
    })
  }
  return changes
}

/** What .orchestra/ holds to import: its settings, imported, and its worker prompt. */
export interface OrchestraProject {
  /** null when orchestra has no settings file. */
  readonly settings: SettingsImport | null
  /** The worker prompt's text, null when orchestra has none. */
  readonly prompt: string | null
}

/** Reads `path` in `repo`: its text, or none where it is missing or isn't a file one can read. */
const readOptional = (repo: string, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(join(repo, path)).pipe(Effect.option)
  })

/**
 * What the project at `repo` has to import from orchestra: none where .tutti/ is there, .orchestra/
 * isn't, or holds neither settings nor a worker prompt. It only reads.
 */
export const findOrchestra = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(join(repo, ".tutti"))) return Option.none<OrchestraProject>()
    if (!(yield* fs.exists(join(repo, orchestraDir)))) return Option.none<OrchestraProject>()
    const text = yield* readOptional(repo, orchestraSettingsFile)
    const prompt = yield* readOptional(repo, orchestraPromptFile)
    if (Option.isNone(text) && Option.isNone(prompt)) return Option.none<OrchestraProject>()
    const settings = Option.map(text, (value) => {
      try {
        return importSettings(JSON.parse(value))
      } catch (error) {
        return {
          json: {},
          imported: [],
          leftOut: [
            {
              key: orchestraSettingsFile,
              why: `isn't valid JSON: ${sanitizeLine(error instanceof Error ? error.message : String(error))}`,
            },
          ],
          mcpUnset: false,
        } satisfies SettingsImport
      }
    })
    return Option.some<OrchestraProject>({
      settings: Option.getOrNull(settings),
      prompt: Option.getOrNull(prompt),
    })
  })

/** The offer to import from orchestra, as init's form asks it. */
export interface ImportOffer {
  /** What it would import: the settings' keys, and the worker prompt. */
  readonly imports: ReadonlyArray<string>
  /** What it can't: each key with why. */
  readonly leftOut: ReadonlyArray<string>
}

/** The offer for `found`. */
export const importOffer = (found: OrchestraProject): ImportOffer => ({
  imports: [
    ...(found.settings?.imported.map((each) => each.key) ?? []),
    ...(found.prompt === null ? [] : ["the worker prompt"]),
  ],
  leftOut: found.settings?.leftOut.map((each) => `${each.key}: ${each.why}`) ?? [],
})

/** The offer as the form describes it. */
export const offerDescription = (offer: ImportOffer): string =>
  [
    `This project has ${orchestraDir}/ and no .tutti/.`,
    offer.imports.length === 0
      ? "Nothing in it can be imported."
      : `tutti can import ${joinAnd(offer.imports)}.`,
    offer.leftOut.length === 0 ? "" : `It can't import ${joinAnd(offer.leftOut)}.`,
    `${orchestraDir}/ is left as it is.`,
  ]
    .filter((part) => part !== "")
    .join(" ")

/** The import's steps for its summary: yes, no, or not asked (no terminal). */
export const importSteps = (
  found: OrchestraProject,
  consent: boolean | "unasked",
): ReadonlyArray<Step> => {
  const label = "import"
  if (consent === "unasked") {
    return [
      step(
        "caution",
        label,
        `not asked (no terminal): ${orchestraDir}/ has settings or a worker prompt tutti can import; remove .tutti/ and run tutti init in a terminal to import them`,
      ),
    ]
  }
  if (!consent) {
    return [step("kept", label, `not imported (declined); ${orchestraDir}/ is left as it is`)]
  }
  const settings = found.settings
  const steps: Array<Step> = []
  if (settings !== null) {
    steps.push(
      settings.imported.length === 0
        ? step("kept", label, `nothing in ${orchestraSettingsFile} can be imported`)
        : step(
            "done",
            label,
            `imported ${joinAnd(settings.imported.map((each) => each.key))} from ${orchestraSettingsFile}; ${orchestraDir}/ is left as it is`,
          ),
    )
    for (const each of settings.leftOut) {
      steps.push(step("caution", label, `not imported: ${each.key}: ${each.why}`))
    }
    if (settings.mcpUnset) {
      steps.push(
        step(
          "caution",
          label,
          "mcp_servers isn't set: orchestra gives workers every MCP server Claude Code finds, tutti none; choose them with --mcp",
        ),
      )
    }
  }
  return steps
}

/** The steps for the changes an imported prompt needs, labelled as its step is. */
export const promptChangeSteps = (prompt: string, path: string): ReadonlyArray<Step> =>
  promptChanges(prompt).map((each) =>
    step(
      "caution",
      "worker prompt",
      `${each.line === null ? path : `${path}:${each.line}`}: ${each.change}`,
    ),
  )
