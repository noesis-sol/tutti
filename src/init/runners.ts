// The project's checks are two runners, shell scripts tutti init writes in the project from its
// suites and the project then owns (§ 8.3, § 9.1):
//
//   scripts/check-fast.sh   the merge check, run on every ticket before it merges
//   scripts/check-full.sh   everything: check-fast.sh, then the slower suites, run once at the end
//
// A full suite that runs all check-fast.sh does and more (the project's own full check, a slow-mode
// flag on the same runner) stands for check-fast.sh: check-full.sh runs it, not check-fast.sh first,
// so each test runs once.
//
// Their format is orchestra's, so runners orchestra wrote work as they are: a suite a line, each in
// a subshell under a comment saying where it was found, after a line printing `SUITE: <name>`; a
// suite that can't run in two worktrees at once between `lock <name>` and `unlock`. A runner with no
// suites is `exit 0`. The headers are the templates beside the worker prompt.
import fastHeader from "../project/templates/check-fast.sh" with { type: "text" }
import fullHeader from "../project/templates/check-full.sh" with { type: "text" }

/** The merge check's runner, as the settings' checks.fast.command names it. */
export const fastRunner = "scripts/check-fast.sh"

/** The full check's runner, as the settings' checks.full.command names it. */
export const fullRunner = "scripts/check-full.sh"

/** The project's own check, which check-fast.sh calls as a suite and never edits. */
export const checkScript = "scripts/check.sh"

/** Starts the line a runner prints as each suite starts: the last one names a failing suite. */
export const suiteMarker = "SUITE:"

/** One line of a runner: a command that tests, lints, type-checks or builds the project. */
export interface Suite {
  /** Such as "unit tests"; it names the suite's lock. */
  readonly name: string
  /** Run from the repository's root, such as "npm test". */
  readonly command: string
  /**
   * Runs it on part of the project, a <placeholder> for the part, such as "bun test <files>", for a
   * worker's check of its own change; absent or "" where it runs only whole.
   */
  readonly targeted?: string
  /** Where it was found, such as "package.json:7", or "--check-fast". */
  readonly foundIn: string
  /** It can't run in two worktrees at once (a fixed port, a shared database): it takes turns. */
  readonly serial: boolean
  /** A full suite that runs all check-fast.sh does and more: check-full.sh runs it instead. */
  readonly coversFast?: boolean
}

/** The shell functions a runner with a serial suite starts with, orchestra's. */
export const lockFunctions = `
# lock NAME: take turns on suite NAME with the checks running at once in this repository's other
# worktrees, until unlock or the end of the script. The lock is a directory in the temp directory,
# named for the repository and the suite, holding its holder's PID; it is taken over once that
# process is gone. (macOS has no flock.)
lock() {
	lock_try="\${TMPDIR:-/tmp}/check-$(repo_id)-$1.lock"
	until mkdir "$lock_try" 2>/dev/null; do
		lock_holder=$(cat "$lock_try/pid" 2>/dev/null) || lock_holder=
		if stale "$lock_try" "$lock_holder" && mkdir "$lock_try.take" 2>/dev/null; then
			# Only a taker holding .take removes another's lock: check it is still the stale one.
			if stale "$lock_try" "$lock_holder" && [ "$(cat "$lock_try/pid" 2>/dev/null)" = "$lock_holder" ]; then
				rm -rf "$lock_try"
			fi
			rmdir "$lock_try.take"
		else
			find "$lock_try.take" -prune -mmin +1 -exec rm -rf {} + 2>/dev/null || true # its taker died
			sleep 1
		fi
	done
	lock_dir=$lock_try
	echo $$ >"$lock_dir/pid"
}

unlock() {
	if [ -n "\${lock_dir:-}" ]; then
		rm -rf "$lock_dir"
		lock_dir=
	fi
}

# stale DIR PID: the lock's holder is gone, or never wrote its PID in a minute.
stale() {
	if [ -n "$2" ]; then
		! kill -0 "$2" 2>/dev/null
	else
		[ -n "$(find "$1" -prune -mmin +1 2>/dev/null)" ]
	fi
}

# repo_id names the repository the same in all its worktrees: a checksum of its git directory.
repo_id() {
	(cd "$(git rev-parse --git-common-dir 2>/dev/null || echo .)" && pwd -P) | cksum | cut -d ' ' -f 1
}

trap unlock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
`

