// Quitting a run end to end (§ 4.8's Quitting, § 7.4's signals): `bun src/main.ts` inside a
// repository on real git, with a fake bd that hands the run one ready ticket and a fake Claude Code
// (test/fixtures/fake-claude/claude.ts, behind --claude) whose worker hangs in its turn. SIGINT,
// SIGTERM or SIGHUP during the run goes to it (src/run/quit.ts's runMain and listen), not to the
// command: the run interrupts the worker, closes its session, saves it in state.json, leaves the
// ticket as it is, and ends INTERRUPTED, exit 130. A signal before the run starts is
// test/run-binary.test.ts's.
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
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

// tutti, its probe's and its worker's Claude Code are bun processes, which bun's 5 s default fails
// beside other checks.
setDefaultTimeout(90_000)

const main = join(import.meta.dir, "..", "src", "main.ts")
const fake = join(import.meta.dir, "fixtures", "fake-claude", "claude.ts")

/** The ticket the fake bd hands the run: it names a file, so the run predicts no footprint. */
const ticket = {
  id: "demo-1",
  title: "A ticket",
  description: "Change the README.",
  status: "open",
  priority: 2,
  issue_type: "task",
  created_at: "2026-10-16T21:35:18Z",
  metadata: { files: ["README.md"] },
}

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
 * A folder for the test: a home for Claude Code's user config, and a bin holding the fake bd and
 * `claude`. The fake bd logs its arguments to `bd.log` and answers with the one ticket: bd ready and
 * bd show give it, bd update gives it back claimed, another command on it gives it back, and the
 * rest `[]`. `claude` prints a version and otherwise runs the fake Claude Code, which logs to
 * `claude.log`.
 */
const machine = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-run-binary-quit-")))
  const home = join(root, "home")
  const bin = join(root, "bin")
  mkdirSync(home)
  mkdirSync(bin)
  const open = JSON.stringify([ticket])
  const claimed = JSON.stringify([{ ...ticket, status: "in_progress", assignee: "A Maintainer" }])
  writeFileSync(
    join(bin, "bd"),
    `#!/bin/sh
echo "$*" >> '${join(root, "bd.log")}'
case "$1 $2" in
  "ready "*) echo '${open}' ;;
  "show demo-1") echo '${open}' ;;
  "update demo-1") echo '${claimed}' ;;
  *demo-1*) echo '${open}' ;;
  *) echo '[]' ;;
esac
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.301 (Claude Code)"; exit 0; fi
exec bun '${fake}' "$@"
`,
    { mode: 0o755 },
  )
  return { root, home, bin, log: join(root, "claude.log"), bdLog: join(root, "bd.log") }
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

/** Starts a bare `tutti` in `cwd`, stdin no terminal, its Claude Code playing `scenario`. */
const startTutti = (on: Machine, cwd: string, scenario: object) => {
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

/** The fake Claude Code's log: one entry a line, the processes' interleaved. */
const entries = (on: Machine): ReadonlyArray<Record<string, unknown>> =>
  existsSync(on.log)
    ? readFileSync(on.log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : []

/** The ID a Claude Code process was started with, from its arguments' entry, if it is a worker. */
const sessionOf = (entry: Record<string, unknown>): string | undefined =>
  Array.isArray(entry.args)
    ? entry.args
        .find((arg: string) => arg.startsWith("--session-id="))
        ?.slice("--session-id=".length)
    : undefined

/** Whether the entry is a line Claude Code read of this type: `user`, or a control request's subtype. */
const read = (entry: Record<string, unknown>, type: string): boolean => {
  const stdin = entry.stdin as { type?: string; request?: { subtype?: string } } | undefined
  return stdin?.type === type || stdin?.request?.subtype === type
}

/**
 * Starts a run on the ticket and waits until its worker has its prompt, in a turn that hangs until
 * interrupted: the worker's entries in the fake's log, from its arguments on. The run's other
 * Claude Code, the login probe's, has ended by then.
 */
const runUntilWorking = async (on: Machine, repo: Repo) => {
  const proc = startTutti(on, repo.dir, {
    // The worker's session lists the MCP server tutti gives it, as Claude Code does.
    init: { mcp_servers: [{ name: "tutti", status: "connected", source: "sdk" }] },
    turns: [[{ hang: true }]],
  })
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  const worker = () => {
    const all = entries(on)
    const start = all.findIndex((entry) => sessionOf(entry) !== undefined)
    return start === -1 ? [] : all.slice(start)
  }
  const deadline = Date.now() + 60_000
  while (!worker().some((entry) => read(entry, "user")) && Date.now() < deadline) {
    if (!alive(proc.pid)) break
    await Bun.sleep(50)
  }
  if (!worker().some((entry) => read(entry, "user"))) {
    throw new Error(`the worker never started:\n${await stdout}${await stderr}`)
  }
  return { proc, stdout, stderr, worker }
}

describe("a signal during a run", () => {
  for (const [signal, how] of [
    ["SIGINT", "with Ctrl+C"],
    ["SIGTERM", "by SIGTERM"],
    ["SIGHUP", "by SIGHUP"],
  ] as const) {
    slow.test(
      `${signal} quits the run: the worker interrupted, its session closed and saved, INTERRUPTED, exit 130`,
      async () => {
        const on = machine()
        const repo = setUpRepo()
        const { proc, stdout, stderr, worker } = await runUntilWorking(on, repo)
        const sent = Date.now()
        proc.kill(signal)
        const code = await proc.exited
        expect(Date.now() - sent).toBeLessThan(20_000)
        const out = await stdout
        expect(await stderr).toBe("")
        expect(out).toContain(
          `QUIT ${how}: no new tickets; interrupting the workers of demo-1 and saving their sessions for the next run\n`,
        )
        expect(out).toContain(
          `INTERRUPTED: quit ${how}; demo-1's session is saved for the next run\n`,
        )
        expect(code).toBe(130)
        // The worker's turn was interrupted, then its session closed: Claude Code's stdin ended.
        const logged = worker()
        const session = sessionOf(logged[0] ?? {})
        const interrupt = logged.findIndex((entry) => read(entry, "interrupt"))
        const closed = logged.findIndex((entry) => entry.closed === true)
        expect(interrupt).toBeGreaterThan(-1)
        expect(closed).toBeGreaterThan(interrupt)
        // The session is saved for the next run, suspended by the quit.
        const state = JSON.parse(
          readFileSync(join(repo.dir, ".tutti", "run", "state.json"), "utf8"),
        )
        expect(state.tickets["demo-1"]).toMatchObject({ session_id: session, suspended: "quit" })
        // The ticket is left as it was: neither closed nor deferred.
        expect(readFileSync(on.bdLog, "utf8")).not.toMatch(/^(close|defer) /m)
      },
    )
  }
})
