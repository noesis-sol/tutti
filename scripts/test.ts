// scripts/test.ts: the test runner behind scripts/test.sh (§ 13).
//
// Bun's --retry retries a failed test, but neither its console output nor its JUnit report says
// which tests passed only on their retry (Bun 1.4.3; docs/spikes/08-bun-test-retry.md). So this
// follows § 13's fallback: run the suites once without --retry, rerun each failed test once by
// name (-t), and print FLAKY: <file> <test> for each that passes on its rerun. A flaky test does
// not fail the run; a test that fails twice does. Arguments are passed on to bun test.
// TUTTI_CHECK_OWN_PASSED names a file it writes, one a line, the test files whose tests all passed
// (passedFiles), which scripts/check-own.sh keeps from a failed run; the suites don't see it.
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
// Such a run can leave bun test's workers running too, each in a process group of its own: the next
// run kills those whose TMPDIR is the folder of a run that has gone (killLeftWorkers).
//
// A worker's run is given its share of the machine's cores, TUTTI_CORES (or ORCHESTRA_CORES, under
// orchestra), as other workers' checks run beside it (tutti-kkb.24). bun test runs the files in
// that many worker processes at once (--parallel), or in half the machine's cores without a share
// (testWorkers): one after another, the suites kept one core busy while the machine had ten, and
// took 139 s where six workers took 89 s on the same loaded machine (2026-10-22). Each worker's
// JavaScriptCore starts nearly as many garbage collector markers and FTL compiler threads as the
// machine has cores (8 and 7 of 10, Bun 1.4.3), and so does each bun the suites start: the run keeps
// them to the workers' part of the share (coreThreadVariables). A file's failed tests are rerun
// together, in one process, and the files side by side, as many at a time as the first run's
// workers. TUTTI_TEST_PARALLEL gives the workers' number instead (1 for one process). As the files
// load the machine themselves, a test's time limit is 15 s where its file sets none (testTimeLimit),
// not bun's 5 s.
//
// The processes follow the memory too (testProcesses; tutti-epza.19): each stays alive across many
// files, and one worker's whole-suite check started five of 1.3-1.7 GB on a 16 GB Mac, swap near
// full (2026-11-03). So they are no more than the run's share of the memory (the share file, the
// variables, or the memory free now outside tutti) holds at what one takes, which each run learns:
// it reads its test processes' memory and the memory pressure every couple of seconds (watchMemory)
// and keeps its peak in .cache/test-memory.json (recordRun), whose high mark the next runs take. A
// process's memory is that of the file it runs, not the files before: over a whole-suite run at
// three processes each went up and down, peaks of 0.6-1.15 GB, one from 1149 MB to 55 MB within
// 10 s (2026-11-03), so nothing caps the files a process runs, which bun 1.4.3 can't anyway. What
// piled up was the files before's garbage, no file alone taking over 620 MB, which the preload,
// test/warm-up.ts, now collects after each file (tutti-3cri). What a process's tests start is kept
// apart, and counted once for the run, not once a process (tutti-q61i): a few slow files start big
// short-lived processes, build-script.test.ts' bun build --compile 2.5 GB, tutti-skill.test.ts'
// bun src/main.ts 1 GB, alone each 620 MB at most, and one run's sample catching the compile had
// set every run's processes at 2.5 GB. A plain run counts what plain runs' processes and their
// tests took, a TUTTI_SLOW run what slow runs' did (tutti-k4if.2). CI's runners, which run nothing
// else, give the run their whole memory as its share (TUTTI_MEMORY_MB, .github/workflows/ci.yml):
// the memory free less the reserve held macos-latest's 7 GB to one process at the 1.5 GB default a
// fresh runner has, having no record (tutti-34k9.9).
//
// The suites run in an environment of their own, the same on every machine (testEnvironment): a PATH
// with none of the tools tutti finds on it (hiddenTools), so no test finds the machine's claude or
// bd and passes, or skips, only where they are installed (orchestra-nqbn, orchestra-163s); and none
// of the variables of the terminal, the Claude Code session or the tools the tests run under, which
// reached the live tests' sessions (tutti-y0e); and notifications off (TUTTI_NOTIFY=0), so that no
// tutti a test runs shows a desktop notification on the machine (tutti-twdw). Tests read it through
// test/env.ts, which Biome's rules hold them to (biome.json, test/lint/).
//
// It runs nothing on a node_modules behind bun.lock, saying which packages differ (check-deps.ts):
// the suites would run on the packages of before a bump, and fail on bugs it fixed (tutti-a8q2).
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import {
  coresVariable,
  mebibyte,
  memoryReserve,
  memoryVariable,
  orchestraMemoryVariable,
  paneVariable,
  sessionVariable,
  shareFileVariable,
} from "../src/core/env.ts"
import {
  below,
  type Pressure,
  type Processes,
  parseLinux,
  parseProcesses,
  psArgs,
} from "../src/run/load.ts"
import { processAlive } from "../src/services/processTree.ts"
import { staleDependencies, staleReport } from "./check-deps.ts"

export interface TestCase {
  /** The test file, relative to the folder bun test ran in. */
  readonly file: string
  /** The full name bun test's -t matches: the describe blocks and the test, joined by spaces. */
  readonly name: string
  readonly failed: boolean
  /** Whether it failed by running past its time limit (the report's TimeoutError). */
  readonly timedOut: boolean
  /** Whether it didn't run: skipped, or filtered out by a rerun's -t. */
  readonly skipped: boolean
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
  let open:
    | { file: string; name: string; failed: boolean; timedOut: boolean; skipped: boolean }
    | undefined
  const tags =
    /<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g
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
        timedOut: false,
        skipped: false,
      }
      if (selfClosing) cases.push(test)
      else open = test
    } else if ((tag === "failure" || tag === "error") && !closing && open) {
      open.failed = true
      if (tag === "failure" && attribute(attrs, "type") === "TimeoutError") open.timedOut = true
    } else if (tag === "skipped" && !closing && open) {
      open.skipped = true
    }
  }
  return cases
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")

