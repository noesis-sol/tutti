// What tutti init did, step by step, for its summary (§ 8.3), and the machine it does it on: the
// commands it runs (git, bd, the Beads install) and where it finds them. The live machine runs them
// through effect/process (src/services/exec.ts); tests script one.
import { statSync } from "node:fs"
import { Duration, Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { exec, showCommand } from "../services/exec.ts"
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
    which: (command) => Bun.which(command),
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
