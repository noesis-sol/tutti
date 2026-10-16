// Holds a lock in a process of its own, for test/run-lock.test.ts, until killed.
//
//   bun test/fixtures/run-lock/holder.ts <git folder> <tutti|orchestra> [system]
//
// tutti takes both locks through the live RunLock, as a run does, for the branch `main`.
// orchestra stands in for an orchestra run: it takes orchestra.lock alone and writes there what
// orchestra writes. system then starts `sleep 300` with libc system(), a plain fork and exec that
// passes on every descriptor without FD_CLOEXEC.
//
// Prints `child <pid>` for the sleep, then `held` once the lock is taken, or the refusal.

import { dlopen, FFIType } from "bun:ffi"
import { writeSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { flockExclusiveNonBlocking, libcPath, O, openCloexec } from "../../../src/native/libc.ts"
import { RunLock } from "../../../src/services/RunLock.ts"

const [commonDir, who, spawn] = process.argv.slice(2)
if (commonDir === undefined) throw new Error("usage: holder.ts <git folder> <tutti|orchestra>")

const { symbols } = dlopen(libcPath, { system: { args: [FFIType.ptr], returns: FFIType.i32 } })

const held = () => {
  if (spawn === "system") {
    symbols.system(Buffer.from('sleep 300 </dev/null >/dev/null 2>&1 & echo "child $!"\0'))
  }
  console.log("held")
}

if (who === "orchestra") {
  const fd = Effect.runSync(openCloexec(join(commonDir, "orchestra.lock"), O.RDWR | O.CREAT))
  if (!Effect.runSync(flockExclusiveNonBlocking(fd))) {
    console.log("refused")
    process.exit(3)
  }
  const said = {
    pid: process.pid,
    started: "2026-10-17T08:31:00.123456+03:00",
    version: "v0.8.0",
    branch: "main",
    spec: ".orchestra/specs/feature.md",
    pane: "w2T:p1",
  }
  writeSync(fd, `${JSON.stringify(said, null, 2)}\n`)
  held()
  setInterval(() => {}, 1 << 30)
} else {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const lock = yield* RunLock
      yield* lock.acquire({
        repo: join(commonDir, ".."),
        commonDir,
        holder: {
          pid: process.pid,
          started: new Date().toISOString(),
          version: "0.1.0",
          branch: "main",
          scope: "demo-1",
        },
      })
      yield* Effect.sync(held)
      return yield* Effect.never
    }),
  ).pipe(
    Effect.provide(RunLock.layer),
    Effect.catchTag("AlreadyRunning", (error) =>
      Effect.sync(() => {
        console.log(error.message)
        process.exit(3)
      }),
    ),
  )
  Effect.runFork(program)
  setInterval(() => {}, 1 << 30)
}
