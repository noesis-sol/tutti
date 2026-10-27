// A Claude Code process tutti spawns for the SDK, a worker's, the login probe's, the usage probe's
// or an organ's, kept one way by ClaudeCode's adapter (§ 3.2): spawned into a process group of its own
// (spawnInOwnProcessGroup), the end of its stderr kept for the reason a session failed, and its
// exit waited for once its session is closed, its group killed when it doesn't come in time. A
// setup problem or an unwanted turn kills the group at once, without the SDK's grace. A worker's runs
// at a lower CPU priority (workerNice), so that the merge check keeps its pace beside the workers;
// where it can't be lowered, or is raised back, its stderr says why, once in tutti's process.
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { getPriority, setPriority } from "node:os"
import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect } from "effect"
import { killTree } from "../services/processTree.ts"
import { spawnInOwnProcessGroup } from "./options.ts"

/**
 * How far below normal a worker's Claude Code runs (its nice value), and with it what it starts, its
 * commands and their checks: the merge check, which holds the merge queue, runs at normal priority
 * and keeps its pace beside the workers' own checks (tutti-ejkt.12).
 */
export const workerNice = 10

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
 * How long after lowering a priority lower() reads it again, and sets it again where it was raised
 * back: on GitHub's macOS runners a worker's was found back at tutti's own (tutti-djtt).
 */
export const lowerRecheck = Duration.millis(100)

/** Whether a process has said why it couldn't lower a priority: it says so once. */
export interface LowerTold {
  said: boolean
}

/** This process's: lower() says why it couldn't lower a priority once in tutti's life. */
const toldHere: LowerTold = { said: false }

/** What lower() reads and sets a priority with, and where it says why it couldn't. */
export interface LowerWith {
  /** Where lower() says, once, why it couldn't: the session's stderr. */
  readonly say: (line: string) => void
  /** Whether the child still runs: an exited child's priority is neither read nor set. */
  readonly alive: () => boolean
  /** Whether it has said so: this process's, unless a test gives its own. */
  readonly told?: LowerTold
  /** os's calls on a pid, for a test's process table. */
  readonly os?: {
    readonly getPriority: (pid: number) => number
    readonly setPriority: (pid: number, priority: number) => void
  }
}

/**
 * The error's code and message, as a priority call failed: Bun's names the code already ("A system
 * error occurred: uv_os_setpriority returned EPERM (operation not permitted)").
 */
const failure = (cause: unknown): string => {
  const error = cause as { code?: unknown; info?: { code?: unknown } } | null
  const code = error?.info?.code ?? error?.code
  const message = cause instanceof Error ? cause.message : String(cause)
  return typeof code === "string" && !message.includes(code) ? `${code}: ${message}` : message
}

/**
 * Lowers process `pid`'s priority to `nice`, unless it runs lower already, as tutti's own may, and
 * reads it back; reads it again lowerRecheck later, and sets it again where it was raised back. The
 * first time in tutti's process it can't, or finds it raised, it says why through `say`: the error's
 * code and message, the pid, the priority it read before and the one it found after. A priority
 * that can't be set leaves the session at tutti's own.
 */
export const lower = (pid: number, nice: number, using: LowerWith) => {
  const { getPriority: read, setPriority: set } = using.os ?? { getPriority, setPriority }
  const told = using.told ?? toldHere
  const say = (what: string) => {
    if (told.said) return
    told.said = true
    using.say(`tutti: ${what}\n`)
  }
  /** The child's nice value, or why it couldn't be read. */
  const found = (): number | string => {
    try {
      return read(pid)
    } catch (cause) {
      return failure(cause)
    }
  }
  const shown = (at: number | string) =>
    typeof at === "number" ? `nice ${at}` : `no priority (${at})`
  const isLow = (at: number | string) => typeof at === "number" && at >= nice
  /** Sets it where it runs above `nice`: "low" where it ran at `nice` or lower already. */
  const attempt = (): "low" | "lowered" | { readonly why: string } => {
    const before = found()
    if (isLow(before)) return "low"
    if (typeof before === "string")
      return { why: `couldn't read Claude Code's priority (pid ${pid}) to lower it: ${before}` }
    const was = `Claude Code (pid ${pid}, at ${shown(before)})`
    try {
      set(pid, nice)
    } catch (cause) {
      const after = shown(found())
      return {
        why: `couldn't lower ${was} to nice ${nice}: ${failure(cause)}; found ${after} after`,
      }
    }
    const after = found()
    return isLow(after)
      ? "lowered"
      : { why: `lowered ${was} to nice ${nice}, but found ${shown(after)} after` }
  }
  const first = attempt()
  if (first === "low") return
  if (first !== "lowered") say(first.why)
  const later = Duration.toMillis(lowerRecheck)
  const recheck = setTimeout(() => {
    if (!using.alive()) return
    const now = found()
    if (isLow(now)) return
    const again = attempt()
    if (first !== "lowered" || again === "low") return
    const outcome = again === "lowered" ? `nice ${nice}` : again.why
    say(
      `Claude Code (pid ${pid}), lowered to nice ${nice}, was at ${shown(now)} ${later} ms later; set again: ${outcome}`,
    )
  }, later)
  recheck.unref?.()
}

/**
 * `options` with the spawn of a SessionProcess, and the SessionProcess: Claude Code spawned into a
 * process group of its own, at `nice` when given, its stderr passed to `options.stderr` as before,
 * and its end kept.
 */
export const withSessionProcess = (
  options: Options,
  nice?: number,
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
        if (nice !== undefined && spawned.pid !== undefined)
          lower(spawned.pid, nice, {
            say: (line) => {
              try {
                stderr?.(line)
              } catch {
                // A transcript that can't be written mustn't end the session.
              }
            },
            alive: () => !gone(spawned),
          })
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
