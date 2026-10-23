// What tutti init did, step by step, for its summary (§ 8.3), and the machine it does it on: the
// commands it runs (git, bd, the Beads install) and where it finds them. The live machine runs them
// through effect/process (src/services/exec.ts); tests script one. Once its questions are answered,
// init takes its steps in turn through runSteps, which checks for a stop after each.
import { statSync } from "node:fs"
import { Deferred, Duration, Effect, type FileSystem, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { exec, showCommand } from "../services/exec.ts"
import { whichOnPath } from "../services/onPath.ts"
import { sanitizeLine } from "../ui/sanitize.ts"

/**
 * How a step went, as the summary marks it: done ✓, kept as it was •, missing ✗ (something to fix
 * before a run), or a caution !.
 */
export type StepKind = "done" | "kept" | "missing" | "caution"

/** A line of init's summary: what it is about, and what init did or found. */
export interface Step {
  readonly kind: StepKind
  readonly label: string
  readonly detail: string
  /** The files the step wrote or left for you to commit, from the project's top. */
  readonly commit?: ReadonlyArray<string>
}

export const step = (
  kind: StepKind,
  label: string,
  detail: string,
  commit?: ReadonlyArray<string>,
): Step => ({ kind, label, detail, ...(commit === undefined ? {} : { commit }) })

/** A Step as a schema, for the errors that carry the steps taken. */
const StepSchema = Schema.Struct({
  kind: Schema.Literals(["done", "kept", "missing", "caution"]),
  label: Schema.String,
  detail: Schema.String,
  commit: Schema.optionalKey(Schema.Array(Schema.String)),
})

/**
 * One of init's steps once its questions are answered, as runSteps takes them: Beads, the ticket
 * prefix, the setup, the test work, the login probe.
 */
export interface SetupStep<E, R> {
  /** What the step sets up, as a stop during it names it. */
  readonly name: string
  /** Takes the step: the summary's lines for it. */
  readonly run: Effect.Effect<ReadonlyArray<Step>, E, R>
  /**
   * Whether a stop waits for the step's end: one that writes files a run takes together, or renames
   * every ticket. A stop interrupts any other step at once.
   */
  readonly whole: boolean
  /**
   * What a stop during the step says after "stopped", given the lines it took, null where the stop
   * interrupted it.
   */
  readonly stopped: (took: ReadonlyArray<Step> | null) => string
}

/**
 * init stopped at a stop signal, or Ctrl+C in its renderer: the steps it took, the step the stop
 * came in, and what it says of the stop there.
 */
export class InitStopped extends Schema.TaggedError<InitStopped>()("InitStopped", {
  steps: Schema.Array(StepSchema),
  step: Schema.String,
  words: Schema.String,
}) {
  override get message(): string {
    return `stopped${this.words}`
  }
}

/**
 * One of init's steps failed: the steps taken before it, the step that failed, and why. A step
 * that writes files takes back what it wrote before it fails (./staged.ts).
 */
export class InitFailed extends Schema.TaggedError<InitFailed>()("InitFailed", {
  steps: Schema.Array(StepSchema),
  step: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/** Why a step failed, from its error: the text itself, or its message. */
const reasonOf = (error: unknown): string =>
  typeof error === "string"
    ? error
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error)

/**
 * Takes `steps` in turn, `starting` told each one's name as it starts, until one fails or `stop` is
 * done, checking it after each: the lines they took; InitStopped where a stop came, and InitFailed
 * where a step failed, each with the lines taken until then. A whole step runs to its end,
 * uninterrupted; another is interrupted by a stop, and isn't started once one has come.
 */
export const runSteps = <S extends SetupStep<unknown, unknown>>(
  steps: ReadonlyArray<S>,
  stop: Deferred.Deferred<void>,
  starting: (name: string) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<ReadonlyArray<Step>, InitFailed | InitStopped, Effect.Services<S["run"]>> =>
  Effect.gen(function* () {
    const did: Array<Step> = []
    for (const each of steps) {
      yield* starting(each.name)
      const halt = (took: ReadonlyArray<Step> | null) =>
        new InitStopped({
          steps: [...did, ...(took ?? [])],
          step: each.name,
          words: each.stopped(took),
        })
      if (!each.whole && (yield* Deferred.isDone(stop))) return yield* halt(null)
      const run = Effect.mapError(
        each.run,
        (error) => new InitFailed({ steps: [...did], step: each.name, reason: reasonOf(error) }),
      )
      const took = each.whole
        ? yield* Effect.uninterruptible(run)
        : yield* Effect.raceFirst(run, Effect.as(Deferred.await(stop), null))
      if (took === null) return yield* halt(null)
      if (yield* Deferred.isDone(stop)) return yield* halt(took)
      did.push(...took)
    }
    return did
  }) as Effect.Effect<ReadonlyArray<Step>, InitFailed | InitStopped, Effect.Services<S["run"]>>

/** The summary's mark for each kind. */
export const marks: Record<StepKind, string> = {
  done: "✓",
  kept: "•",
  missing: "✗",
  caution: "!",
}

/** A step as a plain line: its mark, its label, and its detail. */
export const stepLine = (each: Step): string =>
  `${marks[each.kind]} ${each.label}${each.detail === "" ? "" : `  ${each.detail}`}`

/** Lists items as a sentence does: "a", "a and b", "a, b and c". */
export const joinAnd = (items: ReadonlyArray<string>): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

/** How a command failed: why, and the last lines of its output, where a command says what went wrong. */
export const failure = (what: string, why: string, output: string): string => {
  const lines = output
    .split("\n")
    .map((line) => sanitizeLine(line).trim())
    .filter((line) => line !== "")
  return `${what} failed (${why})${lines.length === 0 ? "" : `: ${lines.slice(-3).join(" ")}`}`
}

/** What init runs commands on, and where it finds them. */
export interface Machine {
  /**
   * Runs `command` with `args` in `cwd` to its end, within `timeLimit`: its stdout, or why it
   * failed, as `failure` says it.
   */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    timeLimit: Duration.Input,
  ) => Effect.Effect<string, string>
  /** Where `command` is on the PATH, or null. */
  readonly which: (command: string) => string | null
  /** An environment variable, or undefined. */
  readonly env: (name: string) => string | undefined
  /** The operating system, as process.platform names it. */
  readonly platform: string
  /** Whether `path` is a file this user can run. */
  readonly executable: (path: string) => boolean
}

/** The live machine: effect/process, this process's PATH and environment. */
export const liveMachine = Effect.gen(function* () {
  const context = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >()
  return {
    run: (command, args, cwd, timeLimit) => {
      const shown = showCommand({ command, args })
      return exec({ command, args, cwd, timeLimit }).pipe(
        Effect.provideContext(context),
        Effect.mapError((error) =>
          error._tag === "CommandTimedOut"
            ? failure(shown, `timed out after ${Duration.format(error.timeLimit)}`, error.stderr)
            : failure(shown, error.reason, ""),
        ),
        Effect.flatMap((output) =>
          output.exitCode === 0
            ? Effect.succeed(output.stdout)
            : Effect.fail(
                failure(
                  shown,
                  `exit status ${output.exitCode}`,
                  `${output.stdout}\n${output.stderr}`,
                ),
              ),
        ),
      )
    },
    which: whichOnPath,
    env: (name) => process.env[name],
    platform: process.platform,
    executable: (path) => {
      try {
        const stat = statSync(path)
        return stat.isFile() && (stat.mode & 0o111) !== 0
      } catch {
        return false
      }
    },
  } satisfies Machine
})
