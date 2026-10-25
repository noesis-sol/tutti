// --overnight's open questions end to end (tutti-kkb.51): `bun src/main.ts --overnight --plain`
// without a terminal, inside a repository on real git, with a fake bd whose one open question
// blocks a ticket and a fake Claude Code behind --claude. Nothing is asked: once the pre-flight has
// cleared the run, the question is listed with the ticket it keeps waiting and how to answer it,
// before the run starts, and the log says it was left open.
import { describe, expect, setDefaultTimeout } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
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

const question = {
  id: "q-1",
  title: "Which flag name?",
  status: "open",
  labels: ["human"],
  metadata: {
    options: [
      { label: "--flag", description: "short" },
      { label: "--long-flag", description: "clear" },
    ],
    recommended: 1,
  },
}
const waiting = { id: "tut-2", title: "Waits", status: "open" }

/** bd: the question, and the ticket it blocks; nothing else to list. */
const bd = `#!/bin/sh
case "$1 $2" in
  "human list") echo '${JSON.stringify([question])}' ;;
  "show q-1") echo '${JSON.stringify([{ ...question, dependents: [{ ...waiting, dependency_type: "blocks" }] }])}' ;;
  "show tut-2") echo '${JSON.stringify([{ ...waiting, dependencies: [{ ...question, dependency_type: "blocks" }] }])}' ;;
  *) echo '[]' ;;
esac
`

describe("tutti --overnight without a terminal", () => {
  slow.test("lists the open questions before the run, nothing asked", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-overnight-questions-")))
    const home = join(root, "home")
    const bin = join(root, "bin")
    mkdirSync(home)
    mkdirSync(bin)
    writeFileSync(join(bin, "bd"), bd, { mode: 0o755 })
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
      ],
      { cwd: repo.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env },
    )
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(code).toBe(0)
    // The pre-flight's ready check warns: without a terminal, nothing puts the question first.
    expect(stdout).toContain(
      "  ! no ticket is ready, and 1 more waits only on questions, to be ready once it is answered: unless they are answered first (bd human respond), the run would end at once",
    )
    expect(stdout).toContain("◆ Overnight pre-flight: 1 question left open")
    expect(stdout).toContain(
      '  ! q-1 (Which flag name?): tut-2 waits on it. Answer it with bd human respond q-1 "<answer>"',
    )
    expect(stdout).not.toContain("Answered")
    expect(readFileSync(join(repo.dir, ".tutti", "tutti.log"), "utf8")).toContain(
      "overnight pre-flight: left open: q-1 (Which flag name?): tut-2 waits on it",
    )
  })
})
