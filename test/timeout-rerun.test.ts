import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import fc from "fast-check"
import {
  betweenTestErrors,
  parseJUnit,
  stackFiles,
  type TestCase,
  timeoutLeftovers,
} from "../scripts/test.ts"

// The runner tests start two or three bun processes each, and their fixtures wait out time limits.
setDefaultTimeout(30_000)

// What bun test prints for a test that timed out and then failed an expect (Bun 1.4.3).
const leftover = (path: string): string => `t.test.ts:
(fail) group > slow [101.06ms]
  ^ this test timed out after 100ms.

# Unhandled error between tests
-------------------------------
4 |     await new Promise((r) => setTimeout(r, 300))
5 |     expect(1).toBe(2)
                  ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at check (/w/src/helper.ts:2:40)
      at <anonymous> (${path}:5:15)
-------------------------------


 2 pass
 1 fail
 1 error
`

const timedOut: TestCase = { file: "t.test.ts", name: "group slow", failed: true, timedOut: true }
const failedOnly: TestCase = { ...timedOut, timedOut: false }

describe("parseJUnit", () => {
  test("marks a test that timed out", () => {
    const report = `<testsuites>
  <testsuite name="t.test.ts" file="t.test.ts">
    <testcase name="slow" file="t.test.ts"><failure type="TimeoutError" message="test timed out" /></testcase>
    <testcase name="wrong" file="t.test.ts"><failure type="AssertionError" message="no" /></testcase>
  </testsuite>
</testsuites>`
    expect(parseJUnit(report)).toEqual([
      { file: "t.test.ts", name: "slow", failed: true, timedOut: true },
      { file: "t.test.ts", name: "wrong", failed: true, timedOut: false },
    ])
  })
})

describe("betweenTestErrors and stackFiles", () => {
  test("read each error between tests and the files of its frames", () => {
    const blocks = betweenTestErrors(`\u001b[0m${leftover("/w/t.test.ts")}`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain("error: expect(received).toBe(expected)")
    expect(blocks[0]).not.toContain(" 1 error")
    expect(stackFiles(blocks[0] ?? "")).toEqual(["/w/src/helper.ts", "/w/t.test.ts"])
    expect(stackFiles("    at /a b/c.ts:1:2\n  at f (/x (y)/z.ts:3:4)\nat nothing")).toEqual([
      "/a b/c.ts",
      "/x (y)/z.ts",
    ])
  })

  test("read nothing from output without one", () => {
    expect(betweenTestErrors(" 1 pass\n 0 fail\n")).toEqual([])
  })

  test("never throw, whatever the output", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        for (const block of betweenTestErrors(text)) stackFiles(block)
      }),
    )
  })
})

describe("timeoutLeftovers", () => {
  test("forgives an error between tests from a timed-out test's file", () => {
    expect(timeoutLeftovers(leftover("/w/t.test.ts"), 1, [timedOut], "/w")).toBe(true)
  })

  test("forgives nothing when no test was counted with an error", () => {
    expect(timeoutLeftovers(" 1 fail\n", 0, [failedOnly], "/w")).toBe(true)
  })

  test("doesn't forgive an error from a file with no timed-out test", () => {
    expect(timeoutLeftovers(leftover("/w/t.test.ts"), 1, [failedOnly], "/w")).toBe(false)
    expect(timeoutLeftovers(leftover("/w/other.test.ts"), 1, [timedOut], "/w")).toBe(false)
    expect(timeoutLeftovers(leftover("/elsewhere/t.test.ts"), 1, [timedOut], "/w")).toBe(false)
  })

  test("doesn't forgive errors it didn't read, nor one without a stack", () => {
    expect(timeoutLeftovers(leftover("/w/t.test.ts"), 2, [timedOut], "/w")).toBe(false)
    expect(timeoutLeftovers(" 1 error\n", 1, [timedOut], "/w")).toBe(false)
    const bare = "# Unhandled error between tests\n-----\nerror: boom\n-----\n"
    expect(timeoutLeftovers(bare, 1, [timedOut], "/w")).toBe(false)
  })

  test("doesn't forgive an error count the output doesn't match", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 5 }), (text, extra) => {
        const errors = betweenTestErrors(text).length + extra
        expect(timeoutLeftovers(text, errors, [timedOut], "/w")).toBe(false)
      }),
    )
  })
})