/** A -t pattern that matches exactly the test with this full name. */
export const exactNamePattern = (name: string): string => `^${escapeRegExp(name)}$`

/** A -t pattern that matches exactly each test with one of these full names, and no other. */
export const exactNamesPattern = (names: ReadonlyArray<string>): string =>
  `^(?:${[...new Set(names)].map(escapeRegExp).join("|")})$`

/** A file's failed tests, rerun together in one bun test. */
export interface RerunGroup {
  readonly file: string
  readonly tests: ReadonlyArray<TestCase>
}

/** The failed tests by file, the files in the order their first failures came. */
export const rerunGroups = (failed: ReadonlyArray<TestCase>): ReadonlyArray<RerunGroup> => {
  const groups = new Map<string, Array<TestCase>>()
  for (const test of failed) groups.set(test.file, [...(groups.get(test.file) ?? []), test])
  return [...groups].map(([file, tests]) => ({ file, tests }))
}

/**
 * The tests of `group` that passed on its rerun, whose bun test exited with `code` and printed
 * `output`, from its report `reran`: each test of the name ran and none failed, and the rerun
 * failed outside its tests by nothing but leftovers of those that timed out again
 * (timeoutLeftovers), as the first run's failures are read.
 */
export const passedOnRerun = (
  group: RerunGroup,
  code: number,
  output: string,
  reran: ReadonlyArray<TestCase>,
  cwd: string,
): ReadonlyArray<TestCase> => {
  const failedAgain = reran.filter((test) => test.failed)
  const counts = summaryCounts(output)
  const clean =
    code === 0 ||
    (counts.fail === failedAgain.length && timeoutLeftovers(output, counts.error, failedAgain, cwd))
  if (!clean) return []
  return group.tests.filter((test) => {
    const runs = reran.filter((run) => run.name === test.name)
    return runs.length > 0 && runs.every((run) => !run.failed && !run.skipped)
  })
}

/**
 * Starts each of `tasks`, no more than `limit` at a time, in their order, and returns a promise of
 * each one's result, in the same order.
 */
export const inPool = <A>(
  tasks: ReadonlyArray<() => Promise<A>>,
  limit: number,
): ReadonlyArray<Promise<A>> => {
  const results = tasks.map(() => Promise.withResolvers<A>())
  let next = 0
  const work = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++
      const task = tasks[index]
      const result = results[index]
      if (task === undefined || result === undefined) continue
      await task().then(result.resolve, result.reject)
    }
  }
  for (let i = 0; i < Math.max(1, Math.min(limit, tasks.length)); i++) void work()
  return results.map((result) => result.promise)
}

export const flakyLine = (test: TestCase): string => `FLAKY: ${test.file} ${test.name}`

/**
 * The test files of the first run's report `cases` whose tests all passed, sorted: those with no
 * test in `failing`, the tests that failed and didn't pass on a rerun, and not in `erred`, the files
 * that raised an error between tests (erredFiles). A file that didn't load isn't in the report, so
 * isn't one.
 */
export const passedFiles = (
  cases: ReadonlyArray<TestCase>,
  failing: ReadonlyArray<TestCase>,
  erred: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const failed = new Set([...failing.map((test) => test.file), ...erred])
  return [...new Set(cases.map((test) => test.file))].filter((file) => !failed.has(file)).sort()
}

const fileArgument = (file: string): string =>
  file.startsWith("/") || file.startsWith("./") ? file : `./${file}`

