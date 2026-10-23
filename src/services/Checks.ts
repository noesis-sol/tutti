// Checks (§ 3.3): runs the project's setup command, check_fast and check_full in a folder, each
// through exec (a process group of its own) within its time limit from AppConfig. The whole output
// goes to a file the caller names (check.log or setup.log in a worktree's .tutti/run/, § 9.1), or to
// a descriptor the caller opened for it through the symlink guard; in
// memory, only what is said of it is kept, each part bounded, as orchestra keeps it: its last lines,
// the lines that say what failed, its FLAKY: lines and the suites its SUITE: lines name. The lines
// that say what failed are picked as orchestra picks them, for Go's tools, generic errors and the
// test runners of other languages (bun, jest, vitest, node, pytest, cargo, mocha and TAP), and also
// for tsc and Biome, the tools of a TypeScript project such as tutti's own. A check
// that loops printing until its time limit holds no more of tutti's memory than one that prints a
// page. Interrupting a check kills its process group, and no result comes of it (§ 3.4).
import { Context, Duration, Effect, type FileSystem, Layer, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BranchEnv } from "../agent/env.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { exec } from "./exec.ts"

export const checkKinds = ["setup", "fast", "full"] as const
export type CheckKind = (typeof checkKinds)[number]

/** The file in a worktree's .tutti/run/ that holds the whole output of its last check (§ 9.1). */
export const checkLogName = "check.log"
/** The file in a worktree's .tutti/run/ that holds the whole output of its last setup (§ 9.1). */
export const setupLogName = "setup.log"

/** How much of a check's output is held in memory: orchestra's bounds. */
export const OutputBounds = {
  /** How many of its last lines are kept: the most anything says of its end (the full check's). */
  keptLines: 40,
  /** How much of one line is kept; the rest of a longer one is in the file alone. */
  maxLineBytes: 16 * 1024,
  /** How many FLAKY: lines are kept; the rest are counted. */
  maxFlaky: 50,
  /** How many lines that say what failed are kept; the last kept then says how many more there were. */
  maxSaid: 30,
  /** How many characters of each line said are kept. */
  saidWidth: 200,
  /** How many of the lines that say what failed are told apart, to count each once. */
  maxSeen: 1 << 16,
  /** How many suites' names are kept. */
  maxSuites: 100,
} as const

/** Starts a line that says a test failed and then passed on a rerun (scripts/test.sh prints them). */
export const flakyPrefix = "FLAKY:"
/** Starts the line a runner prints as each suite starts, `SUITE: unit tests`. */
export const suiteMarker = "SUITE:"

// failedAnywhere matches a line of a check's output, trimmed, that says a package or a test failed
// (go test's FAIL and --- FAIL:, gotestsum's === FAIL:, a bare FAIL saying nothing more aside), or
// that the race detector found a data race.
const failedAnywhere = /^(FAIL\W+\S|--- FAIL|=== FAIL)|DATA RACE|race detected/
// failedAtStart matches a line that, unindented, says what failed: a panic, a tool's own error,
// gotestsum's count of failures, golangci-lint's of issues, and a lint, vet or build error, which
// starts with its file's position. A failing test's own messages are indented.
const failedAtStart =
  /^(panic:|[Ee][Rr][Rr][Oo][Rr]\b|fatal:|level=error|DONE \d.*fail|\d+ issues?:|[^\s:]+\.\w+:\d+(:\d+)?: )/
