// tutti init's own command end to end (§ 7): `bun src/main.ts init` without a terminal, which asks
// nothing and takes the flags, in a temp repository on real git with a fake bd on the PATH. Its
// refusals (outside a repository, in a linked worktree, flag problems), --update in a set-up
// project, and a whole init's summary, a failing bd init's included, through runInit and the live
// machine it runs bd on.
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
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Each test starts tutti as a bun process, which bun's 5 s default fails beside other checks.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")

/**
 * A folder for the test: a home for Claude Code's user config, and a bin holding a fake bd that
 * logs each call to `bd.log`; `bd init` makes .beads (or fails, with `failInit`), `bd config`
 * answers the prefix `demo`, and every other call `[]`.
 */
const machine = (failInit = false) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-command-")))
  const home = join(root, "home")
  const bin = join(root, "bin")
  const log = join(root, "bd.log")
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(
    join(bin, "bd"),
    `#!/bin/sh
echo "bd $*" >> '${log}'
case "$1" in
  init) ${failInit ? "echo 'bd: the database is locked' >&2; exit 1" : "mkdir -p .beads"} ;;
  config) echo '{"schema_version":1,"data":{"key":"issue_prefix","value":"demo"}}' ;;
  *) echo '[]' ;;
esac
`,
    { mode: 0o755 },
  )
  return { root, home, bin, log }
}

type Machine = ReturnType<typeof machine>

/** `tutti init` with `args` in `cwd`, stdin and stdout no terminal: its exit code, stdout and stderr. */
const tuttiInit = async (on: Machine, cwd: string, args: ReadonlyArray<string> = []) => {
  const env: Record<string, string | undefined> = {
    ...testEnv,
    PATH: `${on.bin}:${testEnv.PATH ?? ""}`,
    HOME: on.home,
  }
  // No login from the machine's environment: the login probe finds none either way.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const proc = Bun.spawn(["bun", main, "init", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

const bdCalls = (on: Machine): ReadonlyArray<string> =>
  existsSync(on.log) ? readFileSync(on.log, "utf8").trimEnd().split("\n") : []

/** The files a whole init writes. */
const setupFiles = [
  ".tutti/worker-prompt.md",
  ".tutti/settings.json",
  ".tutti/.gitignore",
  "scripts/check-fast.sh",
  "scripts/check-full.sh",
]

describe("tutti init's refusals", () => {
  slow.test("outside a git repository: its line, exit 2, nothing run", async () => {
    const on = machine()
    const folder = join(on.root, "not-a-repository")
    mkdirSync(folder)
    const { code, stdout, stderr } = await tuttiInit(on, folder)
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toBe("tutti init: Not inside a git repository: cd into the project first.\n")
    expect(bdCalls(on)).toEqual([])
    expect(existsSync(join(folder, ".tutti"))).toBe(false)
  })

  slow.test("in a linked worktree: exit 2, and to run it from the main checkout", async () => {
    const on = machine()
    const repo = makeRepo()
    const worktree = repo.worktree("feature")
    const { code, stdout, stderr } = await tuttiInit(on, worktree)
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      `tutti init: ${worktree} is a linked worktree. Run this from the main checkout.\n`,
    )
    expect(bdCalls(on)).toEqual([])
    expect(existsSync(join(worktree, ".tutti"))).toBe(false)
    expect(existsSync(join(repo.dir, ".tutti"))).toBe(false)
  })

  slow.test(
    "flag problems: exit 2, each problem a `tutti init:` line, nothing written",
    async () => {
      const on = machine()
      const repo = makeRepo()
      const { code, stdout, stderr } = await tuttiInit(on, repo.dir, [
        "--update",
        "--force",
        "--concurrent",
        "0",
        "--verifier=maybe",
      ])
      expect(code).toBe(2)
      expect(stdout).toBe("")
      const lines = stderr.trimEnd().split("\n")
      expect(lines).toHaveLength(3)
      for (const line of lines) expect(line.startsWith("tutti init: ")).toBe(true)
      expect(lines[0]).toStartWith("tutti init: --concurrent ")
      expect(lines[0]).toContain("'0'")
      expect(lines[1]).toStartWith("tutti init: --verifier ")
      expect(lines[2]).toBe(
        "tutti init: --update takes no other flag: run tutti init without it to change the rest",
      )
      expect(bdCalls(on)).toEqual([])
      expect(existsSync(join(repo.dir, ".tutti"))).toBe(false)
    },
  )
})