// bun test's output without its colour codes.
const plainText = (output: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes, ESC included
  output.replace(/\u001b\[[0-9;]*m/g, "")

/** The fail and error counts in bun test's closing summary (" 2 fail", " 1 error"). */
export const summaryCounts = (
  output: string,
): { readonly fail: number; readonly error: number } => {
  const plain = plainText(output)
  const count = (word: string): number => {
    const matches = [...plain.matchAll(new RegExp(`^\\s*(\\d+) ${word}s?\\s*$`, "gm"))]
    return Number(matches.at(-1)?.[1] ?? 0)
  }
  return { fail: count("fail"), error: count("error") }
}

/**
 * The errors bun test printed as "# Unhandled error between tests", each the text from that heading
 * to the dashed line that closes it, with the last line before it that reads "<file>:" for a file
 * `isFile` takes: the test file bun ran it in, which it names so above its tests, and again above
 * the error under --parallel (Bun 1.4.3); under GitHub Actions (GITHUB_ACTIONS) bun prints it
 * "::group::<file>:". A test's own output may read so too, hence `isFile`.
 */
const errorBlocks = (
  output: string,
  isFile: (file: string) => boolean,
): ReadonlyArray<{ readonly file: string | undefined; readonly text: string }> => {
  const blocks: Array<{ readonly file: string | undefined; readonly text: string }> = []
  let file: string | undefined
  let block: Array<string> | undefined
  for (const line of plainText(output).split("\n")) {
    if (block === undefined) {
      if (line.trim() === "# Unhandled error between tests") block = []
      else {
        const heading = /^(?:::group::)?(\S.*):\s*$/.exec(line)?.[1]
        if (heading !== undefined && isFile(heading)) file = heading
      }
    } else if (/^-+\s*$/.test(line)) {
      if (block.length > 0) {
        blocks.push({ file, text: block.join("\n") })
        block = undefined
      }
    } else {
      block.push(line)
    }
  }
  if (block !== undefined) blocks.push({ file, text: block.join("\n") })
  return blocks
}

/**
 * The errors bun test printed as "# Unhandled error between tests", each the text from that heading
 * to the dashed line that closes it (Bun 1.4.3).
 */
export const betweenTestErrors = (output: string): ReadonlyArray<string> =>
  errorBlocks(output, () => false).map((block) => block.text)

/** The files of a stack trace's frames: "at f (/a/b.ts:1:2)", "at /a/b.ts:1:2". */
export const stackFiles = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/^\s*at (?:.*? \()?(.+?):\d+:\d+\)?\s*$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )

const realPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Those of the test `files` of bun's report, paths relative to `cwd`, that an error between tests
 * names, though their tests may all have passed (tutti-fnvd.2): the file bun printed it under
 * (errorBlocks) or one of its frames. Undefined where bun counted more `errors` than it printed, or
 * one names no file, as no file can then be cleared of them. A file that didn't load raises one too,
 * named but not in the report.
 */
export const erredFiles = (
  output: string,
  errors: number,
  files: ReadonlyArray<string>,
  cwd: string,
): ReadonlyArray<string> | undefined => {
  const path = (file: string): string => realPath(resolve(cwd, file))
  const blocks = errorBlocks(output, (file) => isFile(path(file)))
  if (blocks.length < errors) return undefined
  const named = blocks.map((block) => [
    ...(block.file === undefined ? [] : [block.file]),
    ...stackFiles(block.text),
  ])
  if (named.some((names) => names.length === 0)) return undefined
  const erred = new Set(named.flat().map(path))
  return files.filter((file) => erred.has(path(file)))
}

/**
 * Whether bun test's `errors` outside any test are all left over from the tests in `failed` that
 * timed out, so that rerunning those may clear them: each was printed as an error between tests
 * (betweenTestErrors) with a frame in a timed-out test's file, its path relative to `cwd`. A test
 * that runs past its time limit carries on after bun moves on, killing the processes it started,
 * and an expect it fails then is an error between tests (tutti-06a).
 */
export const timeoutLeftovers = (
  output: string,
  errors: number,
  failed: ReadonlyArray<TestCase>,
  cwd: string,
): boolean => {
  const blocks = betweenTestErrors(output)
  if (blocks.length !== errors) return false
  const timedOut = new Set(
    failed.filter((test) => test.timedOut).map((test) => realPath(resolve(cwd, test.file))),
  )
  return blocks.every((block) =>
    stackFiles(block).some((file) => timedOut.has(realPath(resolve(cwd, file)))),
  )
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
 * The variables that keep the threads of bun test's `processes`, and those of each bun the suites
 * start, to the share of the machine's `cores` that `env` gives (coreShareOf), or to the cores
 * without one: JavaScriptCore's threads at each process's part of it, at least one, but those `env`
 * sets already. None for one process without a share, or with one of all the cores.
 */
export const coreThreadVariables = (
  env: Readonly<Record<string, string | undefined>>,
  cores: number = availableParallelism(),
  processes = 1,
): Record<string, string> => {
  const share = coreShareOf(env)
  if (processes <= 1 && (share === undefined || share >= cores)) return {}
  const each = Math.max(1, Math.floor(Math.min(share ?? cores, cores) / Math.max(processes, 1)))
  const result: Record<string, string> = {}
  for (const name of jscThreadVariables) {
    if ((env[name] ?? "") === "") result[name] = String(each)
  }
  return result
}

/**
 * How many worker processes bun test runs the files in (--parallel): TUTTI_TEST_PARALLEL where it
 * holds a whole number of at least one, else the run's share of the machine's `cores`
 * (coreShareOf), else half the cores, at least one; no more than the script files `args` name,
 * where they name some (test/x.test.ts, a fixture's ./test/fixtures/flaky/flaky.fixture.ts). 1 runs
 * them in one process, as do arguments that choose --parallel themselves (counted as 1 here).
 *
 * Half, not all, without a share: a merge check runs with none, beside the workers' own checks, and
 * with every core taken by the suites the machine is overloaded and timing-sensitive tests fail
 * (2026-10-22: three FLAKY in one full check at all ten); orchestra's default cap on workers across
 * the machine is half the cores for the same reason.
 */
export const testWorkers = (
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyArray<string>,
  cores: number = availableParallelism(),
): number => {
  if (args.some((arg) => arg === "--parallel" || arg.startsWith("--parallel="))) return 1
  const asked = env.TUTTI_TEST_PARALLEL?.trim() ?? ""
  const wanted =
    /^\d+$/.test(asked) && Number(asked) >= 1
      ? Number(asked)
      : (coreShareOf(env) ?? Math.max(1, Math.floor(cores / 2)))
  const files = args.filter((arg) => !arg.startsWith("-") && /\.[cm]?[jt]sx?$/.test(arg)).length
  return Math.max(1, files > 0 ? Math.min(wanted, files) : wanted)
}

/**
 * bun test's --parallel for `workers` processes running the files `args` name, or every file where
 * they name none: for one process too, where it runs more than one file, as only under --parallel
 * does each file run in a fresh global with the preload's hooks around it, which collect its
 * garbage (test/warm-up.ts; tutti-3cri); without, a file's garbage stays for the next. At
 * --parallel=1 bun test starts no worker but runs the files itself, each still in a fresh global
 * (Bun 1.4.3; testsInWorkers). None for one file, or where the arguments choose --parallel
 * themselves.
 */
export const parallelArguments = (
  workers: number,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (args.some((arg) => arg === "--parallel" || arg.startsWith("--parallel="))) return []
  const files = args.filter((arg) => !arg.startsWith("-") && /\.[cm]?[jt]sx?$/.test(arg)).length
  return workers > 1 || files !== 1 ? [`--parallel=${workers}`] : []
}

/**
 * Whether bun test, given `args`, runs the files in worker processes of its own: where the last
 * --parallel asks for more than one, a bare --parallel for as many as the machine's `cores`. At
 * --parallel=1, or without --parallel, it runs them in its own process (Bun 1.4.3), whose memory
 * is then the test process's: a one-process run that read its children read only what its tests
 * started, 147-210 MB where a worker's peak was 880-1107 MB (tutti-96rg).
 */
export const testsInWorkers = (
  args: ReadonlyArray<string>,
  cores: number = availableParallelism(),
): boolean => {
  const asked = args.filter((arg) => arg === "--parallel" || arg.startsWith("--parallel=")).at(-1)
  if (asked === undefined) return false
  return (asked === "--parallel" ? cores : Number(asked.slice("--parallel=".length))) > 1
}

/** What the processes are sized by beside the cores (testProcesses). */
export interface Sizing {
  /** The run's share of the memory, in bytes (memoryShareOf, availableMemory); undefined where
   * neither is known. */
  readonly memory: number | undefined
  /** The memory one test process takes, in bytes: the record's high mark, or defaultProcessMemory. */
  readonly each: number
  /** The memory kept, once for the run, for what the tests start, in bytes (childrenMark). */
  readonly children?: number | undefined
  /** The most processes a run may start as a run met memory pressure lately (heldProcesses). */
  readonly held?: number | undefined
}

/** The memory one test process is taken to need until the record has a run's (2026-11-03). */
export const defaultProcessMemory = 1.5 * 1024 ** 3

const gigabytes = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

const plural = (count: number, noun: string, nouns = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : nouns}`

/**
 * How many worker processes bun test runs the files in, and the run's first line, which says why:
 * the least of testWorkers' number (TUTTI_TEST_PARALLEL's, or the cores share) and the processes
 * the memory share, less `sizing.children`, holds at `sizing.each` a process, and no more than
 * `sizing.held`; at least one. `scripts/test.sh: 3 processes (cores 5, memory 4.6 GB at ~1.5 GB
 * each)`, `… memory 4.6 GB less ~1.0 GB for what the tests start, at ~0.6 GB each)`.
 */
export const testProcesses = (
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyArray<string>,
  sizing: Sizing,
  cores: number = availableParallelism(),
): { readonly processes: number; readonly line: string } => {
  if (args.some((arg) => arg === "--parallel" || arg.startsWith("--parallel="))) {
    return { processes: 1, line: "scripts/test.sh: processes as the arguments' --parallel says" }
  }
  const asked = env.TUTTI_TEST_PARALLEL?.trim() ?? ""
  const reasons = [
    /^\d+$/.test(asked) && Number(asked) >= 1
      ? `TUTTI_TEST_PARALLEL ${Number(asked)}`
      : `cores ${coreShareOf(env) ?? Math.max(1, Math.floor(cores / 2))}`,
  ]
  let processes = testWorkers(env, args, cores)
  const { memory, each, children = 0, held } = sizing
  if (memory === undefined) reasons.push("memory not known")
  else {
    const kept = children > 0 ? ` less ~${gigabytes(children)} GB for what the tests start,` : ""
    reasons.push(`memory ${gigabytes(memory)} GB${kept} at ~${gigabytes(each)} GB each`)
    const left = Math.max(memory - children, 0)
    processes = Math.min(processes, Math.max(1, Math.floor(left / Math.max(each, 1))))
  }
  if (held !== undefined) {
    reasons.push(`no more than ${held} as memory pressure reached warn lately`)
    processes = Math.max(1, Math.min(processes, held))
  }
  const files = args.filter((arg) => !arg.startsWith("-") && /\.[cm]?[jt]sx?$/.test(arg)).length
  if (files > 0) reasons.push(plural(files, "file"))
  return {
    processes,
    line: `scripts/test.sh: ${plural(processes, "process", "processes")} (${reasons.join(", ")})`,
  }
}

/**
 * The share tutti keeps in the file TUTTI_SHARE_FILE names (src/run/share.ts' shareLine), as a run
 * reads it as it starts: the variables it stands for, TUTTI_CORES and TUTTI_MEMORY_MB, those of
 * its figures that are whole numbers of at least one; none where the file is unset, unreadable or
 * not such a line. TUTTI_CORES and TUTTI_MEMORY_MB are the share as the worker's session started;
 * the file follows it as the run's memory pressure moves it.
 */
export const shareFileVariables = (
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Record<string, string> => {
  const path = env[shareFileVariable] ?? ""
  if (path === "") return {}
  let share: unknown
  try {
    share = JSON.parse(read(path))
  } catch {
    return {}
  }
  if (typeof share !== "object" || share === null) return {}
  const whole = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1
  const { cores, memory_mb: memory } = share as { cores?: unknown; memory_mb?: unknown }
  return {
    ...(whole(cores) ? { [coresVariable]: String(cores) } : {}),
    ...(whole(memory) ? { [memoryVariable]: String(memory) } : {}),
  }
}

/**
 * The run's share of the memory, in bytes: TUTTI_MEMORY_MB, or orchestra's ORCHESTRA_MEMORY_MB, in
 * MiB, a whole number of at least 1; undefined when neither holds one.
 */
export const memoryShareOf = (
  env: Readonly<Record<string, string | undefined>>,
): number | undefined => {
  for (const name of [memoryVariable, orchestraMemoryVariable]) {
    const value = env[name]?.trim() ?? ""
    if (/^\d+$/.test(value) && Number(value) >= 1) return Number(value) * mebibyte
  }
  return undefined
}

/** The number on vm_stat's or /proc/meminfo's line that starts with `name`. */
const counted = (text: string, name: string): number | undefined => {
  const line = text.split("\n").find((each) => each.startsWith(name))
  const value = line?.slice(name.length).trim().split(/\s+/)[0]?.replace(/\.$/, "") ?? ""
  return /^\d+$/.test(value) ? Number(value) : undefined
}

/**
 * The memory macOS can give programs now, from vm_stat's output, in bytes: its free, inactive and
 * purgeable pages; undefined where any can't be read.
 */
export const darwinAvailable = (vmstat: string): number | undefined => {
  const page = /\(page size of (\d+) bytes\)/.exec(vmstat)?.[1]
  const pages = ["Pages free:", "Pages inactive:", "Pages purgeable:"].map((name) =>
    counted(vmstat, name),
  )
  if (page === undefined || pages.some((count) => count === undefined)) return undefined
  return pages.reduce((sum: number, count) => sum + (count ?? 0), 0) * Number(page)
}

/** The memory Linux can give programs now, /proc/meminfo's MemAvailable, in bytes. */
export const linuxAvailable = (meminfo: string): number | undefined => {
  const kilobytes = counted(meminfo, "MemAvailable:")
  return kilobytes === undefined ? undefined : kilobytes * 1024
}

/**
 * A run's share of the memory outside tutti, where neither the share file nor the variables give
 * one: the memory the machine can give programs now, less load.ts' memoryReserve, as tutti keeps
 * one; undefined where it can't be read.
 */
export const availableMemory = (
  platform: NodeJS.Platform = process.platform,
): number | undefined => {
  let available: number | undefined
  try {
    if (platform === "darwin") {
      const vmstat = Bun.spawnSync(["vm_stat"])
      if (vmstat.exitCode === 0) available = darwinAvailable(vmstat.stdout.toString())
    } else if (platform === "linux") {
      available = linuxAvailable(readFileSync("/proc/meminfo", "utf8"))
    }
  } catch {
    return undefined
  }
  return available === undefined ? undefined : Math.max(available - memoryReserve, 0)
}

/**
 * One run the record keeps: when it ended, the most one test process took itself and the most one
 * process's tests started took (processPeak), its processes and files, whether it was TUTTI_SLOW,
 * and `root` where bun test ran the files in its own process, the test process read.
 */
export interface MemoryRun {
  readonly at: string
  readonly peak_mb: number
  readonly children_mb: number
  readonly processes: number
  readonly files: number
  readonly slow: boolean
  readonly root?: true
}

/**
 * What .cache/test-memory.json keeps: recent runs' peaks, latest last, and the last run that met
 * memory pressure at warn or worse, with the processes it ran in.
 */
export interface MemoryRecord {
  readonly runs: ReadonlyArray<MemoryRun>
  readonly warn?: { readonly at: string; readonly processes: number }
}

/** The runs the record keeps, its latest. */
export const recordedRuns = 20

/**
 * The fewest test files a run must have run for the record to keep its peak: a process's memory is
 * that of the file it runs, and a few files may not take what the hungriest do.
 */
export const recordFiles = 50

/** How long a run that met memory pressure holds the next runs to fewer processes. */
export const warnHold = 10 * 60_000

/**
 * The record in `text`, the runs and the warn that are well formed; empty for anything else. A run
 * kept before tutti-q61i, without children_mb, counted its tests' processes in its peak, and is left
 * out, as is a run in one process without `root`: kept before tutti-96rg, its peak was only what
 * its tests started, read below bun test, which ran the files itself.
 */
export const parseMemoryRecord = (text: string): MemoryRecord => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { runs: [] }
  }
  if (typeof json !== "object" || json === null) return { runs: [] }
  const { runs, warn } = json as { runs?: unknown; warn?: unknown }
  const whole = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1
  const dated = (value: unknown): value is string =>
    typeof value === "string" && !Number.isNaN(Date.parse(value))
  const kept = (Array.isArray(runs) ? runs : []).filter(
    (run: Partial<MemoryRun> | null): run is MemoryRun =>
      typeof run === "object" &&
      run !== null &&
      dated(run.at) &&
      whole(run.peak_mb) &&
      typeof run.children_mb === "number" &&
      Number.isInteger(run.children_mb) &&
      run.children_mb >= 0 &&
      whole(run.processes) &&
      whole(run.files) &&
      typeof run.slow === "boolean" &&
      (run.root === undefined || run.root === true) &&
      (run.processes > 1 || run.root === true),
  )
  const { at, processes } = (typeof warn === "object" && warn !== null ? warn : {}) as {
    at?: unknown
    processes?: unknown
  }
  return {
    runs: kept.slice(-recordedRuns),
    ...(dated(at) && whole(processes) ? { warn: { at, processes } } : {}),
  }
}

/**
 * The memory one test process takes, as the record learned it, in bytes: the 90th percentile of
 * the peaks (nearest rank) of its runs that were TUTTI_SLOW as this one is (`slow`), or of all its
 * runs where none was, so that one odd run neither sets it nor is forgotten at once; undefined
 * without a run. Plain runs' processes peaked at 150-240 MB, TUTTI_SLOW runs' at 577-841 MB
 * (2026-11-08), and the slow ones had set a plain run's processes at 0.6 GB (tutti-k4if.2).
 */
export const highMark = (record: MemoryRecord, slow: boolean): number | undefined =>
  percentile90(alikeRuns(record, slow).map((run) => run.peak_mb))

/**
 * The memory a run keeps for what its tests start, in bytes: the 90th percentile of the children_mb
 * of the record's runs that were TUTTI_SLOW as this one is (`slow`), or of all its runs where none
 * was; 0 without a run. Kept once for the run: few files start much, and seldom at once.
 */
export const childrenMark = (record: MemoryRecord, slow: boolean): number =>
  percentile90(alikeRuns(record, slow).map((run) => run.children_mb)) ?? 0

/** The record's runs that were TUTTI_SLOW as `slow` says, or all of them where none was. */
const alikeRuns = (record: MemoryRecord, slow: boolean): ReadonlyArray<MemoryRun> => {
  const alike = record.runs.filter((run) => run.slow === slow)
  return alike.length > 0 ? alike : record.runs
}

/** The 90th percentile (nearest rank) of `values`, MiB, in bytes; undefined without one. */
const percentile90 = (values: ReadonlyArray<number>): number | undefined => {
  const sorted = [...values].sort((a, b) => a - b)
  const mark = sorted[Math.ceil(sorted.length * 0.9) - 1]
  return mark === undefined ? undefined : mark * mebibyte
}

/**
 * The most processes a run started at `now` may start: one fewer than the record's last run that
 * met memory pressure ran in, at least one, for warnHold after it; undefined otherwise.
 */
export const heldProcesses = (record: MemoryRecord, now: number): number | undefined => {
  if (record.warn === undefined) return undefined
  const since = now - Date.parse(record.warn.at)
  return since >= 0 && since < warnHold ? Math.max(1, record.warn.processes - 1) : undefined
}

/**
 * What a run's watch found (watchMemory): the most one test process took and the most its tests
 * started took, and the pressure.
 */
export interface Watched {
  /** In bytes; 0 where the processes were never read. */
  readonly peak: number
  /** In bytes; 0 where the processes were never read or started none. */
  readonly children: number
  /** Whether the memory pressure reached warn or worse. */
  readonly warned: boolean
  /** Whether the test process read was bun test's own, which ran the files itself. */
  readonly root?: boolean
}

/**
 * The record with the run that ended at `at` in it, which ran `files` test files in `processes`
 * processes, TUTTI_SLOW or not (`slow`): its peaks where it ran recordFiles or more and one was
 * read, its warn where it met one.
 */
export const recordRun = (
  record: MemoryRecord,
  run: Watched & {
    readonly at: number
    readonly processes: number
    readonly files: number
    readonly slow: boolean
  },
): MemoryRecord => {
  const at = new Date(run.at).toISOString()
  const peak = Math.ceil(run.peak / mebibyte)
  const kept: MemoryRun = {
    at,
    peak_mb: peak,
    children_mb: Math.ceil(run.children / mebibyte),
    processes: run.processes,
    files: run.files,
    slow: run.slow,
    ...(run.root === true ? { root: true as const } : {}),
  }
  const runs = run.files >= recordFiles && peak >= 1 ? [...record.runs, kept] : record.runs
  return {
    runs: runs.slice(-recordedRuns),
    ...(run.warned
      ? { warn: { at, processes: run.processes } }
      : record.warn === undefined
        ? {}
        : { warn: record.warn }),
  }
}

/**
 * The record's file: TUTTI_TEST_MEMORY_FILE, else .cache/test-memory.json in the main checkout,
 * which `cwd`'s worktrees share (git's common folder's parent), or in `cwd` outside git: a
 * worker's worktree is new, and would learn nothing.
 */
export const memoryRecordPath = (
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): string => {
  if (env.TUTTI_TEST_MEMORY_FILE) return env.TUTTI_TEST_MEMORY_FILE
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    stderr: "ignore",
  })
  const common = git.exitCode === 0 ? git.stdout.toString().trim() : ""
  return join(common === "" ? cwd : dirname(common), ".cache", "test-memory.json")
}

const readMemoryRecord = (path: string): MemoryRecord => {
  try {
    return parseMemoryRecord(readFileSync(path, "utf8"))
  } catch {
    return { runs: [] }
  }
}

// Written whole to a file of its own, then renamed over the record, so a run reading it beside
// another's write never reads half of one. Two runs ending together may lose one's run.
const writeMemoryRecord = (path: string, record: MemoryRecord): void => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const partial = `${path}.${process.pid}`
    writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`)
    renameSync(partial, path)
  } catch {
    // A record that can't be written leaves the next run to its default.
  }
}

