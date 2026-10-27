// scripts/test.ts reruns a file's failed tests together, in one bun test, and the files side by
// side, as many at a time as the run's share of the cores (tutti-0vbd.4).
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import fc from "fast-check"
import {
  exactNamesPattern,
  inPool,
  passedOnRerun,
  rerunGroups,
  type TestCase,
} from "../scripts/test.ts"
import { testEnv } from "./env.ts"

// The runner tests start several bun processes each, and wait for reruns to overlap.
setDefaultTimeout(60_000)

const failure = (file: string, name: string): TestCase => ({
  file,
  name,
  failed: true,
  timedOut: false,
  skipped: false,
})

describe("exactNamesPattern", () => {
  test("matches exactly each name, special characters included, and no other", () => {
    const names = ['outer <a&b> x "q" (y)', "[1+1=2?] a.b $5 ^ | \\ {3}", "plain"]
    const pattern = new RegExp(exactNamesPattern(names))
    for (const name of names) {
      expect(pattern.test(name)).toBe(true)
      expect(pattern.test(`${name} more`)).toBe(false)
      expect(pattern.test(`before ${name}`)).toBe(false)
    }
    expect(pattern.test("plain|[1+1=2?] a.b $5 ^ | \\ {3}")).toBe(false)
  })

  test("matches each of any names exactly", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
        fc.string(),
        (names, other) => {
          const pattern = new RegExp(exactNamesPattern(names))
          for (const name of names) expect(pattern.test(name)).toBe(true)
          expect(pattern.test(other)).toBe(names.includes(other))
        },
      ),
    )
  })
})

describe("rerunGroups", () => {
  test("groups the failures by file, in the order the files' first failures came", () => {
    const failed = [
      failure("b.test.ts", "one"),
      failure("a.test.ts", "two"),
      failure("b.test.ts", "three"),
    ]
    expect(rerunGroups(failed)).toEqual([
      { file: "b.test.ts", tests: [failed[0], failed[2]] as Array<TestCase> },
      { file: "a.test.ts", tests: [failed[1]] as Array<TestCase> },
    ])
  })
})

describe("passedOnRerun", () => {
  const one = failure("t.test.ts", "one")
  const two = failure("t.test.ts", "two")
  const group = { file: "t.test.ts", tests: [one, two] }
  const ran = (test: TestCase, failed: boolean, skipped = false): TestCase => ({
    ...test,
    failed,
    skipped,
  })

  test("passes each test that ran and passed, though another failed again", () => {
    expect(passedOnRerun(group, 0, " 2 pass\n", [ran(one, false), ran(two, false)], "/w")).toEqual([
      one,
      two,
    ])
    expect(
      passedOnRerun(group, 1, " 1 pass\n 1 fail\n", [ran(one, false), ran(two, true)], "/w"),
    ).toEqual([one])
  })

  test("passes no test that was filtered out or missing from the report", () => {
    expect(passedOnRerun(group, 0, "", [ran(one, false, true), ran(two, false)], "/w")).toEqual([
      two,
    ])
    expect(passedOnRerun(group, 1, "", [], "/w")).toEqual([])
  })

  test("passes none when the rerun failed outside its tests", () => {
    expect(
      passedOnRerun(group, 1, " 2 pass\n 1 error\n", [ran(one, false), ran(two, false)], "/w"),
    ).toEqual([])
    expect(
      passedOnRerun(group, 1, " 1 pass\n 2 fail\n", [ran(one, false), ran(two, true)], "/w"),
    ).toEqual([])
  })
})

describe("inPool", () => {
  test("runs no more than its limit at a time, and gives the results in order", async () => {
    let running = 0
    let most = 0
    const tasks = [30, 5, 20, 1, 10].map((ms, index) => async () => {
      running++
      most = Math.max(most, running)
      await Bun.sleep(ms)
      running--
      return index
    })
    expect(await Promise.all(inPool(tasks, 2))).toEqual([0, 1, 2, 3, 4])
    expect(most).toBe(2)
  })
})

