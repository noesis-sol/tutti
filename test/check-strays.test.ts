// What a check left running outside its process group (src/services/Checks.ts' stoppingStrays,
// src/services/Worktrees.ts' removeDetached): a process started in a session of its own, its parent
// gone, so that exec's stop of the check's group and tree doesn't reach it, as a server a check
// started with setsid or nohup. A check that fails, times out or is interrupted has it stopped as it
// ends, the processes in its folder before it started left running, as a worker's session is in its
// ticket's worktree; a detached worktree's removal stops it too.
import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer, Option } from "effect"
import { defaultSettings } from "../src/cli/resolveConfig.ts"
import { Checks, stoppingStrays } from "../src/services/Checks.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { processAlive } from "../src/services/processTree.ts"
import { Strays, layer as straysLayer } from "../src/services/Strays.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const started: Array<number> = []

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
})

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-check-strays-")))

/**
 * A script that starts `sleep 600` in a session of its own, writes its PID to `stray` in the folder
 * it runs in, and exits, leaving it to init: no process group or tree of the check's holds it.
 */
const escaping = [
  `const { spawn } = require("node:child_process")`,
  `const { writeFileSync } = require("node:fs")`,
  `const child = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" })`,
  `writeFileSync("stray", child.pid + "\\n")`,
  `child.unref()`,
].join("\n")

/** A folder whose check.sh starts a stray (escaping) and then runs `then`. */
const checkFolder = (then: string) => {
  const cwd = folder()
  writeFileSync(join(cwd, "escape.js"), escaping)
  writeFileSync(join(cwd, "check.sh"), `"${process.execPath}" escape.js\n${then}\n`)
  return { cwd, outputFile: join(cwd, "check.log") }
}

/** The stray's PID, once the check has written it. */
const strayIn = async (cwd: string): Promise<number> => {
  const file = join(cwd, "stray")
  const deadline = Date.now() + 10_000
  while (!existsSync(file) || !readFileSync(file, "utf8").endsWith("\n")) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`)
    await Bun.sleep(10)
  }
  const pid = Number(readFileSync(file, "utf8").trim())
  started.push(pid)
  return pid
}

/** Starts `sleep` in `cwd` from the test, in a group of its own, as a worker's session runs there. */
const before = async (cwd: string): Promise<number> => {
  const child = spawn("/bin/sleep", ["61"], { cwd, detached: true, stdio: "ignore" })
  child.unref()
  const pid = child.pid
  if (pid === undefined) throw new Error("sleep didn't start")
  started.push(pid)
  // Until the listing can see where it runs.
  await Bun.sleep(100)
  return pid
}

/** The live Checks layer, its fast check `sh check.sh` within `limit`, with the live Strays. */
const checksLayer = (limit = "20 seconds") => {
  const { checks } = defaultSettings
  const settings = {
    ...defaultSettings,
    checks: {
      ...checks,
      fast: { command: "sh check.sh", timeout: Duration.fromInputUnsafe(limit as Duration.Input) },
    },
  }
  return Checks.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TestAppConfig.layer(TestAppConfig.appConfig({ settings })),
        straysLayer({ grace: "2 seconds" }),
        logLayer(),
      ),
    ),
    Layer.provideMerge(BunServices.layer),
  )
}

/** Runs `use` over the live Checks, and gives how it ended with the log's lines. */
const checking = <A, E>(
  limit: string | undefined,
  use: (checks: Checks["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(use(yield* Checks))
      return { exit, lines: yield* texts }
    }).pipe(Effect.provide(checksLayer(limit))),
  )

/** Waits up to `ms` for process `pid` to have gone. */
const gone = async (pid: number, ms = 3000) => {
  const until = Date.now() + ms
  while (processAlive(pid) && Date.now() < until) await Bun.sleep(20)
  return !processAlive(pid)
}

describe("a check that doesn't pass", () => {
  test("that fails has what it left running stopped, and what ran there before it kept", async () => {
    const wt = checkFolder("exit 3")
    const kept = await before(wt.cwd)
    const { exit, lines } = await checking(undefined, (checks) => checks.fast(wt))
    expect(Exit.isFailure(exit)).toBe(true)
    const stray = await strayIn(wt.cwd)
    expect(processAlive(stray)).toBe(false)
    expect(processAlive(kept)).toBe(true)
    expect(lines).toEqual([`  stopped 1 process the fast check left running in ${wt.cwd}: sleep`])
  })

  test("that times out has what it left running stopped", async () => {
    const wt = checkFolder("sleep 30")
    const { exit } = await checking("2 seconds", (checks) => checks.fast(wt))
    expect(Exit.isFailure(exit) && `${exit.cause}`).toContain("CheckTimedOut")
    expect(processAlive(await strayIn(wt.cwd))).toBe(false)
  })

  test("that is interrupted has what it left running stopped", async () => {
    const wt = checkFolder("sleep 30")
    await Effect.runPromise(
      Effect.gen(function* () {
        const checks = yield* Checks
        const fiber = yield* Effect.forkChild(checks.fast(wt))
        const stray = yield* Effect.promise(() => strayIn(wt.cwd))
        yield* Fiber.interrupt(fiber)
        // The interruption ends once the stray is stopped.
        expect(processAlive(stray)).toBe(false)
      }).pipe(Effect.provide(checksLayer())),
    )
  })
})

describe("stoppingStrays", () => {
  test("stops nothing when what ran in the folder before couldn't be listed", async () => {
    const stops: Array<string> = []
    const strays = Strays.of({
      running: () => Effect.succeed(undefined),
      stop: (folder) =>
        Effect.sync(() => {
          stops.push(folder)
          return []
        }),
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        stoppingStrays(
          "fast",
          "/nowhere",
          Effect.fail("failed"),
          Option.some(strays),
          Option.none(),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(stops).toEqual([])
  })
})

slow.describe("a detached worktree's removal", () => {
  test("stops what was left running in it, in a session of its own, before deleting it", async () => {
    const repo = makeRepo()
    const root = folder()
    const layer = Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
      Layer.provideMerge(Layer.mergeAll(straysLayer({ grace: "2 seconds" }), logLayer())),
      Layer.provideMerge(Git.layer()),
      Layer.provideMerge(GitWriter.layer),
      Layer.provideMerge(BunServices.layer),
    )
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const path = yield* worktrees.addDetached("tutti-early-", "main")
        writeFileSync(join(path, "escape.js"), escaping)
        const ran = Bun.spawnSync([process.execPath, "escape.js"], { cwd: path })
        expect(ran.exitCode).toBe(0)
        const stray = yield* Effect.promise(() => strayIn(path))
        expect(processAlive(stray)).toBe(true)
        yield* worktrees.removeDetached(path)
        expect(yield* Effect.promise(() => gone(stray))).toBe(true)
        expect(existsSync(path)).toBe(false)
        return { path, lines: yield* texts }
      }).pipe(Effect.provide(layer)),
    )
    expect(lines.lines).toEqual([`  stopped 1 process left running in ${lines.path}: sleep`])
  })
})