/**
 * The most one test process takes itself in the listing `all`, in bytes, and the most everything
 * below one of them takes (the processes its tests started). The test processes are bun test's,
 * `root`'s, children where it runs the files in workers (`parallel`, testsInWorkers), else `root`
 * itself, as at --parallel=1.
 */
export const processPeak = (
  all: Processes,
  root: number,
  parallel: boolean,
): { readonly own: number; readonly children: number } => {
  const tests = parallel
    ? [...all].filter(([, each]) => each.parent === root).map(([pid]) => pid)
    : [root]
  let own = 0
  let children = 0
  for (const pid of tests) {
    own = Math.max(own, all.get(pid)?.memory ?? 0)
    children = Math.max(children, below(all, pid, new Set()))
  }
  return { own, children }
}

/** How often a run reads its test processes' memory and the memory pressure. */
export const watchEvery = 2_000

/** macOS's kern.memorystatus_vm_pressure_level, as load.ts' parseDarwin reads it. */
const darwinPressures: Readonly<Record<string, Pressure>> = {
  1: "normal",
  2: "warn",
  4: "critical",
}

/** The kernel's memory pressure now: macOS's level from sysctl, Linux's stall in /proc. */
const pressureNow = async (platform: NodeJS.Platform): Promise<Pressure> => {
  try {
    if (platform === "darwin") {
      const proc = Bun.spawn(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], {
        stderr: "ignore",
      })
      const level = (await new Response(proc.stdout).text()).trim()
      return darwinPressures[level] ?? "unknown"
    }
    const read = (path: string) => readFileSync(path, "utf8")
    const files = { loadavg: "", vmstat: "", cores: 0 }
    const kernel = parseLinux({ ...files, pressure: read("/proc/pressure/memory"), meminfo: "" })
    return kernel?.pressure ?? "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Reads, every watchEvery until `exited` settles, the memory of bun test `root`'s test processes
 * and their tests' (processPeak) and the memory pressure, and returns the most of each and whether
 * it reached warn: ps once, and sysctl or /proc, a few milliseconds.
 */
export const watchMemory = async (
  root: number,
  parallel: boolean,
  exited: Promise<unknown>,
  platform: NodeJS.Platform = process.platform,
): Promise<Watched> => {
  let peak = 0
  let children = 0
  let warned = false
  let done = false
  void exited.finally(() => {
    done = true
  })
  while (!done) {
    const ps = Bun.spawn(["ps", ...psArgs], { stderr: "ignore" })
    const [listing, pressure] = await Promise.all([
      new Response(ps.stdout).text(),
      pressureNow(platform),
    ])
    const all = parseProcesses(listing)
    if (all !== undefined) {
      const read = processPeak(all, root, parallel)
      peak = Math.max(peak, read.own)
      children = Math.max(children, read.children)
    }
    if (pressure === "warn" || pressure === "critical") warned = true
    await Promise.race([Bun.sleep(watchEvery), exited])
  }
  return { peak, children, warned, root: !parallel }
}

/** A test's time limit where its file sets none (setDefaultTimeout), in place of bun's 5 s. */
export const testTimeLimit = 15_000

/**
 * bun test's --timeout for testTimeLimit, unless `args` give one: the suites load the machine
 * themselves, their files running side by side, and a test that starts git or a script took over 5
 * s on a loaded machine where it takes under 1 s alone (2026-10-22).
 */
export const timeLimitArguments = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="))
    ? []
    : [`--timeout=${testTimeLimit}`]

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
  // Claude Code's in a session, beside the session's own (sessionVariable), and orchestra's for its
  // workers
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
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
])

