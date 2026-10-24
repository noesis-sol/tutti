// The one way tutti writes a file whole: writeFileAtomic. It writes through a link to the file the
// link points at, so a dotfile manager's ~/.claude.json stays a link; keeps the file's mode, or
// takes the one it is given; writes to a temporary file of a name no other writer picks, beside
// the file, syncs it and renames it over the file, then syncs the folder so the rename lasts; and
// removes the temporary file where it fails. A crash at any point leaves the old file or the new
// one, never a mix. tutti init's setup stages its writes instead (src/init/staged.ts), and puts
// them in as one with the same pieces.
import { basename, dirname, join, resolve } from "node:path"
import { Context, Effect, FileSystem } from "effect"
import type { PlatformError } from "effect/PlatformError"

/** The modes of a file written whole; with neither, a new file takes the umask's. */
export interface AtomicWriteOptions {
  /** Its mode, whatever it had. */
  readonly mode?: number | undefined
  /** Its mode where there is no file yet: one there keeps its own. */
  readonly newMode?: number | undefined
}

/** How many links writeTarget follows, as the system's own limit (ELOOP). */
const mostLinks = 40

/**
 * The file a write to `path` lands in: the one a link there points at, through every link, even
 * one that points at nothing yet; `path` itself where it isn't a link.
 */
export const writeTarget = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string> =>
  fs.realPath(path).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        let at = path
        for (let links = 0; links < mostLinks; links++) {
          const link = yield* fs.readLink(at).pipe(Effect.orElseSucceed(() => null))
          if (link === null) return at
          at = resolve(dirname(at), link)
        }
        return at
      }),
    ),
  )

/** A name for a file beside `path`, hidden, ending in `.<kind>`, that no other writer picks. */
export const temporaryBeside = (path: string, kind: string): string =>
  join(dirname(path), `.${basename(path)}.tutti-${process.pid}-${crypto.randomUUID()}.${kind}`)

/** The mode of the file at `path`, its permission bits; null where there is none. */
export const modeOf = (fs: FileSystem.FileSystem, path: string): Effect.Effect<number | null> =>
  fs.stat(path).pipe(
    Effect.map((info) => info.mode & 0o7777),
    Effect.orElseSucceed(() => null),
  )

/**
 * Writes `data` to `temporary`, a file that must not be there yet, with `mode` where it isn't null
 * (past the umask), and syncs it. With `made`, `temporary` is one the caller has made already, as
 * tutti update makes its own to find out that it may write beside the binary.
 */
export const writeSynced = (
  fs: FileSystem.FileSystem,
  temporary: string,
  data: Uint8Array,
  mode: number | null,
  made = false,
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(temporary, {
          flag: made ? "w" : "wx",
          ...(mode === null ? {} : { mode }),
        })
        yield* handle.writeAll(data)
        yield* handle.sync
      }),
    )
    if (mode !== null) yield* fs.chmod(temporary, mode)
  })

/** Syncs `folder`, so that a rename in it lasts; some file systems refuse, and it was renamed. */
export const syncFolder = (fs: FileSystem.FileSystem, folder: string): Effect.Effect<void> =>
  Effect.ignore(
    Effect.scoped(Effect.flatMap(fs.open(folder, { flag: "r" }), (handle) => handle.sync)),
  )

const encoder = new TextEncoder()

/** Writes a file whole, as writeFileAtomic does. */
export type FileWriter = (
  path: string,
  data: string | Uint8Array,
  options?: AtomicWriteOptions,
) => Effect.Effect<void, PlatformError, FileSystem.FileSystem>

/** writeFileAtomic's way when nothing stages the writes: the file replaced on disk. */
export const replaceAtomically: FileWriter = (path, data, options) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const target = yield* writeTarget(fs, path)
    const mode = options?.mode ?? (yield* modeOf(fs, target)) ?? options?.newMode ?? null
    const temporary = temporaryBeside(target, "tmp")
    yield* Effect.gen(function* () {
      yield* writeSynced(
        fs,
        temporary,
        typeof data === "string" ? encoder.encode(data) : data,
        mode,
      )
      yield* fs.rename(temporary, target)
    }).pipe(Effect.onError(() => Effect.ignore(fs.remove(temporary))))
    yield* syncFolder(fs, dirname(target))
  })

/**
 * How writeFileAtomic writes: replaceAtomically, but where tutti init stages its setup, which
 * gives its own writer for the files it puts in as one (src/init/staged.ts).
 */
export const AtomicWriter = Context.Reference<FileWriter>(
  "tutti/services/atomicFile/AtomicWriter",
  {
    defaultValue: () => replaceAtomically,
  },
)

/**
 * Writes `data` to the file at `path` whole: the old file or the new one is there, never a mix
 * (see the top of this file). Its folder must be there.
 */
export const writeFileAtomic: FileWriter = (path, data, options) =>
  Effect.flatMap(AtomicWriter, (write) => write(path, data, options))
