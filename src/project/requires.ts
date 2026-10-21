// The project's requires list (§ 8.4's `requires`), as orchestra 0.9.1's: what its machine must
// have, a tool, a service running, a permission. A run checks it as it starts, `tutti init` and
// `tutti requires` do too (src/run/requires.ts). People read the README to set a machine up, tutti
// reads the list; written apart, they drift. So the README's section on what to install is the list
// as Markdown (requiresMarkdown), between two markers: `tutti init` writes it where the README has
// none and keeps it in step, `tutti requires --readme` writes it once the list changes, and a run's
// start says when it differs (README_STALE).
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { type Requirement, settingsFile } from "./settings.ts"

/** Whether `r` applies on the operating system `platform` (process.platform). */
export const appliesOn = (r: Requirement, platform: string): boolean =>
  r.platforms === undefined ||
  r.platforms.length === 0 ||
  (r.platforms as ReadonlyArray<string>).includes(platform)

/** The file in the main checkout's .tutti/run/ that holds the output of `name`'s last install. */
export const requireLogName = (name: string): string => `requires-${name}.log`

/** Whether `a` and `b` are the same requirement, field by field. */
export const sameRequirement = (a: Requirement, b: Requirement): boolean =>
  a.name === b.name &&
  a.check === b.check &&
  a.install === b.install &&
  a.manual === b.manual &&
  (a.platforms ?? []).join(",") === (b.platforms ?? []).join(",")

/** The README the section is kept in, at the repository's top. */
export const readmeName = "README.md"

/** The lines that open and close the section, each on a line of its own. */
export const requiresStart = "<!-- tutti:requires -->"
export const requiresEnd = "<!-- /tutti:requires -->"

const marker = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[ \\t]*\\r?$`, "gmu")

/** The operating systems as people name them. */
const platformNames: Readonly<Record<string, string>> = { darwin: "macOS", linux: "Linux" }

/** The length of the longest run of `char` in `text`. */
const longestRun = (text: string, char: string): number => {
  let longest = 0
  let run = 0
  for (const each of text) {
    run = each === char ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}

/** A nested list item, `label` then the command: a code span for one line, a fenced block for more. */
const mdItem = (label: string, command: string): string => {
  const cmd = command.trim()
  if (!cmd.includes("\n")) {
    const fence = "`".repeat(longestRun(cmd, "`") + 1)
    const pad = cmd.startsWith("`") || cmd.endsWith("`") ? " " : ""
    return `  - ${label}: ${fence}${pad}${cmd}${pad}${fence}\n`
  }
  const fence = "`".repeat(Math.max(3, longestRun(cmd, "`") + 1))
  const lines = cmd.split("\n").map((each) => {
    const trimmed = each.replace(/[ \t\r]+$/u, "")
    return trimmed === "" ? "" : `    ${trimmed}`
  })
  return `  - ${label}:\n\n    ${fence}sh\n${lines.join("\n")}\n    ${fence}\n\n`
}

/**
 * The README's section for the requirements in `list`, its markers included: a heading, then each
 * requirement with how it is checked and how it is installed, or what a person must do; for an
 * empty list, that there is nothing to install.
 */
export const requiresMarkdown = (list: ReadonlyArray<Requirement>): string => {
  const parts = [
    `${requiresStart}\n`,
    `<!-- Generated from "requires" in ${settingsFile}: change the list, then run tutti requires --readme. -->\n`,
    "## What to install\n\n",
  ]
  if (list.length === 0) {
    parts.push(
      `Nothing yet: the project's requires list, \`"requires"\` in \`${settingsFile}\`, has no entries.\n`,
    )
  } else {
    parts.push(
      `What this project needs of the machine, from \`"requires"\` in \`${settingsFile}\`. \`tutti requires\` checks each one and installs what it can.\n\n`,
    )
    for (const r of list) {
      const only =
        r.platforms === undefined || r.platforms.length === 0
          ? ""
          : ` (only on ${r.platforms.map((p) => platformNames[p] ?? p).join(", ")})`
      parts.push(`- **${r.name}**${only}\n`, mdItem("check", r.check))
      parts.push(
        r.install !== undefined && r.install !== ""
          ? mdItem("install", r.install)
          : `  - by hand: ${(r.manual ?? "").trim().split(/\s+/u).join(" ")}\n`,
      )
    }
  }
  parts.push(`${requiresEnd}\n`)
  return parts.join("")
}

