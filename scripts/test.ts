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
//
// The suites make their temp folders under os.tmpdir() and leave them there. Thousands of entries in
// one folder slow every bun test started in a folder under it, at any depth (~1-5 s to start at
// 500k entries), so each run gets a temp folder of its own, given to bun test as TMPDIR, and removes
// it when it ends. On macOS that folder is not in $TMPDIR, the per-user folder every program on the
// machine leaves its temp files in, but in /tmp, as the SDK extracts Claude Code there
// (src/agent/claudeExtract.ts); TUTTI_TEST_TMPDIR names another. A run killed before it could
// remove its folder (SIGKILL) leaves it, named with the run's process ID: the next run removes it.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
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
  temp: string,
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
    { stdin: "inherit", stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: temp } },
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

const main = async (args: ReadonlyArray<string>, temp: string): Promise<number> => {
  const reports = mkdtempSync(join(temp, "tutti-test-reports-"))
  const first = join(reports, "first.xml")
  const { code, output } = await runBunTest(args, first, temp)
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
      temp,
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

/** The folder each run's temp folder is made in. */
export const runTempBase = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string => env.TUTTI_TEST_TMPDIR || (platform === "darwin" ? "/tmp" : tmpdir())

const runTempPrefix = "tutti-test-"

/** The process ID in the name of a run's temp folder, or undefined for any other name. */
export const runTempPid = (name: string): number | undefined => {
  const match = new RegExp(`^${runTempPrefix}(\\d+)-[A-Za-z0-9]+$`).exec(name)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process is there, another user's.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Removes the temp folders that earlier runs left in base, those named with the ID of a process
 * that has ended, and returns their paths. A link, or a folder another user owns, is left alone.
 */
export const removeStaleRuns = (
  base: string,
  alive: (pid: number) => boolean = isAlive,
): ReadonlyArray<string> => {
  let names: ReadonlyArray<string>
  try {
    names = readdirSync(base)
  } catch {
    return []
  }
  const removed: Array<string> = []
  for (const name of names) {
    const pid = runTempPid(name)
    if (pid === undefined || pid === process.pid || alive(pid)) continue
    const path = join(base, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.uid !== process.getuid?.()) continue
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    } catch {
      // Gone already: another run starting beside this one removed it.
    }
  }
  return removed
}

if (import.meta.main) {
  const base = runTempBase(process.env, process.platform)
  removeStaleRuns(base)
  const temp = mkdtempSync(join(base, `${runTempPrefix}${process.pid}-`))
  const remove = () => rmSync(temp, { recursive: true, force: true })
  for (const [signal, code] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      remove()
      process.exit(code)
    })
  }
  let code = 1
  try {
    code = await main(Bun.argv.slice(2), temp)
  } finally {
    remove()
  }
  process.exit(code)
}