// failedInTypeScript matches a line, unindented, that tsc or Biome prints for what failed: tsc's
// error at its file's position, `src/a.ts(10,5): error TS2322: …`, and Biome's and tsc's count of
// errors, `Found 3 errors.`.
const failedInTypeScript = /^([^\s(]+\(\d+,\d+\): error TS\d|Found \d+ errors?\b)/
// failedMarks are the marks test runners put before a test that failed (see failedTest).
const failedMarks = "✕×✗✖●"
// failedTest matches a line of a check's output, trimmed, in which another test runner than go test
// says a test failed, naming it, or counts the failures: bun's (fail), jest's ✕ and ● (its FAIL line
// is failedAnywhere's), vitest's ×, bun's ✗ and node's ✖ (vitest's FAIL and cargo nextest's are
// failedAnywhere's too), pytest's FAILED in its summary or after the test's path, cargo's
// `test … ... FAILED`, `test result: FAILED` and a test's panic, mocha's `1) …` and `N failing`,
// TAP's `not ok`, and the counts of failures jest, vitest, pytest and bun end with.
const failedTest = new RegExp(
  String.raw`^(\(fail\) |[${failedMarks}] \S|FAILED |\S+::\S+ FAILED\b|` +
    String.raw`test .* \.\.\. FAILED$|test result: FAILED|thread '.*' panicked at |\d+\) \S|not ok \d|` +
    String.raw`[1-9]\d* fail(ing)?$|(Tests|Test Suites|Test Files):?\s+[1-9]\d* failed\b|=+ (.*\D)?[1-9]\d* failed\b)`,
)
// biomeHeader matches the line that starts one of Biome's diagnostics: its file, with the position
// when it has one, its category and a rule, `src/a.ts:10:5 lint/style/useConst  FIXABLE  ━━━━`. The
// diagnostic is an error, not a warning, when its first line after it starts with ×.
const biomeHeader = /^\S+ [a-z][\w/]*( +[A-Z]+)* +━/
const biomeError = "× "

/**
 * Whether `trimmed` holds text every line failedTest matches holds: a word for failing, a panic, a
 * numbered item's ") ", TAP's "not ok", or a runner's mark for a failed test at its start.
 */
const mayFailTest = (trimmed: string): boolean =>
  trimmed.includes("FAIL") ||
  trimmed.includes("fail") ||
  trimmed.includes(") ") ||
  trimmed.includes("panicked") ||
  trimmed.startsWith("not ok") ||
  failedMarks.includes(trimmed.charAt(0))

/**
 * Whether `line`, `trimmed` once trimmed, says what failed. Each pattern is tried only on a line
 * holding text every line it matches holds, which a plain search finds much faster.
 */
const saysFailed = (trimmed: string, line: string): boolean => {
  if (
    (trimmed.includes("FAIL") ||
      trimmed.includes("DATA RACE") ||
      trimmed.includes("race detected")) &&
    failedAnywhere.test(trimmed)
  ) {
    return true
  }
  if (
    (line.startsWith("Found ") || line.includes("): error TS")) &&
    failedInTypeScript.test(line)
  ) {
    return true
  }
  if (mayFailTest(trimmed) && failedTest.test(trimmed)) return true
  // A colon, but for a tool's own error and gotestsum's DONE line.
  const may =
    line.includes(":") ||
    line.startsWith("DONE ") ||
    line.startsWith("level=error") ||
    line.slice(0, 5).toLowerCase() === "error"
  return may && failedAtStart.test(line)
}

/** Cuts each line to saidWidth characters and keeps at most `n`, the first; the last kept then says how many more there were. */
export const boundLines = (lines: ReadonlyArray<string>, n: number): Array<string> => {
  const kept =
    lines.length > n
      ? [...lines.slice(0, n - 1), `(… and ${lines.length - n + 1} more lines like these)`]
      : [...lines]
  return kept.map((line) => {
    const chars = Array.from(line)
    return chars.length > OutputBounds.saidWidth
      ? `${chars.slice(0, OutputBounds.saidWidth - 1).join("")}…`
      : line
  })
}

/** What is said of a check's output. */
export interface Said {
  /** The lines that say what failed, each once, trimmed, as CheckOutput picks them; at most maxSaid. */
  readonly failingLines: ReadonlyArray<string>
  /**
   * Its last lines, at most keptLines, blank lines at the end left out; none when it printed
   * nothing. What tells of a ticket's check takes the last maxSaid of them.
   */
  readonly lastLines: ReadonlyArray<string>
  /** The suites its SUITE: lines named, each once, in the order they started. */
  readonly suites: ReadonlyArray<string>
  /** The suite named last, the one it was in at its end; null when none was named. */
  readonly suite: string | null
  /** The tests its FLAKY: lines name, the first maxFlaky. */
  readonly flaky: ReadonlyArray<string>
  /** How many FLAKY: lines it printed. */
  readonly flakyCount: number
}

/** A line being printed on one stream, at most maxLineBytes of it. */
class LineBuffer {
  readonly bytes = new Uint8Array(OutputBounds.maxLineBytes)
  length = 0

  take(chunk: Uint8Array): void {
    const room = this.bytes.length - this.length
    if (room <= 0) return
    const part = chunk.subarray(0, Math.min(room, chunk.length))
    this.bytes.set(part, this.length)
    this.length += part.length
  }
}

const decoder = new TextDecoder()

/**
 * Takes a check's output as it is printed and keeps what is said of it (see Said). stdout and
 * stderr each have a line of their own being printed, so their lines don't run into each other.
 */
export class CheckOutput {
  private readonly partial = { stdout: new LineBuffer(), stderr: new LineBuffer() }
  private readonly tail: Array<string> = []
  /** The blank lines printed since the last line in tail, kept once another line follows. */
  private blanks = 0
  private readonly said: Array<string> = []
  private saidCount = 0
  private readonly seen = new Set<number | bigint>()
  /** In the tests named after "running tests:", until a blank line. */
  private running = false
  /**
   * The line that started a Biome diagnostic, until its first line after it says what it is; "" after
   * Biome's other lines drawn.
   */
  private biome: string | null = null
  private readonly flaky: Array<string> = []
  private flakyCount = 0
  private readonly suites: Array<string> = []
  private suite: string | null = null

  /** Takes the next chunk printed on `from`. */
  write(chunk: Uint8Array, from: "stdout" | "stderr" = "stdout"): void {
    const line = this.partial[from]
    let start = 0
    for (;;) {
      const end = chunk.indexOf(10, start)
      if (end < 0) {
        line.take(chunk.subarray(start))
        return
      }
      line.take(chunk.subarray(start, end))
      this.endLine(line)
      start = end + 1
    }
  }

  /** Takes the last line of each stream printed without a newline. Call it once the command has exited. */
  end(): void {
    for (const line of [this.partial.stdout, this.partial.stderr]) {
      if (line.length > 0) this.endLine(line)
    }
  }

  /** What is said of the output taken so far. */
  summary(): Said {
    const said =
      this.saidCount > this.said.length
        ? [
            ...this.said.slice(0, OutputBounds.maxSaid - 1),
            `(… and ${this.saidCount - OutputBounds.maxSaid + 1} more lines like these)`,
          ]
        : this.said
    const last = this.tail.slice(-OutputBounds.keptLines)
    return {
      failingLines: boundLines(said, OutputBounds.maxSaid),
      lastLines: last.some((line) => line.trim() !== "")
        ? boundLines(last, OutputBounds.keptLines)
        : [],
      suites: [...this.suites],
      suite: this.suite,
      flaky: [...this.flaky],
      flakyCount: this.flakyCount,
    }
  }

  private endLine(buffer: LineBuffer): void {
    const raw = decoder.decode(buffer.bytes.subarray(0, buffer.length))
    buffer.length = 0
    this.keepTail(raw)
    const line = raw.replace(/\r+$/, "")
    this.scanFailure(line)
    if (line.startsWith(flakyPrefix)) {
      this.flakyCount++
      if (this.flaky.length < OutputBounds.maxFlaky) {
        this.flaky.push(line.slice(flakyPrefix.length).trim())
      }
    }
    const trimmed = line.trim()
    if (trimmed.startsWith(suiteMarker)) {
      const name = trimmed.slice(suiteMarker.length).trim().split(/\s+/).join(" ")
      if (name !== "") {
        this.suite = name
        if (!this.suites.includes(name) && this.suites.length < OutputBounds.maxSuites) {
          this.suites.push(name)
        }
      }
    }
  }

  /** Keeps `line` among the last lines; blank lines at the end are left out. */
  private keepTail(line: string): void {
    if (line === "") {
      this.blanks++
      return
    }
    for (let i = 0; i < Math.min(this.blanks, OutputBounds.keptLines); i++) this.push("")
    this.blanks = 0
    this.push(line)
  }

  private push(line: string): void {
    this.tail.push(line)
    if (this.tail.length > OutputBounds.keptLines) this.tail.shift()
  }

  /**
   * Keeps `line`, trimmed, if it says what failed: saysFailed matches it, or it is "running tests:"
   * (a Go test binary timing out) or one of the tests named under it, up to a blank line, or it
   * starts a Biome diagnostic that is an error, which is kept, without the line drawn after it,
   * with the error's first line. The × line after Biome's other lines drawn, such as its closing
   * `check ━━━━`, is Biome's, not a failed test's (failedTest's ×): it says nothing more.
   */
  private scanFailure(line: string): void {
    const trimmed = line.trim()
    if (trimmed === "") {
      this.running = false
      return
    }
    const biome = this.biome
    this.biome = null
    if (biome !== null && trimmed.startsWith(biomeError)) {
      if (biome === "") return
      this.say(biome)
      this.say(trimmed)
      return
    }
    if (trimmed === "running tests:") this.running = true
    else if (!this.running && line.includes("━") && biomeHeader.test(line)) {
      this.biome = trimmed.replace(/ *━+$/, "")
      return
    } else if (!this.running && !saysFailed(trimmed, line)) {
      if (trimmed.endsWith("━")) this.biome = ""
      return
    }
    this.say(trimmed)
  }

  /** Keeps `trimmed` among the lines that say what failed, once. */
  private say(trimmed: string): void {
    const hash = Bun.hash(trimmed)
    if (this.seen.has(hash)) return
    if (this.seen.size < OutputBounds.maxSeen) this.seen.add(hash)
    this.saidCount++
    if (this.said.length < OutputBounds.maxSaid) this.said.push(trimmed)
  }
}

const CheckKind = Schema.Literals(checkKinds)

const saidFields = {
  failingLines: Schema.Array(Schema.String),
  lastLines: Schema.Array(Schema.String),
  suites: Schema.Array(Schema.String),
  suite: Schema.NullOr(Schema.String),
  flaky: Schema.Array(Schema.String),
  flakyCount: Schema.Number,
}

/** The check exited with a code other than 0. A check a signal ended gets 128 + its number. */
export class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  check: CheckKind,
  command: Schema.String,
  exitCode: Schema.Number,
  /** The file that holds the whole output. */
  outputFile: Schema.String,
  ...saidFields,
}) {
  override get message(): string {
    return `'${this.command}' failed with exit code ${this.exitCode}; the whole output is in ${this.outputFile}`
  }
}

