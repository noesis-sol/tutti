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
//
// A worker's run is given its share of the machine's cores, TUTTI_CORES (or ORCHESTRA_CORES, under
// orchestra), as other workers' checks run beside it (tutti-kkb.24). bun test runs the files one
// after another, but its JavaScriptCore starts nearly as many garbage collector markers and FTL
// compiler threads as the machine has cores (8 and 7 of 10, Bun 1.4.3), and so does each bun the
// suites start: given a share below the machine's cores, the run keeps them to it
// (coreThreadVariables).
//
// The suites run in an environment of their own, the same on every machine (testEnvironment): a PATH
// with none of the tools tutti finds on it (hiddenTools), so no test finds the machine's claude or
// bd and passes, or skips, only where they are installed (orchestra-nqbn, orchestra-163s); and none
// of the variables of the terminal, the Claude Code session or the tools the tests run under, which
// reached the live tests' sessions (tutti-y0e). Tests read it through test/env.ts, which Biome's
// rules hold them to (biome.json, test/lint/).
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { paneVariable } from "../src/agent/env.ts"

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

/**
 * The run's share of the machine's cores: TUTTI_CORES, or orchestra's ORCHESTRA_CORES, a whole
 * number of at least 1; undefined when neither holds one.
 */
export const coreShareOf = (
  env: Readonly<Record<string, string | undefined>>,
): number | undefined => {
  for (const name of ["TUTTI_CORES", "ORCHESTRA_CORES"]) {
    const value = env[name]?.trim() ?? ""
    if (/^\d+$/.test(value) && Number(value) >= 1) return Number(value)
  }
  return undefined
}

/**
 * JavaScriptCore's options for the threads it starts as many of as there are cores, which bun reads
 * from BUN_JSC_<option>. Its DFG compiler threads are 2 already.
 */
export const jscThreadVariables = [
  "BUN_JSC_numberOfGCMarkers",
  "BUN_JSC_numberOfFTLCompilerThreads",
] as const

/**
 * The variables that keep bun test's threads, and those of each bun the suites start, to the
 * share of the machine's `cores` that `env` gives (coreShareOf): JavaScriptCore's threads at the
 * share, but those `env` sets already. None without a share, or with one of all the cores.
 */
export const coreThreadVariables = (
  env: Readonly<Record<string, string | undefined>>,
  cores: number = availableParallelism(),
): Record<string, string> => {
  const share = coreShareOf(env)
  if (share === undefined || share >= cores) return {}
  const result: Record<string, string> = {}
  for (const name of jscThreadVariables) {
    if ((env[name] ?? "") === "") result[name] = String(share)
  }
  return result
}

/**
 * The tools tutti looks for on the PATH (Claude Code, Beads, Homebrew) and the terminals it runs in.
 * No test finds the machine's: one that needs a tool puts a fake of it on the PATH it gives, and a
 * slow or live test that uses the real one on purpose finds it on TUTTI_TEST_MACHINE_PATH.
 */
export const hiddenTools: ReadonlyArray<string> = ["claude", "bd", "brew", "tmux", "herdr", "cmux"]

// The test gates and the variables tests give scripts/test.sh's own fixtures: tutti's other
// variables are settings (TUTTI_CONCURRENT, TUTTI_CLAUDE, …), which the machine's mustn't change.
const keptTuttiVariable = (name: string): boolean =>
  name === "TUTTI_SLOW" ||
  name === "TUTTI_LIVE" ||
  name.startsWith("TUTTI_TEST_") ||
  name.startsWith("TUTTI_FIXTURE_")

const machinePrefixes: ReadonlyArray<string> = [
  // terminals', beside the pane's (paneVariable)
  "ITERM_",
  "KITTY_",
  "GHOSTTY_",
  "WEZTERM_",
  // Claude Code's in a session, and orchestra's for its workers
  "CLAUDE_CODE_",
  "ORCHESTRA_",
  // Beads'
  "BD_",
  "BEADS_",
]

const machineNames: ReadonlySet<string> = new Set([
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERMINFO",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
])

/**
 * Whether a variable is the machine's rather than the tests': the terminal's (its pane's included),
 * the Claude Code session's or orchestra worker's the tests may run in, Beads', or tutti's settings.
 */
export const machineVariable = (name: string): boolean =>
  paneVariable(name) ||
  machineNames.has(name) ||
  machinePrefixes.some((prefix) => name.startsWith(prefix)) ||
  (name.startsWith("TUTTI_") && !keptTuttiVariable(name))

/**
 * `path` without hiddenTools: each of its folders that holds one is replaced by a folder made in
 * `shadows` with links to all else it holds, so the order the PATH finds tools in is kept. Empty
 * entries (the current folder) and folders that aren't there are left out.
 */
export const airtightPath = (path: string, shadows: string): string => {
  const hidden = (name: string): boolean => hiddenTools.includes(name.toLowerCase())
  const folders: Array<string> = []
  for (const [index, entry] of path.split(delimiter).entries()) {
    if (entry === "") continue
    const folder = resolve(entry)
    let names: ReadonlyArray<string>
    try {
      names = readdirSync(folder)
    } catch {
      continue
    }
    if (!names.some(hidden)) {
      folders.push(folder)
      continue
    }
    const shadow = join(shadows, String(index))
    mkdirSync(shadow, { recursive: true })
    for (const name of names) if (!hidden(name)) symlinkSync(join(folder, name), join(shadow, name))
    folders.push(shadow)
  }
  return folders.join(delimiter)
}

/**
 * The suites' environment: `env` without the machine's variables (machineVariable), its PATH made
 * airtight in `shadows` (airtightPath), and the machine's PATH as TUTTI_TEST_MACHINE_PATH.
 */
export const testEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  shadows: string,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !machineVariable(name)) result[name] = value
  }
  result.PATH = airtightPath(env.PATH ?? "", shadows)
  result.TUTTI_TEST_MACHINE_PATH = env.PATH ?? ""
  return result
}

const runBunTest = async (
  args: ReadonlyArray<string>,
  report: string,
  temp: string,
  environment: Readonly<Record<string, string>>,
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
    {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...environment, TMPDIR: temp },
    },
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
  // The share is read from the machine's variables, which the suites' environment leaves out.
  const environment = {
    ...testEnvironment(process.env, join(temp, "tutti-test-path")),
    ...coreThreadVariables(process.env),
  }
  const first = join(reports, "first.xml")
  const { code, output } = await runBunTest(args, first, temp, environment)
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
      environment,
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
