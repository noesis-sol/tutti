// scripts/check-own.sh after a run whose tests failed (tutti-0vbd.2): it keeps, at that run's tree,
// the test files whose tests all passed in it, which scripts/test.ts writes down
// (TUTTI_CHECK_OWN_PASSED), and the earlier pass's that it left out (check-own.ts' afterFailure). The
// script runs in a real git repository of its own, its steps stubbed as in
// test/check-own-pass.test.ts, scripts/test.sh failing the files named in a file beside the repo.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import fc from "fast-check"
import { afterFailure, type PassRecord, readRecord, recordFile } from "../scripts/check-own.ts"
import { passedFiles, type TestCase } from "../scripts/test.ts"
import { testEnv, which } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// The runner test starts bun test three times, and the scripts several bun and git each.
setDefaultTimeout(60_000)

const tree = "a".repeat(40)
const record = (tests: ReadonlyArray<string>): PassRecord => ({ tree, mode: "plain", tests })

describe("afterFailure", () => {
  test("keeps the tests left out and those that ran and passed, not those that failed", () => {
    const next = record(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"])
    const unrun = record(["test/a.test.ts"])
    expect(afterFailure(next, unrun, ["test/c.test.ts"])).toEqual({
      kept: record(["test/a.test.ts", "test/c.test.ts"]),
      failed: ["test/b.test.ts", "test/d.test.ts"],
    })
  })

  test("parts the run's tests into kept and failed, and never keeps one that ran and failed", () => {
    const all = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"]
    const tests = fc.subarray(all)
    fc.assert(
      fc.property(tests, tests, tests, (selected, left, passed) => {
        const unrun = selected.filter((test) => left.includes(test))
        const { kept, failed } = afterFailure(record(selected), record(unrun), passed)
        expect([...kept.tests, ...failed].sort()).toEqual(selected)
        for (const test of kept.tests)
          expect(unrun.includes(test) || passed.includes(test)).toBe(true)
        for (const test of failed) expect(passed.includes(test) || unrun.includes(test)).toBe(false)
        expect(kept.tree).toBe(tree)
      }),
    )
  })
})

const testCase = (file: string, name: string, failed = false): TestCase => ({
  file,
  name,
  failed,
  timedOut: false,
  skipped: false,
})

describe("passedFiles", () => {
  test("names the files of the report with no test still failing, sorted, once each", () => {
    const flaky = testCase("b.test.ts", "flips", true)
    const broken = testCase("c.test.ts", "broken", true)
    const cases = [
      testCase("b.test.ts", "steady"),
      flaky,
      testCase("a.test.ts", "one"),
      testCase("a.test.ts", "two"),
      testCase("c.test.ts", "fine"),
      broken,
    ]
    expect(passedFiles(cases, [broken])).toEqual(["a.test.ts", "b.test.ts"])
    expect(passedFiles(cases, [flaky, broken])).toEqual(["a.test.ts"])
    expect(passedFiles([], [])).toEqual([])
  })
})

describe("scripts/test.ts with TUTTI_CHECK_OWN_PASSED", () => {
  const ok = 'import { expect, test } from "bun:test"\ntest("ok", () => expect(1).toBe(1))\n'
  const run = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-passed-"))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    const out = join(dir, "passed")
    const proc = Bun.spawnSync(["bun", resolve(import.meta.dir, "../scripts/test.ts")], {
      cwd: dir,
      env: { ...testEnv, TUTTI_CHECK_OWN_PASSED: out },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: proc.exitCode, passed: readFileSync(out, "utf8").split("\n") }
  }

  test("writes the files whose tests all passed, a flaky one's included, not a failed one's", () => {
    const { code, passed } = run({
      "ok.test.ts": ok,
      "broken.test.ts": `import { expect, test } from "bun:test"
test("fine", () => expect(1).toBe(1))
test("broken", () => expect(1).toBe(2))
`,
      // Fails the first time it runs in its folder and passes on its rerun.
      "flaky.test.ts": `import { existsSync, writeFileSync } from "node:fs"
import { expect, test } from "bun:test"
test("flips", () => {
  const seen = existsSync("seen")
  writeFileSync("seen", "")
  expect(seen).toBe(true)
})
`,
    })
    expect(code).toBe(1)
    expect(passed).toEqual(["flaky.test.ts", "ok.test.ts"])
  })

  test("leaves out a file that doesn't load, and writes every file of a run that passed", () => {
    const failed = run({
      "ok.test.ts": ok,
      "unloaded.test.ts":
        'import { test } from "bun:test"\ntest("a", () => {})\nthrow new Error("no")\n',
    })
    expect(failed.code).not.toBe(0)
    expect(failed.passed).toEqual(["ok.test.ts"])
    const passed = run({ "ok.test.ts": ok, "also.test.ts": ok })
    expect(passed.code).toBe(0)
    expect(passed.passed).toEqual(["also.test.ts", "ok.test.ts"])
  })
})

const stub = (file: string, body: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

// Prints the files it was given, writes down those not named in ../failing as passed, and fails
// when it was given one that is.
const testScript = `echo "test.sh $*"
status=0
: > "$TUTTI_CHECK_OWN_PASSED"
for file in "$@"; do
  file=\${file#./}
  if [ -f ../failing ] && grep -qxF "$file" ../failing; then status=1
  else echo "$file" >> "$TUTTI_CHECK_OWN_PASSED"; fi
done
exit "$status"`

/**
 * A repository on main with the script and stubbed steps, and a branch `work` checked out that
 * changed src/a.ts, src/b.ts and src/c.ts, so check-own picks the three tests that import them.
 */
const project = () => {
  const repo = makeRepo()
  const bin = join(repo.dir, "..", "bin")
  stub(
    join(bin, "bunx"),
    'echo "bunx $*"\nif [ "$1" = tsc ] && [ -f ../tsc-fails ]; then exit 2; fi',
  )
  mkdirSync(join(repo.dir, "scripts"))
  for (const name of ["check-own.sh", "check-own.ts"]) {
    copyFileSync(resolve(import.meta.dir, "../scripts", name), join(repo.dir, "scripts", name))
  }
  chmodSync(join(repo.dir, "scripts", "check-own.sh"), 0o755)
  stub(join(repo.dir, "scripts", "test.sh"), testScript)
  stub(join(repo.dir, "scripts", "check.sh"), 'echo "whole check"')
  stub(join(repo.dir, "scripts", "fetch-shellcheck.sh"), "exit 2")
  repo.commit("Project", {
    "package.json": "{}\n",
    "src/a.ts": "export const a = 1\n",
    "src/b.ts": "export const b = 2\n",
    "src/c.ts": "export const c = 3\n",
    "test/a.test.ts": 'import { a } from "../src/a.ts"\n',
    "test/b.test.ts": 'import { b } from "../src/b.ts"\n',
    "test/c.test.ts": 'import { c } from "../src/c.ts"\n',
  })
  repo.git(["checkout", "--quiet", "-b", "work"])
  repo.commit("Change a, b and c", {
    "src/a.ts": "export const a = 10\n",
    "src/b.ts": "export const b = 20\n",
    "src/c.ts": "export const c = 30\n",
  })
  const tools = [process.execPath, which("git") ?? "/usr/bin/git"].map((tool) => dirname(tool))
  const run = (mode: "plain" | "slow" = "plain") => {
    const proc = Bun.spawnSync([join(repo.dir, "scripts", "check-own.sh")], {
      cwd: repo.dir,
      env: {
        HOME: testEnv.HOME ?? "",
        PATH: [bin, ...tools, "/usr/bin", "/bin"].join(":"),
        ...(mode === "slow" ? { TUTTI_SLOW: "1" } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = proc.stdout.toString() + proc.stderr.toString()
    const lines = out.trimEnd().split("\n")
    return { code: proc.exitCode, out, last: lines[lines.length - 1] ?? "" }
  }
  const failing = (...tests: ReadonlyArray<string>) =>
    writeFileSync(join(repo.dir, "..", "failing"), tests.map((test) => `${test}\n`).join(""))
  const gitDir = join(repo.dir, ".git")
  const kept = (mode: PassRecord["mode"]) =>
    existsSync(recordFile(gitDir, mode))
      ? readRecord(readFileSync(recordFile(gitDir, mode), "utf8"))?.tests
      : undefined
  return { repo, run, failing, gitDir, kept }
}

describe("scripts/check-own.sh after a run whose tests failed", () => {
  slow.test(
    "keeps the others' passes, and after the fix runs that file and what it touches",
    () => {
      const { repo, run, failing, gitDir, kept } = project()
      failing("test/b.test.ts")
      const first = run()
      expect(first.out).toContain("test.sh ./test/a.test.ts ./test/b.test.ts ./test/c.test.ts\n")
      expect(first.out).toContain("check-own: kept 2 test files passed at")
      expect(first.last).toBe("scripts/check-own.sh: FAIL in test (exit 1)")
      expect(kept("plain")).toEqual(["test/a.test.ts", "test/c.test.ts"])
      for (const own of ["next", "unrun"] as const) {
        expect(existsSync(recordFile(gitDir, own))).toBe(false)
      }
      expect(existsSync(join(gitDir, "tutti-check-own-passed"))).toBe(false)

      failing()
      repo.commit("Fix b, and a with it", {
        "src/a.ts": "export const a = 11\n",
        "src/b.ts": "export const b = 21\n",
      })
      const { out, last } = run()
      expect(out).toMatch(
        /check-own: 1 test file passed at [0-9a-f]{7} and nothing since touches them; running 2\./,
      )
      expect(out).toContain("test.sh ./test/a.test.ts ./test/b.test.ts\n")
      expect(last).toBe("scripts/check-own.sh: PASS")
      expect(kept("plain")).toEqual(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"])
    },
  )

  slow.test("runs a failed test's file again though nothing since touches it", () => {
    const { repo, run, failing } = project()
    failing("test/b.test.ts")
    run()
    failing()
    repo.write({ "docs/notes.md": "notes\n" })
    const { out } = run()
    expect(out).toContain("check-own: 2 test files passed at")
    expect(out).toContain("running 1.")
    expect(out).toContain("test.sh ./test/b.test.ts\n")
  })

  slow.test("keeps the earlier pass's tests the failed run left out", () => {
    const { repo, run, failing, kept } = project()
    expect(run().last).toBe("scripts/check-own.sh: PASS")
    failing("test/b.test.ts")
    repo.commit("Change b and c", {
      "src/b.ts": "export const b = 200\n",
      "src/c.ts": "export const c = 300\n",
    })
    const failed = run()
    expect(failed.out).toContain("test.sh ./test/b.test.ts ./test/c.test.ts\n")
    expect(failed.last).toBe("scripts/check-own.sh: FAIL in test (exit 1)")
    expect(kept("plain")).toEqual(["test/a.test.ts", "test/c.test.ts"])
    failing()
    repo.commit("Fix b", { "src/b.ts": "export const b = 201\n" })
    const { out } = run()
    expect(out).toContain("check-own: 2 test files passed at")
    expect(out).toContain("test.sh ./test/b.test.ts\n")
  })

  slow.test(
    "takes a file that failed out of the slow pass too, and keeps a slow run's for both",
    () => {
      const { repo, run, failing, gitDir, kept } = project()
      expect(run("slow").last).toBe("TUTTI_SLOW=1 scripts/check-own.sh: PASS")
      // No plain pass to stand on, so the plain run runs the tests the slow pass stands for.
      rmSync(recordFile(gitDir, "plain"))
      failing("test/b.test.ts")
      expect(run().last).toBe("scripts/check-own.sh: FAIL in test (exit 1)")
      expect(kept("plain")).toEqual(["test/a.test.ts", "test/c.test.ts"])
      expect(kept("slow")).toEqual(["test/a.test.ts", "test/c.test.ts"])

      repo.write({ "docs/notes.md": "notes\n" })
      const slowRun = run("slow")
      expect(slowRun.out).toContain("test.sh ./test/b.test.ts\n")
      expect(slowRun.last).toBe("TUTTI_SLOW=1 scripts/check-own.sh: FAIL in test (exit 1)")
      expect(kept("slow")).toEqual(["test/a.test.ts", "test/c.test.ts"])
      expect(kept("plain")).toEqual(["test/a.test.ts", "test/c.test.ts"])
    },
  )

  slow.test("keeps nothing on a tsc failure, and forgets the passes kept", () => {
    const { repo, run, failing, kept } = project()
    failing("test/b.test.ts")
    run()
    expect(kept("plain")).toEqual(["test/a.test.ts", "test/c.test.ts"])
    failing()
    writeFileSync(join(repo.dir, "..", "tsc-fails"), "")
    repo.commit("Break the types", { "src/b.ts": "export const b: string = 2\n" })
    const failed = run()
    expect(failed.last).toBe("scripts/check-own.sh: FAIL in tsc (exit 2)")
    expect(failed.out).not.toContain("test.sh")
    expect(kept("plain")).toBeUndefined()
    expect(kept("slow")).toBeUndefined()
    rmSync(join(repo.dir, "..", "tsc-fails"))
    repo.write({ "docs/notes.md": "notes\n" })
    const { out } = run()
    expect(out).not.toContain("passed at")
    expect(out).toContain("test.sh ./test/a.test.ts ./test/b.test.ts ./test/c.test.ts\n")
  })
})
