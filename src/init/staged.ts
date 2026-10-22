// tutti init's setup, staged (§ 8.3), so that a failure never leaves it half written. The setup's
// step writes through `staging`'s FileSystem, which keeps every file it writes in memory over the
// project's own and reads them back as written; then `commitStaged` puts them in the project as
// one: each first to a temporary file beside its own, then each renamed over it, the settings last,
// as a run counts the project set up once they are there (src/run/startup.ts). A write or rename
// that fails takes back what came before it: the setup is left as it was, or as init would leave
// it, and SetupNotWritten names any file it couldn't take back.
import { basename, dirname, join, relative, resolve } from "node:path"
import { ByteSize, Effect, FileSystem, Option, Schema, Sink, Stream } from "effect"
import { badArgument, type PlatformError, systemError } from "effect/PlatformError"
import { joinAnd } from "./steps.ts"

/** A file the setup writes: where, what, and its mode where the setup gives one. */
export interface StagedWrite {
  readonly path: string
  readonly data: Uint8Array
  readonly mode: number | null
}

/** A FileSystem that stages its writes over `real`, and the writes it staged, in order. */
export interface Staging {
  readonly fs: FileSystem.FileSystem
  readonly writes: () => ReadonlyArray<StagedWrite>
}

const encoder = new TextEncoder()

/** What a staging FileSystem fails with for what it doesn't stage: nothing in the setup asks it. */
const unstaged = (method: string) =>
  badArgument({
    module: "FileSystem",
    method,
    description: "tutti init stages the setup's writes, and doesn't stage this one",
  })

const notFound = (method: string, path: string) =>
  systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path })

/**
 * A FileSystem over `real` that keeps what is written to it in memory: files written, folders made
 * and modes changed. It reads them back, and reads the rest from `real`; it moves, removes and
 * opens nothing.
 */
export const staging = (real: FileSystem.FileSystem): Staging => {
  const files = new Map<string, { data: Uint8Array; mode: number | null }>()
  const folders = new Set<string>()
  const staged = (path: string) => files.get(resolve(path))
  const stagedFolder = (path: string) => {
    const at = resolve(path)
    if (folders.has(at)) return true
    const inside = `${at}/`
    for (const each of [...folders, ...files.keys()]) if (each.startsWith(inside)) return true
    return false
  }
  const exists = (path: string) =>
    staged(path) !== undefined || stagedFolder(path) ? Effect.succeed(true) : real.exists(path)
  const readFile = (path: string) => {
    const file = staged(path)
    return file === undefined ? real.readFile(path) : Effect.succeed(file.data)
  }
  const write = (
    method: string,
    path: string,
    data: Uint8Array,
    options?: {
      readonly flag?: FileSystem.OpenFlag | undefined
      readonly mode?: number | undefined
    },
  ) =>
    Effect.gen(function* () {
      const flag = options?.flag ?? "w"
      if (flag !== "w" && flag !== "a") return yield* unstaged(`${method} (flag ${flag})`)
      if (!(yield* exists(dirname(path)))) return yield* notFound(method, path)
      const at = resolve(path)
      const was = files.get(at)
      const before =
        flag === "w"
          ? new Uint8Array()
          : (was?.data ??
            (yield* real
              .readFile(path)
              .pipe(
                Effect.catchTag("PlatformError", (error) =>
                  error.reason._tag === "NotFound" ? Effect.succeed(new Uint8Array()) : error,
                ),
              )))
      const joined = new Uint8Array(before.length + data.length)
      joined.set(before)
      joined.set(data, before.length)
      files.delete(at)
      files.set(at, { data: joined, mode: options?.mode ?? was?.mode ?? null })
    })
  const fs = FileSystem.FileSystem.of({
    ...real,
    access: (path, options) =>
      staged(path) !== undefined || stagedFolder(path) ? Effect.void : real.access(path, options),
    exists,
    readFile,
    readFileString: (path, encoding) => {
      const file = staged(path)
      return file === undefined
        ? real.readFileString(path, encoding)
        : Effect.succeed(new TextDecoder(encoding as Bun.Encoding | undefined).decode(file.data))
    },
    stream: (path, options) => {
      const file = staged(path)
      return file === undefined ? real.stream(path, options) : Stream.make(file.data)
    },
    stat: (path) => {
      const file = staged(path)
      if (file === undefined && !stagedFolder(path)) return real.stat(path)
      return Effect.succeed({
        type: file === undefined ? "Directory" : "File",
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 0n,
        ino: Option.none(),
        mode: file?.mode ?? (file === undefined ? 0o755 : 0o644),
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        size: ByteSize.bytes(file?.data.length ?? 0),
        blksize: Option.none(),
        blocks: Option.none(),
      } satisfies FileSystem.File.Info)
    },
    makeDirectory: (path, options) =>
      Effect.gen(function* () {
        if (options?.recursive !== true) {
          if (yield* exists(path)) {
            return yield* systemError({
              _tag: "AlreadyExists",
              module: "FileSystem",
              method: "makeDirectory",
              pathOrDescriptor: path,
            })
          }
          if (!(yield* exists(dirname(path)))) return yield* notFound("makeDirectory", path)
        }
        if (staged(path) !== undefined) return yield* unstaged("makeDirectory (over a file)")
        folders.add(resolve(path))
      }),
    writeFile: (path, data, options) => write("writeFile", path, data, options),
    writeFileString: (path, data, options) =>
      write("writeFileString", path, encoder.encode(data), options),
    chmod: (path, mode) =>
      Effect.gen(function* () {
        const data = yield* readFile(path)
        const at = resolve(path)
        files.set(at, { data, mode })
      }),
    chown: () => unstaged("chown"),
    copy: () => unstaged("copy"),
    copyFile: () => unstaged("copyFile"),
    link: () => unstaged("link"),
    makeTempDirectory: () => unstaged("makeTempDirectory"),
    makeTempDirectoryScoped: () => unstaged("makeTempDirectoryScoped"),
    makeTempFile: () => unstaged("makeTempFile"),
    makeTempFileScoped: () => unstaged("makeTempFileScoped"),
    open: () => unstaged("open"),
    remove: () => unstaged("remove"),
    rename: () => unstaged("rename"),
    sink: () => Sink.fail(unstaged("sink")),
    symlink: () => unstaged("symlink"),
    truncate: () => unstaged("truncate"),
    utimes: () => unstaged("utimes"),
  })
  return {
    fs,
    writes: () => [...files].map(([path, file]) => ({ path, data: file.data, mode: file.mode })),
  }
}

