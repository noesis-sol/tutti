// M0 spike (tutti-nrg.1.7): the program compiled with `bun build --compile`, Claude Code embedded.
// An entry in `entries/` imports one platform's `claude` as a file and calls `run` with its path;
// `build.ts` compiles an entry. Then:
//
//   ./tutti-spike-<target> <step>... [--claude <path>]
//
// Steps: extract, version, auth, probe, turn, frame, tty-frame, login, all (every step but turn,
// tty-frame and login). Each prints one line `RESULT <step> {...}` on stdout. `--claude` runs the
// steps with another Claude Code instead of the embedded one, as tutti's `--claude` would.
// Throwaway code: not part of tutti, not type-checked or linted by scripts/check.sh.

import { query } from "@anthropic-ai/claude-agent-sdk"
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract"
import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

const result = (step: string, value: unknown) => {
  process.stdout.write(`RESULT ${step} ${JSON.stringify(value)}\n`)
}

const ms = (t0: number) => Math.round(performance.now() - t0)

const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-compile-spike-")))

// OpenTUI's library as installed, or as Bun writes an embedded one out for dlopen:
// `$TMPDIR/.bun-<uid>-<hash>.dylib` (or `.so`).
const NATIVE_LIBRARY = /opentui|\/\.bun-\d+-[0-9a-f]+\.(dylib|so)$/

// Where the running process mapped a native library from: /proc on Linux, lsof on macOS.
const mappedPaths = (pattern: RegExp): string[] => {
  if (process.platform === "linux") {
    const maps = readFileSync("/proc/self/maps", "utf8").split("\n")
    return [...new Set(maps.map((l) => l.split(/\s+/)[5] ?? "").filter((p) => pattern.test(p)))]
  }
  const out = Bun.spawnSync(["lsof", "-p", String(process.pid), "-Fn"]).stdout.toString()
  return [
    ...new Set(
      out
        .split("\n")
        .filter((l) => l.startsWith("n") && pattern.test(l))
        .map((l) => l.slice(1)),
    ),
  ]
}

const extract = (binPath: string) => {
  const t0 = performance.now()
  const cli = extractFromBunfs(binPath)
  const firstMs = ms(t0)
  const t1 = performance.now()
  const again = extractFromBunfs(binPath)
  const secondMs = ms(t1)
  return {
    embeddedPath: binPath,
    extractedPath: cli,
    sameOnSecondCall: again === cli,
    bytes: statSync(cli).size,
    mode: (statSync(cli).mode & 0o777).toString(8),
    firstCallMs: firstMs,
    secondCallMs: secondMs,
  }
}

const version = (cli: string) => {
  const t0 = performance.now()
  const out = Bun.spawnSync([cli, "--version"])
  return { stdout: out.stdout.toString().trim(), exitCode: out.exitCode, ms: ms(t0) }
}

// `claude auth status` without the account's identity: whether it is logged in and how.
const auth = (cli: string) => {
  const out = Bun.spawnSync([cli, "auth", "status", "--json"])
  try {
    const status = JSON.parse(out.stdout.toString()) as Record<string, unknown>
    const { loggedIn, authMethod, apiProvider, subscriptionType } = status
    return { exitCode: out.exitCode, loggedIn, authMethod, apiProvider, subscriptionType }
  } catch {
    return { exitCode: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() }
  }
}

// A session that sends no message: initializationResult() costs no model turn (spec § 4.13).
const probe = async (cli: string) => {
  let release = () => {}
  const never = new Promise<void>((resolve) => {
    release = resolve
  })
  async function* noMessages() {
    await never
  }
  const t0 = performance.now()
  const q = query({
    prompt: noMessages(),
    options: { pathToClaudeCodeExecutable: cli, settingSources: [], cwd: workspace() },
  })
  try {
    const init = await q.initializationResult()
    const account = init.account
    return {
      ms: ms(t0),
      account: account
        ? {
            hasEmail: Boolean(account.email),
            subscriptionType: account.subscriptionType,
            apiProvider: account.apiProvider,
            apiKeySource: account.apiKeySource,
          }
        : null,
    }
  } catch (error) {
    return { ms: ms(t0), error: String(error) }
  } finally {
    release()
    q.close()
  }
}

