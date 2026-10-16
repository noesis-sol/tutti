// A child of spike.ts lock: takes flock(LOCK_EX|LOCK_NB) on a file and reports on stdout.
//
//   bun spikes/bun-ffi/holder.ts <lock file> <open> [<spawner>] [--try]
//
// <open> is how the file is opened:
//   ffi-cloexec   libc open(O_RDWR|O_CREAT|O_CLOEXEC, 0644) through bun:ffi, as § 9.2 has it
//   ffi-plain     the same without O_CLOEXEC: the control for inheritance
//   fs            node:fs openSync(path, "a+"), Bun's own flags
// <spawner>, once the lock is held, spawns `sleep 300` and prints `child <pid>`:
//   bun-spawn     Bun.spawn
//   node-spawn    node:child_process spawn
//   effect        effect/process ChildProcess with @effect/platform-bun's spawner (which is
//                 node:child_process underneath), detached as tutti's workers will be
//   libc-system   libc system("sleep 300 &") through bun:ffi: a plain fork and exec, which keeps
//                 every descriptor without FD_CLOEXEC; the control showing that the test catches a
//                 leak
//   none          no child
// --try takes the lock (or not), prints `held` or `refused`, and exits.
//
// Lines printed: `held fd=<n> fdflags=<cloexec|inherited>`, `refused errno=<n>`, `child <pid>`.

import { dlopen, FFIType } from "bun:ffi"
import { spawn as nodeSpawn } from "node:child_process"
import { openSync } from "node:fs"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import { C, cloexecOf, flock, libcPath, open } from "./libc.ts"

const [path, how = "ffi-cloexec", spawner = "none"] = process.argv
  .slice(2)
  .filter((a) => a !== "--try")
const tryOnly = process.argv.includes("--try")
if (path === undefined) throw new Error("usage: holder.ts <lock file> <open> [<spawner>] [--try]")

const fd =
  how === "fs"
    ? openSync(path, "a+")
    : open(path, C.O_RDWR | C.O_CREAT | (how === "ffi-cloexec" ? C.O_CLOEXEC : 0), 0o644)

if (!flock(fd, C.LOCK_EX | C.LOCK_NB)) {
  console.log(`refused errno=${C.EWOULDBLOCK}`)
  process.exit(3)
}
console.log(`held fd=${fd} fdflags=${cloexecOf(fd)}`)
if (tryOnly) process.exit(0)

const sleeper = ["sleep", "300"] as const
if (spawner === "bun-spawn") {
  const child = Bun.spawn([...sleeper], { stdio: ["ignore", "ignore", "ignore"] })
  console.log(`child ${child.pid}`)
} else if (spawner === "node-spawn") {
  const child = nodeSpawn(sleeper[0], [sleeper[1]], { stdio: "ignore" })
  console.log(`child ${child.pid}`)
} else if (spawner === "libc-system") {
  const { symbols } = dlopen(libcPath, { system: { args: [FFIType.ptr], returns: FFIType.i32 } })
  symbols.system(Buffer.from('sleep 300 </dev/null >/dev/null 2>&1 & echo "child $!"\0'))
} else if (spawner === "effect") {
  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(sleeper[0], [sleeper[1]], {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })
        console.log(`child ${handle.pid}`)
        yield* Effect.never
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  )
}

// Hold until killed.
setInterval(() => {}, 1 << 30)
