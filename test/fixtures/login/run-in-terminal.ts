// Stands in for tutti login's login in test/login-terminal.test.ts: runs runInTerminal
// (src/cli/login.ts) with the command line given as its arguments, on this process's own stdin,
// stdout and stderr, then prints `exit <code>` on stdout, or `failed: <problems>` on stderr.
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { runInTerminal } from "../../../src/cli/login.ts"

const [command, ...args] = process.argv.slice(2)
if (command === undefined) throw new Error("usage: run-in-terminal.ts <command> [args…]")

const exit = await Effect.runPromise(
  runInTerminal({ command, args }).pipe(Effect.provide(BunServices.layer), Effect.result),
)
if (exit._tag === "Success") console.log(`exit ${exit.success}`)
else console.error(`failed: ${exit.failure.problems.join("\n")}`)