describe("tutti init without a terminal", () => {
  slow.test("a whole init: the summary on stdout, .tutti/ written, exit 0", async () => {
    const on = machine()
    const repo = makeRepo()
    const { code, stdout, stderr } = await tuttiInit(on, repo.dir, ["--concurrent", "3"])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    // Without a terminal, the summary's plain lines: no colour, no form.
    expect(stdout).not.toContain("\u001b[")
    const lines = stdout.split("\n")
    expect(lines[0]).toStartWith("✓ Beads  ran bd init")
    expect(lines).toContain(
      "✓ worker prompt  wrote .tutti/worker-prompt.md from the built-in template",
    )
    expect(lines).toContain("✓ settings  wrote .tutti/settings.json")
    expect(lines).toContain(
      "✓ .gitignore  wrote .tutti/.gitignore: the log, the reports and the run's files",
    )
    expect(lines.some((line) => line.startsWith("✓ concurrent  3 tickets at the same time"))).toBe(
      true,
    )
    expect(stdout).toContain("• verifier  not asked (no terminal)")
    expect(lines).toContain("Next:")
    expect(stdout).toContain("  Commit .tutti/, scripts/check-fast.sh and scripts/check-full.sh.")
    // The live machine ran the fake bd in the repository.
    expect(bdCalls(on)).toContain("bd init --non-interactive --role maintainer --init-if-missing")
    expect(existsSync(join(repo.dir, ".beads"))).toBe(true)
    for (const path of setupFiles) {
      expect(`${path} ${existsSync(join(repo.dir, path))}`).toBe(`${path} true`)
    }
    const settings = JSON.parse(readFileSync(join(repo.dir, ".tutti/settings.json"), "utf8"))
    expect(settings.concurrent).toBe(3)
    expect(settings.checks.fast.command).toBe("scripts/check-fast.sh")
  })

  slow.test(
    "bd init failing: a ✗ Beads line with bd's output, the rest written, exit 0",
    async () => {
      const on = machine(true)
      const repo = makeRepo()
      const { code, stdout, stderr } = await tuttiInit(on, repo.dir)
      expect(stderr).toBe("")
      expect(code).toBe(0)
      const failed =
        "bd init --non-interactive --role maintainer --init-if-missing failed (exit status 1): bd: the database is locked"
      expect(stdout.split("\n")[0]).toBe(`✗ Beads  ${failed}`)
      expect(stdout).toContain(`  Fix what's missing above (Beads: ${failed})`)
      expect(existsSync(join(repo.dir, ".beads"))).toBe(false)
      for (const path of setupFiles) {
        expect(`${path} ${existsSync(join(repo.dir, path))}`).toBe(`${path} true`)
      }
    },
  )

  slow.test("--update in a set-up project: its lines, exit 0, the files as they were", async () => {
    const on = machine()
    const repo = makeRepo()
    const first = await tuttiInit(on, repo.dir)
    expect(first.code).toBe(0)
    const prompt = readFileSync(join(repo.dir, ".tutti/worker-prompt.md"), "utf8")
    const calls = bdCalls(on).length

    const { code, stdout, stderr } = await tuttiInit(on, repo.dir, ["--update"])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout.trimEnd().split("\n")).toEqual([
      "• worker prompt  .tutti/worker-prompt.md has every change to its template",
      "",
      "Next:",
      "  Nothing to commit: the worker prompt and the verifier have every change to their templates.",
    ])
    expect(readFileSync(join(repo.dir, ".tutti/worker-prompt.md"), "utf8")).toBe(prompt)
    // --update asks nothing of Beads.
    expect(bdCalls(on)).toHaveLength(calls)
  })
})