/** A command's words, split at spaces, quotes and the shell's operators. */
const commandWords = (command: string): ReadonlyArray<string> =>
  command.split(/[\s;&|()<>'"`]+/).filter((word) => word !== "")

/** Whether `word` is `path` from the repository's root, or `path` at the end of a longer one. */
const namesPath = (word: string, path: string): boolean =>
  word === path || word.endsWith(`/${path}`)

const namesPathIn = (command: string, path: string): boolean =>
  commandWords(command).some((word) => namesPath(word, path))

/**
 * Whether a suite's command runs a runner anywhere in it: a runner with such a suite would run
 * itself, check-fast.sh by way of check-full.sh, until fork fails.
 */
export const runsRunner = (command: string): boolean =>
  namesPathIn(command, fastRunner) || namesPathIn(command, fullRunner)

/**
 * Whether a check command is just the runner at `path`, run by a shell or not: init keeps that
 * runner as it is.
 */
export const isRunner = (check: string, path: string): boolean => {
  let words = check.trim().split(/\s+/)
  if (words.length === 2 && ["sh", "bash", "exec"].includes(words[0] ?? "")) words = words.slice(1)
  return words.length === 1 && namesPath(words[0] ?? "", path)
}

/**
 * The suites a check command given to init (`--check-fast`) stands for, found in `from`: none for
 * "", and null (the runner kept as it is) for the runner itself.
 */
export const runnerSuites = (
  check: string,
  from: string,
  path: string,
): ReadonlyArray<Suite> | null => {
  const command = check.trim()
  if (command === "") return []
  if (isRunner(command, path)) return null
  return [{ name: "", command, foundIn: from, serial: false }]
}

const oneLine = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ")

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/** The comment above a suite's line: its name and where it was found. */
const suiteComment = (suite: Suite): string => {
  const parts = [
    ...(oneLine(suite.name) === "" ? [] : [oneLine(suite.name)]),
    ...(oneLine(suite.foundIn) === "" ? [] : [`from ${oneLine(suite.foundIn)}`]),
    ...(suite.serial ? ["one worktree at a time"] : []),
    ...(suite.coversFast === true ? [`runs all ${fastRunner} does, and more`] : []),
  ]
  return parts.length === 0 ? "# a suite" : `# ${parts.join(", ")}`
}

/** What a suite's SUITE: line calls it: its name, or else its command. */
const suiteLabel = (suite: Suite): string =>
  oneLine(suite.name) === "" ? oneLine(suite.command) : oneLine(suite.name)

/** A suite's lock's name: its name, or else its command, in lowercase letters, digits and dashes. */
export const lockName = (suite: Suite): string => {
  const from = suite.name.trim() === "" ? suite.command : suite.name
  const words = from.toLowerCase().match(/[a-z0-9]+/g) ?? []
  let name = ""
  for (const word of words) {
    name = name === "" ? word : `${name}-${word}`
    if (name.length >= 40) break
  }
  return name === "" ? "suite" : name.slice(0, 40)
}

/** The suites a runner may list, and those it leaves out, which run a runner. */
export const withoutRunners = (
  suites: ReadonlyArray<Suite>,
): { readonly kept: ReadonlyArray<Suite>; readonly left: ReadonlyArray<Suite> } => ({
  kept: suites.filter((suite) => !runsRunner(suite.command)),
  left: suites.filter((suite) => runsRunner(suite.command)),
})

/** A runner: its header, then its suites, or `exit 0` with none. */
const runnerScript = (header: string, suites: ReadonlyArray<Suite>): string => {
  const lines = suites
    .map((suite) => ({ ...suite, command: suite.command.trim() }))
    .filter((suite) => suite.command !== "")
  if (lines.length === 0) {
    return `${header}# It checks nothing yet: add a line for each suite.\nexit 0\n`
  }
  let script = `${header}set -e\ncd "$(dirname "$0")/.."\n`
  if (lines.some((suite) => suite.serial)) script += lockFunctions
  for (const suite of lines) {
    script += `\n${suiteComment(suite)}\n`
    script += `printf '%s\\n' ${shellQuote(`${suiteMarker} ${suiteLabel(suite)}`)}\n`
    // Under set -e, sh carries on past a failure in an AND-OR list anywhere but at its end: the
    // subshell's status is its last command's, and set -e stops the script on it. The ) goes on
    // a line of its own, after any comment the command ends with.
    script += suite.serial
      ? `lock ${lockName(suite)}\n(\n${suite.command}\n)\nunlock\n`
      : `(\n${suite.command}\n)\n`
  }
  return script
}

/** The scripts/check-fast.sh init writes for `suites`; a suite that runs a runner is left out. */
export const fastScript = (suites: ReadonlyArray<Suite>): string =>
  runnerScript(fastHeader, withoutRunners(suites).kept)

/** Whether a runner's suites stand for check-fast.sh: one runs all it does, and more. */
export const coversFast = (suites: ReadonlyArray<Suite>): boolean =>
  suites.some((suite) => suite.coversFast === true && suite.command.trim() !== "")

/**
 * check-full.sh's header where its suites stand for check-fast.sh: the template's, its first lines,
 * which say check-fast.sh runs first, saying it doesn't.
 */
const coveringHeader = (): string => {
  const shebang = "#!/bin/sh\n"
  const rest = fullHeader.indexOf("# tutti init wrote it")
  if (!fullHeader.startsWith(shebang) || rest < 0) return fullHeader
  return `${shebang}# scripts/check-full.sh: every check, each test once. Its first suite runs all
# scripts/check-fast.sh does, and more, so check-fast.sh doesn't run first. tutti runs it once at
# the end of a run.
${fullHeader.slice(rest)}`
}

/**
 * The scripts/check-full.sh init writes for its own suites, the slower ones: check-fast.sh first,
 * then those. Where one of them runs all check-fast.sh does, it runs them alone, that one first, so
 * each test runs once. With none, and `fastEmpty` (check-fast.sh checks nothing either), it is
 * `exit 0`.
 */
export const fullScript = (suites: ReadonlyArray<Suite>, fastEmpty: boolean): string => {
  const kept = withoutRunners(suites).kept
  if (coversFast(kept)) {
    const covering = kept.filter((suite) => suite.coversFast === true)
    const rest = kept.filter((suite) => suite.coversFast !== true)
    return runnerScript(coveringHeader(), [...covering, ...rest])
  }
  const all =
    kept.length > 0 || !fastEmpty
      ? [{ name: "", command: fastRunner, foundIn: "the merge check", serial: false }, ...kept]
      : kept
  return runnerScript(fullHeader, all)
}

/** Whether a runner's script checks nothing: init's `exit 0`. */
export const checksNothing = (script: string): boolean => script.endsWith("\nexit 0\n")

/** Whether `line` prints a suite's marker and does nothing else, as runnerScript writes it. */
const isMarkerLine = (line: string): boolean => {
  const start = `printf '%s\\n' `
  if (!line.startsWith(start)) return false
  const word = line.slice(start.length)
  if (word.length < 2 || !word.startsWith("'") || !word.endsWith("'")) return false
  const text = word.slice(1, -1).replaceAll(`'\\''`, "'")
  return text.startsWith(`${suiteMarker} `) && shellQuote(text) === word
}

/**
 * The commands a runner's script runs, a line each, for a question or the verifier to show: its
 * lines without the comments and what init writes around the suites (set -e, the cd, the lock, the
 * subshells' parentheses, the SUITE: lines).
 */
export const runnerCommands = (script: string): ReadonlyArray<string> =>
  script
    .replace(lockFunctions, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        !(
          line === "" ||
          line.startsWith("#") ||
          line === "set -e" ||
          line === `cd "$(dirname "$0")/.."` ||
          line === "(" ||
          line === ")" ||
          line === "unlock" ||
          (line.startsWith("lock ") && !/[;&|]/.test(line)) ||
          isMarkerLine(line)
        ),
    )

/**
 * Whether a runner's script, init's or the project's own, runs no command but `exit 0`: a
 * check-full.sh beside it needn't run it first.
 */
export const runsNothing = (script: string): boolean =>
  runnerCommands(script).every((command) => command === "exit 0")

/**
 * Whether a suite's command runs the project's own check, scripts/check.sh: a word of it is the
 * script's path from the repository's root, or that path from a variable or the file system's root.
 */
export const runsCheckScript = (command: string): boolean =>
  commandWords(command).some((each) => {
    const word = each.startsWith("./") ? each.slice(2) : each
    return (
      word === checkScript ||
      (word.endsWith(`/${checkScript}`) && (word.startsWith("$") || word.startsWith("/")))
    )
  })
