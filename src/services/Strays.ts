// Strays (§ 5 item 12): the processes a ticket's worker left running in its worktree, stopped when
// tutti removes the worktree or deletes its folder from the trash. On macOS a test runner's workers
// killed with their parent (a Bash tool call that timed out, vitest's pool after its main process
// died) can be left spinning in process groups of their own, parented to launchd, long after the
// ticket merged: no process tree of tutti's holds them, so only where they run says whose they
// are. A stray is a process whose working directory or executable (or a file it maps as text, such
// as a native module) is in the folder; its rename into the trash moves them with it.
//
// They are found with lsof on macOS (`-d cwd,txt`, a tenth of a second for the whole machine) and
// from /proc on Linux, where lsof may not be installed; another user's processes, which tutti may
// not signal, aren't listed. Each gets a SIGTERM, and those still in the folder after the grace a
// SIGKILL. tutti's own process and its parent are never strays.
import { join } from "node:path"
import { Context, Duration, Effect, FileSystem, Layer, Schedule } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { exec, TimeLimit } from "./exec.ts"
import { processAlive } from "./processTree.ts"

/** A process left running in a folder: its ID and its command's name. */
export interface Stray {
  readonly pid: number
  readonly command: string
}

export class Strays extends Context.Service<
  Strays,
  {
    /**
     * Stops the processes left running in `folder`, other users' aside: SIGTERM, then SIGKILL to
     * those still there after the grace. It returns those it signalled, and never fails: a folder
     * that isn't there, or a listing that fails, has none.
     */
    stop(folder: string): Effect.Effect<ReadonlyArray<Stray>>
  }
>()("tutti/services/Strays") {}

/** How long a stray has between its SIGTERM and its SIGKILL. */
export const strayGrace: Duration.Duration = Duration.seconds(5)

/** A process as the listing gives it: the paths it has as its directory, executable or text. */
export interface Listed extends Stray {
  readonly paths: ReadonlyArray<string>
}

/** lsof's arguments listing every process's directory and text files, as fields parseLsof reads. */
export const lsofArgs = ["-n", "-P", "-w", "+c", "0", "-d", "cwd,txt", "-F", "pcn"] as const

/**
 * The processes in `text`, lsof's output with lsofArgs: a `p<pid>` line starts each, `c<command>`
 * names it, and an `n<path>` line gives each of its files. Lines of other fields are skipped.
 */
export const parseLsof = (text: string): Array<Listed> => {
  const listed: Array<{ pid: number; command: string; paths: Array<string> }> = []
  for (const line of text.split("\n")) {
    const field = line.slice(1)
    if (line.startsWith("p")) {
      if (/^\d+$/.test(field)) listed.push({ pid: Number(field), command: "", paths: [] })
      continue
    }
    const current = listed.at(-1)
    if (current === undefined) continue
    if (line.startsWith("c")) current.command = field
    else if (line.startsWith("n") && field !== "") current.paths.push(field)
  }
  return listed
}

/** Whether `path` is `folder` or in it. */
export const inFolder = (folder: string, path: string): boolean =>
  path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`)

/** The processes of `listed` in `folder`, but `spare`'s. */
export const straysIn = (
  listed: ReadonlyArray<Listed>,
  folder: string,
  spare: ReadonlyArray<number>,
): Array<Stray> =>
  listed
    .filter(
      (each) => !spare.includes(each.pid) && each.paths.some((path) => inFolder(folder, path)),
    )
    .map(({ pid, command }) => ({ pid, command }))

/** Sends `signal` to process `pid`; false when it has gone or may not be signalled. */
const signal = (pid: number, name: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, name)
    return true
  } catch {
    return false
  }
}

/** How often stop looks for the strays it sent a SIGTERM while the grace lasts. */
const poll = Duration.millis(100)

/** The live Strays, its grace `strayGrace` unless `options` says otherwise. */
export const layer = (options: { readonly grace?: Duration.Input } = {}) =>
  Layer.effect(
    Strays,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
      >()
      const fs = yield* FileSystem.FileSystem
      const grace = Duration.fromInputUnsafe(options.grace ?? strayGrace)

      // Each /proc/<pid>'s directory and executable; one tutti may not read is left out.
      const fromProc = Effect.gen(function* () {
        const pids = (yield* fs.readDirectory("/proc")).filter((name) => /^\d+$/.test(name))
        return yield* Effect.forEach(pids, (pid) =>
          Effect.gen(function* () {
            const at = join("/proc", pid)
            const links = yield* Effect.forEach(["cwd", "exe"], (link) =>
              Effect.orElseSucceed(fs.readLink(join(at, link)), () => ""),
            )
            const command = yield* Effect.orElseSucceed(
              fs.readFileString(join(at, "comm")),
              () => "",
            )
            return {
              pid: Number(pid),
              command: command.trim(),
              paths: links.filter((path) => path !== ""),
            }
          }),
        )
      })

      // lsof exits 1 when it can't read some process; what it listed is still there.
      const fromLsof = Effect.map(
        exec({ command: "lsof", args: lsofArgs, timeLimit: TimeLimit.read }),
        (output) => parseLsof(output.stdout),
      )

      const listing: Effect.Effect<ReadonlyArray<Listed>> =
        process.platform === "linux"
          ? Effect.orElseSucceed(fromProc, () => [])
          : Effect.orElseSucceed(Effect.provideContext(fromLsof, context), () => [])

      const spare = [process.pid, process.ppid]
      const strays = (folder: string) =>
        Effect.map(listing, (listed) => straysIn(listed, folder, spare))

      const stop = (given: string) =>
        Effect.gen(function* () {
          const folder = yield* Effect.orElseSucceed(fs.realPath(given), () => undefined)
          if (folder === undefined) return []
          const found = yield* strays(folder)
          const signalled = found.filter((stray) => signal(stray.pid, "SIGTERM"))
          if (signalled.length === 0) return signalled
          yield* Effect.repeat(
            Effect.sync(() => signalled.some((stray) => processAlive(stray.pid))),
            { while: (alive) => alive, schedule: Schedule.spaced(poll) },
          ).pipe(Effect.timeoutOption(grace))
          if (!signalled.some((stray) => processAlive(stray.pid))) return signalled
          // Listed again, so a PID that has gone and been reused elsewhere gets no SIGKILL.
          const left = yield* strays(folder)
          for (const stray of left) signal(stray.pid, "SIGKILL")
          return signalled
        })

      return Strays.of({ stop })
    }),
  )
