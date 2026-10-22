// A worker's process tree (§ 3.2): Claude Code leads a process group of its own, but its Bash
// shells are detached, each the leader of a group of its own, and only Claude Code's own shutdown
// stops them. Killing Claude Code's group outright (a SIGKILL, from tutti, the SDK or a reaper)
// would leave its commands running, using the worker's share of the cores and writing into a
// worktree tutti reuses or removes. So before that SIGKILL the group is stopped (SIGSTOP: it
// starts no more), the groups of its members' descendants are read from ps, and each is killed
// with the group.
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
const processTable = (): Array<ProcessRow> => {
  const ps = spawnSync("ps", psArgs, { encoding: "utf8", timeout: 5000, windowsHide: true })
  return ps.status === 0 && typeof ps.stdout === "string" ? parseProcesses(ps.stdout) : []
}

/**
 * Kills the process group `group` leads with SIGKILL, and first the groups of its members'
 * descendants (descendantGroups), never tutti's own: Claude Code's detached Bash shells with it.
 * Never a missing or bad PID.
 */
export const killTree = (group: number | undefined): void => {
  if (group === undefined || !Number.isInteger(group) || group <= 1) return
  if (!signalGroup(group, "SIGSTOP")) return
  const processes = processTable()
  const own = processes.find((p) => p.pid === process.pid)?.pgid
  for (const descendant of descendantGroups(processes, group, own === undefined ? [] : [own])) {
    signalGroup(descendant, "SIGKILL")
  }
  signalGroup(group, "SIGKILL")
}
