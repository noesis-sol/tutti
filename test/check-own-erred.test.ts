// scripts/test.ts' list of the test files that passed (TUTTI_CHECK_OWN_PASSED), which
// scripts/check-own.sh keeps from a failed run, leaves out a file that raised an error between
// tests though its tests all passed (tutti-fnvd.2): bun's report has no failed test for it, and the
// next run would leave it out.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import fc from "fast-check"
import { erredFiles, passedFiles, type TestCase } from "../scripts/test.ts"
import { testEnv } from "./env.ts"

// The runner tests start bun test, and their fixtures wait on a timer.
setDefaultTimeout(30_000)

// What bun test prints for an error between tests under the heading of the file it ran in (Bun
// 1.4.3), a frame in `frame`.
const between = (heading: string, frame: string): string => `${heading}:
(pass) leaves a timer [0.03ms]

# Unhandled error between tests
-------------------------------
6 |     throw new Error("stray")
                               ^
error: stray
      at <anonymous> (${frame}:6:28)
-------------------------------
`

const folder = (files: ReadonlyArray<string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-erred-"))
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), "")
  }
  return dir
}

describe("erredFiles", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]
  const dir = folder([...files, "src/helper.ts", "test/unloaded.test.ts"])

  test("names the file an error between tests was printed under, or one of its frames", () => {
    const output = `test/a.test.ts:\n(pass) one\n\n${between("test/b.test.ts", join(dir, "src/helper.ts"))}`
    expect(erredFiles(output, 1, files, dir)).toEqual(["test/b.test.ts"])
    const framed = between("not a file", join(dir, "test/c.test.ts"))
    expect(erredFiles(framed, 1, files, dir)).toEqual(["test/c.test.ts"])
  })

  test("reads the heading bun prints under GitHub Actions, ::group::<file>:", () => {
    const output = between("::group::test/b.test.ts", join(dir, "src/helper.ts"))
    expect(erredFiles(output, 1, files, dir)).toEqual(["test/b.test.ts"])
  })

  test("takes no line of a test's output for its heading", () => {
    const output = `test/a.test.ts:\nnoise:\n${between("noise", join(dir, "src/helper.ts"))}`
    expect(erredFiles(output, 1, files, dir)).toEqual(["test/a.test.ts"])
  })

  test("names none of the report's files for a file that didn't load", () => {
    const unloaded = join(dir, "test/unloaded.test.ts")
    expect(erredFiles(between("test/unloaded.test.ts", unloaded), 1, files, dir)).toEqual([])
    expect(erredFiles(" 3 pass\n 0 fail\n", 0, files, dir)).toEqual([])
  })

  test("places nothing when an error names no file, or bun counted more than it printed", () => {
    const bare = "# Unhandled error between tests\n-----\nerror: boom\n-----\n"
    expect(erredFiles(bare, 1, files, dir)).toBeUndefined()
    const output = between("test/b.test.ts", join(dir, "test/b.test.ts"))
    expect(erredFiles(output, 2, files, dir)).toBeUndefined()
  })

  test("never throws, and names only the report's files", () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(3), (text, errors) => {
        for (const file of erredFiles(text, errors, files, dir) ?? []) expect(files).toContain(file)
      }),
    )
  })
})

const testCase = (file: string, name: string): TestCase => ({
  file,
  name,
  failed: false,
  timedOut: false,
  skipped: false,
})

describe("passedFiles", () => {
  test("leaves out the files that raised an error between tests", () => {
    const cases = [testCase("a.test.ts", "one"), testCase("b.test.ts", "two")]
    expect(passedFiles(cases, [], ["b.test.ts"])).toEqual(["a.test.ts"])
  })
})

describe("scripts/test.ts with TUTTI_CHECK_OWN_PASSED", () => {
  const ok = 'import { expect, test } from "bun:test"\ntest("ok", () => expect(1).toBe(1))\n'

  // A test that passes, but leaves a timer that throws, from `from`, while the file's afterAll
  // waits for it to write `mark`: an error between tests.
  const stray = (from: string, mark: string) => `import { existsSync } from "node:fs"
import { afterAll, test } from "bun:test"
import { later } from "${from}"
test("leaves a timer", () => later("${mark}"))
afterAll(async () => {
  while (!existsSync("${mark}")) await new Promise((r) => setTimeout(r, 10))
})
`
  const helper = `import { writeFileSync } from "node:fs"
export const later = (mark: string) =>
  setTimeout(() => {
    writeFileSync(mark, "")
    throw new Error("stray")
  }, 100)
`

  const run = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-erred-"))
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    const out = join(dir, "passed")
    const proc = Bun.spawnSync(["bun", resolve(import.meta.dir, "../scripts/test.ts")], {
      cwd: dir,
      env: { ...testEnv, TUTTI_CHECK_OWN_PASSED: out, TUTTI_TEST_PARALLEL: "2" },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: proc.exitCode, err: proc.stderr.toString(), passed: readFileSync(out, "utf8") }
  }

  test("leaves out a file whose tests passed but that raised an error between them", () => {
    const { code, err, passed } = run({
      "test/ok.test.ts": ok,
      "test/own.test.ts": stray("./own-helper.ts", "own"),
      "test/own-helper.ts": helper,
      "test/shared.test.ts": stray("../src/helper.ts", "shared"),
      "src/helper.ts": helper,
    })
    expect(err).toContain("# Unhandled error between tests")
    expect(code).not.toBe(0)
    expect(passed.split("\n")).toEqual(["test/ok.test.ts"])
  })
})
