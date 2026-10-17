// A process group's reaper (§ 3.2, § 3.3 "Time limits"): a sh in a process group of its own, its
// stdin a pipe from tutti. A kill -9 of tutti runs no finalizer and takes every time limit with it,
// but it closes the reaper's pipe too, and the reaper then ends the group it watches: SIGTERM, then
// SIGKILL after a grace. Workers' groups and exec's commands' get one each. The reaper holds no
// reference to tutti's event loop, so a tutti that exits doesn't wait on it.
//
// The reaper must outlive tutti and must not keep it running, so it is started with
// node:child_process's spawn and unref'd, which effect/process doesn't offer.
import { type ChildProcess, spawn } from "node:child_process"

/** How long a reaped group has between the reaper's SIGTERM and its SIGKILL, in whole seconds. */
export const reapGrace = 10

// The reaper's script: $1 is the group, $2 the grace. `read` returns once tutti's end of the pipe
// closes; the group is then given its SIGTERM, and its SIGKILL if it is still there after the grace.
const reaperScript =
  'read _; kill -TERM -"$1" 2>/dev/null; i=0; while [ "$i" -lt "$2" ] && kill -0 -"$1" 2>/dev/null; do sleep 1; i=$((i + 1)); done; kill -KILL -"$1" 2>/dev/null'

/**
 * Starts the reaper of the process group whose leader is `group`, with a grace of `grace` whole
 * seconds, and returns it, or undefined when `group` is no PID to reap.
 */
export const startReaper = (
  group: number | undefined,
  grace: number = reapGrace,
): ChildProcess | undefined => {
  if (group === undefined || !Number.isInteger(group) || group <= 1) return undefined
  const seconds = Math.max(0, Math.ceil(grace))
  const reaper = spawn("/bin/sh", ["-c", reaperScript, "reaper", String(group), String(seconds)], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
    windowsHide: true,
  })
  reaper.on("error", () => {})
  reaper.stdin?.on("error", () => {})
  reaper.unref()
  return reaper
}

/** Ends a reaper whose group has gone, without it reaping, if it is still running. */
export const stopReaper = (reaper: ChildProcess | undefined): void => {
  if (reaper === undefined) return
  if (reaper.exitCode === null && reaper.signalCode === null) reaper.kill("SIGKILL")
}

/**
 * Starts the reaper of the process group `child` leads, and returns it, or undefined when `child`
 * has no PID to reap. The reaper is killed when `child` exits.
 */
export const reap = (child: ChildProcess, grace: number = reapGrace): ChildProcess | undefined => {
  const reaper = startReaper(child.pid, grace)
  if (reaper === undefined) return undefined
  const done = () => stopReaper(reaper)
  if (child.exitCode !== null || child.signalCode !== null) done()
  else child.once("exit", done)
  return reaper
}
