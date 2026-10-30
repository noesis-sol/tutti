// --feature "<request>" end to end (§ 5 item 13): `bun src/main.ts` inside a repository on real git
// set up with nothing to run, with a fake bd that logs what it is asked and a fake Claude Code
// (test/fixtures/fake-claude/claude.ts, behind --claude) that logs what it reads. On a terminal,
// the feature is talked through in the Interview view, the request the breakdown's first message,
// nothing asked first; without a terminal that shows it, the run ends with exit 2 and nothing
// filed; --yes and TUTTI_YES, gone with the unattended feature run, end it with exit 2 at the
// startup checks.
import { afterEach, describe, expect, setDefaultTimeout } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { featureUnavailable } from "../src/run/choose.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Each test starts tutti and Claude Code's fake as bun processes.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")
const fake = join(import.meta.dir, "fixtures", "fake-claude", "claude.ts")

/** The processes a test started, killed once it is done. */
const toKill: Array<number> = []

afterEach(() => {
  for (const pid of toKill.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Gone already.
    }
  }
})

/**
 * A repository `tutti init` has set up, with nothing to run, and a bin holding a fake bd that logs
 * each call to `bd.log` and answers `[]`, and `claude`, which prints a version and otherwise runs
 * the fake Claude Code.
 */
const setUp = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-feature-binary-")))
  const home = join(root, "home")
  const bin = join(root, "bin")
  const bdLog = join(root, "bd.log")
  const claudeLog = join(root, "claude.log")
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(join(bin, "bd"), `#!/bin/sh\necho "$*" >> '${bdLog}'\necho '[]'\n`, {
    mode: 0o755,
  })
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.301 (Claude Code)"; exit 0; fi
exec bun '${fake}' "$@"
`,
    { mode: 0o755 },
  )
  const repo = makeRepo()
  repo.commit("Set up tutti", {
    ".tutti/settings.json": "{}\n",
    ".tutti/worker-prompt.md": builtInWorkerPrompt,
  })
  mkdirSync(join(repo.dir, ".beads"))
  return { home, bin, bdLog, claudeLog, repo: repo.dir }
}

/** tutti's environment on the machine `setUp` made, with `variables` over the tests'. */
const envOf = (on: ReturnType<typeof setUp>, variables: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = {
    ...testEnv,
    ...variables,
    PATH: `${on.bin}:${testEnv.PATH ?? ""}`,
    HOME: on.home,
    FAKE_CLAUDE_SCENARIO: JSON.stringify({ log: on.claudeLog }),
  }
  // The fake's login is the one the probe finds.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")

/** A bare `tutti` with `args`, stdin no terminal, to its end: its exit code, stdout and stderr. */
const tutti = async (args: ReadonlyArray<string>, variables: Record<string, string> = {}) => {
  const on = setUp()
  const proc = Bun.spawn(["bun", main, "--claude", join(on.bin, "claude"), ...args], {
    cwd: on.repo,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: envOf(on, variables),
  })
  toKill.push(proc.pid)
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr, bd: read(on.bdLog) }
}

/** What the fake Claude Code read on stdin: the SDK's lines, as it logged them. */
const readByClaude = (log: string): ReadonlyArray<Record<string, unknown>> =>
  log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { stdin?: Record<string, unknown> })
    .flatMap((entry) => (entry.stdin === undefined ? [] : [entry.stdin]))

/**
 * A bare `tutti` with `args` on a pseudo-terminal, its stdin and stdout both, until a session's
 * first message holding `request` reaches the fake Claude Code, or tutti exits: what tutti wrote,
 * and the user messages the fake read.
 */
const onTerminal = async (args: ReadonlyArray<string>, request: string) => {
  const on = setUp()
  let written = ""
  const decoder = new TextDecoder()
  const proc = Bun.spawn(["bun", main, "--claude", join(on.bin, "claude"), ...args], {
    cwd: on.repo,
    env: { ...envOf(on), TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: {
      cols: 100,
      rows: 30,
      data: (_, data) => {
        written += decoder.decode(data, { stream: true })
      },
    },
  })
  toKill.push(proc.pid)
  let exited = false
  void proc.exited.then(() => {
    exited = true
  })
  const messages = () =>
    readByClaude(read(on.claudeLog))
      .filter((line) => line.type === "user")
      .map((line) => JSON.stringify(line))
  const deadline = Date.now() + 45_000
  while (!exited && Date.now() < deadline && !messages().some((m) => m.includes(request))) {
    await Bun.sleep(100)
  }
  // What it drew in the same breath.
  await Bun.sleep(300)
  if (!exited) proc.kill("SIGKILL")
  await proc.exited
  proc.terminal?.close()
  return { written, messages: messages(), bd: read(on.bdLog) }
}

/** What the startup checks say of --yes, or TUTTI_YES, as `given`: one of their problems. */
const yesProblem = (given: string) =>
  `\n  - ${given} is no longer read: --feature always talks the feature through with you; tutti --spec <file> runs a request written to a file unattended.\n`

/** What the renderer writes as it takes the screen: the alternate screen. */
const altScreen = "\x1b[?1049h"

describe("--feature on a terminal", () => {
  slow.test(
    "opens the Interview view, the request the breakdown's first message, nothing asked",
    async () => {
      const { written, messages, bd } = await onTerminal(
        ["--feature", "Add a greeting to the CLI"],
        "Add a greeting to the CLI",
      )
      expect(written).toContain(altScreen)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain("<pasted_content")
      expect(messages[0]).toContain("Add a greeting to the CLI")
      // No plan confirmation, and nothing filed by tutti itself.
      expect(written).not.toContain("[y/N]")
      expect(bd).not.toContain("create")
    },
  )
})

describe("--feature where it can't talk", () => {
  slow.test("without a terminal for the Interview view: exit 2, nothing filed", async () => {
    for (const args of [
      ["--feature", "Add a greeting"],
      ["--plain", "--feature", "Add a greeting"],
    ]) {
      const { code, stderr, bd } = await tutti(args)
      expect(stderr).toBe(`${featureUnavailable}\n`)
      expect(code).toBe(2)
      expect(bd).not.toContain("create")
    }
  })

  slow.test("--yes ends the run at the startup checks: exit 2, nothing filed", async () => {
    const { code, stderr, bd } = await tutti(["--feature", "Add a greeting", "--yes"])
    expect(stderr).toStartWith("tutti cannot start:\n")
    expect(stderr).toContain(yesProblem("--yes"))
    expect(code).toBe(2)
    expect(bd).not.toContain("create")
  })

  slow.test("TUTTI_YES ends the run the same, with --feature or without it", async () => {
    const withFeature = await tutti(["--feature", "Add a greeting"], { TUTTI_YES: "1" })
    expect(withFeature.stderr).toContain(yesProblem("TUTTI_YES"))
    expect(withFeature.code).toBe(2)
    const alone = await tutti(["--tickets"], { TUTTI_YES: "1" })
    expect(alone.stderr).toContain(yesProblem("TUTTI_YES"))
    expect(alone.code).toBe(2)
  })
})
