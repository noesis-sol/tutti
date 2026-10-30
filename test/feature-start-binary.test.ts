// A feature run's START block end to end (§ 4.10): `bun src/main.ts --feature "<request>"`, and a
// bare `bun src/main.ts` choosing New feature at the start question, on a pseudo-terminal, inside a repository on real git set up with nothing to run, with a fake bd that
// files and shows (test/fixtures/fake-bd/bd.ts) and a fake Claude Code (behind --claude) whose first
// turn files the epic and its ticket through tutti's own MCP tools, file_root then file_breakdown,
// as the interview's breakdown does. The interview ends filed, the run starts scoped to the epic,
// and the log's START block names `feature <epic>` and the request it was talked through from.
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
import { serverName } from "../src/agent/ticketTools.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { logFile } from "../src/run/log.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// tutti, its probes' Claude Code, the interview's and bd are bun processes of their own.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")
const fakeClaude = join(import.meta.dir, "fixtures", "fake-claude", "claude.ts")
const fakeBd = join(import.meta.dir, "fixtures", "fake-bd", "bd.ts")

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

/** The epic the fake bd files first. */
const epic = "demo-1"

/** The interview's first turn: the epic, then its one ticket, filed through tutti's tools. */
const filingTurn = [
  {
    mcp: {
      server: serverName,
      tool: "file_root",
      arguments: {
        title: "Greet on start",
        description: "The CLI greets you as it starts.",
        priority: 2,
      },
    },
  },
  {
    mcp: {
      server: serverName,
      tool: "file_breakdown",
      arguments: {
        root: epic,
        issues: [
          {
            key: "greeting",
            parent: "",
            type: "task",
            priority: 2,
            title: "Print a greeting",
            description: "Print a greeting as the CLI starts, as the root epic decided.",
            acceptance: "The CLI prints Hello as it starts.",
            labels: [],
            files: ["src/cli.ts"],
            waits_for: [],
          },
        ],
      },
    },
  },
  { text: "Filed the epic and its ticket." },
]

/**
 * A repository `tutti init` has set up, with nothing to run, and a bin holding the fake bd, its
 * issues and log in `bd/`, and `claude`, which prints a version and otherwise runs the fake Claude
 * Code with `scenario`, logging to `claude.log`.
 */
