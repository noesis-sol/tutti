// A bare `tutti` end to end (§ 5): `bun src/main.ts` inside a repository on real git, with a fake bd
// and a fake Claude Code (test/fixtures/fake-claude/claude.ts, behind --claude) on the PATH, so the
// startup checks pass but for the problem a test makes. Its refusals, each exit 2 with its problem
// on stderr: a repository without .tutti/, a dirty main checkout, a detached HEAD, and a second run
// while another holds the run lock (test/fixtures/run-lock/holder.ts). A signal before the run
// starts interrupts the command (src/run/quit.ts's runMain): exit 130.
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
import { notSetUpMessage } from "../src/run/startup.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

// Each test starts tutti and Claude Code's fake as bun processes, which bun's 5 s default fails
// beside other checks.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")
const fake = join(import.meta.dir, "fixtures", "fake-claude", "claude.ts")
const holderScript = join(import.meta.dir, "fixtures", "run-lock", "holder.ts")

/** The processes a test started, killed once it is done. */
const toKill: Array<number> = []

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const pid of toKill.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL")
})

/**
 * A folder for the test: a home for Claude Code's user config, and a bin holding a fake bd that
 * answers `[]` to everything, and `claude`, which prints a version and otherwise runs the fake
 * Claude Code, which logs to `claude.log` as it starts.
 */
const machine = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-run-binary-")))
  const home = join(root, "home")
  const bin = join(root, "bin")
  const log = join(root, "claude.log")
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(join(bin, "bd"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 })
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.301 (Claude Code)"; exit 0; fi
exec bun '${fake}' "$@"
`,
    { mode: 0o755 },
  )
  return { root, home, bin, log }
}

type Machine = ReturnType<typeof machine>

/** A repository `tutti init` has set up, committed and clean, with a Beads database. */
const setUpRepo = (): Repo => {
  const repo = makeRepo()
  repo.commit("Set up tutti", {
    ".tutti/settings.json": "{}\n",
    ".tutti/worker-prompt.md": builtInWorkerPrompt,
  })
  mkdirSync(join(repo.dir, ".beads"))
  return repo
}

/**
 * Starts a bare `tutti` in `cwd`, stdin no terminal, with the fake Claude Code playing `scenario`
 * (test/fixtures/fake-claude/claude.ts's FAKE_CLAUDE_SCENARIO).
 */
const startTutti = (on: Machine, cwd: string, scenario: object = {}) => {
  const env: Record<string, string | undefined> = {
    ...testEnv,
    PATH: `${on.bin}:${testEnv.PATH ?? ""}`,
    HOME: on.home,
    FAKE_CLAUDE_SCENARIO: JSON.stringify({ log: on.log, ...scenario }),
  }
  // The fake's login is the one the probe finds.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const proc = Bun.spawn(["bun", main, "--claude", join(on.bin, "claude"), "--plain"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  toKill.push(proc.pid)
  return proc
}

/** A bare `tutti` in `cwd` to its end: its exit code, stdout and stderr. */
const tutti = async (on: Machine, cwd: string) => {
  const proc = startTutti(on, cwd)
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** Starts the lock's holder for the repository's git folder and waits until it holds the lock. */
const holdLock = async (commonDir: string) => {
  const holder = Bun.spawn(["bun", holderScript, commonDir, "tutti"], {
    stdout: "pipe",
    stderr: "inherit",
  })
  toKill.push(holder.pid)
  let out = ""
  const decoder = new TextDecoder()
  for await (const chunk of holder.stdout) {
    out += decoder.decode(chunk)
    if (/^(held|.* running in .*)$/m.test(out)) break
  }
  expect(out).toMatch(/^held$/m)
  return holder.pid
}

describe("a bare tutti's startup refusals", () => {
  slow.test("a repository without .tutti/: exit 2, and to run tutti init", async () => {
    const on = machine()
    const repo = makeRepo()
    const { code, stdout, stderr } = await tutti(on, repo.dir)
    expect(stderr).toBe(`${notSetUpMessage}\n`)
    expect(stdout).toBe("")
    expect(code).toBe(2)
  })

  slow.test("a dirty main checkout: exit 2, its uncommitted changes named", async () => {
    const on = machine()
    const repo = setUpRepo()
    repo.write({ "README.md": "changed\n" })
    const { code, stderr } = await tutti(on, repo.dir)
    expect(stderr).toBe(
      "tutti cannot start:\n" +
        "  - The main checkout has uncommitted changes (README.md). Commit or stash them first: finished tickets merge into it. Inspect with: git status\n",
    )
    expect(code).toBe(2)
  })

  slow.test("a detached HEAD: exit 2, and to check out a branch", async () => {
    const on = machine()
    const repo = setUpRepo()
    repo.git(["checkout", "--quiet", "--detach"])
    const { code, stderr } = await tutti(on, repo.dir)
    expect(stderr).toBe(
      "tutti cannot start:\n" +
        "  - The main checkout is on a detached HEAD. Check out the branch finished tickets should land on.\n",
    )
    expect(code).toBe(2)
  })

  slow.test("a second tutti while another holds the run lock: refused, exit 2", async () => {
    const on = machine()
    const repo = setUpRepo()
    const pid = await holdLock(join(repo.dir, ".git"))
    const { code, stdout, stderr } = await tutti(on, repo.dir)
    expect(stderr).toContain(`tutti is already running in ${repo.dir}`)
    expect(stderr).toContain(`pid ${pid}`)
    expect(stdout).toBe("")
    expect(code).toBe(2)
    // The startup checks passed before the lock refused it: the probe's Claude Code ran.
    expect(existsSync(on.log)).toBe(true)
  })
})

describe("a signal before the run starts", () => {
  slow.test("SIGINT during the startup checks interrupts tutti: exit 130", async () => {
    const on = machine()
    const repo = setUpRepo()
    // The probe's Claude Code takes its time to answer, so tutti is still in its startup checks.
    const proc = startTutti(on, repo.dir, { initializeLag: 30_000 })
    const deadline = Date.now() + 30_000
    while (!(existsSync(on.log) && readFileSync(on.log, "utf8") !== "") && Date.now() < deadline) {
      await Bun.sleep(50)
    }
    expect(existsSync(on.log)).toBe(true)
    const sent = Date.now()
    proc.kill("SIGINT")
    const code = await proc.exited
    expect(code).toBe(130)
    expect(Date.now() - sent).toBeLessThan(20_000)
  })
})
