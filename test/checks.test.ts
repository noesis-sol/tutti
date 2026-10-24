import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer } from "effect"
import fc from "fast-check"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import {
  boundLines,
  CheckFailed,
  CheckNotRun,
  CheckOutput,
  Checks,
  CheckTimedOut,
  OutputBounds,
} from "../src/services/Checks.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestChecks from "../src/testing/Checks.ts"

interface Commands {
  readonly setup?: string | null
  readonly fast?: string | null
  readonly full?: string | null
  readonly fastLimit?: string
  readonly fullLimit?: string
}

/** The live Checks layer, with the settings naming these commands and limits. */
const checksLayer = (commands: Commands) => {
  const { checks } = defaultSettings
  const settings = {
    ...defaultSettings,
    checks: {
      ...checks,
      setup: { ...checks.setup, command: commands.setup ?? null },
      fast: {
        command: commands.fast ?? null,
        timeout: Duration.fromInputUnsafe((commands.fastLimit ?? "10 seconds") as Duration.Input),
      },
      full: {
        command: commands.full ?? null,
        timeout: Duration.fromInputUnsafe((commands.fullLimit ?? "10 seconds") as Duration.Input),
      },
    },
  }
  return Checks.layer.pipe(
    Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
    Layer.provideMerge(BunServices.layer),
  )
}

const runExit = <A, E>(
  commands: Commands,
  effect: (checks: Checks["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(
        Effect.gen(function* () {
          return yield* effect(yield* Checks)
        }),
        checksLayer(commands),
      ),
    ),
  )

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const tempDir = () => mkdtempSync(join(tmpdir(), "tutti-checks-"))

