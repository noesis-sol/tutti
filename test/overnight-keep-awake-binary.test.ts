// An overnight run keeps the machine awake from before its pre-flight (tutti-epza.17), whose
// questions may wait on a maintainer who has walked away: `bun src/main.ts --overnight --plain` in a
// repository on real git, with a fake bd, a fake Claude Code, and a fake keep-awake command on the
// PATH that says it ran. The log has it started before the pre-flight's first line, even in a run
// the pre-flight refuses.
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

describe("tutti --overnight", () => {
  slow.test("keeps the machine awake before its pre-flight", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-overnight-awake-")))
    const home = join(root, "home")
    const bin = join(root, "bin")
    const ran = join(root, "kept-awake")
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
    // The system's keep-awake command, macOS's or Linux's: it says it ran, then holds until killed.
    for (const command of ["caffeinate", "systemd-inhibit"]) {
      writeFileSync(join(bin, command), `#!/bin/sh\necho "$0" >> '${ran}'\nexec sleep 60\n`, {
        mode: 0o755,
      })
    }
    const repo = makeRepo()
    repo.commit("Set up tutti", {
      ".tutti/settings.json": `${JSON.stringify(
        { concurrent: 2, workers: { ticket_limit: "2h" }, checks: { fast: { command: "true" } } },
        null,
        2,
      )}\n`,
      ".tutti/worker-prompt.md": builtInWorkerPrompt,
      ".gitignore": ".tutti/run/\n.tutti/tutti.log\n",
    })
    mkdirSync(join(repo.dir, ".beads"))
    const env: Record<string, string | undefined> = {
      ...testEnv,
      PATH: `${bin}:${testEnv.PATH ?? ""}`,
      HOME: home,
      FAKE_CLAUDE_SCENARIO: JSON.stringify({ log: join(root, "claude.log") }),
    }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    const proc = Bun.spawn(
      [
        "bun",
        main,
        "--claude",
        join(bin, "claude"),
        "--overnight",
        "--plain",
        "--overnight-free-disk",
        "0",
        // A failed check: the pre-flight refuses the run, which never begins.
        "--limit",
        "1",
      ],
      { cwd: repo.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env },
    )
    const [code] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code).toBe(2)
    expect(existsSync(ran)).toBe(true)
    const log = readFileSync(join(repo.dir, ".tutti", "tutti.log"), "utf8").split("\n")
    const awake = log.findIndex((line) =>
      line.includes("keeping the machine awake while the run goes"),
    )
    const preflight = log.findIndex((line) => line.includes("overnight pre-flight: "))
    expect(awake).toBeGreaterThanOrEqual(0)
    expect(preflight).toBeGreaterThan(awake)
  })
})
