// Every external command tutti runs (git, bd, checks, setup) goes through this module (§ 3.3 "Time
// limits", § 3.2). A command starts detached, the leader of a process group of its own, so the
// terminal's signals reach tutti alone. Its scope stops the group (stopGroup: SIGTERM, then after a
// grace SIGKILL to its whole process tree, the groups of its members' descendants too, as bun test
// --parallel's workers each lead one) when it closes or the fiber is interrupted. Its time limit
// stops the group itself when it expires: a fiber of its own sends the signals, so the limit holds
// even while the caller is uninterruptible (§ 3.4). The limit counts the time the machine is awake
// (Wake.ts), so a command isn't killed at the wake for the time the machine slept. A kill -9 of
// tutti runs neither, so the group also has a reaper (src/services/reaper.ts) that ends its tree
// then, with the same grace; the reaper goes with the group.
// Bun's node:child_process can lose a command's exit and its output (tutti-cje): exec stops waiting
// for them a grace after the group has gone, and fails with CommandNotRun. A process that left the
// group can hold its output open: exec reads it for a grace after the leader has exited, then stops.
import type { ChildProcess as Reaper } from "node:child_process"
import { writeSync } from "node:fs"
import { constants } from "node:os"
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { withoutGitLocal } from "./gitEnv.ts"
import { descendantGroups, killTree, ownGroup, processAlive, processTable } from "./processTree.ts"
import { startReaper, stopReaper } from "./reaper.ts"
import { sleepAwake } from "./Wake.ts"

/** orchestra's limits: 30 s for a read, 2 min for a git write or a `bd` update. Checks pass their own. */
export const TimeLimit = {
  read: Duration.seconds(30),
  write: Duration.minutes(2),
} as const

/** How long a process group has between SIGTERM and SIGKILL, unless the command says otherwise. */
export const defaultKillGrace: Duration.Duration = Duration.seconds(2)

/**
 * How long exec waits for a command's exit once its process group has gone, where the exit is due at
 * once. Bun 1.4.3's node:child_process can lose a child's exit and output, about once in a few
 * thousand spawns (tutti-cje); past this grace, exec fails with CommandNotRun.
 */
export const LostExitGrace = Context.Reference<Duration.Duration>(
  "tutti/services/exec/LostExitGrace",
  { defaultValue: () => Duration.seconds(5) },
)

/**
 * How long exec waits for a command's output to close once its leader has exited and its process
 * group has been killed. A process that left the group (setsid, a detached spawn) can hold the pipes
 * open for as long as it runs; past this grace, exec stops reading and returns what it read.
 */
export const LeftoverOutputGrace = Context.Reference<Duration.Duration>(
  "tutti/services/exec/LeftoverOutputGrace",
  { defaultValue: () => Duration.seconds(2) },
)

/** What exec adds to a command's stderr when a process it left running held its output open. */
export const leftoverOutputNote = (grace: Duration.Duration): string =>
  `tutti: stopped reading the command's output ${Duration.format(grace)} after it exited: a process it left running, outside its process group, holds the output open\n`

/** How often exec looks for a command's process group while it waits for the command's exit. */
const groupPoll = Duration.millis(200)

/** Ends once the group has been gone for `grace`, in which its exit is lost (see LostExitGrace). */
const groupGoneFor = (group: number, grace: Duration.Duration): Effect.Effect<void> =>
  Effect.repeat(
    Effect.sync(() => processAlive(-group)),
    {
      while: (alive) => alive,
      schedule: Schedule.spaced(groupPoll),
    },
  ).pipe(Effect.andThen(Effect.sleep(grace)), Effect.interruptible)

/**
 * Stops the process group `group` leads: SIGTERM, then SIGKILL to its process tree (killTree) once
 * `grace` has passed with the group, or a group of its members' descendants, still there. The tree
 * is listed before the SIGTERM: a test worker whose coordinator has gone has PID 1 for its parent,
 * out of the tree, and a SIGKILL that reaches bun test before it has handled the SIGTERM leaves its
 * workers running. It runs to its end once started, so an interruption can't list the tree anew.
 */
const stopGroup = (group: number, grace: Duration.Duration): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      if (!processAlive(-group)) return Effect.void
      const before = processTable()
      const descendants = descendantGroups(before, group, ownGroup(before))
      const left = () => processAlive(-group) || descendants.some((d) => processAlive(-d))
      try {
        process.kill(-group, "SIGTERM")
      } catch {
        // Gone already.
      }
      return Effect.andThen(
        nativeWait(() => !left(), Duration.toMillis(grace)),
        Effect.sync(() => {
          if (left()) killTree(group, before)
        }),
      )
    }),
  )

/**
 * Ends once `done` holds or `ms` have passed, by native time, as the spawner's own waits do: a
 * scenario's TestClock stands still, and the kill must not wait on it.
 */