// One real turn on haiku, with no settings, hooks or tools from the user's configuration.
const turn = async (cli: string) => {
  const t0 = performance.now()
  let claudeCodeVersion: string | undefined
  let text: string | undefined
  let subtype: string | undefined
  let costUsd: number | undefined
  try {
    for await (const message of query({
      prompt: "Reply with the single word PONG and nothing else.",
      options: {
        pathToClaudeCodeExecutable: cli,
        model: "haiku",
        maxTurns: 1,
        settingSources: [],
        tools: [],
        cwd: workspace(),
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        claudeCodeVersion = message.claude_code_version
      }
      if (message.type === "result") {
        subtype = message.subtype
        costUsd = message.total_cost_usd
        if (message.subtype === "success") text = message.result
      }
    }
    return { ms: ms(t0), claudeCodeVersion, subtype, text, costUsd }
  } catch (error) {
    return { ms: ms(t0), claudeCodeVersion, error: String(error) }
  }
}

const Frame = () => (
  <box border title="tutti" padding={1}>
    <text>Claude Code embedded; OpenTUI native library loaded</text>
  </box>
)

// One frame through OpenTUI's test renderer: its buffers live in the native library, so this needs
// the embedded libopentui, but not a terminal.
const frame = async () => {
  const t0 = performance.now()
  const { createTestRenderer } = await import("@opentui/core/testing")
  const { createRoot } = await import("@opentui/react")
  const setup = await createTestRenderer({ width: 60, height: 5 })
  const loadMs = ms(t0)
  createRoot(setup.renderer).render(<Frame />)
  await setup.flush()
  await setup.renderOnce()
  const chars = setup.captureCharFrame()
  await setup.dispose()
  return {
    loadMs,
    ms: ms(t0),
    nodeEnv: process.env.NODE_ENV,
    nativeLibrary: mappedPaths(NATIVE_LIBRARY),
    frame: chars.split("\n").filter((l) => l.trim() !== ""),
  }
}

// One frame in the real terminal: createCliRenderer, render, destroy.
const ttyFrame = async () => {
  const t0 = performance.now()
  const { createCliRenderer } = await import("@opentui/core")
  const { createRoot } = await import("@opentui/react")
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] })
  createRoot(renderer).render(<Frame />)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const nativeLibrary = mappedPaths(NATIVE_LIBRARY)
  renderer.destroy()
  await renderer.closed
  return { ms: ms(t0), nativeLibrary }
}

// The embedded Claude Code's own interactive login (`tutti login`), on this terminal.
const login = async (cli: string) => {
  const proc = Bun.spawn([cli, "auth", "login"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return { command: [cli, "auth", "login"], exitCode: await proc.exited }
}

export const run = async (binPath: string) => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { claude: { type: "string" } },
    allowPositionals: true,
  })
  const steps = positionals.includes("all")
    ? ["extract", "version", "auth", "probe", "frame"]
    : positionals
  if (steps.length === 0) {
    process.stderr.write(
      "usage: <step>... [--claude <path>]  (extract version auth probe turn frame tty-frame login all)\n",
    )
    process.exit(2)
  }
  let cli = values.claude
  const ensureCli = () => {
    if (cli === undefined) cli = extract(binPath).extractedPath
    return cli
  }
  result("platform", {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    embeddedPath: binPath,
    execPath: process.execPath,
  })
  for (const step of steps) {
    switch (step) {
      case "extract": {
        const extracted = extract(binPath)
        cli ??= extracted.extractedPath
        result(step, extracted)
        break
      }
      case "version":
        result(step, version(ensureCli()))
        break
      case "auth":
        result(step, auth(ensureCli()))
        break
      case "probe":
        result(step, await probe(ensureCli()))
        break
      case "turn":
        result(step, await turn(ensureCli()))
        break
      case "frame":
        result(step, await frame())
        break
      case "tty-frame":
        result(step, await ttyFrame())
        break
      case "login":
        result(step, await login(ensureCli()))
        break
      default:
        result(step, { error: "unknown step" })
    }
  }
}
