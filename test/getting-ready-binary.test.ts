// The getting-ready line on a real terminal (src/run/gettingReady.ts, § 7.1): `bun src/main.ts` on
// a pseudo-terminal, inside a repository on real git set up with nothing to run, with a fake bd and
// a fake Claude Code (test/fixtures/fake-claude/claude.ts, behind --claude). On each path of the
// run's start the line is drawn while the checks go and is erased, with nothing left, before the
// first thing else is written: the renderer taking the screen, the Nothing to run box, a plain
// run's log lines, why the run can't start, and --feature's first organ line.
import { afterEach, describe, expect, setDefaultTimeout } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eraseLine } from "../src/print/organLine.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Each test starts tutti and Claude Code's fake as bun processes.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")
const fake = join(import.meta.dir, "fixtures", "fake-claude", "claude.ts")

/** What the renderer writes as it takes the screen: the alternate screen. */
const altScreen = "\x1b[?1049h"

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
 * A repository `tutti init` has set up, with nothing to run, and a bin holding a fake bd that
 * answers `[]` to everything and `claude`, which prints a version and otherwise runs the fake.
 */
const setUp = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-getting-ready-")))
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
  repo.commit("Set up tutti", {
    ".tutti/settings.json": "{}\n",
    ".tutti/worker-prompt.md": builtInWorkerPrompt,
  })
  mkdirSync(join(repo.dir, ".beads"))
  return { home, bin, repo: repo.dir }
}

/**
 * A bare `tutti` with `args` on a pseudo-terminal, its stdin and stdout both, until what it wrote
 * holds `until` or it exits: everything it wrote.
 */
const onTerminal = async (args: ReadonlyArray<string>, until: string) => {
  const on = setUp()
  const env: Record<string, string | undefined> = {
    ...testEnv,
    PATH: `${on.bin}:${testEnv.PATH ?? ""}`,
    HOME: on.home,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FAKE_CLAUDE_SCENARIO: JSON.stringify({}),
  }
  // The fake's login is the one the probe finds.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  let written = ""
  const decoder = new TextDecoder()
  const { promise: seen, resolve } = Promise.withResolvers<void>()
  const proc = Bun.spawn(["bun", main, "--claude", join(on.bin, "claude"), ...args], {
    cwd: on.repo,
    env,
    terminal: {
      cols: 100,
      rows: 30,
      data: (_, data) => {
        written += decoder.decode(data, { stream: true })
        if (written.includes(until)) resolve()
      },
    },
  })
  toKill.push(proc.pid)
  await Promise.race([seen, proc.exited])
  // What the line wrote in the same breath as what ended it.
  await Bun.sleep(200)
  if (alive(proc.pid)) process.kill(proc.pid, "SIGKILL")
  await proc.exited
  proc.terminal?.close()
  return written
}

const sequences =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what is stripped
  /\x1b\[[0-9;?$>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[P_][^\x1b]*\x1b\\|\x1b[78]/g

/** What `text` shows: its escape sequences, the terminal's queries and styles, left out. */
const visible = (text: string): string => text.replace(sequences, "")

/**
 * What tutti wrote, split where the getting-ready line was last erased: the line's frames, drawn
 * and then erased, and what followed it, which holds none of them.
 */
const afterTheLine = (written: string) => {
  const last = written.lastIndexOf("Getting ready")
  expect(last).toBeGreaterThan(-1)
  const erased = written.indexOf(eraseLine, last)
  expect(erased).toBeGreaterThan(-1)
  // Between the last frame and its erasing, only the rest of that frame: its text and its styles.
  expect(written.slice(last, erased)).not.toContain("\n")
  expect(written.slice(last, erased)).not.toContain(altScreen)
  const rest = written.slice(erased + eraseLine.length)
  expect(rest).not.toContain("Getting ready")
  // Before the first frame, nothing of tutti's.
  expect(visible(written.slice(0, written.indexOf(eraseLine))).trim()).toBe("")
  return rest
}

describe("the getting-ready line on a terminal", () => {
  slow.test("is erased before the renderer takes the screen for the start question", async () => {
    const rest = afterTheLine(await onTerminal([], altScreen))
    expect(rest).toContain(altScreen)
    // Nothing reached the main screen before the renderer took it but its queries.
    expect(visible(rest.slice(0, rest.indexOf(altScreen))).trim()).toBe("")
  })

  slow.test("is erased before the Nothing to run box", async () => {
    const rest = afterTheLine(await onTerminal(["--tickets"], "All done"))
    expect(visible(rest)).toMatch(/^╭/)
    expect(rest).toContain("All done")
  })

  slow.test("is erased before a plain run's log lines", async () => {
    const rest = afterTheLine(await onTerminal(["--plain", "--tickets"], "READY_EMPTY"))
    expect(rest).toContain("READY_EMPTY")
    expect(rest).not.toContain(altScreen)
  })

  slow.test("is erased before why the run can't start", async () => {
    const rest = afterTheLine(await onTerminal(["--yes"], "cannot start"))
    expect(visible(rest)).toMatch(/^tutti cannot start:/)
  })

  slow.test("is erased before --feature's first organ line: one spinner at a time", async () => {
    // The fake gives the screening no answer: its line spins, or ends at once with its outcome.
    const rest = afterTheLine(
      await onTerminal(["--feature", "Add a greeting", "--yes"], "screen the request"),
    )
    expect(visible(rest)).toMatch(/^(⣾ Screening the request|◆ Request not screened)/)
  })
})
