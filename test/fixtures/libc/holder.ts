// Takes the run lock in a process of its own, for test/libc.test.ts, and holds it until killed.
//
//   bun test/fixtures/libc/holder.ts <lock file> <cloexec|plain> [system]
//
// cloexec opens the file with openCloexec, as tutti does. plain opens it with libc open and no
// O_CLOEXEC (the file must exist): the control, showing the test would catch a leaked descriptor.
// system then starts `sleep 300` with libc system(), a plain fork and exec that passes on every
// descriptor without FD_CLOEXEC, unlike Bun's spawners, which close them all.
//
// Prints `child <pid>` for the sleep, then `held` once the lock is taken, or `refused`.
import { dlopen, FFIType } from "bun:ffi"
import { Effect } from "effect"
import { flockExclusiveNonBlocking, libcPath, O, openCloexec } from "../../../src/native/libc.ts"

const [path, how, spawn] = process.argv.slice(2)
if (path === undefined) throw new Error("usage: holder.ts <lock file> <cloexec|plain> [system]")

// open without O_CREAT reads no mode, so the variadic call needs no padding here.
const { symbols } = dlopen(libcPath, {
  open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  system: { args: [FFIType.ptr], returns: FFIType.i32 },
})

const fd =
  how === "plain"
    ? symbols.open(Buffer.from(`${path}\0`), O.RDWR)
    : Effect.runSync(openCloexec(path, O.RDWR | O.CREAT))
if (fd === -1) throw new Error(`could not open ${path}`)

if (!Effect.runSync(flockExclusiveNonBlocking(fd))) {
  console.log("refused")
  process.exit(3)
}
if (spawn === "system") {
  symbols.system(Buffer.from('sleep 300 </dev/null >/dev/null 2>&1 & echo "child $!"\0'))
}
console.log("held")

setInterval(() => {}, 1 << 30)
