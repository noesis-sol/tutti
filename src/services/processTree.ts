// A worker's process tree (§ 3.2): Claude Code leads a process group of its own, but its Bash
// shells are detached, each the leader of a group of its own, and only Claude Code's own shutdown
// stops them. Killing Claude Code's group outright (a SIGKILL, from tutti, the SDK or a reaper)
// would leave its commands running, using the worker's share of the cores and writing into a
// worktree tutti reuses or removes. So before that SIGKILL the group is stopped (SIGSTOP: it
// starts no more), the groups of its members' descendants are read from ps, and each is killed
// with the group.
//
// A check's tree (§ 3.3 "Time limits") is killed the same way: bun test --parallel runs each test
// worker in a group of its own, and a SIGKILL of the check's group alone, before bun test has
// handled its SIGTERM, leaves them running. A worker whose coordinator has gone has PID 1
// (launchd) for its parent, out of the tree, so exec lists the tree before its SIGTERM and killTree
// kills that listing's groups too.
//
// The kill is synchronous, as the SDK's child.kill("SIGKILL") it stands behind is, so ps is run
// with node:child_process's spawnSync rather than effect/process.
import { spawnSync } from "node:child_process"

/** A process, as ps lists it. */
export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
}

/** The ps arguments whose output parseProcesses reads. */
export const psArgs = ["-A", "-o", "pid=,ppid=,pgid="] as const

/** The processes in `text`, ps's output with psArgs: three numbers a line; other lines are skipped. */
export const parseProcesses = (text: string): Array<ProcessRow> =>
  text.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 3 || !fields.every((field) => /^\d+$/.test(field))) return []
    const [pid, ppid, pgid] = fields.map(Number) as [number, number, number]
    return [{ pid, ppid, pgid }]
  })

/**
 * The process groups of the descendants of `group`'s members, other than `group` itself, `spare`'s
 * and any of PID 1 or below, in the order they are found.
 */
export const descendantGroups = (
  processes: ReadonlyArray<ProcessRow>,
  group: number,
  spare: ReadonlyArray<number> = [],
): Array<number> => {
  const tree = new Set(processes.filter((p) => p.pgid === group).map((p) => p.pid))
  let grown = true
  while (grown) {
    grown = false
    for (const p of processes) {
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid)
        grown = true
      }
    }
  }
  const groups: Array<number> = []
  for (const p of processes) {
    if (!tree.has(p.pid) || p.pgid <= 1 || p.pgid === group || spare.includes(p.pgid)) continue
    if (!groups.includes(p.pgid)) groups.push(p.pgid)
  }
  return groups
}

/**
 * Whether process `pid` is there, or, for a negative `pid`, some process of the group `-pid` leads.
 * Only ESRCH says it has gone: EPERM is one tutti may not signal, as another user's, or on macOS a
 * group whose only member is a zombie not yet reaped.
 */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Sends `signal` to the process group `group`; false when there is none to signal. */
const signalGroup = (group: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-group, signal)
    return true
  } catch {
    return false
  }
}

/** The process table, from ps; empty when ps can't be run. */
export const processTable = (): Array<ProcessRow> => {
  const ps = spawnSync("ps", psArgs, { encoding: "utf8", timeout: 5000, windowsHide: true })
  return ps.status === 0 && typeof ps.stdout === "string" ? parseProcesses(ps.stdout) : []
}

/** The process group of tutti itself, in `processes`, as a list to spare (descendantGroups). */
export const ownGroup = (processes: ReadonlyArray<ProcessRow>): Array<number> => {
  const own = processes.find((p) => p.pid === process.pid)?.pgid
  return own === undefined ? [] : [own]
}

/**
 * The groups killTree kills before `group`: the descendants' groups in `processes`
 * (descendantGroups), then those of `before`, an earlier listing, that a member's death has since
 * cut from the tree, where a process `before` listed in one is still in it, so that no group whose
 * ID was reused since is named.
 */
export const treeGroups = (
  processes: ReadonlyArray<ProcessRow>,
  before: ReadonlyArray<ProcessRow>,
  group: number,
  spare: ReadonlyArray<number> = [],
): Array<number> => {
  const now = descendantGroups(processes, group, spare)
  const listed = new Set(before.map((p) => `${p.pid} ${p.pgid}`))
  const earlier = descendantGroups(before, group, spare).filter(
    (descendant) =>
      !now.includes(descendant) &&
      processes.some((p) => p.pgid === descendant && listed.has(`${p.pid} ${p.pgid}`)),
  )
  return [...now, ...earlier]
}

/**
 * Kills the process group `group` leads with SIGKILL, and first the groups of its members'
 * descendants (descendantGroups), never tutti's own: Claude Code's detached Bash shells with it,
 * and a check's test workers. With `before`, the process table listed before the group was first
 * signalled, the descendants' groups it had go too (treeGroups), the group gone or not. Never a
 * missing or bad PID.
 */
export const killTree = (
  group: number | undefined,
  before: ReadonlyArray<ProcessRow> = [],
): void => {
  if (group === undefined || !Number.isInteger(group) || group <= 1) return
  const stopped = signalGroup(group, "SIGSTOP")
  if (!stopped && before.length === 0) return
  const processes = processTable()
  for (const descendant of treeGroups(processes, before, group, ownGroup(processes))) {
    signalGroup(descendant, "SIGKILL")
  }
  if (stopped) signalGroup(group, "SIGKILL")
}