/** A folder to run a check in, with `script` as its check.sh, and where its output goes. */
const worktree = (script: string) => {
  const cwd = tempDir()
  writeFileSync(join(cwd, "check.sh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return { cwd, outputFile: join(cwd, "check.log") }
}

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

// Prints a line, then writes its own PID and its background child's to pids, and waits on the child.
const hangs = `echo started; sleep 30 & echo $$ $! > pids; wait`

const failingCheck = [
  `echo "SUITE: unit"`,
  `echo "FLAKY: test/a.test.ts retries once"`,
  `echo "--- FAIL: TestUndo (0.01s)"`,
  `echo "    undo_test.go:12: the stack is empty"`,
  `echo "--- FAIL: TestUndo (0.01s)"`,
  `echo "SUITE:   lint   checks  "`,
  `echo "src/a.go:3:1: unused variable x" >&2`,
  `echo "error: lint found 1 problem" >&2`,
  `exit 3`,
].join("\n")

describe("the live layer", () => {
  test("a check that passes says its suites and FLAKY: lines, and keeps its whole output", async () => {
    const wt = worktree(
      `echo "SUITE: unit"; echo "FLAKY: test/a.test.ts undoes a drag"; echo ok; echo warn >&2`,
    )
    const exit = await runExit({ fast: "./check.sh" }, (checks) => checks.fast(wt))
    if (Exit.isFailure(exit)) throw new Error(`${exit.cause}`)
    expect(exit.value).toMatchObject({
      _tag: "CheckPassed",
      check: "fast",
      command: "./check.sh",
      failingLines: [],
      suites: ["unit"],
      suite: "unit",
      flaky: ["test/a.test.ts undoes a drag"],
      flakyCount: 1,
    })
    const lines = readFileSync(wt.outputFile, "utf8").split("\n").filter(Boolean).sort()
    expect(lines).toEqual(["FLAKY: test/a.test.ts undoes a drag", "SUITE: unit", "ok", "warn"])
  })

  test("a check that fails says what failed, its suites and FLAKY: lines", async () => {
    const wt = worktree(failingCheck)
    const error = failure(await runExit({ fast: "./check.sh" }, (checks) => checks.fast(wt)))
    expect(error).toBeInstanceOf(CheckFailed)
    expect(error).toMatchObject({
      check: "fast",
      command: "./check.sh",
      exitCode: 3,
      outputFile: wt.outputFile,
      suites: ["unit", "lint checks"],
      suite: "lint checks",
      flaky: ["test/a.test.ts retries once"],
      flakyCount: 1,
    })
    // A failing test's own messages are indented; the same line is said once.
    expect([...(error as CheckFailed).failingLines].sort()).toEqual([
      "--- FAIL: TestUndo (0.01s)",
      "error: lint found 1 problem",
      "src/a.go:3:1: unused variable x",
    ])
    expect(readFileSync(wt.outputFile, "utf8")).toContain("undo_test.go:12: the stack is empty")
  })

  test("each kind runs its own command within its own time limit", async () => {
    const commands = {
      setup: `sleep 1; echo set up`,
      fast: `sleep 1; echo fast`,
      full: `sleep 1; echo full`,
      fastLimit: "200 millis",
      fullLimit: "10 seconds",
    }
    const wt = worktree("")
    const timedOut = (exit: Exit.Exit<unknown, unknown>) => {
      const error = failure(exit)
      expect(error).toBeInstanceOf(CheckTimedOut)
      return error as CheckTimedOut
    }
    const fast = timedOut(await runExit(commands, (checks) => checks.fast(wt)))
    expect(fast).toMatchObject({ check: "fast", command: commands.fast })
    expect(Duration.toMillis(fast.timeLimit)).toBe(200)
    const setup = timedOut(
      await runExit(commands, (checks) => checks.setup({ ...wt, before: "fast" })),
    )
    expect(setup).toMatchObject({ check: "setup", command: commands.setup })
    expect(Duration.toMillis(setup.timeLimit)).toBe(200)

    const full = await runExit(commands, (checks) => checks.full(wt))
    expect(Exit.isSuccess(full) && full.value).toMatchObject({ _tag: "CheckPassed", check: "full" })
    expect(readFileSync(wt.outputFile, "utf8")).toBe("full\n")
    const setupFull = await runExit(commands, (checks) => checks.setup({ ...wt, before: "full" }))
    expect(Exit.isSuccess(setupFull) && setupFull.value).toMatchObject({ check: "setup" })
    expect(readFileSync(wt.outputFile, "utf8")).toBe("set up\n")
  })

  test("a time limit kills the check's process group and says what it printed", async () => {
    const wt = worktree(`echo "SUITE: slow"; ${hangs}`)
    const error = failure(
      await runExit({ fast: "./check.sh", fastLimit: "1 second" }, (checks) => checks.fast(wt)),
    )
    expect(error).toBeInstanceOf(CheckTimedOut)
    expect(error).toMatchObject({
      suites: ["slow"],
      lastLines: ["SUITE: slow", "started"],
      outputFile: wt.outputFile,
    })
    expect(await gone(await pidsIn(join(wt.cwd, "pids")))).toBe(true)
  })

  test("interrupting a check kills its process group, and no result comes of it", async () => {
    const wt = worktree(hangs)
    const fiber = Effect.runFork(
      Effect.provide(
        Effect.gen(function* () {
          return yield* (yield* Checks).full(wt)
        }),
        checksLayer({ full: "./check.sh" }),
      ),
    )
    const pids = await pidsIn(join(wt.cwd, "pids"))
    expect(pids.every(alive)).toBe(true)
    const exit = await Effect.runPromise(
      Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(await gone(pids)).toBe(true)
  })

  test("a check the settings don't name runs nothing", async () => {
    const wt = worktree("")
    const exit = await runExit({}, (checks) => checks.setup({ ...wt, before: "fast" }))
    expect(exit).toEqual(Exit.succeed({ _tag: "NoCheckCommand", check: "setup" }))
    expect(existsSync(wt.outputFile)).toBe(false)
  })

  test("a check whose output file can't be written fails with CheckNotRun", async () => {
    const wt = worktree("")
    const outputFile = join(wt.cwd, "no-such-folder", "check.log")
    const error = failure(
      await runExit({ fast: "true" }, (checks) => checks.fast({ ...wt, outputFile })),
    )
    expect(error).toBeInstanceOf(CheckNotRun)
    expect(error).toMatchObject({ check: "fast", command: "true" })
  })
})

const encode = (text: string) => new TextEncoder().encode(text)

/** What CheckOutput says of `text`, printed on stdout in one chunk. */
const said = (text: string) => {
  const output = new CheckOutput()
  output.write(encode(text))
  output.end()
  return output.summary()
}

describe("CheckOutput", () => {
  test("picks the lines that say what failed as orchestra does", () => {
    const lines = [
      "ok  	example.com/a	0.1s",
      "FAIL	example.com/b [build failed]",
      "FAIL",
      "=== FAIL: b TestX (0.00s)",
      "WARNING: DATA RACE",
      "panic: test timed out after 10m0s",
      "running tests:",
      "	TestSlow (10m0s)",
      "",
      "	TestNotSaid",
      "Error: something broke",
      "fatal: not a git repository",
      'level=error msg="lint failed"',
      "DONE 12 tests, 2 failures in 1.2s",
      "3 issues:",
      "b/b.go:4:2: undefined: y",
      "  indented.go:1: a test's own message",
      "note: nothing failed here",
    ]
    expect(said(lines.join("\n")).failingLines).toEqual([
      "FAIL	example.com/b [build failed]",
      "=== FAIL: b TestX (0.00s)",
      "WARNING: DATA RACE",
      "panic: test timed out after 10m0s",
      "running tests:",
      "TestSlow (10m0s)",
      "Error: something broke",
      "fatal: not a git repository",
      'level=error msg="lint failed"',
      "DONE 12 tests, 2 failures in 1.2s",
      "3 issues:",
      "b/b.go:4:2: undefined: y",
    ])
  })

  test("says at most maxSaid lines, the last saying how many more there were", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `error: problem ${i}`)
    const failing = said(lines.join("\n")).failingLines
    expect(failing).toHaveLength(OutputBounds.maxSaid)
    expect(failing[OutputBounds.maxSaid - 2]).toBe("error: problem 28")
    expect(failing[OutputBounds.maxSaid - 1]).toBe("(… and 11 more lines like these)")
  })

  test("cuts long lines, in memory and in what is said", () => {
    const long = `error: ${"x".repeat(OutputBounds.maxLineBytes * 2)}`
    const { failingLines, lastLines } = said(`${long}\nnext\n`)
    expect(failingLines).toEqual([`error: ${"x".repeat(OutputBounds.saidWidth - 8)}…`])
    expect(lastLines).toHaveLength(2)
    expect(lastLines[1]).toBe("next")
  })

  test("keeps the last lines, but not blank lines at the end, and drops carriage returns", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    const { lastLines } = said(`${lines.join("\r\n")}\r\n\n\n`)
    expect(lastLines).toHaveLength(OutputBounds.keptLines)
    expect(lastLines.at(-1)).toBe("line 49\r")
    expect(said("\n\n  \n").lastLines).toEqual([])
    expect(said("SUITE: unit\r\n").suite).toBe("unit")
  })

  test("counts every FLAKY: line, keeping the first maxFlaky", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `FLAKY: test ${i}`)
    const { flaky, flakyCount } = said(lines.join("\n"))
    expect(flakyCount).toBe(60)
    expect(flaky).toHaveLength(OutputBounds.maxFlaky)
    expect(flaky[0]).toBe("test 0")
  })

  test("names each suite once, in the order they started, and the one it ended in", () => {
    const { suites, suite } = said("SUITE: a\nSUITE: b\nSUITE: a\nSUITE:\n")
    expect(suites).toEqual(["a", "b"])
    expect(suite).toBe("a")
  })

  test("keeps stdout's and stderr's lines apart while each is being printed", () => {
    const output = new CheckOutput()
    output.write(encode("SUITE: "), "stdout")
    output.write(encode("error: on stderr\n"), "stderr")
    output.write(encode("unit\n"), "stdout")
    output.end()
    expect(output.summary()).toMatchObject({
      failingLines: ["error: on stderr"],
      suites: ["unit"],
    })
  })

  test("says the same of an output however it is cut into chunks", () => {
    const line = fc.oneof(
      fc.string(),
      fc.constantFrom("", "FLAKY: a test", "SUITE: unit", "--- FAIL: TestX", "error: bad", "é€"),
    )
    fc.assert(
      fc.property(fc.array(line), fc.array(fc.nat()), (lines, cuts) => {
        const bytes = encode(lines.join("\n"))
        const output = new CheckOutput()
        let start = 0
        for (const cut of cuts) {
          const end = Math.min(bytes.length, start + (cut % 7))
          output.write(bytes.subarray(start, end))
          start = end
        }
        output.write(bytes.subarray(start))
        output.end()
        expect(output.summary()).toEqual(said(lines.join("\n")))
      }),
    )
  })

  test("never says more than its bounds, whatever is printed", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: "binary" }), { maxLength: 200 }), (lines) => {
        const s = said(lines.join("\n"))
        expect(s.failingLines.length).toBeLessThanOrEqual(OutputBounds.maxSaid)
        expect(s.lastLines.length).toBeLessThanOrEqual(OutputBounds.keptLines)
        expect(s.flaky.length).toBeLessThanOrEqual(OutputBounds.maxFlaky)
        for (const l of [...s.failingLines, ...s.lastLines]) {
          expect(Array.from(l).length).toBeLessThanOrEqual(OutputBounds.saidWidth)
        }
      }),
    )
  })
})

