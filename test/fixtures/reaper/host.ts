// Stands in for tutti in test/worker-reaper.test.ts. It starts a busy worker, a sh that never
// reads its stdin and waits on a long sleep, the way a mid-turn Claude Code ignores its stdin's
// EOF. `spawn` starts it with spawnInOwnProcessGroup; `stubborn` starts it ignoring SIGTERM and
// reaps it with a one-second grace. The worker writes its PID and its sleep's to <dir>/pids, and
// the test then kills this host with SIGKILL. `exit` instead lets the host end by itself, its
// worker still busy, once the PIDs are written. `tree` starts claude.ts, a Claude Code with a
// detached command, ignoring SIGTERM, and reaps it and its descendants with a one-second grace.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawnInOwnProcessGroup } from "../../../src/agent/options.ts"
import { reap } from "../../../src/services/reaper.ts"

const [mode, dir] = process.argv.slice(2)
if (dir === undefined) throw new Error("usage: host.ts spawn|stubborn|exit|tree <dir>")

const pids = join(dir, "pids")
const busy = (trap: string) =>
  `${trap} sleep 60 & echo "$$ $!" > "$1.part" && mv "$1.part" "$1"; wait`

if (mode === "tree") {
  const claude = join(import.meta.dir, "claude.ts")
  const child = spawn(process.execPath, [claude, pids], { stdio: "ignore", detached: true })
  reap(child, 1, true)
} else if (mode === "stubborn") {
  const child = spawn("/bin/sh", ["-c", busy("trap '' TERM;"), "worker", pids], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  })
  reap(child, 1)
} else {
  spawnInOwnProcessGroup(() => {})({
    command: "/bin/sh",
    args: ["-c", busy(""), "worker", pids],
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
  })
}

const ready = setInterval(() => {
  if (!existsSync(pids)) return
  clearInterval(ready)
  console.log("ready")
  if (mode === "exit") process.exit(0)
}, 20)
