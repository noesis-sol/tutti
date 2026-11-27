// The libc src/native/libc.ts loads, found the same way, for the tests' and fixtures' own bindings
// of what libc.ts keeps to itself, and whether a descriptor is marked close-on-exec.
import { dlopen, FFIType } from "bun:ffi"

// As libc.ts: darwin's libSystem, else glibc's name, which musl's loader maps to itself, or musl's.
const candidates =
  process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, "libc.so"]

// fcntl(F_GETFD) takes no third argument, so the variadic call needs no padding.
const symbols = { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const

const opened = (() => {
  for (const path of candidates) {
    try {
      return { path, lib: dlopen(path, symbols) }
    } catch {}
  }
  throw new Error(`could not load libc from ${candidates.join(", ")}`)
})()

/** The libc that was loaded. */
export const libcPath: string = opened.path

const F_GETFD = 1
const FD_CLOEXEC = 1

/** Whether `fd` is marked close-on-exec, from fcntl(F_GETFD). */
export const isCloseOnExec = (fd: number): boolean => {
  const flags = opened.lib.symbols.fcntl(fd, F_GETFD)
  if (flags === -1) throw new Error(`fcntl(F_GETFD) failed on fd ${fd}`)
  return (flags & FD_CLOEXEC) !== 0
}
