// libc through bun:ffi, for the spike tutti-nrg.1.6 (spec § 9.1, § 9.2): flock, open and openat
// with O_CLOEXEC and O_NOFOLLOW, fcntl(F_GETFD/F_GETFL), and errno. Not product code: the shape
// tutti's own bindings (tutti-nrg.2.8) can start from.
//
// Two things differ by platform besides the constants:
//
// - errno is read through a function returning its address: `__error` on darwin,
//   `__errno_location` on glibc and musl.
// - open and openat are variadic (the mode is `...`). On darwin arm64, variadic arguments go on
//   the stack while bun:ffi passes every declared argument in registers, so a plain
//   `openat(dirfd, path, flags, mode)` hands openat whatever happens to be on the stack as the
//   mode. The binding declares five padding arguments to fill x3..x7, so that the mode is the
//   ninth argument and lands in the first stack slot, where va_arg reads it. Everywhere else
//   (darwin x86_64, linux x86_64 and aarch64) variadic integers travel in the same registers as
//   fixed ones and the plain declaration works.

import { dlopen, FFIType, type Pointer, read } from "bun:ffi"

export type Platform = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64"

export const platform = `${process.platform}-${process.arch}` as Platform

// Every constant the spike uses, per platform, from the system headers: darwin's
// <sys/fcntl.h> and <sys/errno.h>; linux's <asm-generic/fcntl.h> (with arch/arm64's and
// arch/x86's overrides) and <asm-generic/errno.h>.
export interface Constants {
  readonly O_RDONLY: number
  readonly O_WRONLY: number
  readonly O_RDWR: number
  readonly O_CREAT: number
  readonly O_EXCL: number
  readonly O_TRUNC: number
  readonly O_APPEND: number
  readonly O_NOFOLLOW: number
  readonly O_DIRECTORY: number
  readonly O_CLOEXEC: number
  /** darwin only (macOS 11+): refuse a symlink in any component of the path. */
  readonly O_NOFOLLOW_ANY: number | undefined
  /** darwin only: refuse a path that resolves outside the starting directory. */
  readonly O_RESOLVE_BENEATH: number | undefined
  readonly AT_FDCWD: number
  readonly F_GETFD: number
  readonly F_GETFL: number
  readonly FD_CLOEXEC: number
  readonly LOCK_EX: number
  readonly LOCK_NB: number
  readonly LOCK_UN: number
  readonly ENOENT: number
  readonly EEXIST: number
  readonly ENOTDIR: number
  readonly EWOULDBLOCK: number
  readonly ELOOP: number
  readonly EXDEV: number
  /** darwin only: what O_RESOLVE_BENEATH returns for a path leaving the directory. */
  readonly ENOTCAPABLE: number | undefined
}

const darwin = {
  O_RDONLY: 0x0,
  O_WRONLY: 0x1,
  O_RDWR: 0x2,
  O_CREAT: 0x200,
  O_EXCL: 0x800,
  O_TRUNC: 0x400,
  O_APPEND: 0x8,
  O_NOFOLLOW: 0x100,
  O_DIRECTORY: 0x100000,
  O_CLOEXEC: 0x1000000,
  O_NOFOLLOW_ANY: 0x20000000,
  O_RESOLVE_BENEATH: 0x1000,
  AT_FDCWD: -2,
  F_GETFD: 1,
  F_GETFL: 3,
  FD_CLOEXEC: 1,
  LOCK_EX: 2,
  LOCK_NB: 4,
  LOCK_UN: 8,
  ENOENT: 2,
  EEXIST: 17,
  ENOTDIR: 20,
  EWOULDBLOCK: 35,
  ELOOP: 62,
  EXDEV: 18,
  ENOTCAPABLE: 107,
} satisfies Constants

const linux = {
  O_RDONLY: 0x0,
  O_WRONLY: 0x1,
  O_RDWR: 0x2,
  O_CREAT: 0x40,
  O_EXCL: 0x80,
  O_TRUNC: 0x200,
  O_APPEND: 0x400,
  O_NOFOLLOW: 0x20000, // x86_64; arm64 overrides it below
  O_DIRECTORY: 0x10000, // x86_64; arm64 overrides it below
  O_CLOEXEC: 0x80000,
  O_NOFOLLOW_ANY: undefined,
  O_RESOLVE_BENEATH: undefined,
  AT_FDCWD: -100,
  F_GETFD: 1,
  F_GETFL: 3,
  FD_CLOEXEC: 1,
  LOCK_EX: 2,
  LOCK_NB: 4,
  LOCK_UN: 8,
  ENOENT: 2,
  EEXIST: 17,
  ENOTDIR: 20,
  EWOULDBLOCK: 11,
  ELOOP: 40,
  EXDEV: 18,
  ENOTCAPABLE: undefined,
} satisfies Constants

export const constantsByPlatform: Record<Platform, Constants> = {
  "darwin-arm64": darwin,
  "darwin-x64": darwin,
  "linux-x64": linux,
  "linux-arm64": { ...linux, O_NOFOLLOW: 0x8000, O_DIRECTORY: 0x4000 },
}

const known = constantsByPlatform[platform]
if (known === undefined) throw new Error(`no libc constants for ${platform}`)
export const C: Constants = known

