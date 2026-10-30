// libc through bun:ffi (§ 9.1 the symlink guard, § 9.2 the run lock), as the M0 spike settled it
// (docs/spikes/06-bun-ffi.md): open with O_CLOEXEC, flock, a per-component openat with O_NOFOLLOW,
// and O_EXCL creation. darwin and Linux, arm64 and x86_64.
//
// Three things differ by platform:
//
// - The constants. Linux's O_NOFOLLOW and O_DIRECTORY differ between x86_64 and arm64, so every
//   flag node:fs has comes from node:fs, and every errno from node:os. The table per OS holds
//   only what they lack: O_CLOEXEC.
// - errno is read through a function returning its address: `__error` on darwin,
//   `__errno_location` on glibc and musl. It is read right after the failing call.
// - open and openat are variadic (the mode is `...`). On darwin arm64, variadic arguments go on
//   the stack while bun:ffi passes every declared argument in registers, so the binding declares
//   padding arguments that fill x3..x7 and passes the mode as the ninth argument, the first stack
//   slot, where va_arg reads it. Without them a created file gets whatever was on the stack as its
//   mode. Elsewhere variadic integers travel in the same registers as fixed ones.
import { dlopen, FFIType, type Pointer, read } from "bun:ffi"
import {
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  type Stats,
  writeSync,
} from "node:fs"
import { constants as osConstants } from "node:os"
import { basename, dirname, join } from "node:path"
import { Effect, Schema } from "effect"

/** What node:fs and node:os lack, per OS, from darwin's <sys/fcntl.h> and Linux's <fcntl.h>. */
const perOs: Partial<Record<NodeJS.Platform, { readonly O_CLOEXEC: number }>> = {
  darwin: { O_CLOEXEC: 0x1000000 },
  linux: { O_CLOEXEC: 0x80000 },
}

const os = perOs[process.platform]
if (os === undefined) throw new Error(`tutti has no libc bindings for ${process.platform}`)

/** The open flags and lock operations tutti uses, for this platform and architecture. */
export const O = {
  RDONLY: fsConstants.O_RDONLY,
  WRONLY: fsConstants.O_WRONLY,
  RDWR: fsConstants.O_RDWR,
  CREAT: fsConstants.O_CREAT,
  EXCL: fsConstants.O_EXCL,
  TRUNC: fsConstants.O_TRUNC,
  APPEND: fsConstants.O_APPEND,
  NOFOLLOW: fsConstants.O_NOFOLLOW,
  DIRECTORY: fsConstants.O_DIRECTORY,
  NONBLOCK: fsConstants.O_NONBLOCK,
  CLOEXEC: os.O_CLOEXEC,
} as const

const F_GETFD = 1
const F_GETFL = 3
const F_SETFL = 4
const FD_CLOEXEC = 1
const LOCK_SH = 1
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const { EEXIST, ELOOP, ENOENT, ENOTDIR, ENXIO, EOPNOTSUPP, EWOULDBLOCK } = osConstants.errno

// darwin's libc is libSystem (in the dyld shared cache, so the file needn't exist on disk);
// glibc's is libc.so.6, a name musl's loader also maps to itself.
const libcCandidates =
  process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, "libc.so"]

const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location"
const variadicOnStack = process.platform === "darwin" && process.arch === "arm64"
const padOpenat = variadicOnStack ? 5 : 0
const padOpen = variadicOnStack ? 6 : 0
const padFcntl = variadicOnStack ? 6 : 0
const padding = (n: number) => Array<FFIType>(n).fill(FFIType.i64)
const zeros = (n: number) => Array<number>(n).fill(0)

const symbols = {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  // Variadic too: F_SETFL's third argument goes where open's mode does; F_GETFD and F_GETFL
  // ignore it.
  fcntl: {
    args: [FFIType.i32, FFIType.i32, ...padding(padFcntl), FFIType.i64],
    returns: FFIType.i32,
  },
  open: {
    args: [FFIType.ptr, FFIType.i32, ...padding(padOpen), FFIType.i64],
    returns: FFIType.i32,
  },
  openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, ...padding(padOpenat), FFIType.i64],
    returns: FFIType.i32,
  },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  renameat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  [errnoSymbol]: { args: [], returns: FFIType.ptr },
} as const