/**
 * Whether a variable is the machine's rather than the tests': the terminal's (its pane's included),
 * the Claude Code session's or orchestra worker's the tests may run in, Beads', or tutti's settings.
 */
export const machineVariable = (name: string): boolean =>
  paneVariable(name) ||
  sessionVariable(name) ||
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
 * airtight in `shadows` (airtightPath), the machine's PATH as TUTTI_TEST_MACHINE_PATH, and
 * notifications off (TUTTI_NOTIFY=0): a tutti the tests spawn would otherwise show its notices on
 * the machine's desktop, as osascript stays on the PATH. Tests of the notifier give their own config.
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
  result.TUTTI_NOTIFY = "0"
  return result
}

// Its output is copied through to ours as it comes, or, with `echo` false, only returned: a rerun
// beside others prints its own once it ends, so that its lines stay together. `watch`, where given,
// watches bun test's process (its ID) until it exits, and what it returns is the result's.
const runBunTest = async (
  args: ReadonlyArray<string>,
  report: string,
  temp: string,
  environment: Readonly<Record<string, string>>,
  echo = true,
  watch?: (pid: number, exited: Promise<number>) => Promise<Watched>,
): Promise<{
  readonly code: number
  readonly out: string
  readonly err: string
  readonly output: string
  readonly watched: Watched | undefined
}> => {
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
  const [out, err, code, watched] = await Promise.all([
    echo ? tee(proc.stdout, process.stdout) : new Response(proc.stdout).text(),
    echo ? tee(proc.stderr, process.stderr) : new Response(proc.stderr).text(),
    proc.exited,
    watch?.(proc.pid, proc.exited),
  ])
  return { code, out, err, output: `${out}\n${err}`, watched }
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
  // The share is read from the machine's variables, which the suites' environment leaves out, and
  // from the share file, which follows it.
  const machine = { ...process.env, ...shareFileVariables(process.env) }
  const suites = testEnvironment(process.env, join(temp, "tutti-test-path"))
  // A run a test starts, in the suites' environment, is a fixture's, its outcome the same on any
  // machine: it reads no record but the one TUTTI_TEST_MEMORY_FILE names, and neither watches the
  // memory nor keeps a record.
  const own = process.env.TUTTI_TEST_MACHINE_PATH === undefined
  const recordPath = memoryRecordPath(process.env)
  const record: MemoryRecord =
    own || process.env.TUTTI_TEST_MEMORY_FILE ? readMemoryRecord(recordPath) : { runs: [] }
  const slow = process.env.TUTTI_SLOW === "1"
  const sizing: Sizing = {
    memory: memoryShareOf(machine) ?? availableMemory(),
    each: highMark(record, slow) ?? defaultProcessMemory,
    children: childrenMark(record, slow),
    held: heldProcesses(record, Date.now()),
  }
  const { processes: workers, line } = testProcesses(machine, args, sizing)
  console.log(line)
  const parallel = parallelArguments(workers, args)
  const limit = timeLimitArguments(args)
  const first = join(reports, "first.xml")
  const firstArgs = [...parallel, ...limit, ...args]
  const { code, output, watched } = await runBunTest(
    firstArgs,
    first,
    temp,
    { ...suites, ...coreThreadVariables(machine, undefined, workers) },
    true,
    own ? (pid, exited) => watchMemory(pid, testsInWorkers(firstArgs), exited) : undefined,
  )
  const cases = readReport(first)
  const warned = watched?.warned === true
  if (warned) {
    console.log(
      `scripts/test.sh: memory pressure reached warn with ${plural(workers, "process", "processes")}` +
        " running; the reruns, and the runs of the next 10 minutes, start fewer",
    )
  }
  if (watched !== undefined) {
    const files = new Set(cases.map((test) => test.file)).size
    const run = { ...watched, at: Date.now(), processes: workers, files, slow }
    writeMemoryRecord(recordPath, recordRun(readMemoryRecord(recordPath), run))
  }
  const counts = summaryCounts(output)
  // The verdict, the files whose tests all passed written first where check-own.sh asked for them,
  // which it keeps when the run fails (tutti-0vbd.2): none where an error between tests can't be
  // placed in a file (erredFiles).
  const verdict = (code: number, failing: ReadonlyArray<TestCase>): number => {
    const out = process.env.TUTTI_CHECK_OWN_PASSED
    if (out) {
      const files = [...new Set(cases.map((test) => test.file))]
      const erred = erredFiles(output, counts.error, files, process.cwd())
      writeFileSync(out, erred === undefined ? "" : passedFiles(cases, failing, erred).join("\n"))
    }
    return code
  }
  if (code === 0) return verdict(0, [])
  const failed = cases.filter((test) => test.failed)
  // A failure outside any test (a file that doesn't load, an error between tests) isn't in the
  // report and has no name to rerun: when bun counted one, the run fails as bun test did, but for
  // errors left over from tests that timed out, which their reruns stand for.
  if (failed.length === 0 || counts.fail !== failed.length) return verdict(code, failed)
  if (!timeoutLeftovers(output, counts.error, failed, process.cwd())) return verdict(code, failed)
  // A file's failed tests are rerun together, in one process, and the files side by side, as many at
  // a time as the first run's workers (tutti-0vbd.4): one after another, 19 failures took 779 s.
  // Each prints its output once it ends, in the order the failures came.
  const groups = rerunGroups(failed)
  const rerunWorkers = Math.min(
    testProcesses(
      machine,
      groups.map((group) => fileArgument(group.file)),
      sizing,
    ).processes,
    warned ? Math.max(1, workers - 1) : workers,
  )
  const environment = { ...suites, ...coreThreadVariables(machine, undefined, rerunWorkers) }
  const reruns = inPool(
    groups.map((group, index) => async () => {
      const report = join(reports, `rerun-${index}.xml`)
      const pattern = exactNamesPattern(group.tests.map((test) => test.name))
      const rerunArgs = [...limit, fileArgument(group.file), "--test-name-pattern", pattern]
      const rerun = await runBunTest(rerunArgs, report, temp, environment, false)
      return { ...rerun, reran: readReport(report) }
    }),
    rerunWorkers,
  )
  const stillFailing: Array<TestCase> = []
  for (const [index, group] of groups.entries()) {
    for (const test of group.tests) console.log(`\nRerunning ${test.file} ${test.name}`)
    const rerun = await reruns[index]
    if (rerun === undefined) continue
    process.stdout.write(rerun.out)
    process.stderr.write(rerun.err)
    const passed = passedOnRerun(group, rerun.code, rerun.output, rerun.reran, process.cwd())
    for (const test of group.tests) {
      if (passed.includes(test)) console.log(flakyLine(test))
      else stillFailing.push(test)
    }
  }
  return verdict(stillFailing.length === 0 ? 0 : 1, stillFailing)
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

/**
 * Removes the temp folders that earlier runs left in base, those named with the ID of a process
 * that has ended, and returns their paths. A link, or a folder another user owns, is left alone.
 */
export const removeStaleRuns = (
  base: string,
  alive: (pid: number) => boolean = processAlive,
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

/** One of this user's processes, as killLeftWorkers reads it: its command line and its TMPDIR. */
export interface UserProcess {
  readonly pid: number
  readonly command: string
  readonly tmpdir: string | undefined
}

/**
 * This user's processes in ps -E's output (macOS), a line each: the PID, the command line, then
 * the process's environment, which ps shows for this user's own processes only. The TMPDIR read is
 * the line's last.
 */
export const parsePsEnvironment = (text: string): ReadonlyArray<UserProcess> =>
  text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) return []
    const tmpdirs = [...match[2].matchAll(/(?:^|\s)TMPDIR=(\S+)/g)]
    return [{ pid: Number(match[1]), command: match[2], tmpdir: tmpdirs.at(-1)?.[1] }]
  })

