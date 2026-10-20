// bun test's preload (bunfig.toml): one spawn before the tests. Bun 1.4.3's node:child_process can
// lose the exit and output of a bun test process's first spawn in its tests, about once in four at
// a load of ~30 (tutti-cje), and not those of the spawns after it; exec then fails that command
// with CommandNotRun (src/services/exec.ts's LostExitGrace). A spawn in the preload itself doesn't
// take that loss, one in a beforeAll does: this one takes it, if it comes.
import { beforeAll } from "bun:test"
import { spawn } from "node:child_process"

beforeAll(async () => {
  const child = spawn("/bin/sh", ["-c", "exit 0"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  child.on("error", () => {})
  let exited = false
  child.on("exit", () => {
    exited = true
  })
  // A lost exit still sets exitCode: past a second after it, the 'exit' isn't coming.
  const deadline = Date.now() + 5000
  let lostBy: number | undefined
  while (!exited && Date.now() < deadline && (lostBy === undefined || Date.now() < lostBy)) {
    if (lostBy === undefined && (child.exitCode !== null || child.signalCode !== null)) {
      lostBy = Date.now() + 1000
    }
    await Bun.sleep(10)
  }
})
