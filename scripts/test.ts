// scripts/test.ts: the test runner behind scripts/test.sh (§ 13).
//
// Bun's --retry retries a failed test, but neither its console output nor its JUnit report says
// which tests passed only on their retry (checked with Bun 1.4.3). So this follows § 13's fallback:
// run the suites once without --retry, rerun each failed test once by name (-t), and print
// FLAKY: <file> <test> for each that passes on its rerun. A flaky test does not fail the run; a test
// that fails twice does. Arguments are passed on to bun test.
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface TestCase {
  /** The test file, relative to the folder bun test ran in. */
  readonly file: string
  /** The full name bun test's -t matches: the describe blocks and the test, joined by spaces. */
  readonly name: string
  readonly failed: boolean
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

export const unescapeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16))
    if (ref.startsWith("#")) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10))
    return entities[ref] ?? whole
  })

const attribute = (attrs: string, key: string): string | undefined => {
  const match = new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(attrs)
  return match?.[1] === undefined ? undefined : unescapeXml(match[1])
}

/**
 * Reads the test cases out of a JUnit report written by bun test --reporter=junit. Each file is a
 * top-level testsuite; describe blocks are testsuites nested in it.
 */
export const parseJUnit = (xml: string): ReadonlyArray<TestCase> => {
  const cases: Array<TestCase> = []
  const suites: Array<{ readonly name: string; readonly file: string }> = []
  let open: { file: string; name: string; failed: boolean } | undefined
  const tags = /<(\/?)(testsuites|testsuite|testcase|failure|error)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g
  for (const [, closing, tag, attrs = "", selfClosing] of xml.matchAll(tags)) {
    if (tag === "testsuite") {
      if (closing) suites.pop()
      else if (!selfClosing) {
        suites.push({ name: attribute(attrs, "name") ?? "", file: attribute(attrs, "file") ?? "" })
      }
    } else if (tag === "testcase") {
      if (closing) {
        if (open) cases.push(open)
        open = undefined
        continue
      }
      const describes = suites.slice(1).map((suite) => suite.name)
      const test = {
        file: attribute(attrs, "file") ?? suites[0]?.file ?? "",
        name: [...describes, attribute(attrs, "name") ?? ""].join(" "),
        failed: false,
      }
      if (selfClosing) cases.push(test)
      else open = test
    } else if ((tag === "failure" || tag === "error") && !closing && open) {
      open.failed = true
    }
  }
  return cases
}

/** A -t pattern that matches exactly the test with this full name. */
export const exactNamePattern = (name: string): string =>
  `^${name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`

export const flakyLine = (test: TestCase): string => `FLAKY: ${test.file} ${test.name}`

const fileArgument = (file: string): string =>
  file.startsWith("/") || file.startsWith("./") ? file : `./${file}`

const runBunTest = (args: ReadonlyArray<string>, report: string): number =>
  Bun.spawnSync(["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
  }).exitCode

const readReport = (report: string): ReadonlyArray<TestCase> => {
  try {
    return parseJUnit(readFileSync(report, "utf8"))
  } catch {
    return []
  }
}

const main = (args: ReadonlyArray<string>): number => {
  const reports = mkdtempSync(join(tmpdir(), "tutti-test-"))
  const first = join(reports, "first.xml")
  const code = runBunTest(args, first)
  if (code === 0) return 0
  const failed = readReport(first).filter((test) => test.failed)
  // A failure outside any test (a file that doesn't load, an error between tests) has no name to
  // rerun: the run fails as bun test did.
  if (failed.length === 0) return code
  let stillFailing = 0
  failed.forEach((test, index) => {
    const report = join(reports, `rerun-${index}.xml`)
    console.log(`\nRerunning ${test.file} ${test.name}`)
    const rerunCode = runBunTest(
      [fileArgument(test.file), "--test-name-pattern", exactNamePattern(test.name)],
      report,
    )
    const reran = readReport(report)
    if (rerunCode === 0 && reran.length > 0 && reran.every((t) => !t.failed)) {
      console.log(flakyLine(test))
    } else {
      stillFailing++
    }
  })
  return stillFailing === 0 ? 0 : 1
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)))
}
