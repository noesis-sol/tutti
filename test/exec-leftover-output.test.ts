// A process that leaves the command's process group (setsid, a detached spawn with inherited stdio)
// keeps its stdout and stderr open after the leader has exited and the group has been killed. exec
// reads them for LeftoverOutputGrace, then stops and returns what it read (tutti-b2f).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit } from "effect"
import {
  type Command,
  CommandTimedOut,
  exec,
  LeftoverOutputGrace,
  leftoverOutputNote,
} from "../src/services/exec.ts"

setDefaultTimeout(30_000)

const grace = Duration.millis(500)

const runExit = (command: Command) =>
  Effect.runPromise(
    Effect.exit(
      exec(command).pipe(
        Effect.provideService(LeftoverOutputGrace, grace),
        Effect.provide(BunServices.layer),
      ),
    ),
  )

const tempDir = () => mkdtempSync(join(tmpdir(), "tutti-exec-leftover-"))

/** The PIDs of the leftover processes a test started, killed once it is done. */
const leftovers: Array<number> = []

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
})

/** Waits for the PID the leftover process writes, and keeps it to be killed after the test. */
const leftoverPid = async (file: string): Promise<number> => {
  const deadline = Date.now() + 5000
  while (!existsSync(file) || !readFileSync(file, "utf8").endsWith("\n")) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`)
    await Bun.sleep(10)
  }
  const pid = Number(readFileSync(file, "utf8").trim())
  leftovers.push(pid)
  return pid
}

/** A shell line that starts a process in a session of its own, which holds the pipes for 20 s. */
const detached = (pidFile: string) =>
  `perl -e 'use POSIX; POSIX::setsid() or die; open(F, ">", $ARGV[0]); print F "$$\\n"; close F; sleep 20' '${pidFile}' &`

describe("exec, when a process left outside the group holds the output open", () => {
  test("returns the exit code and the output so far a grace after the leader exits", async () => {
    const dir = tempDir()
    const pidFile = join(dir, "pid")
    const outputFile = join(dir, "output")
    const chunks: Array<string> = []
    const started = Date.now()
    const exit = await runExit({
      command: "sh",
      args: ["-c", `${detached(pidFile)} sleep 0.3; echo started; echo err >&2; exit 4`],
      timeLimit: "20 seconds",
      outputFile,
      onOutput: (chunk) => chunks.push(new TextDecoder().decode(chunk)),
    })
    const elapsed = Date.now() - started
    await leftoverPid(pidFile)
    if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
    expect(exit.value.exitCode).toBe(4)
    expect(exit.value.stdout).toBe("started\n")
    expect(exit.value.stderr).toBe(`err\n${leftoverOutputNote(grace)}`)
    expect(elapsed).toBeLessThan(10_000)
    expect(readFileSync(outputFile, "utf8")).toContain(leftoverOutputNote(grace))
    expect(chunks.join("")).toContain(leftoverOutputNote(grace))
  })

  test("can't outlive the time limit: fails with CommandTimedOut within the limit and the graces", async () => {
    const dir = tempDir()
    const pidFile = join(dir, "pid")
    const started = Date.now()
    const exit = await runExit({
      command: "sh",
      args: ["-c", `${detached(pidFile)} echo late >&2; sleep 30`],
      timeLimit: "1 second",
      killGrace: "500 millis",
    })
    const elapsed = Date.now() - started
    await leftoverPid(pidFile)
    if (Exit.isSuccess(exit))
      throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    expect(error).toBeInstanceOf(CommandTimedOut)
    expect((error as CommandTimedOut).stderr).toBe(`late\n${leftoverOutputNote(grace)}`)
    // The limit, the kill grace and the output grace, with room for a loaded machine: well short of
    // the leftover process's 20 s.
    expect(elapsed).toBeLessThan(8_000)
  })

  test("doesn't cut short a command whose output closes in time", async () => {
    const exit = await runExit({
      command: "sh",
      args: ["-c", "(sleep 0.2; echo from the group) & echo leader"],
      timeLimit: "10 seconds",
    })
    if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
    expect(exit.value.stderr).toBe("")
  })
})