describe("scripts/test.ts reruns", () => {
  const runner = resolve(import.meta.dir, "../scripts/test.ts")

  const run = (files: Record<string, string>, cores?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-rerun-together-"))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(testEnv)) {
      if (value !== undefined && name !== "TUTTI_TEST_PARALLEL") env[name] = value
    }
    if (cores !== undefined) env.TUTTI_CORES = cores
    const proc = Bun.spawnSync(["bun", runner], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
    return { dir, code: proc.exitCode, out: proc.stdout.toString() }
  }

  // A test that fails the first time it runs in its folder and passes after, writing the ID of the
  // process it ran in on each run to pids-<id>.
  const flips = (id: string) => `test("flips ${id}", () => {
  appendFileSync("pids-${id}", \`\${process.pid}\\n\`)
  const seen = existsSync("seen-${id}")
  writeFileSync("seen-${id}", "")
  expect(seen).toBe(true)
})
`
  const imports = `import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { expect, test } from "bun:test"
`

  test("reruns two failing tests of a file in one process, both FLAKY when they pass", () => {
    const { dir, code, out } = run({
      "f.test.ts": `${imports}${flips("a")}${flips("b")}test("steady", () => expect(1).toBe(1))\n`,
    })
    const pids = (id: string) =>
      readFileSync(join(dir, `pids-${id}`), "utf8")
        .trim()
        .split("\n")
    expect(pids("a")).toHaveLength(2)
    expect(pids("b")).toHaveLength(2)
    expect(pids("a")[1]).toBe(pids("b")[1] ?? "")
    const lines = out.split("\n").filter((line) => /^(Rerunning|FLAKY:) /.test(line))
    expect(lines).toEqual([
      "Rerunning f.test.ts flips a",
      "Rerunning f.test.ts flips b",
      "FLAKY: f.test.ts flips a",
      "FLAKY: f.test.ts flips b",
    ])
    expect(code).toBe(0)
  })

  test("fails when one of a file's tests fails its rerun too, the other FLAKY", () => {
    const { code, out } = run({
      "f.test.ts": `${imports}${flips("a")}test("broken", () => expect(1).toBe(2))\n`,
    })
    expect(out).toContain("Rerunning f.test.ts broken")
    expect(out.match(/^FLAKY: .*$/gm)).toEqual(["FLAKY: f.test.ts flips a"])
    expect(code).toBe(1)
  })

  // A test that fails at once on its first run, and on its rerun marks itself active and waits, up
  // to 10 s, for another rerun to be active beside it, writing the most it saw active to most-<id>.
  // Once two have met, a rerun that starts later stops waiting at once.
  const overlaps = (id: string) => `${imports}test("overlaps ${id}", async () => {
  if (!existsSync("seen-${id}")) {
    writeFileSync("seen-${id}", "")
    expect(1).toBe(2)
  }
  mkdirSync("active", { recursive: true })
  writeFileSync("active/${id}", "")
  const start = Date.now()
  let most = 0
  while (Date.now() - start < 10_000) {
    most = Math.max(most, readdirSync("active").length)
    if (most >= 2) writeFileSync("met", "")
    if ((most >= 2 && Date.now() - start >= 300) || existsSync("met")) break
    await new Promise((r) => setTimeout(r, 20))
  }
  rmSync("active/${id}")
  writeFileSync("most-${id}", String(most))
}, 20_000)
`

  test("reruns the failures of three files side by side, no more at once than the share", () => {
    const { dir, code, out } = run(
      { "a.test.ts": overlaps("a"), "b.test.ts": overlaps("b"), "c.test.ts": overlaps("c") },
      "2",
    )
    const most = readdirSync(dir)
      .filter((name) => name.startsWith("most-"))
      .map((name) => Number(readFileSync(join(dir, name), "utf8")))
    expect(most).toHaveLength(3)
    expect(Math.max(...most)).toBe(2)
    // Each rerun's lines together, the files in the order bun's report gave their failures.
    const lines = out.split("\n").filter((line) => /^(Rerunning|FLAKY:) /.test(line))
    const files = lines.filter((_, index) => index % 2 === 0).map((line) => line.split(" ")[1])
    expect([...files].sort()).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"])
    expect(lines).toEqual(
      files.flatMap((file) => {
        const id = file?.charAt(0)
        return [`Rerunning ${file} overlaps ${id}`, `FLAKY: ${file} overlaps ${id}`]
      }),
    )
    expect(code).toBe(0)
  })
})
