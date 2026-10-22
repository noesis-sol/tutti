// Stands in for a busy Claude Code in test/process-tree.test.ts: it starts a Bash command the way
// Claude Code 2.1.301 does, detached, the leader of a process group of its own, and a child in its
// own group, and ignores SIGTERM, as a Claude Code whose shutdown outlasts its grace. It writes its
// PID, its command's and its child's to <file>, and runs until it is killed.
import { spawn } from "node:child_process"
import { renameSync, writeFileSync } from "node:fs"

const [file] = process.argv.slice(2)
if (file === undefined) throw new Error("usage: claude.ts <file>")

process.on("SIGTERM", () => {})
const command = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { stdio: "ignore", detached: true })
const child = spawn("/bin/sh", ["-c", "sleep 60"], { stdio: "ignore" })
writeFileSync(`${file}.part`, `${process.pid} ${command.pid} ${child.pid}`)
renameSync(`${file}.part`, file)
setInterval(() => {}, 1000)