// The library to dlopen. darwin's libc is libSystem (in the dyld shared cache, so the file
// needn't exist on disk); glibc's is libc.so.6; musl's is its loader, libc.musl-<arch>.so.1.
export const libcCandidates =
  process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, "libc.so"]

const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location"
const variadicOnStack = platform === "darwin-arm64"

const pad = Array<FFIType>(variadicOnStack ? 5 : 0).fill(FFIType.i64)
const padOpen = Array<FFIType>(variadicOnStack ? 6 : 0).fill(FFIType.i64)

const symbols = {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  // fcntl is variadic too, but F_GETFD and F_GETFL take no third argument.
  fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  open: { args: [FFIType.ptr, FFIType.i32, ...padOpen, FFIType.i64], returns: FFIType.i32 },
  openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, ...pad, FFIType.i64],
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
  throw new Error(`could not dlopen libc:\n${errors.join("\n")}`)
}

const { path: libcPath, lib } = openLibc()

export { libcPath }

const s = lib.symbols as unknown as {
  flock: (fd: number, op: number) => number
  close: (fd: number) => number
  fcntl: (fd: number, cmd: number) => number
  open: (...args: Array<unknown>) => number
  openat: (...args: Array<unknown>) => number
  __error?: () => Pointer
  __errno_location?: () => Pointer
}

const errnoAddress = (s.__error ?? s.__errno_location) as () => Pointer

/** errno, read right after the failing call, before anything else can touch it. */
export const errno = (): number => read.i32(errnoAddress(), 0)

const cstr = (text: string) => Buffer.from(`${text}\0`, "utf8")

export class Errno extends Error {
  constructor(
    readonly call: string,
    readonly code: number,
  ) {
    super(`${call}: errno ${code} (${errnoName(code)})`)
  }
}

export const errnoName = (code: number): string => {
  for (const [name, value] of Object.entries(C)) {
    if (name.startsWith("E") && value === code) return name
  }
  return String(code)
}

/** Calls a libc function returning -1 on failure, and throws Errno with errno then. */
const check = (call: string, result: number): number => {
  if (result === -1) throw new Errno(call, errno())
  return result
}

const padArgs = (n: number) => Array<number>(n).fill(0)

export const open = (path: string, flags: number, mode = 0): number =>
  check("open", s.open(cstr(path), flags, ...padArgs(padOpen.length), mode))

export const openat = (dirfd: number, path: string, flags: number, mode = 0): number =>
  check("openat", s.openat(dirfd, cstr(path), flags, ...padArgs(pad.length), mode))

/** openat declared without the darwin arm64 padding: the mode is only right off darwin arm64. */
// A second dlopen of the same library, since bun:ffi binds a symbol under its own name only.
export const openatUnpadded = (
  dirfd: number,
  path: string,
  flags: number,
  mode: number,
): number => {
  const plain = dlopen(libcPath, {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  })
  try {
    return check("openat", plain.symbols.openat(dirfd, cstr(path), flags, mode))
  } finally {
    plain.close()
  }
}

export const close = (fd: number): void => {
  check("close", s.close(fd))
}

/** flock; returns false when LOCK_NB was asked and another open file holds the lock. */
export const flock = (fd: number, op: number): boolean => {
  if (s.flock(fd, op) === 0) return true
  const code = errno()
  if (code === C.EWOULDBLOCK && (op & C.LOCK_NB) !== 0) return false
  throw new Errno("flock", code)
}

export const fdFlags = (fd: number): number => check("fcntl(F_GETFD)", s.fcntl(fd, C.F_GETFD))
export const statusFlags = (fd: number): number => check("fcntl(F_GETFL)", s.fcntl(fd, C.F_GETFL))

/** Whether fd is open (fcntl(F_GETFD) succeeds), and if so whether FD_CLOEXEC is set. */
export const cloexecOf = (fd: number): "closed" | "cloexec" | "inherited" => {
  const r = s.fcntl(fd, C.F_GETFD)
  if (r === -1) return "closed"
  return (r & C.FD_CLOEXEC) !== 0 ? "cloexec" : "inherited"
}

export class Refused extends Error {}

/**
 * Opens `relative` under the directory `rootFd`, one component at a time, each with O_NOFOLLOW,
 * so that a symlink anywhere in the path is refused (ELOOP or ENOTDIR from the kernel). `.`,
 * `..`, empty components and absolute paths are refused before any call. The directories along
 * the way are opened O_RDONLY|O_DIRECTORY and closed again; the file is opened with `flags`
 * (O_NOFOLLOW and O_CLOEXEC added) and `mode`.
 */
export const openBeneath = (rootFd: number, relative: string, flags: number, mode = 0): number => {
  const parts = relative.split("/")
  if (relative.startsWith("/") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Refused(`not a plain relative path: ${JSON.stringify(relative)}`)
  }
  const name = parts.pop() as string
  let dir = rootFd
  try {
    for (const part of parts) {
      const next = openat(dir, part, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_CLOEXEC)
      if (dir !== rootFd) close(dir)
      dir = next
    }
    return openat(dir, name, flags | C.O_NOFOLLOW | C.O_CLOEXEC, mode)
  } finally {
    if (dir !== rootFd) close(dir)
  }
}