const setUp = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-feature-start-binary-")))
  const home = join(root, "home")
  const bin = join(root, "bin")
  const bdDir = join(root, "bd")
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(bdDir)
  writeFileSync(join(bin, "bd"), `#!/bin/sh\nFAKE_BD_DIR='${bdDir}' exec bun '${fakeBd}' "$@"\n`, {
    mode: 0o755,
  })
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.301 (Claude Code)"; exit 0; fi
exec bun '${fakeClaude}' "$@"
`,
    { mode: 0o755 },
  )
  const repo = makeRepo()
  repo.commit("Set up tutti", {
    ".tutti/settings.json": "{}\n",
    ".tutti/worker-prompt.md": builtInWorkerPrompt,
    ".gitignore": ".tutti/run/\n.tutti/tutti.log\n",
    "src/cli.ts": 'console.log("cli")\n',
  })
  mkdirSync(join(repo.dir, ".beads"))
  return { root, home, bin, bdDir, claudeLog: join(root, "claude.log"), repo: repo.dir }
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")

/** What the fake Claude Code's tool calls answered, as it logged them. */
const mcpAnswers = (log: string): ReadonlyArray<{ tool: string; answer: string }> =>
  log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { mcp?: { tool: string; answer: string } })
    .flatMap((entry) => (entry.mcp === undefined ? [] : [entry.mcp]))

/** What tutti has drawn on its pseudo-terminal, its escape sequences dropped, and keys to type. */
interface OnTerminal {
  /** Waits until tutti has drawn `text` since it started; fails after 30 s. */
  readonly drawn: (text: string) => Promise<void>
  /** Types `keys`, then lets tutti take them. */
  readonly type: (keys: string) => Promise<void>
}

/**
 * A bare `tutti` with `args` on a pseudo-terminal, its stdin and stdout both, `talk` given it to
 * type into once it has started, until its log has a START block that names a request, or it
 * exits: the log, what the fake bd was asked, and what the fake Claude Code's tool calls answered.
 */
const featureRun = async (
  args: ReadonlyArray<string>,
  talk: (on: OnTerminal) => Promise<void> = async () => {},
) => {
  const on = setUp()
  const env: Record<string, string | undefined> = {
    ...testEnv,
    PATH: `${on.bin}:${testEnv.PATH ?? ""}`,
    HOME: on.home,
    FAKE_CLAUDE_SCENARIO: JSON.stringify({
      log: on.claudeLog,
      // tutti's in-process server, as Claude Code lists the SDK's servers it was given.
      init: { mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }] },
      turns: [filingTurn],
    }),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  }
  // The fake's login is the one the probe finds.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  let written = ""
  const decoder = new TextDecoder()
  const proc = Bun.spawn(["bun", main, "--claude", join(on.bin, "claude"), ...args], {
    cwd: on.repo,
    env,
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
  const plain = () => Bun.stripANSI(written)
  await talk({
    drawn: async (text) => {
      const deadline = Date.now() + 30_000
      while (!exited && Date.now() < deadline && !plain().includes(text)) await Bun.sleep(50)
      if (!plain().includes(text)) throw new Error(`tutti didn't draw ${JSON.stringify(text)}`)
    },
    type: async (keys) => {
      proc.terminal?.write(keys)
      await Bun.sleep(300)
    },
  })
  const log = () => read(join(on.repo, logFile))
  const deadline = Date.now() + 45_000
  while (!exited && Date.now() < deadline && !log().includes("talked through from")) {
    await Bun.sleep(100)
  }
  if (!exited) proc.kill("SIGKILL")
  await proc.exited
  proc.terminal?.close()
  return {
    log: log(),
    bd: read(join(on.bdDir, "bd.log")),
    answers: mcpAnswers(read(on.claudeLog)),
  }
}

/** Expects `ran` filed the epic and its ticket, and started the run on it, talked through from `request`. */
const expectFeatureRun = (ran: Awaited<ReturnType<typeof featureRun>>, request: string) => {
  const { log, bd, answers } = ran
  // The breakdown's tools filed the epic and its ticket, through bd.
  expect(answers.map((a) => a.tool)).toEqual(["file_root", "file_breakdown"])
  expect(answers[0]?.answer).toBe(`Filed the root epic ${epic}.`)
  expect(answers[1]?.answer).toContain(`${epic}.1 (greeting) Print a greeting`)
  expect(bd).toContain("create --json --title=Greet on start")
  expect(log).toContain(`filed ${epic}: 1 ticket, starting the run`)
  const lines = log.split("\n")
  const at = lines.findIndex((line) => line.includes(" START tutti "))
  expect(at).toBeGreaterThan(-1)
  expect(lines[at]).toContain(` · feature ${epic} (`)
  expect(lines[at + 1]).toEndWith(`  feature: epic ${epic}, talked through from: ${request}`)
}

describe("a feature filed in the interview starts the run on its epic", () => {
  slow.test("--feature: the START block names the epic and the request", async () => {
    const ran = await featureRun(["--feature", "Add a greeting\n  to the CLI"])
    expectFeatureRun(ran, "Add a greeting to the CLI")
  })

  slow.test("New feature: the START block names the epic and the description typed", async () => {
    const ran = await featureRun([], async (on) => {
      await on.drawn("What should this run work on?")
      // Down twice to New feature, below Spec.
      await on.type("\x1b[B")
      await on.type("\x1b[B")
      await on.drawn("> New feature")
      await on.type("\r")
      await on.drawn("Describe the feature")
      // Ctrl+J starts a new line.
      await on.type("Greet whoever\nstarts the CLI")
      await on.type("\r")
    })
    expectFeatureRun(ran, "Greet whoever starts the CLI")
  })
})
