// --overnight end to end (tutti-kkb.46): `bun src/main.ts --overnight --plain` inside a repository
// on real git, with a fake bd whose backlog is empty and a fake Claude Code behind --claude. A failed
// pre-flight check refuses the run with the setup exit code, 2, saying so on stderr, before anything
// is recorded; --force-overnight starts it, and its start record has "overnight": true, with the
// auto-answer --overnight turns on.
import { describe, expect, setDefaultTimeout } from "bun:test"
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
import { makeRepo } from "./git.ts"

// tutti, its probes' Claude Code and the merge check are processes of their own.
setDefaultTimeout(90_000)

const main = join(import.meta.dir, "..", "src", "main.ts")
const fake = join(import.meta.dir, "fixtures", "fake-claude", "claude.ts")

/**
 * A repository tutti has set up, committed and clean, whose settings pass every failing check but
 * --limit's, and a bin holding a bd with nothing to run and the fake Claude Code.
 */
const setUp = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-overnight-binary-")))
  const home = join(root, "home")
  const bin = join(root, "bin")
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
  const repo = makeRepo()
  const settings = {
    concurrent: 2,
    workers: { ticket_limit: "2h" },
    checks: { fast: { command: "true" } },
  }
  repo.commit("Set up tutti", {
    ".tutti/settings.json": `${JSON.stringify(settings, null, 2)}\n`,
    ".tutti/worker-prompt.md": builtInWorkerPrompt,
    ".gitignore": ".tutti/run/\n.tutti/tutti.log\n",
  })
  mkdirSync(join(repo.dir, ".beads"))
  return { repo: repo.dir, home, bin, log: join(root, "claude.log") }
}

/** Runs `tutti --overnight --plain` with `args` in the repository; its exit code and output. */
const overnight = async (on: ReturnType<typeof setUp>, args: ReadonlyArray<string>) => {
  const env: Record<string, string | undefined> = {
    ...testEnv,
    PATH: `${on.bin}:${testEnv.PATH ?? ""}`,
    HOME: on.home,
    FAKE_CLAUDE_SCENARIO: JSON.stringify({ log: on.log }),
  }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const proc = Bun.spawn(
    [
      "bun",
      main,
      "--claude",
      join(on.bin, "claude"),
      "--overnight",
      "--plain",
      // A test machine's free disk is no concern of the test's.
      "--overnight-free-disk",
      "0",
      ...args,
    ],
    { cwd: on.repo, stdin: "ignore", stdout: "pipe", stderr: "pipe", env },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** The run's records in the repository's event stream. */
const records = (repo: string): ReadonlyArray<Record<string, unknown>> => {
  const file = join(repo, ".tutti", "run", "events.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : []
}

describe("tutti --overnight", () => {
  slow.test("refuses the run on a failed check left, with exit code 2", async () => {
    const on = setUp()
    const ran = await overnight(on, ["--limit", "1"])
    expect(ran.code).toBe(2)
    expect(ran.stdout).toContain("◆ Overnight pre-flight: 1 failed, ")
    expect(ran.stdout).toContain("  ✗ --limit 1 is set: the run would stop after 1 ticket")
    expect(ran.stdout).toContain("  ✓ the merge check 'true' passes on main at ")
    expect(ran.stderr).toContain(
      "tutti --overnight cannot start: 1 check failed. Fix what the checklist says, or start anyway with --force-overnight.",
    )
    // Refused before its start: nothing recorded, and the log keeps why.
    expect(records(on.repo).filter((record) => record.kind === "start")).toEqual([])
    expect(readFileSync(join(on.repo, ".tutti", "tutti.log"), "utf8")).toContain(
      "overnight pre-flight: 1 check failed: the run doesn't start",
    )
  })

  slow.test("--force-overnight starts it, its start record overnight", async () => {
    const on = setUp()
    const ran = await overnight(on, ["--limit", "1", "--force-overnight"])
    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain(
      "◆ overnight pre-flight: starting with 1 check failed (--force-overnight)",
    )
    const start = records(on.repo).find((record) => record.kind === "start")
    expect(start).toMatchObject({ overnight: true, auto_answer: 0 })
  })
})