/** Whether the command line is a bun test --parallel worker's. */
export const testWorkerCommand = (command: string): boolean =>
  /(?:^|\/)bun test --test-worker(?:\s|$)/.test(command)

/**
 * The test workers of runs that have ended, by the run's process ID: those whose TMPDIR is a run's
 * temp folder (runTempPid) named with the ID of a process that has gone, other than this run's.
 */
export const leftWorkers = (
  processes: ReadonlyArray<UserProcess>,
  alive: (pid: number) => boolean,
): ReadonlyMap<number, ReadonlyArray<number>> => {
  const left = new Map<number, Array<number>>()
  for (const { pid, command, tmpdir } of processes) {
    if (tmpdir === undefined || !testWorkerCommand(command)) continue
    const run = runTempPid(basename(tmpdir.replace(/\/+$/, "")))
    if (run === undefined || run === process.pid || alive(run)) continue
    left.set(run, [...(left.get(run) ?? []), pid])
  }
  return left
}

/** This user's processes, with their TMPDIR: from ps -E on macOS, from /proc on Linux. */
export const userProcesses = (platform: NodeJS.Platform = process.platform) => {
  if (platform === "darwin") {
    const uid = String(process.getuid?.() ?? "")
    const ps = Bun.spawnSync(["ps", "-E", "-ww", "-U", uid, "-o", "pid=,command="])
    return ps.exitCode === 0 ? parsePsEnvironment(ps.stdout.toString()) : []
  }
  let names: ReadonlyArray<string>
  try {
    names = readdirSync("/proc")
  } catch {
    return []
  }
  return names.flatMap((name): ReadonlyArray<UserProcess> => {
    if (!/^\d+$/.test(name)) return []
    try {
      // Another user's environ can't be read, so their processes are skipped.
      if (lstatSync(`/proc/${name}`).uid !== process.getuid?.()) return []
      const command = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim()
      const environment = readFileSync(`/proc/${name}/environ`, "utf8").split("\0")
      const tmpdir = environment.findLast((entry) => entry.startsWith("TMPDIR="))
      return [{ pid: Number(name), command, tmpdir: tmpdir?.slice("TMPDIR=".length) }]
    } catch {
      return []
    }
  })
}