/** A README whose section's markers don't pair up: one without the other, or the end before the start. */
export const readmeMarkersProblem = `${readmeName} has ${requiresStart} and ${requiresEnd} out of pair: give each once, the start first, or remove both`

/**
 * Where the section is in `text`: from its start marker's line to the end of its end marker's
 * line; null where `text` has neither marker; readmeMarkersProblem where they don't pair up.
 */
const readmeSection = (
  text: string,
): { readonly start: number; readonly end: number } | null | "unpaired" => {
  const starts = [...text.matchAll(marker(requiresStart))]
  const ends = [...text.matchAll(marker(requiresEnd))]
  if (starts.length === 0 && ends.length === 0) return null
  const [first] = starts
  const [last] = ends
  if (starts.length !== 1 || ends.length !== 1 || first === undefined || last === undefined) {
    return "unpaired"
  }
  if (last.index < first.index + first[0].length) return "unpaired"
  let end = last.index + last[0].length
  if (text[end] === "\n") end++
  return { start: first.index, end }
}

/**
 * `text`, a README, with its section replaced by the one for `list`, or the section added at its
 * end, after a blank line, where it has none; in the README's line endings. Undefined where the
 * markers don't pair up.
 */
export const withRequires = (
  text: string,
  list: ReadonlyArray<Requirement>,
): string | undefined => {
  const crlf = text.includes("\r\n")
  const nl = crlf ? "\r\n" : "\n"
  const section = crlf ? requiresMarkdown(list).replaceAll("\n", "\r\n") : requiresMarkdown(list)
  const found = readmeSection(text)
  if (found === "unpaired") return undefined
  if (found !== null) return text.slice(0, found.start) + section + text.slice(found.end)
  if (text === "") return section
  return `${text.replace(/[\r\n]+$/u, "")}${nl}${nl}${section}`
}

/** How a README stands to the requires list. */
export type ReadmeState =
  /** Its section is the list's. */
  | "inStep"
  /** There is no README.md. */
  | "none"
  /** It has no section. */
  | "noSection"
  /** Its section differs from the list. */
  | "stale"
  /** Its markers don't pair up. */
  | "unpaired"

/** How `text`, a README, stands to `list`. */
export const readmeStateOf = (text: string, list: ReadonlyArray<Requirement>): ReadmeState => {
  const found = readmeSection(text)
  if (found === "unpaired") return "unpaired"
  if (found === null) return "noSection"
  return text.slice(found.start, found.end).replaceAll("\r\n", "\n") === requiresMarkdown(list)
    ? "inStep"
    : "stale"
}

/** The README at `repo`'s top, null where there is none; fails where it can't be read. */
const readReadme = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs
      .readFileString(join(repo, readmeName))
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error.message),
        ),
      )
  })

/** How the README at `repo`'s top stands to `list`; fails saying why it can't be read. */
export const readmeState = (repo: string, list: ReadonlyArray<Requirement>) =>
  Effect.map(readReadme(repo), (text) => (text === null ? "none" : readmeStateOf(text, list)))

/**
 * Writes the section for `list` into the README at `repo`'s top, replacing the one it has or adding
 * one at its end, and creating README.md where there is none: whether it changed. Fails saying why
 * it couldn't, readmeMarkersProblem where the markers don't pair up.
 */
export const writeReadmeRequires = (repo: string, list: ReadonlyArray<Requirement>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = (yield* readReadme(repo)) ?? ""
    const written = withRequires(text, list)
    if (written === undefined) return yield* Effect.fail(readmeMarkersProblem)
    if (written === text) return false
    yield* fs
      .writeFileString(join(repo, readmeName), written)
      .pipe(Effect.mapError((error) => error.message))
    return true
  })

/**
 * What a run's start says of the README at `repo`'s top where it differs from `list`: its section
 * differs, or it has none though the list has entries; null where it is in step, there is no
 * README.md, or there is nothing to say.
 */
export const readmeStaleLine = (repo: string, list: ReadonlyArray<Requirement>) =>
  Effect.map(Effect.result(readmeState(repo, list)), (state): string | null => {
    const fix = ": tutti requires --readme writes it, to commit"
    if (state._tag === "Failure") return `cannot read ${readmeName}: ${state.failure}`
    switch (state.success) {
      case "unpaired":
        return readmeMarkersProblem
      case "stale":
        return `${readmeName}'s section on what to install differs from the requires list in ${settingsFile}${fix}`
      case "noSection":
        return list.length === 0
          ? null
          : `${readmeName} has no section on what to install from the requires list in ${settingsFile}${fix}`
      default:
        return null
    }
  })
