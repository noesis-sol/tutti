// Stands in for tutti in test/exec-reaper.test.ts. It runs a busy command through exec, a sh that
// waits on a long sleep with a time limit far off; `stubborn` runs it ignoring SIGTERM, with a
// one-second grace. The command writes its PID and its sleep's to <dir>/pids, and the test then
// kills this host with SIGKILL, mid-command. `claude` and `coordinator` run the fixture of that
// name instead (claude.ts, coordinator.ts), whose descendants lead process groups of their own; it
// writes the PIDs.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { exec } from "../../../src/services/exec.ts"

const [mode, dir] = process.argv.slice(2)
if (dir === undefined) {
  throw new Error("usage: exec-host.ts spawn|stubborn|claude|coordinator <dir>")
}

const pids = join(dir, "pids")
const trap = mode === "stubborn" ? "trap '' TERM;" : ""

const ready = setInterval(() => {
  if (!existsSync(pids)) return
  clearInterval(ready)
  console.log("ready")
}, 20)

const fixture = mode === "claude" || mode === "coordinator" ? `${mode}.ts` : undefined

await Effect.runPromise(
  exec({
    ...(fixture === undefined
      ? {
          command: "/bin/sh",
          args: [
            "-c",
            `${trap} sleep 60 & echo "$$ $!" > "$1.part" && mv "$1.part" "$1"; wait`,
            "command",
            pids,
          ],
        }
      : { command: process.execPath, args: [join(import.meta.dir, fixture), pids] }),
    timeLimit: "10 minutes",
    killGrace: "1 second",
  }).pipe(Effect.provide(BunServices.layer)),
)
