// Stands in for bun test --parallel's coordinator in test/exec-process-tree.test.ts: it starts a
// test worker as bun test 1.4.3 does, the leader of a process group of its own, one that ignores
// SIGTERM, and exits at a SIGTERM without stopping it, so the worker is left with PID 1 for its
// parent, out of the command's tree. It writes its PID and its worker's to <file>, and runs until it
// is signalled.
import { spawn } from "node:child_process"
import { renameSync, writeFileSync } from "node:fs"

const [file] = process.argv.slice(2)
if (file === undefined) throw new Error("usage: coordinator.ts <file>")

process.on("SIGTERM", () => process.exit(143))
const worker = spawn("/bin/sh", ["-c", "trap '' TERM; exec sleep 60"], {
  stdio: "ignore",
  detached: true,
})
worker.unref()
writeFileSync(`${file}.part`, `${process.pid} ${worker.pid}`)
renameSync(`${file}.part`, file)
setInterval(() => {}, 1000)
