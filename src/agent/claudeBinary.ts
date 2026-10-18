// The Claude Code tutti's sessions run (§ 12 "Claude Code itself is embedded" and "Another Claude
// Code", § 4.1 `pathToClaudeCodeExecutable`): the workers', the login probe's, the organs' and
// tutti login's. It is, first match wins:
//
// - **Another Claude Code**, `--claude <path>` (or TUTTI_CLAUDE). A path with no `/` is looked up
//   on PATH, any other is taken from the folder tutti was started in. tutti runs `<path>
//   --version` and warns when the version is outside the range below; it runs it all the same.
// - **The embedded one**, in a compiled build. The build's entry (src/entries/<target>.ts) imports
//   its platform package's `claude` as a file, which lives in Bun's $bunfs once compiled, and hands
//   it to `embed`. A child process can't run a file in $bunfs, so the SDK's `extractFromBunfs`
//   copies it out, into a folder named after its content's hash: once per version, and reused by
//   every later run of that version. A later run finds that copy by the SDK manifest's checksum,
//   without reading and hashing the embedded file again, and removes other versions' stale copies
//   (claudeExtract.ts). This runs once per run, in the startup checks, and every session gets the
//   path from the configuration.
// - **The SDK's own**, run from source: no path, and the SDK resolves its platform package's
//   binary itself.
//
// The range (§ 12): from the SDK's `claudeCodeVersion`, the Claude Code its platform packages
// carry and a compiled tutti embeds, read from its package.json at build time, to 30 patch
// releases above it. The SDK checks none itself: below it, features tutti relies on may be
// missing; above it, a release may no longer be tested with tutti's SDK.
import { dirname, isAbsolute, resolve } from "node:path"
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract"
import sdk from "@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" }
import { Effect, Option } from "effect"
import { exec } from "../services/exec.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { extractedCopy, extractionBase, knownFor, tidyExtracted } from "./claudeExtract.ts"

/** The Claude Code a compiled tutti embeds: the one the SDK's platform packages carry. */
export const embeddedVersion: string = sdk.claudeCodeVersion

/** How many patch releases above `embeddedVersion` the range reaches. */
export const rangePatches = 30

/** A Claude Code version: major, minor and patch. */
export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** The first `<major>.<minor>.<patch>` in `text`, as `claude --version` prints it. */
export const parseVersion = (text: string): Option.Option<Version> => {
  const found = /(?<![\d.])(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?!\.?\d)/.exec(text)
  if (found === null) return Option.none()
  const [, major, minor, patch] = found.map(Number)
  return major === undefined || minor === undefined || patch === undefined
    ? Option.none()
    : Option.some({ major, minor, patch })
}

export const showVersion = (version: Version): string =>
  `${version.major}.${version.minor}.${version.patch}`

const compare = (a: Version, b: Version): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch

/** The versions tutti supports, both ends included. */
export interface Range {
  readonly from: Version
  readonly to: Version
}

/** The range from `base` to `rangePatches` patch releases above it. */
export const rangeFrom = (base: Version): Range => ({
  from: base,
  to: { ...base, patch: base.patch + rangePatches },
})

/** The range tutti supports: from the embedded Claude Code's version. */
export const supportedRange: Range = rangeFrom(Option.getOrThrow(parseVersion(embeddedVersion)))

export const inRange = (version: Version, range: Range): boolean =>
  compare(version, range.from) >= 0 && compare(version, range.to) <= 0

/**
 * The warning for another Claude Code at `path`, whose `--version` printed `output`: none when its
 * version is in `range`. It names the version, the range and the embedded Claude Code's version.
 */
export const versionWarning = (
  path: string,
  output: string,
  range: Range = supportedRange,
): string | null => {
  const version = parseVersion(output)
  const supported = `tutti supports ${showVersion(range.from)} to ${showVersion(range.to)}, and embeds ${embeddedVersion}`
  if (Option.isNone(version)) {
    const printed = sanitizeLine(output.trim()).slice(0, 200)
    return `couldn't read the version of the Claude Code at ${path} (--claude) in its --version, "${printed}": ${supported}. tutti runs it all the same`
  }
  if (inRange(version.value, range)) return null
  return `the Claude Code at ${path} (--claude) is ${showVersion(version.value)}, outside the range: ${supported}. tutti runs it all the same`
}

// The platform's claude, imported as a file by a compiled build's entry, and the build's target;
// null from source.
let embeddedFile: string | null = null
let embeddedTarget: string | null = null

/**
 * Called by a compiled build's entry, before tutti starts, with its platform package's `claude`
 * imported as a file: `import claude from "@anthropic-ai/claude-agent-sdk-<target>/claude" with
 * { type: "file" }`, and its `<target>`, as the SDK's manifest names it.
 */
export const embed = (file: string, target: string): void => {
  embeddedFile = file
  embeddedTarget = target
}

