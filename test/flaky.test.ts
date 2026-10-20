import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  exactNamePattern,
  flakyLine,
  parseJUnit,
  summaryCounts,
  unescapeXml,
} from "../scripts/test.ts"

// The scripts/test.ts tests run the runner on files of their own: each starts two or three bun
// processes, about 1-3 s on an idle machine, which bun's 5 s default fails when other checks run
// beside this one.
setDefaultTimeout(30_000)

// A report as bun test --reporter=junit writes it (Bun 1.4.3): one testsuite per file, a nested
// testsuite per describe block.
const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="4" failures="2" skipped="0" time="0.06">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="2" failures="1" time="0.01">
    <testcase name="passes" classname="" time="0.0001" file="test/a.test.ts" line="3" assertions="1" />
    <testcase name="fails &gt; sometimes" classname="" time="0.0001" file="test/a.test.ts" line="4" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;">AssertionError: &lt;testcase name="no"&gt;</failure>
    </testcase>
  </testsuite>
  <testsuite name="test/b.test.ts" file="test/b.test.ts" tests="2" failures="1" time="0.04">
    <testsuite name="outer &lt;a&amp;b&gt;" file="test/b.test.ts" line="2" tests="2" failures="1" time="0">
      <testsuite name="inner" file="test/b.test.ts" line="3" tests="1" failures="1" time="0.01">
        <testcase name="x &quot;q&quot; (y)" classname="inner &gt; outer" time="0.01" file="test/b.test.ts" line="4" assertions="1">
          <failure type="AssertionError" message="boom">boom</failure>
        </testcase>
      </testsuite>
      <testcase name="skipped" classname="outer" time="0" file="test/b.test.ts" line="6" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`

describe("parseJUnit", () => {
  test("reads every test case with its file, full name and outcome", () => {
    expect(parseJUnit(report)).toEqual([
      { file: "test/a.test.ts", name: "passes", failed: false },
      { file: "test/a.test.ts", name: "fails > sometimes", failed: true },
      { file: "test/b.test.ts", name: 'outer <a&b> inner x "q" (y)', failed: true },
      { file: "test/b.test.ts", name: "outer <a&b> skipped", failed: false },
    ])
  })

  test("reads nothing from an empty or broken report", () => {
    expect(parseJUnit("")).toEqual([])
    expect(parseJUnit("not xml")).toEqual([])
  })

  test("unescapes entities and character references", () => {
    expect(unescapeXml("&lt;&amp;&gt;&quot;&apos;&#10;&#x41;&nope;")).toBe("<&>\"'\nA&nope;")
  })
})

describe("exactNamePattern", () => {
  test("matches exactly the name, special characters included", () => {
    const name = 'outer <a&b> inner x "q" (y) [1+1=2?] a.b $5 ^ | \\ {3}'
    const pattern = new RegExp(exactNamePattern(name))
    expect(pattern.test(name)).toBe(true)
    expect(pattern.test(`${name} more`)).toBe(false)
    expect(pattern.test(`before ${name}`)).toBe(false)
  })
})

test("flakyLine names the file and the test", () => {
  expect(flakyLine({ file: "test/a.test.ts", name: "outer inner", failed: true })).toBe(
    "FLAKY: test/a.test.ts outer inner",
  )
})

describe("summaryCounts", () => {
  test("reads the fail and error counts from bun test's summary", () => {
    const output = "a.test.ts:\n(fail) x\n\n 3 pass\n 2 fail\n 1 error\n 5 expect() calls\n"
    expect(summaryCounts(output)).toEqual({ fail: 2, error: 1 })
  })

  test("reads coloured output, and zero when a count is missing", () => {
    expect(summaryCounts("\u001b[0m\u001b[31m 4 fail\u001b[0m\n")).toEqual({ fail: 4, error: 0 })
    expect(summaryCounts(" 2 errors\n")).toEqual({ fail: 0, error: 2 })
  })
})

describe("scripts/test.ts", () => {
  const runner = resolve(import.meta.dir, "../scripts/test.ts")

  const run = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-flaky-"))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    const proc = Bun.spawnSync(["bun", runner], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    return { code: proc.exitCode, out: proc.stdout.toString() }
  }

  // Fails the first time it runs in its folder and passes after, as a flaky test would.
  const flaky = `import { existsSync, writeFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
describe("group (1)", () => {
  test("flips", () => {
    const seen = existsSync("seen")
    writeFileSync("seen", "")
    expect(seen).toBe(true)
  })
})
test("steady", () => expect(1).toBe(1))
`

  test("prints FLAKY for a test that passes only on its rerun, and exits 0", () => {
    const { code, out } = run({ "f.test.ts": flaky })
    expect(out).toContain("FLAKY: f.test.ts group (1) flips")
    expect(code).toBe(0)
  })

  test("fails on a test that fails twice, without a FLAKY line", () => {
    const { code, out } = run({
      "f.test.ts": `import { expect, test } from "bun:test"\ntest("broken", () => expect(1).toBe(2))\n`,
    })
    expect(out).not.toContain("FLAKY:")
    expect(code).toBe(1)
  })

  test("fails on a file that doesn't load, even when another test is flaky", () => {
    const { code, out } = run({
      "f.test.ts": flaky,
      "g.test.ts": `throw new Error("does not load")\n`,
    })
    expect(out).not.toContain("FLAKY:")
    expect(code).not.toBe(0)
  })

  test("exits 0 without reruns when every test passes", () => {
    const { code, out } = run({
      "f.test.ts": `import { expect, test } from "bun:test"\ntest("fine", () => expect(1).toBe(1))\n`,
    })
    expect(out).not.toContain("Rerunning")
    expect(code).toBe(0)
  })
})