describe("scripts/test.ts on a timed-out test", () => {
  const runner = resolve(import.meta.dir, "../scripts/test.ts")

  const run = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-timeout-"))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    const proc = Bun.spawnSync(["bun", runner], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
  }

  // The next test, which runs until a timed-out test's late expect has failed: the test writes
  // `late` just before it fails it.
  const untilLate = `test("after", async () => {
  while (!existsSync("late")) await new Promise((r) => setTimeout(r, 10))
})
`

  // Runs past its time limit the first time it runs in its folder, failing an expect after bun has
  // moved on to the next test, so bun counts an error between tests; passes at once after.
  const timesOutOnce = `import { existsSync, rmSync, writeFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
describe("group", () => {
  test("slow", async () => {
    rmSync("late", { force: true })
    const seen = existsSync("seen")
    writeFileSync("seen", "")
    if (seen) return
    await new Promise((r) => setTimeout(r, 600))
    writeFileSync("late", "")
    expect(seen).toBe(true)
  }, 200)
})
${untilLate}`

  // Runs past its time limit on every run, failing an expect after.
  const timesOutAlways = `import { existsSync, rmSync, writeFileSync } from "node:fs"
import { expect, test } from "bun:test"
test("slow", async () => {
  rmSync("late", { force: true })
  await new Promise((r) => setTimeout(r, 600))
  writeFileSync("late", "")
  expect(1).toBe(2)
}, 200)
${untilLate}`

  // A test that passes, but leaves a timer that throws while the file's afterAll runs, until it
  // has: an error between tests from a file with no test that timed out.
  const strayError = `import { existsSync, writeFileSync } from "node:fs"
import { afterAll, test } from "bun:test"
test("leaves a timer", () => {
  setTimeout(() => {
    writeFileSync("stray", "")
    throw new Error("stray")
  }, 100)
})
afterAll(async () => {
  while (!existsSync("stray")) await new Promise((r) => setTimeout(r, 10))
})
`

  // Fails the first time it runs in its folder and passes after, without timing out.
  const flaky = `import { existsSync, writeFileSync } from "node:fs"
import { expect, test } from "bun:test"
test("flips", () => {
  const seen = existsSync("seen-flips")
  writeFileSync("seen-flips", "")
  expect(seen).toBe(true)
})
`

  test("reruns a test that timed out and threw between tests, FLAKY when it passes", () => {
    const { code, out, err } = run({ "t.test.ts": timesOutOnce })
    expect(err).toContain("# Unhandled error between tests")
    expect(out).toContain("Rerunning t.test.ts group slow")
    expect(out).toContain("FLAKY: t.test.ts group slow")
    expect(code).toBe(0)
  })

  test("fails when the timed-out test fails its rerun too", () => {
    const { code, out } = run({ "t.test.ts": timesOutAlways })
    expect(out).toContain("Rerunning t.test.ts slow")
    expect(out).not.toContain("FLAKY:")
    expect(code).toBe(1)
  })

  test("fails without reruns on an error between tests from a file with no timed-out test", () => {
    const { code, out, err } = run({ "f.test.ts": flaky, "g.test.ts": strayError })
    expect(err).toContain("# Unhandled error between tests")
    expect(out).not.toContain("Rerunning")
    expect(out).not.toContain("FLAKY:")
    expect(code).not.toBe(0)
  })

  test("fails without reruns when such an error comes beside a timed-out test's", () => {
    const { code, out, err } = run({ "t.test.ts": timesOutOnce, "g.test.ts": strayError })
    expect(err).toContain("# Unhandled error between tests")
    expect(out).not.toContain("Rerunning")
    expect(code).not.toBe(0)
  })
})