/**
 * The setup's files couldn't all be written: the one that failed, from the project's top, and why;
 * and those init wrote and couldn't take back, which are left as it wrote them.
 */
export class SetupNotWritten extends Schema.TaggedError<SetupNotWritten>()("SetupNotWritten", {
  file: Schema.String,
  reason: Schema.String,
  left: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `cannot write ${this.file}: ${this.reason}; ${
      this.left.length === 0
        ? "the setup's files are as they were"
        : `${joinAnd(this.left)} could not be taken back and are as init wrote them, the rest as they were`
    }`
  }
}

/** A name for a file beside `path`, hidden, that no other init picks. */
const beside = (path: string, kind: string) =>
  join(dirname(path), `.${basename(path)}.tutti-${process.pid}-${crypto.randomUUID()}.${kind}`)

/** A file being put in: its temporary file, and, once it replaced one, the old one's copy. */
interface Putting {
  readonly write: StagedWrite
  readonly temporary: string
  backup: string | null
  renamed: boolean
}

/**
 * Writes `writes` into the project at `repo` as one, `last` (the settings) after the rest: each to
 * a temporary file beside it, synced, with its mode (the one there where the write gives none), and
 * once all are written, each renamed over its own. Fails with SetupNotWritten where one can't be,
 * having taken back what it had written: the temporary files and the folders it made removed, and
 * the files it had replaced put back.
 */
export const commitStaged = (
  real: FileSystem.FileSystem,
  repo: string,
  writes: ReadonlyArray<StagedWrite>,
  last: string,
) =>
  Effect.gen(function* () {
    const ordered = [
      ...writes.filter((each) => each.path !== resolve(last)),
      ...writes.filter((each) => each.path === resolve(last)),
    ]
    const made: Array<string> = []
    const putting: Array<Putting> = []
    const fail = (write: StagedWrite, error: PlatformError) =>
      Effect.gen(function* () {
        const left: Array<string> = []
        for (const each of [...putting].reverse()) {
          const target = each.write.path
          const back = each.renamed
            ? each.backup === null
              ? real.remove(target)
              : real.rename(each.backup, target)
            : real.remove(each.temporary)
          const undone = yield* Effect.result(back)
          if (undone._tag === "Failure" && each.renamed) left.push(relative(repo, target))
          if (each.backup !== null && !each.renamed) yield* Effect.ignore(real.remove(each.backup))
        }
        // The folders init made, newest first, where nothing it couldn't take back is in them.
        if (left.length === 0) {
          for (const folder of [...made].reverse()) {
            yield* Effect.ignore(real.remove(folder, { recursive: true }))
          }
        }
        return yield* new SetupNotWritten({
          file: relative(repo, write.path),
          reason: error.message,
          left,
        })
      })

    for (const write of ordered) {
      const done = yield* Effect.result(
        Effect.gen(function* () {
          const folder = dirname(write.path)
          let top: string | null = null
          for (let at = folder; at !== dirname(at) && !(yield* real.exists(at)); at = dirname(at)) {
            top = at
          }
          if (top !== null) {
            yield* real.makeDirectory(folder, { recursive: true })
            made.push(top)
          }
          const mode =
            write.mode ??
            (yield* real.stat(write.path).pipe(
              Effect.map((info) => info.mode & 0o7777),
              Effect.orElseSucceed(() => null),
            ))
          const temporary = beside(write.path, "new")
          putting.push({ write, temporary, backup: null, renamed: false })
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* real.open(temporary, {
                flag: "wx",
                ...(mode === null ? {} : { mode }),
              })
              yield* handle.writeAll(write.data)
              yield* handle.sync
            }),
          )
          if (mode !== null) yield* real.chmod(temporary, mode)
        }),
      )
      if (done._tag === "Failure") return yield* fail(write, done.failure)
    }

    for (const each of putting) {
      const done = yield* Effect.result(
        Effect.gen(function* () {
          if (yield* real.exists(each.write.path)) {
            const backup = beside(each.write.path, "old")
            yield* real
              .link(each.write.path, backup)
              .pipe(Effect.catch(() => real.copyFile(each.write.path, backup)))
            each.backup = backup
          }
          yield* real.rename(each.temporary, each.write.path)
          each.renamed = true
        }),
      )
      if (done._tag === "Failure") return yield* fail(each.write, done.failure)
    }
    for (const each of putting) {
      if (each.backup !== null) yield* Effect.ignore(real.remove(each.backup))
    }
  })
