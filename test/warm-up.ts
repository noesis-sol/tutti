// bun test's preload (bunfig.toml): one spawn before the tests. Bun 1.4.3's node:child_process can
// lose the exit and output of a bun test process's first spawn in its tests, about once in four at
// a load of ~30 (tutti-cje), and not those of the spawns after it; exec then fails that command
// with CommandNotRun (src/services/exec.ts's LostExitGrace). A spawn in the preload itself doesn't
// take that loss, one in a beforeAll does: this one takes it, if it comes.
import { beforeAll } from "bun:test"
import { spawn } from "node:child_process"

/** What waitForExit reads of a child: its 'exit' event, and the code or signal it exited with. */
export interface Exiting {
  readonly once: (event: "exit", listener: () => void) => unknown
  readonly exitCode: number | null
  readonly signalCode: string | null
}

/**
 * Resolves on the child's 'exit', or at the deadline. A lost exit still sets exitCode or
 * signalCode, checked every `poll` ms: past `lost` ms after either is set, the 'exit' isn't coming.
 */
export const waitForExit = (
  child: Exiting,
  { deadline = 5000, lost = 1000, poll = 100 } = {},
): Promise<void> =>
  new Promise((resolve) => {
    let lostBy: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(timeout)
      clearInterval(check)
      clearTimeout(lostBy)
      resolve()
    }
    const timeout = setTimeout(done, deadline)
    const check = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(check)
        lostBy = setTimeout(done, lost)
      }
    }, poll)
    child.once("exit", done)
  })

beforeAll(async () => {
  const child = spawn("/bin/sh", ["-c", "exit 0"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  child.on("error", () => {})
  await waitForExit(child)
})
