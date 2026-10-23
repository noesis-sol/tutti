// A Claude Code process tutti spawns for the SDK, a worker's, the login probe's, the usage probe's
// or an organ's, kept one way (§ 3.2): spawned into a process group of its own
// (spawnInOwnProcessGroup), the end of its stderr kept for the reason a session failed, and its
// exit waited for once its session is closed, its group killed when it doesn't come in time. A
// setup problem or an unwanted turn kills the group at once, without the SDK's grace.
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect } from "effect"
import { killTree } from "../services/processTree.ts"
import { spawnInOwnProcessGroup } from "./options.ts"

/** How much of Claude Code's stderr a session keeps, at most, for the reason it failed. */
export const stderrKept = 2000

/**
 * How long an organ's or the usage probe's Claude Code has to exit once its session is closed,
 * before its process group is killed.
 */
export const organCloseLimit = Duration.seconds(10)

/** How long, once Claude Code has exited, its stderr has to close before its tail is read. */
const stderrGrace = Duration.seconds(1)

/** How much of the end of Claude Code's stderr a reason quotes, at most. */
export const stderrQuoted = 500

/**
 * `why`, then the end of what Claude Code wrote to stderr, on one line, when it wrote anything: the
 * SDK's own error says only its exit code when tutti spawns it (tutti-7l57).
 */
export const withStderr = (why: string, stderr: string): string => {
  const said = stderr
    .split(/\s+/u)
    .filter((word) => word !== "")
    .join(" ")
  return said === "" ? why : `${why}: ${said}`
}

export interface SessionProcess {
  /** Claude Code's process, once the SDK has spawned it. */
  readonly child: () => ChildProcessWithoutNullStreams | undefined
  /** The end of what it wrote to stderr, at most `max` characters, trimmed: "" for nothing. */
  readonly stderrTail: (max?: number) => string
  /** Waits until it has exited: at once when it was never spawned, or never started. */
  readonly exited: Effect.Effect<void>
  /** Kills its process group at once, its descendants' first (killTree); nothing if not spawned. */
  readonly kill: Effect.Effect<void>
  /**
   * Closes its session with `close` (the query's close()), and waits up to `limit` for it to exit,
   * then a moment for its stderr to close; kills its group if it hasn't exited by then.
   */
  readonly closeAndWait: (close: () => void, limit: Duration.Input) => Effect.Effect<void>
}

/** Whether `child` has exited, or never started: a spawn that failed has no PID and never exits. */
const gone = (child: ChildProcessWithoutNullStreams): boolean =>
  child.pid === undefined || child.exitCode !== null || child.signalCode !== null

/** Waits for `child`'s `event` ("exit", or "close" once its stdio has closed too). */
const waitFor = (child: ChildProcessWithoutNullStreams, event: "exit" | "close", done: boolean) =>
  Effect.callback<void>((resume) => {
    if (done) return resume(Effect.void)
    const fire = () => resume(Effect.void)
    child.once(event, fire)
    return Effect.sync(() => child.off(event, fire))
  })

/**
 * `options` with the spawn of a SessionProcess, and the SessionProcess: Claude Code spawned into a
 * process group of its own, its stderr passed to `options.stderr` as before, and its end kept.
 */
export const withSessionProcess = (
  options: Options,
): { readonly options: Options; readonly process: SessionProcess } => {
  let child: ChildProcessWithoutNullStreams | undefined
  let tail = ""
  let stderrClosed = false
  const stderr = options.stderr
  const spawn = spawnInOwnProcessGroup((data) => {
    tail = (tail + data).slice(-stderrKept)
    stderr?.(data)
  })
  const exited = Effect.suspend(() =>
    child === undefined ? Effect.void : waitFor(child, "exit", gone(child)),
  )
  const kill = Effect.sync(() => {
    if (child?.pid !== undefined) killTree(child.pid)
  })
  const process: SessionProcess = {
    child: () => child,
    stderrTail: (max = stderrKept) => tail.slice(-max).trim(),
    exited,
    kill,
    closeAndWait: (close, limit) =>
      Effect.gen(function* () {
        close()
        const spawned = child
        if (spawned === undefined) return
        yield* exited.pipe(Effect.timeoutOrElse({ duration: limit, orElse: () => kill }))
        yield* waitFor(spawned, "close", stderrClosed || spawned.pid === undefined).pipe(
          Effect.timeoutOption(stderrGrace),
        )
      }),
  }
  return {
    options: {
      ...options,
      spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
        const spawned = spawn(spawnOptions)
        child = spawned
        spawned.once("close", () => {
          stderrClosed = true
        })
        return spawned
      },
    },
    process,
  }
}