/** The check ran past its time limit, and its process group was killed. */
export class CheckTimedOut extends Schema.TaggedError<CheckTimedOut>()("CheckTimedOut", {
  check: CheckKind,
  command: Schema.String,
  timeLimit: Schema.Duration,
  outputFile: Schema.String,
  ...saidFields,
}) {
  override get message(): string {
    return `'${this.command}' did not finish within ${Duration.format(this.timeLimit)}; the whole output is in ${this.outputFile}`
  }
}

/** The check didn't start, or its output couldn't be read or written to its file. */
export class CheckNotRun extends Schema.TaggedError<CheckNotRun>()("CheckNotRun", {
  check: CheckKind,
  command: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `'${this.command}' could not be run: ${this.reason}`
  }
}

export type CheckError = CheckFailed | CheckTimedOut | CheckNotRun

/** The check exited with 0. Its FLAKY: lines are still worth a warning. */
export interface CheckPassed extends Said {
  readonly _tag: "CheckPassed"
  readonly check: CheckKind
  readonly command: string
}

/** The settings name no command for this check, so nothing ran. */
export interface NoCheckCommand {
  readonly _tag: "NoCheckCommand"
  readonly check: CheckKind
}

export type CheckResult = CheckPassed | NoCheckCommand

export interface RunOptions {
  /** The folder the check runs in: a ticket's worktree, or the full check's. */
  readonly cwd: string
  /** The file that receives the whole output, and that errors name; its folder must exist. */
  readonly outputFile: string
  /**
   * That file, opened through the symlink guard (Worktrees.openRunFile): the output is written to it
   * and `outputFile` is not opened, so no link left in its place can send the output elsewhere.
   */
  readonly outputFd?: number
}