const openLibc = () => {
  const errors: Array<string> = []
  for (const path of libcCandidates) {
    try {
      return { path, lib: dlopen(path, symbols) }
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`)
    }
  }
  throw new Error(`could not load libc:\n${errors.join("\n")}`)
}

const libc = openLibc()

/** The libc that was loaded, for a test's own bindings. */
export const libcPath: string = libc.path

const s = libc.lib.symbols as unknown as {
  flock: (fd: number, op: number) => number
  close: (fd: number) => number
  fcntl: (...args: Array<unknown>) => number
  open: (...args: Array<unknown>) => number
  openat: (...args: Array<unknown>) => number
  unlinkat: (dirfd: number, name: Buffer, flags: number) => number
  renameat: (fromfd: number, from: Buffer, tofd: number, to: Buffer) => number
  __error?: () => Pointer
  __errno_location?: () => Pointer
}

const errnoAddress = (s.__error ?? s.__errno_location) as () => Pointer
const errno = (): number => read.i32(errnoAddress(), 0)

const errnoNames = new Map<number, string>(
  Object.entries(osConstants.errno).map(([name, code]) => [code, name]),
)

const cstr = (text: string) => Buffer.from(`${text}\0`, "utf8")

/** A libc call failed. `code` is errno's name (`EEXIST`, `ELOOP`, …), `errno` its number. */
export class LibcError extends Schema.TaggedError<LibcError>()("LibcError", {
  call: Schema.String,
  path: Schema.String,
  errno: Schema.Number,
  code: Schema.String,
}) {
  override get message(): string {
    return `${this.call} ${this.path}: ${this.code}`
  }
}

/** openUnder found a symbolic link at `component`, the path below the directory up to the link. */
export class SymlinkRefused extends Schema.TaggedError<SymlinkRefused>()("SymlinkRefused", {
  directory: Schema.String,
  path: Schema.String,
  component: Schema.String,
}) {
  override get message(): string {
    return `${this.path} under ${this.directory}: ${this.component} is a symbolic link`
  }
}

/** openUnder found something other than a regular file at `path`, a named pipe or a device. */
export class NotAFileRefused extends Schema.TaggedError<NotAFileRefused>()("NotAFileRefused", {
  directory: Schema.String,
  path: Schema.String,
  kind: Schema.String,
}) {
  override get message(): string {
    return `${this.path} under ${this.directory} is ${this.kind}, not a regular file`
  }
}

/** openUnder was given an absolute path, or one with an empty, `.` or `..` component. */
export class PathRefused extends Schema.TaggedError<PathRefused>()("PathRefused", {
  directory: Schema.String,
  path: Schema.String,
}) {
  override get message(): string {
    return `${JSON.stringify(this.path)} is not a plain path below ${this.directory}`
  }
}

const failure = (call: string, path: string, code: number) =>
  new LibcError({ call, path, errno: code, code: errnoNames.get(code) ?? String(code) })

/** A node:fs call on a raw descriptor failed, as a LibcError. */
const nodeFailure = (call: string, path: string, error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code ?? "EIO"
  return failure(call, path, (osConstants.errno as Record<string, number>)[code] ?? 0)
}

/** Runs a call returning -1 on failure, reading errno before anything else can touch it. */
const attempt = (call: string, path: string, f: () => number): number | LibcError => {
  const result = f()
  return result === -1 ? failure(call, path, errno()) : result
}

const unwrap = <A>(result: A | LibcError): Effect.Effect<A, LibcError> =>
  result instanceof LibcError ? Effect.fail(result) : Effect.succeed(result)

const rawFcntl = (fd: number, cmd: number, arg = 0) =>
  attempt("fcntl", `fd ${fd}`, () => s.fcntl(fd, cmd, ...zeros(padFcntl), arg))

const rawOpen = (path: string, flags: number, mode: number) =>
  attempt("open", path, () => s.open(cstr(path), flags, ...zeros(padOpen), mode))

const rawOpenat = (dirfd: number, name: string, shown: string, flags: number, mode: number) =>
  attempt("openat", shown, () => s.openat(dirfd, cstr(name), flags, ...zeros(padOpenat), mode))

/** Opens a file with O_CLOEXEC added to `flags`, so no child started by any means inherits it. */
export const openCloexec = (
  path: string,
  flags: number,
  mode = 0o644,
): Effect.Effect<number, LibcError> =>
  Effect.suspend(() => unwrap(rawOpen(path, flags | O.CLOEXEC, mode)))

/** Closes a descriptor these bindings opened. */
export const close = (fd: number): Effect.Effect<void, LibcError> =>
  Effect.suspend(() => unwrap(attempt("close", `fd ${fd}`, () => s.close(fd)))).pipe(Effect.asVoid)

/**
 * Takes flock(LOCK_EX|LOCK_NB) on `fd`. Succeeds with false when another open file holds the
 * lock. The system releases it when every descriptor of the open file is closed, `kill -9` too.
 */
export const flockExclusiveNonBlocking = (fd: number): Effect.Effect<boolean, LibcError> =>
  Effect.suspend(() => {
    const result = attempt("flock", `fd ${fd}`, () => s.flock(fd, LOCK_EX | LOCK_NB))
    if (result instanceof LibcError && result.errno === EWOULDBLOCK) return Effect.succeed(false)
    return unwrap(result).pipe(Effect.as(true))
  })

/**
 * Takes flock(LOCK_SH|LOCK_NB) on `fd`. Succeeds with false when another open file holds the lock
 * exclusively; other shared locks don't stop it.
 */
export const flockSharedNonBlocking = (fd: number): Effect.Effect<boolean, LibcError> =>
  Effect.suspend(() => {
    const result = attempt("flock", `fd ${fd}`, () => s.flock(fd, LOCK_SH | LOCK_NB))
    if (result instanceof LibcError && result.errno === EWOULDBLOCK) return Effect.succeed(false)
    return unwrap(result).pipe(Effect.as(true))
  })

/** Releases a lock flockExclusiveNonBlocking or flockSharedNonBlocking took. */
export const unlock = (fd: number): Effect.Effect<void, LibcError> =>
  Effect.suspend(() => unwrap(attempt("flock", `fd ${fd}`, () => s.flock(fd, LOCK_UN)))).pipe(
    Effect.asVoid,
  )

/** Whether `fd` is marked close-on-exec, from fcntl(F_GETFD). */
export const isCloseOnExec = (fd: number): Effect.Effect<boolean, LibcError> =>
  Effect.suspend(() => unwrap(rawFcntl(fd, F_GETFD))).pipe(
    Effect.map((flags) => (flags & FD_CLOEXEC) !== 0),
  )

/** Creates a file that must not exist yet (O_EXCL), never through a link: attention files. */
export const createExclusive = (path: string, mode = 0o600): Effect.Effect<number, LibcError> =>
  openCloexec(path, O.WRONLY | O.CREAT | O.EXCL | O.NOFOLLOW, mode)

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** What a file is, in words, for a refusal. */
const kindOf = (stat: Stats): string =>
  stat.isFIFO()
    ? "a named pipe"
    : stat.isSocket()
      ? "a socket"
      : stat.isCharacterDevice()
        ? "a character device"
        : stat.isBlockDevice()
          ? "a block device"
          : stat.isDirectory()
            ? "a folder"
            : stat.isSymbolicLink()
              ? "a symbolic link"
              : "something else"

const kindAt = (path: string): string | undefined => {
  try {
    const stat = lstatSync(path)
    return stat.isFile() ? undefined : kindOf(stat)
  } catch {
    return undefined
  }
}

// opened checks what the last openat opened: a folder where O_DIRECTORY asked for one, a regular
// file otherwise. The open was non-blocking, so a named pipe or a device opened at once; it is
// closed and refused. A regular file has O_NONBLOCK taken off again, as the caller didn't ask for it.
const opened = (
  fd: number,
  directory: string,
  relativePath: string,
  flags: number,
): number | LibcError | NotAFileRefused => {
  let stat: Stats
  try {
    stat = fstatSync(fd)
  } catch (error) {
    s.close(fd)
    return nodeFailure("fstat", relativePath, error)
  }
  const wanted = (flags & O.DIRECTORY) !== 0 ? stat.isDirectory() : stat.isFile()
  if (!wanted) {
    s.close(fd)
    return new NotAFileRefused({ directory, path: relativePath, kind: kindOf(stat) })
  }
  if ((flags & O.NONBLOCK) !== 0) return fd
  const status = rawFcntl(fd, F_GETFL)
  const cleared = status instanceof LibcError ? status : rawFcntl(fd, F_SETFL, status & ~O.NONBLOCK)
  if (cleared instanceof LibcError) {
    s.close(fd)
    return cleared
  }
  return fd
}

/** What openUnder and writeFileUnder refuse or fail with. */
export type Refusal = LibcError | SymlinkRefused | PathRefused | NotAFileRefused

// refused names a failed openat for what stands at its name where that explains it.
const refused = (
  error: LibcError,
  directory: string,
  relativePath: string,
  component: string,
  last: boolean,
): LibcError | SymlinkRefused | NotAFileRefused => {
  // A link mid-path fails O_DIRECTORY (ENOTDIR), a last one O_NOFOLLOW (ELOOP), or O_EXCL
  // (EEXIST). Each of those is also a plain failure, so the link is confirmed by lstat; the
  // refusal never depended on it.
  const linkish = error.errno === ENOTDIR || error.errno === ELOOP || error.errno === EEXIST
  if (linkish && isSymlink(join(directory, component))) {
    return new SymlinkRefused({ directory, path: relativePath, component })
  }
  // A named pipe opened for writing with no reader fails ENXIO under O_NONBLOCK, and a
  // socket ENXIO or EOPNOTSUPP: named for what they are.
  const kind =
    last && (error.errno === ENXIO || error.errno === EOPNOTSUPP)
      ? kindAt(join(directory, component))
      : undefined
  return kind === undefined ? error : new NotAFileRefused({ directory, path: relativePath, kind })
}

// emptied empties the file the last openat opened, where the caller asked for O_TRUNC, which that
// openat left out. A file with one link is truncated. One with more may be another file of the
// same user hard-linked to the name, the main checkout's .git/config say: it is left as it is,
// its name below `dir` unlinked, and a file of its own created there afresh (O_EXCL). Something
// put at the name between the two fails the creation.
const emptied = (
  fd: number,
  dir: number,
  name: string,
  directory: string,
  relativePath: string,
  flags: number,
  mode: number,
): number | Refusal => {
  let call = "fstat"
  try {
    if (fstatSync(fd).nlink <= 1) {
      call = "ftruncate"
      ftruncateSync(fd, 0)
      return fd
    }
  } catch (error) {
    s.close(fd)
    return nodeFailure(call, relativePath, error)
  }
  s.close(fd)
  const unlinked = attempt("unlinkat", relativePath, () => s.unlinkat(dir, cstr(name), 0))
  if (unlinked instanceof LibcError && unlinked.errno !== ENOENT) return unlinked
  const fresh = (flags & ~O.TRUNC) | O.CREAT | O.EXCL | O.NOFOLLOW | O.NONBLOCK | O.CLOEXEC
  const created = rawOpenat(dir, name, relativePath, fresh, mode)
  if (created instanceof LibcError) {
    return refused(created, directory, relativePath, relativePath, true)
  }
  return opened(created, directory, relativePath, flags)
}

const walk = (
  directory: string,
  relativePath: string,
  flags: number,
  mode: number,
): number | Refusal => {
  const parts = relativePath.split("/")
  if (relativePath.startsWith("/") || parts.some((p) => p === "" || p === "." || p === "..")) {
    return new PathRefused({ directory, path: relativePath })
  }
  // The directory itself may be reached through a link: only what lies below it is guarded.
  const root = rawOpen(directory, O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0)
  if (root instanceof LibcError) return root
  // O_TRUNC is left to emptied, once the last component is known to be a regular file.
  const truncating = (flags & O.TRUNC) !== 0
  const lastFlags = (flags & ~O.TRUNC) | O.NOFOLLOW | O.NONBLOCK | O.CLOEXEC
  let dir = root
  try {
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1
      const component = parts.slice(0, i + 1).join("/")
      const next = last
        ? rawOpenat(dir, part, component, lastFlags, mode)
        : rawOpenat(dir, part, component, O.RDONLY | O.DIRECTORY | O.NOFOLLOW | O.CLOEXEC, 0)
      if (next instanceof LibcError) return refused(next, directory, relativePath, component, last)
      if (last) {
        const fd = opened(next, directory, relativePath, flags)
        if (typeof fd !== "number" || !truncating) return fd
        return emptied(fd, dir, part, directory, relativePath, flags, mode)
      }
      s.close(dir)
      dir = next
    }
    return new PathRefused({ directory, path: relativePath })
  } finally {
    s.close(dir)
  }
}

/**
 * Opens `relativePath` below `directory` one component at a time with openat and O_NOFOLLOW, so
 * that a symbolic link at any component is refused, naming it (§ 9.1). Each step holds its
 * directory open, so swapping a folder for a link between steps doesn't help. Absolute paths and
 * empty, `.` or `..` components are refused before any call. O_NOFOLLOW and O_CLOEXEC are added to
 * `flags`. What is opened must be a regular file, or a folder where `flags` has O_DIRECTORY:
 * anything else, a named pipe or a device, is refused with NotAFileRefused. The last component is
 * opened with O_NONBLOCK, so a named pipe never holds the open, which bun:ffi makes on the
 * JavaScript thread, until its other end opens; O_NONBLOCK is then cleared unless `flags` has it.
 * O_TRUNC never truncates a file with more than one link, which may be another file hard-linked
 * to the name: the name is unlinked and the file created afresh, leaving the other as it was.
 */
export const openUnder = (
  directory: string,
  relativePath: string,
  flags: number,
  mode = 0o644,
): Effect.Effect<number, Refusal> =>
  Effect.suspend(() => {
    const result = walk(directory, relativePath, flags, mode)
    return typeof result === "number" ? Effect.succeed(result) : Effect.fail(result)
  })

/**
 * Makes the folders of `folder` (a path below `directory`) that are missing, one at a time, and
 * gives why they aren't all there, or undefined when they are. It stops at anything that isn't a
 * folder, a symbolic link included, which openUnder then refuses too: nothing is made through a
 * link. A folder made meanwhile by another (EEXIST) counts as made. `mode` is the last folder's,
 * where it is made, past the umask; the others' is 0o755.
 */
export const makeFoldersUnder = (
  directory: string,
  folder: string,
  options: { readonly mode?: number } = {},
): string | undefined => {
  const parts = folder.split("/")
  let at = directory
  for (const [index, part] of parts.entries()) {
    at = join(at, part)
    const shown = parts.slice(0, index + 1).join("/")
    const kind = (): string | undefined => {
      const stat = lstatSync(at)
      if (stat.isSymbolicLink()) return `${shown} is a symbolic link`
      return stat.isDirectory() ? undefined : `${shown} isn't a folder`
    }
    try {
      const wrong = kind()
      if (wrong !== undefined) return wrong
      continue
    } catch {}
    try {
      mkdirSync(at, { mode: index === parts.length - 1 ? (options.mode ?? 0o755) : 0o755 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return `${shown} can't be made: ${error instanceof Error ? error.message : String(error)}`
      }
      try {
        const wrong = kind()
        if (wrong !== undefined) return wrong
      } catch (again) {
        return `${shown} can't be read: ${again instanceof Error ? again.message : String(again)}`
      }
    }
  }
  return undefined
}

// replace writes `data` whole to `name` in the folder open at `dir` (`folder` below `directory`):
// to a hidden temporary file beside it, created there with O_EXCL, synced and renamed over the
// name with renameat, and the folder synced. A file at the name keeps its mode.
const replace = (
  dir: number,
  directory: string,
  folder: string,
  name: string,
  data: Uint8Array,
  mode: number,
): undefined | Refusal => {
  const shown = folder === "." ? name : `${folder}/${name}`
  // What is at the name now: a link or anything but a regular file is refused, though the rename
  // would only have replaced it.
  const existing = rawOpenat(dir, name, shown, O.RDONLY | O.NOFOLLOW | O.NONBLOCK | O.CLOEXEC, 0)
  let keptMode: number | undefined
  if (existing instanceof LibcError) {
    if (existing.errno !== ENOENT) return refused(existing, directory, shown, shown, true)
  } else {
    const checked = opened(existing, directory, shown, O.RDONLY | O.NONBLOCK)
    if (typeof checked !== "number") return checked
    try {
      keptMode = fstatSync(checked).mode & 0o7777
    } catch (error) {
      return nodeFailure("fstat", shown, error)
    } finally {
      s.close(checked)
    }
  }
  const temporary = `.${name}.tutti-${process.pid}-${crypto.randomUUID()}.tmp`
  const flags = O.WRONLY | O.CREAT | O.EXCL | O.NOFOLLOW | O.CLOEXEC
  const fd = rawOpenat(dir, temporary, shown, flags, keptMode ?? mode)
  if (fd instanceof LibcError) return fd
  let call = "write"
  try {
    for (let at = 0; at < data.length; ) at += writeSync(fd, data, at)
    if (keptMode !== undefined) {
      call = "fchmod"
      fchmodSync(fd, keptMode)
    }
    call = "fsync"
    fsyncSync(fd)
  } catch (error) {
    s.close(fd)
    s.unlinkat(dir, cstr(temporary), 0)
    return nodeFailure(call, shown, error)
  }
  s.close(fd)
  const renamed = attempt("renameat", shown, () =>
    s.renameat(dir, cstr(temporary), dir, cstr(name)),
  )
  if (renamed instanceof LibcError) {
    s.unlinkat(dir, cstr(temporary), 0)
    return renamed
  }
  // Some file systems refuse to sync a folder, and the file was renamed.
  try {
    fsyncSync(dir)
  } catch {}
  return undefined
}

// naming gives a refusal of the folder of `relativePath` as one of the file itself.
const naming = (refusal: Refusal, relativePath: string): Refusal => {
  if (refusal instanceof SymlinkRefused) {
    const { directory, component } = refusal
    return new SymlinkRefused({ directory, path: relativePath, component })
  }
  if (refusal instanceof NotAFileRefused) {
    const { directory, kind } = refusal
    return new NotAFileRefused({ directory, path: relativePath, kind })
  }
  if (refusal instanceof PathRefused) {
    return new PathRefused({ directory: refusal.directory, path: relativePath })
  }
  return refusal
}

/**
 * Writes `data` to the file at `relativePath` below `directory` whole, through the symlink guard
 * (§ 9.1): its folder is opened with openUnder, so a link in its path is refused, and a link or
 * anything but a regular file at its name is refused too. The bytes go to a temporary file beside
 * it, created in that folder, synced and renamed over the name (renameat on the folder's
 * descriptor): the old file or the new one is there, never a mix, and nothing is written through a
 * link. A file there keeps its mode; a new one takes `mode`, past the umask. The folder must be
 * there (makeFoldersUnder).
 */
export const writeFileUnder = (
  directory: string,
  relativePath: string,
  data: string | Uint8Array,
  mode = 0o644,
): Effect.Effect<void, Refusal> =>
  Effect.suspend(() => {
    const folder = dirname(relativePath)
    const name = basename(relativePath)
    if (name === "" || name === "." || name === ".." || relativePath.endsWith("/")) {
      return Effect.fail(new PathRefused({ directory, path: relativePath }))
    }
    const dir =
      folder === "."
        ? rawOpen(directory, O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0)
        : walk(directory, folder, O.RDONLY | O.DIRECTORY, 0)
    if (typeof dir !== "number") return Effect.fail(naming(dir, relativePath))
    const bytes = typeof data === "string" ? Buffer.from(data) : data
    try {
      const failed = replace(dir, directory, folder, name, bytes, mode)
      return failed === undefined ? Effect.void : Effect.fail(failed)
    } finally {
      s.close(dir)
    }
  })

/**
 * Removes the file at `relativePath` below `directory` through the symlink guard (§ 9.1): its
 * folder is opened with openUnder, so a link in its path is refused, and the name is unlinked on
 * the folder's descriptor (unlinkat), so a link at the name is removed itself, not what it points
 * to. A name that isn't there counts as removed.
 */
export const removeUnder = (
  directory: string,
  relativePath: string,
): Effect.Effect<void, Refusal> =>
  Effect.suspend(() => {
    const folder = dirname(relativePath)
    const name = basename(relativePath)
    if (name === "" || name === "." || name === ".." || relativePath.endsWith("/")) {
      return Effect.fail(new PathRefused({ directory, path: relativePath }))
    }
    const dir =
      folder === "."
        ? rawOpen(directory, O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0)
        : walk(directory, folder, O.RDONLY | O.DIRECTORY, 0)
    if (typeof dir !== "number") return Effect.fail(naming(dir, relativePath))
    try {
      const unlinked = attempt("unlinkat", relativePath, () => s.unlinkat(dir, cstr(name), 0))
      return unlinked instanceof LibcError && unlinked.errno !== ENOENT
        ? Effect.fail(unlinked)
        : Effect.void
    } finally {
      s.close(dir)
    }
  })