const sigkill = (pid: number): boolean => {
  try {
    process.kill(pid, "SIGKILL")
    return true
  } catch {
    return false
  }
}

/**
 * Kills, with SIGKILL, the bun test workers runs that have ended left running (leftWorkers), and
 * returns a line for each such run. A run killed outright (SIGKILL, from Claude Code's Bash time
 * limit or a kill -9) can leave its workers behind, each in a process group of its own, and a
 * worker spinning in synchronous code ignores SIGTERM: two spun for days (tutti-gr4z.1).
 */
export const killLeftWorkers = (
  processes: ReadonlyArray<UserProcess> = userProcesses(),
  alive: (pid: number) => boolean = processAlive,
  kill: (pid: number) => boolean = sigkill,
): ReadonlyArray<string> =>
  [...leftWorkers(processes, alive)].flatMap(([run, workers]) => {
    const killed = workers.filter(kill).length
    if (killed === 0) return []
    const noun = killed === 1 ? "test worker" : "test workers"
    return [`scripts/test.sh: killed ${killed} ${noun} left by an earlier run (pid ${run})`]
  })

if (import.meta.main) {
  const stale = staleReport("scripts/test.sh", staleDependencies(resolve(import.meta.dir, "..")))
  for (const line of stale) console.error(line)
  if (stale.length > 0) process.exit(1)
  const base = runTempBase(process.env, process.platform)
  removeStaleRuns(base)
  for (const line of killLeftWorkers()) console.error(line)
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