export interface SetupOptions extends RunOptions {
  /** The check the setup comes before, whose time limit it runs within, as in orchestra. */
  readonly before: "fast" | "full"
  /**
   * The command to run in place of checks.setup.command: the run's setup, which a merge that
   * changed .tutti/settings.json sets from then on (setup.ts); null runs nothing.
   */
  readonly command?: string | null
}

/**
 * Runs `command` with `sh -c` in `options.cwd` within `timeLimit`, in the environment of commands
 * run on a branch's behalf (BranchEnv), the whole output going to `options.outputFile` (or
 * `options.outputFd`, when given). Nothing runs when `command` is null.
 */
export const runCheck = Effect.fn("runCheck")(function* (
  check: CheckKind,
  command: string | null,
  timeLimit: Duration.Input,
  options: RunOptions,
) {
  if (command === null) return { _tag: "NoCheckCommand", check } satisfies NoCheckCommand
  const output = new CheckOutput()
  const ran = yield* exec({
    command: "sh",
    args: ["-c", command],
    timeLimit,
    cwd: options.cwd,
    baseEnv: yield* BranchEnv,
    outputFile: options.outputFile,
    ...(options.outputFd === undefined ? {} : { outputFd: options.outputFd }),
    onOutput: (chunk, from) => output.write(chunk, from),
    // What is said of the output is kept by CheckOutput; exec need hold none of it.
    maxOutputBytes: 0,
  }).pipe(
    Effect.catchTags({
      CommandTimedOut: (error) => {
        output.end()
        return Effect.fail(
          new CheckTimedOut({
            check,
            command,
            timeLimit: error.timeLimit,
            outputFile: options.outputFile,
            ...output.summary(),
          }),
        )
      },
      CommandNotRun: (error) =>
        Effect.fail(new CheckNotRun({ check, command, reason: error.reason })),
    }),
  )
  output.end()
  if (ran.exitCode !== 0) {
    return yield* new CheckFailed({
      check,
      command,
      exitCode: ran.exitCode,
      outputFile: options.outputFile,
      ...output.summary(),
    })
  }
  return { _tag: "CheckPassed", check, command, ...output.summary() } satisfies CheckPassed
})

