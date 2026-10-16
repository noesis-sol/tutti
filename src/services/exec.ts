// Every external command tutti runs (git, bd, checks, setup) goes through this module (§ 3.3 "Time
// limits", § 3.2). A command starts detached, the leader of a process group of its own, so the
// terminal's signals reach tutti alone. Its scope kills the whole group (SIGTERM, then SIGKILL after
// a grace) when it closes or the fiber is interrupted. Its time limit kills the group itself when
// it expires: a fiber of its own sends the signals, so the limit holds even while the caller is
// uninterruptible (§ 3.4).
import { constants } from "node:os"
import { Cause, Duration, Effect, Exit, Fiber, FileSystem, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** orchestra's limits: 30 s for a read, 2 min for a git write or a `bd` update. Checks pass their own. */
export const TimeLimit = {
  read: Duration.seconds(30),
  write: Duration.minutes(2),
} as const

/** How long a process group has between SIGTERM and SIGKILL, unless the command says otherwise. */
export const defaultKillGrace: Duration.Duration = Duration.seconds(2)

/** How much of each of stdout and stderr is kept in memory, unless the command says otherwise. */
export const defaultMaxOutputBytes = 16 * 1024 * 1024

export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly timeLimit: Duration.Input
  readonly cwd?: string
  /** Set over tutti's own environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Written to the command's stdin, which is otherwise closed. */
  readonly stdin?: string
  /** A file that receives the whole of stdout and stderr as they come, interleaved. */
  readonly outputFile?: string
  /** Called with each chunk of stdout and stderr as it comes, before it reaches the file. */
  readonly onOutput?: (chunk: Uint8Array, from: "stdout" | "stderr") => void
  /** The bytes of stdout and of stderr kept in the result; past this, only the last ones. */
  readonly maxOutputBytes?: number
  readonly killGrace?: Duration.Input
}

export interface Output {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** The command exited with a code other than 0. A command killed by a signal gets 128 + its number. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {}

/** The command ran past its time limit, and its process group was killed. */
export class CommandTimedOut extends Schema.TaggedError<CommandTimedOut>()("CommandTimedOut", {
  command: Schema.String,
  timeLimit: Schema.Duration,
  stderr: Schema.String,
}) {}

/** The command didn't start, or its output couldn't be read or written to its file. */
export class CommandNotRun extends Schema.TaggedError<CommandNotRun>()("CommandNotRun", {
  command: Schema.String,
  reason: Schema.String,
}) {}

const plainArg = /^[\w./=:@%+,-]+$/

/** The command as a person would type it into a shell, for errors and logs. */
export const showCommand = (command: Pick<Command, "command" | "args">): string =>
  [command.command, ...command.args]
    .map((arg) => (plainArg.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(" ")

/** The last `max` bytes of a stream, decoded once at the end so no character is split mid-way. */
class Tail {
  private chunks: Array<Uint8Array> = []
  private size = 0

  constructor(private readonly max: number) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.max) {
      const first = this.chunks[0]
      if (first === undefined) break
      const excess = this.size - this.max
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8")
  }
}

/** The shell's code for a process that a signal ended: 128 + the signal's number. */
const signalExitCode = (cause: Cause.Cause<PlatformError>): number => {
  const name = /'(SIG[A-Z0-9]+)'/.exec(Cause.pretty(cause))?.[1]
  const number = name === undefined ? undefined : constants.signals[name as NodeJS.Signals]
  return 128 + (number ?? 0)
}

/**
 * Runs a command to its end and returns its exit code and output, whatever the code. Fails with
 * CommandTimedOut past its time limit, and with CommandNotRun when it can't be started.
 */
export const exec = Effect.fn("exec")(function* (command: Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const shown = showCommand(command)
  const notRun = (error: PlatformError) =>
    new CommandNotRun({ command: shown, reason: error.message })
  const timeLimit = Duration.fromInputUnsafe(command.timeLimit)
  const grace = command.killGrace ?? defaultKillGrace
  const max = command.maxOutputBytes ?? defaultMaxOutputBytes

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file =
        command.outputFile === undefined
          ? undefined
          : yield* fs.open(command.outputFile, { flag: "w" }).pipe(Effect.mapError(notRun))
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(command.command, command.args, {
            cwd: command.cwd,
            env: command.env,
            extendEnv: true,
            detached: true,
            killSignal: "SIGTERM",
            forceKillAfter: grace,
            stdin:
              command.stdin === undefined
                ? "ignore"
                : Stream.make(new TextEncoder().encode(command.stdin)),
            stdout: "pipe",
            stderr: "pipe",
          }),
        )
        .pipe(Effect.mapError(notRun))
      const kill = Effect.ignore(handle.kill({ killSignal: "SIGTERM", forceKillAfter: grace }))

      // A leader still running at the limit has timed out, whatever code it exits with once killed.
      let timedOut = false
      yield* Effect.interruptible(Effect.sleep(timeLimit)).pipe(
        Effect.andThen(handle.isRunning),
        Effect.flatMap((running) => {
          timedOut = running
          return running ? kill : Effect.void
        }),
        Effect.ignore,
        Effect.forkScoped,
      )

      const stdout = new Tail(max)
      const stderr = new Tail(max)
      const reading = yield* Stream.merge(
        Stream.map(handle.stdout, (chunk) => [stdout, chunk, "stdout"] as const),
        Stream.map(handle.stderr, (chunk) => [stderr, chunk, "stderr"] as const),
      ).pipe(
        Stream.runForEach(([tail, chunk, from]) => {
          tail.push(chunk)
          command.onOutput?.(chunk, from)
          return file === undefined ? Effect.void : file.writeAll(chunk)
        }),
        Effect.mapError(notRun),
        Effect.forkScoped,
      )

      const exit = yield* Effect.exit(handle.exitCode)
      // The leader has gone. What is left of its group would hold the pipes open, so it goes too.
      yield* kill
      yield* Fiber.join(reading)

      const exitCode = Exit.isSuccess(exit) ? exit.value : signalExitCode(exit.cause)
      if (timedOut) {
        return yield* new CommandTimedOut({ command: shown, timeLimit, stderr: stderr.text() })
      }
      return { exitCode, stdout: stdout.text(), stderr: stderr.text() } satisfies Output
    }),
  )
})

/** Runs a command as `exec` does, and fails with CommandFailed when it exits with a code other than 0. */
export const run = Effect.fn("run")(function* (command: Command) {
  const output = yield* exec(command)
  if (output.exitCode !== 0) {
    return yield* new CommandFailed({
      command: showCommand(command),
      exitCode: output.exitCode,
      stderr: output.stderr,
    })
  }
  return output
})
