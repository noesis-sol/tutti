// The setup in the main checkout after a merge (setup.ts's setUpCheckout) leaves what it leaves
// running there: a check that doesn't pass in a worktree has the processes it left in its folder
// stopped (src/services/Checks.ts' stoppingStrays), but people and tutti's own git and bd run in
// the main checkout, so a run asked with `leaveStrays` stops nothing there.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { defaultSettings } from "../src/run/resolveConfig.ts"
import { Checks, type SetupOptions } from "../src/services/Checks.ts"
import { processAlive } from "../src/services/processTree.ts"
import { layer as straysLayer } from "../src/services/Strays.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"

const started: Array<number> = []

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
})

/**
 * A script that starts `sleep 600` in a session of its own, writes its PID to `stray` in the folder
 * it runs in, and exits, leaving it to init: no process group or tree of the setup's holds it.
 */
const escaping = [
  `const { spawn } = require("node:child_process")`,
  `const { writeFileSync } = require("node:fs")`,
  `const child = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" })`,
  `writeFileSync("stray", child.pid + "\\n")`,
  `child.unref()`,
].join("\n")

/** A main checkout whose setup.sh starts a stray (escaping) and then fails. */
const checkout = () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tutti-checkout-strays-")))
  writeFileSync(join(cwd, "escape.js"), escaping)
  writeFileSync(join(cwd, "setup.sh"), `"${process.execPath}" escape.js\nexit 3\n`)
  return cwd
}

/** The stray's PID, once the setup has written it. */
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

/** Waits up to `ms` for process `pid` to have gone. */
const gone = async (pid: number, ms = 3000) => {
  const until = Date.now() + ms
  while (processAlive(pid) && Date.now() < until) await Bun.sleep(20)
  return !processAlive(pid)
}

/** The live Checks layer, its setup `sh setup.sh`, with the live Strays. */
const checksLayer = Checks.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TestAppConfig.layer(
        TestAppConfig.appConfig({
          settings: {
            ...defaultSettings,
            checks: { ...defaultSettings.checks, setup: { command: "sh setup.sh", files: [] } },
          },
        }),
      ),
      straysLayer({ grace: "2 seconds" }),
      logLayer(),
    ),
  ),
  Layer.provideMerge(BunServices.layer),
)

/** Runs the setup in `cwd` with `options` over the live Checks: how it ended, and the log's lines. */
const setUp = (cwd: string, options: Partial<SetupOptions>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const checks = yield* Checks
      const exit = yield* Effect.exit(
        checks.setup({ cwd, outputFile: join(cwd, "setup.log"), before: "fast", ...options }),
      )
      return { exit, lines: yield* texts }
    }).pipe(Effect.provide(checksLayer)),
  )

describe("the main checkout's setup, failing, asked to leave what it leaves running", () => {
  test("stops nothing there, and says nothing of it", async () => {
    const cwd = checkout()
    const { exit, lines } = await setUp(cwd, { leaveStrays: true })
    expect(Exit.isFailure(exit)).toBe(true)
    const stray = await strayIn(cwd)
    // Still there once the stop, had there been one, would have ended.
    await Bun.sleep(300)
    expect(processAlive(stray)).toBe(true)
    expect(lines).toEqual([])
  })

  test("without the ask, as a worktree's, what it left running is stopped", async () => {
    const cwd = checkout()
    const { exit, lines } = await setUp(cwd, {})
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await gone(await strayIn(cwd))).toBe(true)
    expect(lines).toEqual([`  stopped 1 process the setup left running in ${cwd}: sleep`])
  })
})
