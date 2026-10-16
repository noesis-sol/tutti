// Stands in for tutti in test/exec.test.ts's SIGINT test. The test starts it as the leader of a
// process group of its own, as a terminal starts its foreground job, and sends SIGINT to that
// group once the command below has written its PID to <dir>/pid. This host notes the SIGINT and
// carries on; it prints the command's result as JSON when the command ends.
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { exec } from "../../../src/services/exec.ts"

const dir = process.argv[2]
if (dir === undefined) throw new Error("usage: sigint-host.ts <dir>")

process.on("SIGINT", () => console.error("SIGINT"))

const output = await Effect.runPromise(
  exec({
    command: "sh",
    args: ["-c", 'echo $$ > "$1/pid"; sleep 1; echo done', "sh", dir],
    timeLimit: "10 seconds",
  }).pipe(Effect.provide(BunServices.layer)),
)
console.log(JSON.stringify(output))
