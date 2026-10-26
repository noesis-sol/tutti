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

// The reaper's script: $1 is the group, $2 the grace, $3 "tree" when the group's descendants go too.
// `read` returns once tutti's end of the pipe closes; the group is then given its SIGTERM, and its
// SIGKILL if it is still there after the grace. With "tree", that SIGKILL is processTree.ts's
// killTree: the group stopped, then the groups of its members' descendants killed (descendantTree,
// descendantGroups's), and the group last. The tree is listed before the SIGTERM too, as exec's
// stopGroup lists it, and the grace lasts while a group of that listing is there: a test worker
// whose bun test has gone is out of the tree by then, its parent PID 1.
const descendantTree =
  'ps -A -o pid=,ppid=,pgid= | awk -v g="$1" -v me="$(ps -o pgid= -p $$)" \'{ pid[NR] = $1; ppid[NR] = $2; pgid[NR] = $3; if ($3 == g) tree[$1] = 1 } END { do { more = 0; for (i = 1; i <= NR; i++) if (!(pid[i] in tree) && (ppid[i] in tree)) { tree[pid[i]] = 1; more = 1 } } while (more); for (i = 1; i <= NR; i++) if ((pid[i] in tree) && pgid[i] > 1 && pgid[i] != g && pgid[i] != me && !(pgid[i] in seen)) { seen[pgid[i]] = 1; print pgid[i] } }\''
const reaperScript = `read _; before=; if [ "$3" = tree ]; then before=$(${descendantTree}); fi; left() { kill -0 -"$1" 2>/dev/null && return 0; for d in $before; do kill -0 -"$d" 2>/dev/null && return 0; done; return 1; }; kill -TERM -"$1" 2>/dev/null; i=0; while [ "$i" -lt "$2" ] && left "$1"; do sleep 1; i=$((i + 1)); done; if [ "$3" = tree ]; then kill -STOP -"$1" 2>/dev/null; for d in $before $(${descendantTree}); do kill -KILL -"$d" 2>/dev/null; done; fi; kill -KILL -"$1" 2>/dev/null`

/**
 * Starts the reaper of the process group whose leader is `group`, with a grace of `grace` whole
 * seconds, and returns it, or undefined when `group` is no PID to reap. With `tree`, its SIGKILL
 * takes the groups of the group's descendants too (killTree): a worker's, whose Claude Code's Bash
 * shells lead groups of their own, and a command's, whose bun test workers do.
 */
export const startReaper = (
  group: number | undefined,
  grace: number = reapGrace,
  tree = false,
): ChildProcess | undefined => {
  if (group === undefined || !Number.isInteger(group) || group <= 1) return undefined
  const seconds = Math.max(0, Math.ceil(grace))
  const args = ["-c", reaperScript, "reaper", String(group), String(seconds)]
  const reaper = spawn("/bin/sh", tree ? [...args, "tree"] : args, {
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
 * Starts the reaper of the process group `child` leads, its descendants' with it when `tree`
 * (startReaper), and returns it, or undefined when `child` has no PID to reap. The reaper is killed
 * when `child` exits.
 */
export const reap = (
  child: ChildProcess,
  grace: number = reapGrace,
  tree = false,
): ChildProcess | undefined => {
  const reaper = startReaper(child.pid, grace, tree)
  if (reaper === undefined) return undefined
  const done = () => stopReaper(reaper)
  if (child.exitCode !== null || child.signalCode !== null) done()
  else child.once("exit", done)
  return reaper
}
