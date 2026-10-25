// What --overnight's pre-flight reads of the machine beside the kernel's figures (src/run/load.ts),
// as orchestra 0.9.5's overnight_machine.go has it: the processes by name, for the three that use
// the most CPU or memory on a busy machine and for a large virtual machine among them, and the free
// disk where the worktrees go.
import { statfs } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { Effect } from "effect"
import { exec, TimeLimit } from "../services/exec.ts"

/** One process of a listing, with its name: the base name of its executable. */
export interface NamedProcess {
  readonly pid: number
  readonly parent: number
  /** Resident, in bytes. */
  readonly memory: number
  /** The share of a core it has used lately, in percent, as ps gives it. */
  readonly cpu: number
  readonly name: string
}

/** The listing's arguments to ps, the same on macOS and Linux: a process a line, its command last. */
export const namedPsArgs = ["-A", "-o", "pid=,ppid=,rss=,pcpu=,comm="] as const

/** A GB, as the pre-flight counts memory and disk. */
export const gb = 2 ** 30

/**
 * ps's listing of each process's ID, its parent's, its resident memory in kilobytes, its CPU share
 * and its command, a process a line; undefined when a line isn't that. macOS gives the command as
 * the executable's path, spaces and all, Linux its name, which may hold a slash (kworker/0:1).
 */
export const parseNamed = (text: string): ReadonlyArray<NamedProcess> | undefined => {
  const all: Array<NamedProcess> = []
  for (const line of text.split("\n")) {
    const fields = line
      .trim()
      .split(/\s+/)
      .filter((field) => field !== "")
    if (fields.length === 0) continue
    if (fields.length < 5) return undefined
    const [pid, parent, rss, cpu] = fields.slice(0, 4).map((field, at) =>
      // A locale's decimal comma in the CPU share.
      at === 3 && /^\d+(?:[.,]\d+)?$/.test(field)
        ? Number(field.replace(",", "."))
        : /^\d+$/.test(field)
          ? Number(field)
          : Number.NaN,
    ) as [number, number, number, number]
    if ([pid, parent, rss, cpu].some(Number.isNaN)) return undefined
    const command = fields.slice(4).join(" ")
    all.push({
      pid,
      parent,
      memory: rss * 1024,
      cpu,
      name: command.startsWith("/") ? basename(command) : command,
    })
  }
  return all
}

/**
 * The names of the `n` processes of `all` that weigh most by `weight`, heaviest first, those
 * weighing nothing left out, each as `said` says it.
 */
export const heaviest = (
  all: ReadonlyArray<NamedProcess>,
  n: number,
  weight: (process: NamedProcess) => number,
  said: (process: NamedProcess) => string,
): ReadonlyArray<string> =>
  all
    .toSorted((a, b) => weight(b) - weight(a))
    .slice(0, n)
    .filter((process) => weight(process) > 0)
    .map(said)

/** `n` bytes in GB, to a tenth under 10. */
export const memoryGB = (n: number): string =>
  n < 10 * gb ? `${(n / gb).toFixed(1)} GB` : `${Math.floor(n / gb)} GB`

/** The memory a virtual machine holds past which the pre-flight warns of it. */
export const vmMemory = 4 * gb

/**
 * Whether the process `name` runs a virtual machine: Apple's Virtualization framework, which Docker
 * Desktop, OrbStack, Colima and Podman use on macOS, or the hypervisors before it, QEMU and the
 * desktop ones.
 */
export const vmProcess = (name: string): boolean =>
  [
    "com.apple.Virtualization.VirtualMachine",
    "com.docker.hyperkit",
    "hyperkit",
    "vfkit",
    "krunkit",
    "VBoxHeadless",
    "VirtualBoxVM",
    "vmware-vmx",
    "prl_vm_app",
  ].includes(name) || name.startsWith("qemu-system-")

/**
 * The applications that run virtual machines, by the name of a process of theirs, for whose a large
 * virtual machine is: Virtualization's machines run under launchd, not their app.
 */
export const vmApps: Readonly<Record<string, string>> = {
  "com.docker.backend": "Docker Desktop",
  "com.docker.virtualization": "Docker Desktop",
  "com.docker.hyperkit": "Docker Desktop",
  OrbStack: "OrbStack",
  "OrbStack Helper": "OrbStack",
  limactl: "Lima (Colima)",
  colima: "Colima",
  podman: "Podman",
  gvproxy: "Podman",
  UTM: "UTM",
}

/** `a`, `a and b`, `a, b and c`. */
export const joinAnd = (items: ReadonlyArray<string>): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

/**
 * Each virtual machine among `all` holding more than vmMemory, and whose it is where the listing
 * tells: the application above it, else those of vmApps running.
 */
export const largeVMs = (all: ReadonlyArray<NamedProcess>): ReadonlyArray<string> => {
  const byPid = new Map(all.map((process) => [process.pid, process]))
  const running = [...new Set(all.flatMap((process) => vmApps[process.name] ?? []))].toSorted()
  return all
    .filter((process) => vmProcess(process.name) && process.memory > vmMemory)
    .map((process) => {
      let whose = "a virtual machine"
      for (
        let up = process.parent, seen = 0;
        up > 1 && seen < 32;
        up = byPid.get(up)?.parent ?? 0, seen++
      ) {
        const app = vmApps[byPid.get(up)?.name ?? ""]
        if (app !== undefined) {
          whose = `${app}'s virtual machine`
          break
        }
      }
      const vm = `${whose} holds ${memoryGB(process.memory)} of memory (${process.name}, PID ${process.pid})`
      return whose === "a virtual machine" && running.length > 0
        ? `${vm}; ${joinAnd(running)} ${running.length === 1 ? "is" : "are"} running`
        : vm
    })
}

/** The machine's processes with their names, from ps; undefined when they can't be listed. */
export const listNamed = exec({
  command: "ps",
  args: namedPsArgs,
  timeLimit: TimeLimit.read,
  env: { LC_ALL: "C" },
}).pipe(
  Effect.map((out) => (out.exitCode === 0 ? parseNamed(out.stdout) : undefined)),
  Effect.orElseSucceed(() => undefined),
)

/** `dir`, or where it isn't there yet, the nearest folder above it that is. */
const existing = async (dir: string): Promise<string> => {
  for (let at = dir; ; at = dirname(at)) {
    const there = await Bun.file(at)
      .stat()
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => error.code !== "ENOENT")
    if (there || dirname(at) === at) return at
  }
}

/**
 * The free disk where `dir` is, or will be, in bytes, with the folder it was read in: the nearest
 * one that is there; what went wrong where it can't be read.
 */
export const freeDisk = (
  dir: string,
): Effect.Effect<
  { readonly free: number; readonly where: string },
  { readonly where: string; readonly reason: string }
> =>
  Effect.promise(() => existing(dir)).pipe(
    Effect.flatMap((where) =>
      Effect.tryPromise({
        try: async () => {
          const stats = await statfs(where)
          return { free: Number(stats.bavail) * Number(stats.bsize), where }
        },
        catch: (error) => ({
          where,
          reason: error instanceof Error ? error.message : String(error),
        }),
      }),
    ),
  )
