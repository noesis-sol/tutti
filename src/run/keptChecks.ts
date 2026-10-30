// A ticket's failed checks' outputs, kept beside its transcript (§ 9.1, § 10). A check or a setup
// run in a ticket's worktree writes its whole output to the worktree's .tutti/run/, which goes when
// the worktree is trashed or removed, while the worker's transcript in the main checkout outlives
// it. So the output of one that failed or timed out is copied to the main checkout's
// .tutti/run/workers/<id>/checks/<suite>-<n>.log, n counting on from the folder's highest, and its
// `check` record names the copy. A copy holds at most the output's last KeptOutputs.bytes, cut at
// a line's start, and a ticket keeps its last KeptOutputs.files copies, the older removed as each
// is kept. Every file is opened, and removed, through the symlink guard.
import { fstatSync, readdirSync, readSync, writeSync } from "node:fs"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { close, makeFoldersUnder, O, openUnder, removeUnder } from "../native/libc.ts"
import { runFolder, ticketIdProblem } from "../services/Worktrees.ts"
import { detail, Log } from "./log.ts"

/** How much of a ticket's failed checks' output is kept. */
export const KeptOutputs = {
  /** How many of its failed checks' outputs a ticket keeps: its last. */
  files: 10,
  /** How many bytes of an output a copy holds at most: its last, from a line's start. */
  bytes: 1024 * 1024,
} as const

/** The folder of a ticket's kept outputs, relative to the main checkout's top level. */
export const keptChecksFolder = (ticket: string): string => `${runFolder}/workers/${ticket}/checks`

/** A kept output's file name and its number. */
export interface KeptFile {
  readonly name: string
  readonly n: number
}

const keptName = /^[a-z]+-([1-9][0-9]*)\.log$/

/** The kept outputs among `names`, a ticket's folder's, oldest first; other files are left out. */
export const keptFiles = (names: ReadonlyArray<string>): ReadonlyArray<KeptFile> =>
  names
    .flatMap((name) => {
      const match = keptName.exec(name)
      return match === null ? [] : [{ name, n: Number(match[1]) }]
    })
    .sort((a, b) => a.n - b.n)

/** The line a copy cut short starts with, saying how much of the output it left out. */
export const cutNote = (left: number, size: number): string =>
  `[tutti kept the last ${size - left} bytes of this output's ${size}; the first ${left} are left out]\n`

const chunkSize = 64 * 1024

// copyTail copies the file at `from` to `to`: whole, or where it is longer than `most` bytes, from
// the first line that starts within its last `most`, after a cutNote.
const copyTail = (from: number, to: number, most: number): void => {
  const write = (bytes: Uint8Array) => {
    for (let written = 0; written < bytes.length; ) {
      written += writeSync(to, bytes, written, bytes.length - written)
    }
  }
  const size = fstatSync(from).size
  const chunk = Buffer.alloc(chunkSize)
  let at = 0
  if (size > most) {
    at = size - most
    // A line that started before the cut goes; one starting right at it is kept.
    if (readSync(from, chunk, 0, 1, at - 1) === 1 && chunk[0] !== 0x0a) {
      for (let found = false; !found && at < size; ) {
        const read = readSync(from, chunk, 0, chunk.length, at)
        if (read === 0) break
        const newline = chunk.subarray(0, read).indexOf(0x0a)
        found = newline !== -1
        at += found ? newline + 1 : read
      }
    }
    write(Buffer.from(cutNote(at, size)))
  }
  for (;;) {
    const read = readSync(from, chunk, 0, chunk.length, at)
    if (read === 0) return
    write(chunk.subarray(0, read))
    at += read
  }
}

/**
 * Keeps the output of `ticket`'s `suite` check that failed, `name` in its worktree's .tutti/run/,
 * in the main checkout (keptChecksFolder), removing the ticket's older copies beyond
 * KeptOutputs.files, and gives the copy's absolute path. Undefined when it can't be kept: a detail
 * line says why, and the check's record names the worktree's file.
 */
export const keepFailedOutput = (
  ticket: string,
  suite: string,
  worktree: string,
  name: string,
): Effect.Effect<string | undefined, never, AppConfig | Log> =>
  Effect.gen(function* () {
    const { repo } = yield* AppConfig
    const folder = keptChecksFolder(ticket)
    const kept = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const problem = ticketIdProblem(ticket)
          if (problem !== undefined) return yield* Effect.fail(new Error(problem))
          // Stops at a link, which openUnder then refuses, naming it.
          const why = makeFoldersUnder(repo, folder)
          if (why !== undefined) return yield* Effect.fail(new Error(why))
          const before = keptFiles(
            yield* Effect.try({
              try: () => readdirSync(join(repo, folder)),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }),
          )
          const file = `${folder}/${suite}-${(before.at(-1)?.n ?? 0) + 1}.log`
          const open = (directory: string, path: string, flags: number) =>
            Effect.acquireRelease(openUnder(directory, path, flags), (fd) =>
              Effect.ignore(close(fd)),
            )
          const source = yield* open(worktree, `${runFolder}/${name}`, O.RDONLY)
          const target = yield* open(repo, file, O.WRONLY | O.CREAT | O.EXCL)
          yield* Effect.try({
            try: () => copyTail(source, target, KeptOutputs.bytes),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          })
          for (const old of before.slice(0, Math.max(0, before.length + 1 - KeptOutputs.files))) {
            yield* Effect.ignore(removeUnder(repo, `${folder}/${old.name}`))
          }
          return join(repo, file)
        }),
      ),
    )
    if (Result.isSuccess(kept)) return kept.success
    const what = suite === "setup" ? "setup" : `${suite} check`
    yield* (yield* Log).write(
      detail`${ticket}'s ${what}'s output can't be kept in ${join(repo, folder)}: ${kept.failure.message}`,
    )
    return undefined
  })