describe("boundLines", () => {
  test("keeps the first lines and says how many more there were", () => {
    expect(boundLines(["a", "b", "c", "d"], 3)).toEqual([
      "a",
      "b",
      "(… and 2 more lines like these)",
    ])
    expect(boundLines(["a", "b"], 3)).toEqual(["a", "b"])
  })
})

describe("the test layer", () => {
  test("plays each kind's script in order, then passes, recording every run", async () => {
    const runs: Array<TestChecks.CheckRun> = []
    const failed = new CheckFailed({
      check: "fast",
      command: "scripted",
      exitCode: 1,
      outputFile: "/wt/.tutti/run/check.log",
      failingLines: ["error: bad"],
      lastLines: ["error: bad"],
      suites: ["unit"],
      suite: "unit",
      flaky: [],
      flakyCount: 0,
    })
    const settings = TestAppConfig.appConfig().settings
    const config = TestAppConfig.appConfig({
      settings: {
        ...settings,
        checks: { ...settings.checks, setup: { command: "bun i", files: [] } },
      },
    })
    const layer = TestChecks.layer(
      { fast: [failed, TestChecks.passed("fast", { flaky: ["t"], flakyCount: 1 })] },
      runs,
    ).pipe(Layer.provide(TestAppConfig.layer(config)))
    const wt = { cwd: "/wt", outputFile: "/wt/.tutti/run/check.log" }
    const exits = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const checks = yield* Checks
          return [
            yield* Effect.exit(checks.fast(wt)),
            yield* Effect.exit(checks.fast(wt)),
            yield* Effect.exit(checks.fast(wt)),
            yield* Effect.exit(checks.setup({ ...wt, before: "full" })),
          ]
        }),
        layer,
      ),
    )
    expect(failure(exits[0] as Exit.Exit<unknown, unknown>)).toBe(failed)
    expect(exits[1]).toEqual(
      Exit.succeed(TestChecks.passed("fast", { flaky: ["t"], flakyCount: 1 })),
    )
    expect(exits[2]).toEqual(Exit.succeed(TestChecks.passed("fast")))
    expect(exits[3]).toEqual(Exit.succeed(TestChecks.passed("setup")))
    expect(runs.map((run) => [run.check, run.before])).toEqual([
      ["fast", undefined],
      ["fast", undefined],
      ["fast", undefined],
      ["setup", "full"],
    ])
  })
})