export class Checks extends Context.Service<
  Checks,
  {
    /** The setup command (checks.setup.command), within the limit of the check it comes before. */
    setup(options: SetupOptions): Effect.Effect<CheckResult, CheckError>
    /** The merge check (checks.fast.command), within checks.fast.timeout. */
    fast(options: RunOptions): Effect.Effect<CheckResult, CheckError>
    /** The full check (checks.full.command), within checks.full.timeout. */
    full(options: RunOptions): Effect.Effect<CheckResult, CheckError>
  }
>()("tutti/services/Checks") {
  /** The checks AppConfig's settings name, run in process groups of their own. */
  static readonly layer = Layer.effect(
    Checks,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const context = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
      >()
      const { checks } = config.settings
      const limit = { fast: checks.fast.timeout, full: checks.full.timeout }
      return {
        setup: (options) =>
          runCheck(
            "setup",
            options.command === undefined ? checks.setup.command : options.command,
            limit[options.before],
            options,
          ).pipe(Effect.provideContext(context)),
        fast: (options) =>
          runCheck("fast", checks.fast.command, limit.fast, options).pipe(
            Effect.provideContext(context),
          ),
        full: (options) =>
          runCheck("full", checks.full.command, limit.full, options).pipe(
            Effect.provideContext(context),
          ),
      }
    }),
  )
}
