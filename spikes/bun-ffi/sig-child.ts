// A child of spike.ts signals: reports the signals it receives on stdout.
//
//   bun spikes/bun-ffi/sig-child.ts handlers|none
//
// `handlers` installs process.on handlers for SIGUSR1, SIGUSR2 and SIGTSTP, each printing
// `got <signal>`; `none` installs none, to show each signal's default action under Bun. Prints
// `ready <pid>` once set up, then stays alive until killed.
//
// It first moves into a process group of its own (setpgid(0, 0)), whose parent is in another
// group of the same session, as a job in a terminal is. Left in its parent's group, it would be
// in an orphaned group whenever the spike runs without a terminal (under an agent's shell, or as
// a container's PID 1), and the kernel discards SIGTSTP sent to an orphaned group: the
// no-handler control would then show nothing.

import { dlopen, FFIType } from "bun:ffi"
import { libcPath } from "./libc.ts"

const { symbols } = dlopen(libcPath, {
  setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
if (symbols.setpgid(0, 0) !== 0) console.log("setpgid failed")

const mode = process.argv[2] ?? "handlers"
if (mode === "handlers") {
  for (const signal of ["SIGUSR1", "SIGUSR2", "SIGTSTP"] as const) {
    process.on(signal, () => console.log(`got ${signal}`))
  }
}
console.log(`ready ${process.pid}`)
setInterval(() => {}, 1 << 30)
