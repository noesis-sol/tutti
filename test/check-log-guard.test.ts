import { describe, expect, test } from "bun:test"
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer } from "effect"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { outputTo } from "../src/run/check.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckFailed, Checks, checkLogName } from "../src/services/Checks.ts"
import { exec } from "../src/services/exec.ts"
import { runFolder } from "../src/services/Worktrees.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestLog from "../src/testing/Log.ts"
import * as TestWorktrees from "../src/testing/Worktrees.ts"

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-check-log-")))

/** The live Checks layer with `fast` as the merge check, and the run files' layers beside it. */
const layer = (fast: string) => {
  const settings = {
    ...defaultSettings,
    checks: {
      ...defaultSettings.checks,
      fast: { command: fast, timeout: Duration.seconds(10) },
    },
  }
  return Layer.mergeAll(
    Checks.layer.pipe(
      Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
      Layer.provide(BunServices.layer),
    ),
    TestWorktrees.layer(),
    TestLog.layer(),
  )
}

/** Runs the merge check in `worktree` as the merge queue does, and returns how it went and the log. */
const check = (worktree: string, fast = "echo checked; echo said >&2") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ran = yield* Effect.scoped(
        Effect.gen(function* () {
          const to = yield* outputTo({ id: "a" as TicketId, worktree }, checkLogName, "the check's")
          return yield* Effect.exit((yield* Checks).fast({ cwd: worktree, ...to }))
        }),
      )
      return { ran, log: yield* TestLog.texts }
    }).pipe(Effect.provide(layer(fast))),
  )

describe("exec with an output descriptor", () => {
  test("writes the whole output to the descriptor, leaves it open and opens no file", async () => {
    const dir = tempDir()
    const fd = openSync(join(dir, "out.log"), "w")
    const named = join(dir, "not-opened.log")
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          exec({
            command: "sh",
            args: ["-c", "echo first; echo second >&2"],
            timeLimit: "10 seconds",
            outputFile: named,
            outputFd: fd,
          }),
          BunServices.layer,
        ),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(fstatSync(fd).isFile()).toBe(true)
    closeSync(fd)
    const lines = readFileSync(join(dir, "out.log"), "utf8").split("\n").filter(Boolean).sort()
    expect(lines).toEqual(["first", "second"])
    expect(existsSync(named)).toBe(false)
  })
})

describe("the merge check's check.log", () => {
  test("is written in the worktree's .tutti/run/, and a failure names it", async () => {
    const worktree = tempDir()
    const { ran } = await check(worktree, "echo checked; exit 1")
    const log = join(worktree, runFolder, checkLogName)
    expect(readFileSync(log, "utf8")).toBe("checked\n")
    expect(Exit.isFailure(ran)).toBe(true)
    if (Exit.isFailure(ran)) {
      const error = ran.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      expect(error).toBeInstanceOf(CheckFailed)
      expect(error?.message).toEndWith(`the whole output is in ${log}`)
    }
  })

  for (const linked of [".tutti", runFolder, `${runFolder}/${checkLogName}`]) {
    test(`is not followed through a symbolic link at ${linked}`, async () => {
      const worktree = tempDir()
      const outside = tempDir()
      const target = linked.endsWith(".log") ? join(outside, checkLogName) : outside
      if (linked.endsWith(".log")) {
        writeFileSync(target, "untouched\n")
        mkdirSync(join(worktree, runFolder), { recursive: true })
      } else if (linked === runFolder) {
        mkdirSync(join(worktree, ".tutti"))
      }
      symlinkSync(target, join(worktree, linked))
      const { ran, log } = await check(worktree)
      expect(Exit.isSuccess(ran)).toBe(true)
      const file = join(outside, linked === ".tutti" ? "run/check.log" : checkLogName)
      if (linked.endsWith(".log")) expect(readFileSync(file, "utf8")).toBe("untouched\n")
      else expect(existsSync(file)).toBe(false)
      expect(log).toEqual([
        `  a: the check's whole output can't be kept in ${join(worktree, runFolder, checkLogName)}: a symbolic link stands at ${linked}`,
      ])
    })
  }
})
