// scripts/test.ts: the test runner behind scripts/test.sh (§ 13).
//
// Bun's --retry retries a failed test, but neither its console output nor its JUnit report says
// which tests passed only on their retry (Bun 1.4.3; docs/spikes/08-bun-test-retry.md). So this
// follows § 13's fallback: run the suites once without --retry, rerun each failed test once by
// name (-t), and print FLAKY: <file> <test> for each that passes on its rerun. A flaky test does
// not fail the run; a test that fails twice does. Arguments are passed on to bun test.
//
// bunfig.toml defines process.env.NODE_ENV as "production" for React's production build, and bun
// test reads it too. The suites define "test" over it, as bun test sets it, so they keep React's
// development build: @opentui/react/test-utils needs its act, which the production build lacks.
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

/** The fail and error counts in bun test's closing summary (" 2 fail", " 1 error"). */
export const summaryCounts = (
  output: string,
): { readonly fail: number; readonly error: number } => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes, ESC included
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "")
  const count = (word: string): number => {
    const matches = [...plain.matchAll(new RegExp(`^\\s*(\\d+) ${word}s?\\s*$`, "gm"))]
    return Number(matches.at(-1)?.[1] ?? 0)
  }
  return { fail: count("fail"), error: count("error") }
}

// Copies a stream of bun test's output through to ours, as it comes, and returns all of it.
const tee = async (stream: ReadableStream<Uint8Array>, to: NodeJS.WriteStream): Promise<string> => {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) {
    to.write(chunk)
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

const runBunTest = async (
  args: ReadonlyArray<string>,
  report: string,
): Promise<{ readonly code: number; readonly output: string }> => {
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      "--define",
      'process.env.NODE_ENV:"test"',
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      ...args,
    ],
    { stdin: "inherit", stdout: "pipe", stderr: "pipe" },
  )
  const [out, err, code] = await Promise.all([
    tee(proc.stdout, process.stdout),
    tee(proc.stderr, process.stderr),
    proc.exited,
  ])
  return { code, output: `${out}\n${err}` }
}

const readReport = (report: string): ReadonlyArray<TestCase> => {
  try {
    return parseJUnit(readFileSync(report, "utf8"))
  } catch {
    return []
  }
}

const main = async (args: ReadonlyArray<string>): Promise<number> => {
  const reports = mkdtempSync(join(tmpdir(), "tutti-test-"))
  const first = join(reports, "first.xml")
  const { code, output } = await runBunTest(args, first)
  if (code === 0) return 0
  const failed = readReport(first).filter((test) => test.failed)
  // A failure outside any test (a file that doesn't load, an error between tests) isn't in the
  // report and has no name to rerun: when bun counted one, the run fails as bun test did.
  const counts = summaryCounts(output)
  if (failed.length === 0 || counts.error > 0 || counts.fail !== failed.length) return code
  let stillFailing = 0
  for (const [index, test] of failed.entries()) {
    const report = join(reports, `rerun-${index}.xml`)
    console.log(`\nRerunning ${test.file} ${test.name}`)
    const rerun = await runBunTest(
      [fileArgument(test.file), "--test-name-pattern", exactNamePattern(test.name)],
      report,
    )
    const reran = readReport(report)
    if (rerun.code === 0 && reran.length > 0 && reran.every((t) => !t.failed)) {
      console.log(flakyLine(test))
    } else {
      stillFailing++
    }
  }
  return stillFailing === 0 ? 0 : 1
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)))
}