const nativeWait = (done: () => boolean, ms: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const deadline = Date.now() + ms
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () => {
      if (Date.now() >= deadline || done()) resume(Effect.void)
      else timer = setTimeout(poll, Duration.toMillis(groupPoll))
    }
    poll()
    return Effect.sync(() => clearTimeout(timer))
  })

/** How much of each of stdout and stderr is kept in memory, unless the command says otherwise. */
export const defaultMaxOutputBytes = 16 * 1024 * 1024

export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly timeLimit: Duration.Input
  readonly cwd?: string
  /**
   * The environment the command starts from, in place of tutti's own: that of a command run on a
   * branch's behalf (src/agent/env.ts's BranchEnv). Either goes without git's local variables
   * (gitEnv.ts).
   */
  readonly baseEnv?: Readonly<Record<string, string>>
  /** Set over the environment it starts from. */
  readonly env?: Readonly<Record<string, string>>
  /** Written to the command's stdin, which is otherwise closed. */
  readonly stdin?: string
  /** A file that receives the whole of stdout and stderr as they come, interleaved. */
  readonly outputFile?: string
  /**
   * An open descriptor that receives the whole output instead, as `outputFile` would: one opened
   * through the symlink guard (§ 9.1), so no path is opened. exec writes to it and leaves it open.
   */
  readonly outputFd?: number
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
  /** Which of stdout and stderr ran past `maxOutputBytes`, so that only their last bytes are kept. */
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean }
}

/**
 * Why a read whose stdout ran past `max` bytes (`truncated.stdout`) fails rather than be read: it
 * lost its start, so what is left is a partial first field or no JSON at all.
 */
export const outputCut = (max: number, whose = "its"): string =>
  `${whose} output ran past ${max} bytes, and only the last were kept`

/**
 * The process groups exec has started and not yet seen killed, by their leader's PID. A command
 * that is still here once the run's scope has closed was left running: whole-run scenarios read
 * this to fail on it (§ 13), each with a registry of its own.
 */
export const ProcessGroups = Context.Reference<Set<number>>("tutti/services/exec/ProcessGroups", {
  defaultValue: () => new Set(),
})

/** The command exited with a code other than 0. A command killed by a signal gets 128 + its number. */
export class CommandExitedNonZero extends Schema.TaggedError<CommandExitedNonZero>()(
  "CommandExitedNonZero",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
  },
) {}

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