/** The Claude Code sessions run, as the startup checks resolved it. */
export interface Claude {
  /** Its executable, for `pathToClaudeCodeExecutable`; null for the SDK's own. */
  readonly path: string | null
  /** What the run says once as it starts, but doesn't stop it: another Claude Code's version. */
  readonly warnings: ReadonlyArray<string>
  /** Setup problems: no Claude Code at the given path, or the embedded one not extracted. */
  readonly problems: ReadonlyArray<string>
}

/** Where the Claude Code comes from, and how to read it. */
export interface Sources<R> {
  /** The folder tutti was started in, which a relative `--claude` path is taken from. */
  readonly cwd: string
  /** The embedded file, in $bunfs; null from source. */
  readonly embedded: string | null
  /** A real file with the embedded one's content: `extractFromBunfs`, its argument if it fails. */
  readonly extract: (file: string) => string
  /** Keeps the extracted copy at a path in use, and removes other versions' stale copies. */
  readonly tidy: (path: string) => void
  /** Where a command name with no `/` is on PATH, or null. */
  readonly which: (command: string) => string | null
  /** What `<path> --version` printed, or why it printed nothing. */
  readonly version: (path: string) => Effect.Effect<string, string, R>
}

/** Whether a path names a file in Bun's $bunfs (`/$bunfs/…`, or `B:\~BUN\…` on Windows). */
const inBunfs = (path: string): boolean => path.includes("$bunfs") || path.includes("~BUN")

/** The Claude Code sessions run: `given` (--claude), else the embedded one, else the SDK's. */
export const resolveWith = <R>(
  given: string | null,
  sources: Sources<R>,
): Effect.Effect<Claude, never, R> =>
  Effect.gen(function* () {
    if (given !== null) {
      const path = !given.includes("/")
        ? sources.which(given)
        : isAbsolute(given)
          ? given
          : resolve(sources.cwd, given)
      if (path === null) {
        return {
          path: given,
          warnings: [],
          problems: [`There is no ${given} on PATH, for --claude ${given}.`],
        }
      }
      const output = yield* Effect.result(sources.version(path))
      if (output._tag === "Failure") {
        const why = sanitizeLine(output.failure.trim())
        return {
          path,
          warnings: [],
          problems: [`The Claude Code at ${path} (--claude) doesn't run: ${why}`],
        }
      }
      const warning = versionWarning(path, output.success)
      return { path, warnings: warning === null ? [] : [warning], problems: [] }
    }
    if (sources.embedded === null) return { path: null, warnings: [], problems: [] }
    const file = sources.embedded
    const path = yield* Effect.sync(() => sources.extract(file))
    if (!inBunfs(path)) {
      yield* Effect.sync(() => sources.tidy(path))
      return { path, warnings: [], problems: [] }
    }
    return {
      path,
      warnings: [],
      problems: [
        "tutti couldn't copy its embedded Claude Code out to a file it can run. Make room in the " +
          "temporary folder, set CLAUDE_CODE_TMPDIR to a folder with room, or run another " +
          "Claude Code with --claude <path>.",
      ],
    }
  })

// `--version` gets a minute: a binary's first run on macOS waits on Gatekeeper, and under Rosetta
// took 32 s (docs/spikes/07-compile.md).
const claudeVersion = (path: string) =>
  exec({ command: path, args: ["--version"], timeLimit: "1 minute" }).pipe(
    Effect.mapError((error) =>
      error._tag === "CommandTimedOut" ? "--version took more than a minute" : error.reason,
    ),
    Effect.flatMap((output) =>
      output.exitCode === 0
        ? Effect.succeed(output.stdout)
        : Effect.fail(`--version exited with ${output.exitCode}: ${output.stderr}`),
    ),
  )

/** The embedded `file` as a real file: the copy already extracted, else `extractFromBunfs`'s. */
const extract = (file: string): string => {
  const known = embeddedTarget === null ? null : knownFor(embeddedTarget)
  const uid = process.getuid?.()
  const base = extractionBase(process.env, process.platform, uid)
  const copy =
    known === null || base === null || uid === undefined
      ? null
      : extractedCopy(file, known, base, uid)
  return copy ?? extractFromBunfs(file)
}

const tidy = (path: string): void => {
  const uid = process.getuid?.()
  const base = extractionBase(process.env, process.platform, uid)
  if (base !== null && uid !== undefined && dirname(dirname(path)) === base) {
    tidyExtracted(path, base, uid)
  }
}

/** The Claude Code this tutti's sessions run, `given` being --claude as given, from `cwd`. */
export const resolveClaude = (given: string | null, cwd: string) =>
  resolveWith(given, {
    cwd,
    embedded: embeddedFile,
    extract,
    tidy,
    which: (command) => Bun.which(command),
    version: claudeVersion,
  })
