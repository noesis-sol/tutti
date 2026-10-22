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
import { constants as fsConstants, fstatSync, lstatSync, type Stats } from "node:fs"
import { constants as osConstants } from "node:os"
import { join } from "node:path"
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
const { EEXIST, ELOOP, ENOTDIR, ENXIO, EOPNOTSUPP, EWOULDBLOCK } = osConstants.errno

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
    const code = (error as NodeJS.ErrnoException).code ?? "EIO"
    return failure("fstat", relativePath, (osConstants.errno as Record<string, number>)[code] ?? 0)
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

const walk = (
  directory: string,
  relativePath: string,
  flags: number,
  mode: number,
): number | LibcError | SymlinkRefused | PathRefused | NotAFileRefused => {
  const parts = relativePath.split("/")
  if (relativePath.startsWith("/") || parts.some((p) => p === "" || p === "." || p === "..")) {
    return new PathRefused({ directory, path: relativePath })
  }
  // The directory itself may be reached through a link: only what lies below it is guarded.
  const root = rawOpen(directory, O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0)
  if (root instanceof LibcError) return root
  let dir = root
  try {
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1
      const component = parts.slice(0, i + 1).join("/")
      const next = last
        ? rawOpenat(dir, part, component, flags | O.NOFOLLOW | O.NONBLOCK | O.CLOEXEC, mode)
        : rawOpenat(dir, part, component, O.RDONLY | O.DIRECTORY | O.NOFOLLOW | O.CLOEXEC, 0)
      if (next instanceof LibcError) {
        // A link mid-path fails O_DIRECTORY (ENOTDIR), a last one O_NOFOLLOW (ELOOP), or O_EXCL
        // (EEXIST). Each of those is also a plain failure, so the link is confirmed by lstat; the
        // refusal never depended on it.
        const linkish = next.errno === ENOTDIR || next.errno === ELOOP || next.errno === EEXIST
        if (linkish && isSymlink(join(directory, component))) {
          return new SymlinkRefused({ directory, path: relativePath, component })
        }
        // A named pipe opened for writing with no reader fails ENXIO under O_NONBLOCK, and a
        // socket ENXIO or EOPNOTSUPP: named for what they are.
        const kind =
          last && (next.errno === ENXIO || next.errno === EOPNOTSUPP)
            ? kindAt(join(directory, component))
            : undefined
        return kind === undefined
          ? next
          : new NotAFileRefused({ directory, path: relativePath, kind })
      }
      if (last) return opened(next, directory, relativePath, flags)
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
 */
export const openUnder = (
  directory: string,
  relativePath: string,
  flags: number,
  mode = 0o644,
): Effect.Effect<number, LibcError | SymlinkRefused | PathRefused | NotAFileRefused> =>
  Effect.suspend(() => {
    const result = walk(directory, relativePath, flags, mode)
    return typeof result === "number" ? Effect.succeed(result) : Effect.fail(result)
  })