/** The word as a shell reads it back: as it is when plain, else in single quotes. */
export const shellWord = (word: string): string =>
  plainArg.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`

/** The command as a person would type it into a shell, for errors and logs. */
export const showCommand = (command: Pick<Command, "command" | "args">): string =>
  [command.command, ...command.args].map(shellWord).join(" ")

/** The last `max` bytes of a stream, decoded once at the end so no character is split mid-way. */
class Tail {
  private chunks: Array<Uint8Array> = []
  private size = 0
  /** Some of the stream has been dropped. */
  cut = false

  constructor(private readonly max: number) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.max) {
      const first = this.chunks[0]
      if (first === undefined) break
      const excess = this.size - this.max
      this.cut = true
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

/** Writes the whole chunk to the descriptor, however many writes it takes. */
const writeAllTo = (fd: number, chunk: Uint8Array): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      for (let written = 0; written < chunk.length; ) {
        written += writeSync(fd, chunk, written)
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

/**
 * Runs a command to its end and returns its exit code and output, whatever the code. Fails with
 * CommandTimedOut past its time limit, and with CommandNotRun when it can't be started or its exit
 * is lost (see LostExitGrace).
 */
export const exec = Effect.fn("exec")(function* (command: Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const groups = yield* ProcessGroups
  const shown = showCommand(command)
  const notRun = (error: PlatformError | Error) =>
    new CommandNotRun({ command: shown, reason: error.message })
  const timeLimit = Duration.fromInputUnsafe(command.timeLimit)
  const grace = command.killGrace ?? defaultKillGrace
  const max = command.maxOutputBytes ?? defaultMaxOutputBytes
  const lostGrace = yield* LostExitGrace
  const leftoverGrace = yield* LeftoverOutputGrace

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file =
        command.outputFile === undefined || command.outputFd !== undefined
          ? undefined
          : yield* fs.open(command.outputFile, { flag: "w" }).pipe(Effect.mapError(notRun))
      // Added before the spawn, so it runs after the spawner's finalizer has killed the group.
      let group: number | undefined
      let reaper: Reaper | undefined
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopReaper(reaper)
          if (group !== undefined) groups.delete(group)
        }),
      )
      // The spawner's finalizer waits on the command's exit, so it has a scope of its own: one that
      // isn't waited on once the exit is lost, found lost or not (exec interrupted before it knew).
      const spawned = yield* Scope.make()
      let lost = false
      yield* Effect.addFinalizer((exit) => {
        const leader = group
        if (leader === undefined) return Scope.close(spawned, exit)
        const closing = Effect.forkDetach(Scope.close(spawned, exit))
        if (lost) return Effect.asVoid(closing)
        return Effect.flatMap(closing, (fiber) =>
          Effect.raceFirst(
            Effect.interruptible(Fiber.join(fiber)),
            groupGoneFor(leader, lostGrace),
          ),
        )
      })
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(command.command, command.args, {
            cwd: command.cwd,
            env: withoutGitLocal(command.baseEnv ?? process.env, command.env),
            detached: true,
            // No forceKillAfter: the SIGKILL is stopGroup's, to the tree, not the spawner's.
            killSignal: "SIGTERM",
            stdin:
              command.stdin === undefined
                ? "ignore"
                : Stream.make(new TextEncoder().encode(command.stdin)),
            stdout: "pipe",
            stderr: "pipe",
          }),
        )
        .pipe(Scope.provide(spawned), Effect.mapError(notRun))
      group = handle.pid
      groups.add(group)
      const leader = group
      const killGrace = Duration.fromInputUnsafe(grace)
      reaper = yield* Effect.sync(() => startReaper(leader, Duration.toSeconds(killGrace), true))
      const exitLost = groupGoneFor(leader, lostGrace)
      const kill = stopGroup(leader, killGrace)
      // Added after the spawn, so it runs before the spawner's finalizer, whose SIGTERM it gives.
      yield* Effect.addFinalizer(() => kill)

      // A leader still running at the limit has timed out, whatever code it exits with once killed.
      // One whose group has gone has ended, its exit lost.
      let timedOut = false
      yield* Effect.interruptible(sleepAwake(timeLimit)).pipe(
        Effect.andThen(handle.isRunning),
        Effect.flatMap((running) => {
          timedOut = running && processAlive(-leader)
          return running ? kill : Effect.void
        }),
        Effect.ignore,
        Effect.forkScoped,
      )

      const stdout = new Tail(max)
      const stderr = new Tail(max)
      const take = (tail: Tail, chunk: Uint8Array, from: "stdout" | "stderr") => {
        tail.push(chunk)
        command.onOutput?.(chunk, from)
        if (command.outputFd !== undefined) return writeAllTo(command.outputFd, chunk)
        return file === undefined ? Effect.void : file.writeAll(chunk)
      }
      const reading = yield* Stream.merge(
        Stream.map(handle.stdout, (chunk) => [stdout, chunk, "stdout"] as const),
        Stream.map(handle.stderr, (chunk) => [stderr, chunk, "stderr"] as const),
      ).pipe(
        Stream.runForEach(([tail, chunk, from]) => take(tail, chunk, from)),
        Effect.mapError(notRun),
        Effect.forkScoped,
      )

      const exit = yield* Effect.raceFirst(
        Effect.interruptible(Effect.exit(handle.exitCode)),
        Effect.as(exitLost, undefined),
      )
      if (exit === undefined) {
        // The output went with the exit: what came of it is no result.
        lost = true
        if (timedOut) {
          return yield* new CommandTimedOut({ command: shown, timeLimit, stderr: stderr.text() })
        }
        return yield* new CommandNotRun({
          command: shown,
          reason: "its process group ended, but its exit and the end of its output never came",
        })
      }
      // The leader has gone. What is left of its group would hold the pipes open, so it goes too.
      // A process outside the group can still hold them: exec reads on for a grace, then stops.
      yield* kill
      const read = yield* Effect.timeoutOption(
        Effect.interruptible(Fiber.join(reading)),
        leftoverGrace,
      )
      if (Option.isNone(read)) {
        yield* Fiber.interrupt(reading)
        yield* take(
          stderr,
          new TextEncoder().encode(leftoverOutputNote(leftoverGrace)),
          "stderr",
        ).pipe(Effect.mapError(notRun))
      }

      const exitCode = Exit.isSuccess(exit) ? exit.value : signalExitCode(exit.cause)
      if (timedOut) {
        return yield* new CommandTimedOut({ command: shown, timeLimit, stderr: stderr.text() })
      }
      return {
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: { stdout: stdout.cut, stderr: stderr.cut },
      } satisfies Output
    }),
  )
})

/** Runs a command as `exec` does, and fails with CommandExitedNonZero when it exits with a code other than 0. */
export const run = Effect.fn("run")(function* (command: Command) {
  const output = yield* exec(command)
  if (output.exitCode !== 0) {
    return yield* new CommandExitedNonZero({
      command: showCommand(command),
      exitCode: output.exitCode,
      stderr: output.stderr,
    })
  }
  return output
})
