import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Fiber } from "effect"
import {
  type Command,
  CommandFailed,
  CommandNotRun,
  CommandTimedOut,
  exec,
  run,
  showCommand,
} from "../src/services/exec.ts"

const provide = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Effect.Effect<A, E> =>
  Effect.provide(effect, BunServices.layer)

const runExit = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(Effect.exit(provide(effect)))

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const sh = (script: string, more: Partial<Command> = {}): Command => ({
  command: "sh",
  args: ["-c", script],
  timeLimit: "10 seconds",
  ...more,
})

const tempDir = () => mkdtempSync(join(tmpdir(), "tutti-exec-"))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits up to `ms` for every PID to be gone, and says whether they went. */
const gone = async (pids: ReadonlyArray<number>, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (pids.some(alive)) {
    if (Date.now() > deadline) return false
    await Bun.sleep(20)
  }
  return true
}

/** Waits for a file a command writes with a trailing newline, and returns its words as numbers. */
const pidsIn = async (file: string): Promise<Array<number>> => {
  const deadline = Date.now() + 5000
  while (!existsSync(file) || !readFileSync(file, "utf8").endsWith("\n")) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`)
    await Bun.sleep(10)
  }
  return readFileSync(file, "utf8").trim().split(/\s+/).map(Number)
}

// The leader writes its own PID and its background child's PID, then waits on the child.
const leaderAndGrandchild = (pidFile: string, prelude = "") =>
  `${prelude} sleep 30 & echo $$ $! > '${pidFile}'; wait`

describe("exec", () => {
  test("returns a command's stdout, stderr and exit code", async () => {
    const exit = await runExit(exec(sh("echo out; echo err >&2; exit 3")))
    expect(exit).toEqual(Exit.succeed({ exitCode: 3, stdout: "out\n", stderr: "err\n" }))
  })

  test("feeds stdin, sets the environment over tutti's, and runs in cwd", async () => {
    const dir = tempDir()
    const exit = await runExit(
      exec(
        sh('cat; echo "$TUTTI_EXEC_TEST"; test -n "$PATH" && pwd -P', {
          stdin: "in\n",
          env: { TUTTI_EXEC_TEST: "set" },
          cwd: dir,
        }),
      ),
    )
    expect(Exit.isSuccess(exit) && exit.value.stdout).toBe(`in\nset\n${realpathSync(dir)}\n`)
  })

  test("keeps the last bytes of a long output, and the whole of it in the output file", async () => {
    const file = join(tempDir(), "out.log")
    const exit = await runExit(
      exec(sh("echo first; echo second >&2; echo third", { outputFile: file, maxOutputBytes: 6 })),
    )
    expect(exit).toEqual(Exit.succeed({ exitCode: 0, stdout: "third\n", stderr: "econd\n" }))
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).sort()
    expect(lines).toEqual(["first", "second", "third"])
  })

  test("a command a signal ends gets 128 + the signal's number", async () => {
    const exit = await runExit(exec(sh("kill -TERM $$")))
    expect(Exit.isSuccess(exit) && exit.value.exitCode).toBe(143)
  })

  test("a command that can't start fails with CommandNotRun", async () => {
    const exit = await runExit(
      exec({ command: "tutti-no-such-command", args: ["x"], timeLimit: "5 seconds" }),
    )
    const error = failure(exit)
    expect(error).toBeInstanceOf(CommandNotRun)
    expect(error).toMatchObject({ command: "tutti-no-such-command x" })
  })

  test("runs each command as the leader of a process group of its own", async () => {
    const exit = await runExit(exec(sh("echo $$ $(ps -o pgid= -p $$)")))
    const [pid, pgid] = Exit.isSuccess(exit) ? exit.value.stdout.trim().split(/\s+/) : []
    expect(pid).toBeDefined()
    expect(pgid).toBe(pid)
  })

  test("ends what is left of the group when the leader exits", async () => {
    const started = Date.now()
    const exit = await runExit(exec(sh("sleep 30 & echo $!")))
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = Exit.isSuccess(exit) ? Number(exit.value.stdout.trim()) : 0
    expect(pid).toBeGreaterThan(0)
    expect(await gone([pid])).toBe(true)
  })
})

describe("run", () => {
  test("returns the output of a command that succeeds", async () => {
    const exit = await runExit(
      run({ command: "printf", args: ["%s", "a b"], timeLimit: "5 seconds" }),
    )
    expect(exit).toEqual(Exit.succeed({ exitCode: 0, stdout: "a b", stderr: "" }))
  })

  test("fails with CommandFailed carrying the command, exit code and stderr", async () => {
    const exit = await runExit(run(sh("echo nope >&2; exit 2")))
    expect(failure(exit)).toEqual(
      new CommandFailed({
        command: "sh -c 'echo nope >&2; exit 2'",
        exitCode: 2,
        stderr: "nope\n",
      }),
    )
  })
})

describe("time limits", () => {
  test("kill the whole group, grandchild included, and fail with CommandTimedOut", async () => {
    const pidFile = join(tempDir(), "pids")
    const started = Date.now()
    const exit = await runExit(
      exec(sh(`echo late >&2; ${leaderAndGrandchild(pidFile)}`, { timeLimit: "300 millis" })),
    )
    const error = failure(exit)
    expect(error).toBeInstanceOf(CommandTimedOut)
    expect(error).toMatchObject({ stderr: "late\n" })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await gone(await pidsIn(pidFile))).toBe(true)
  })

  test("send SIGKILL after the grace to a group that ignores SIGTERM", async () => {
    const pidFile = join(tempDir(), "pids")
    const exit = await runExit(
      exec(
        sh(leaderAndGrandchild(pidFile, "trap '' TERM;"), {
          timeLimit: "300 millis",
          killGrace: "300 millis",
        }),
      ),
    )
    expect(failure(exit)).toBeInstanceOf(CommandTimedOut)
    expect(await gone(await pidsIn(pidFile))).toBe(true)
  })

  test("fail a command that exits with 0 on the SIGTERM they send", async () => {
    const exit = await runExit(
      run(sh("trap 'echo cleaned up; exit 0' TERM; sleep 30 & wait", { timeLimit: "300 millis" })),
    )
    expect(failure(exit)).toBeInstanceOf(CommandTimedOut)
  })

  test("hold while the caller is uninterruptible", async () => {
    const pidFile = join(tempDir(), "pids")
    const exit = await runExit(
      Effect.uninterruptible(exec(sh(leaderAndGrandchild(pidFile), { timeLimit: "300 millis" }))),
    )
    expect(failure(exit)).toBeInstanceOf(CommandTimedOut)
    expect(await gone(await pidsIn(pidFile))).toBe(true)
  })
})

describe("interruption", () => {
  test("kills the whole group, grandchild included", async () => {
    const pidFile = join(tempDir(), "pids")
    const fiber = Effect.runFork(provide(exec(sh(leaderAndGrandchild(pidFile)))))
    const pids = await pidsIn(pidFile)
    expect(pids.every(alive)).toBe(true)
    const exit = await Effect.runPromise(
      Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(await gone(pids)).toBe(true)
  })
})

describe("signals", () => {
  test("a SIGINT sent to tutti's own process group doesn't reach a started command", async () => {
    const dir = tempDir()
    const host = Bun.spawn(["bun", join(import.meta.dir, "fixtures/exec/sigint-host.ts"), dir], {
      detached: true,
      stdout: "pipe",
      stderr: "pipe",
    })
    await pidsIn(join(dir, "pid"))
    process.kill(-host.pid, "SIGINT")
    const [out, err, code] = await Promise.all([
      new Response(host.stdout).text(),
      new Response(host.stderr).text(),
      host.exited,
    ])
    expect(err).toContain("SIGINT")
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ exitCode: 0, stdout: "done\n", stderr: "" })
  }, 15000)
})

describe("showCommand", () => {
  test("quotes the arguments a shell would split or expand", () => {
    expect(showCommand({ command: "git", args: ["commit", "-m", "it's done", "--", "a.ts"] })).toBe(
      `git commit -m 'it'\\''s done' -- a.ts`,
    )
  })
})
