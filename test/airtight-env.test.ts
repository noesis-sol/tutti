// The suites' environment (scripts/test.ts): a PATH without the tools tutti looks for and without
// the machine's variables, the same with those tools installed and without; and the lint that holds
// the tests to test/env.ts (biome.json, test/lint/bun-which.grit).
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { airtightPath, hiddenTools, machineVariable, testEnvironment } from "../scripts/test.ts"
import { testEnv, which } from "./env.ts"

const root = resolve(import.meta.dir, "..")

const folder = (name: string): string => mkdtempSync(join(tmpdir(), `tutti-airtight-${name}-`))

// One fake for every tool, linked under each name: macOS scans each new executable on its first
// run, which costs up to a second a file.
const fakeTools = (names: ReadonlyArray<string>): string => {
  const bin = folder("bin")
  writeFileSync(join(bin, "fake"), "#!/bin/sh\necho fake\n")
  chmodSync(join(bin, "fake"), 0o755)
  for (const name of names) symlinkSync(join(bin, "fake"), join(bin, name))
  return bin
}

describe("machineVariable", () => {
  test("is the terminal's, its pane's, a Claude Code session's, Beads' and tutti's settings", () => {
    for (const name of [
      "HERDR_PANE_ID",
      "HERDR_SOCKET_PATH",
      "CMUX_SURFACE_ID",
      "TMUX",
      "TMUX_PANE",
      "TERM",
      "TERM_PROGRAM",
      "COLORTERM",
      "GHOSTTY_RESOURCES_DIR",
      "ITERM_SESSION_ID",
      "LC_TERMINAL",
      "SSH_TTY",
      "DISPLAY",
      "NO_COLOR",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_PID",
      "AI_AGENT",
      "BASH_DEFAULT_TIMEOUT_MS",
      "ORCHESTRA_CORES",
      "BD_JSON_ENVELOPE",
      "BEADS_DIR",
      "TUTTI_CONCURRENT",
      "TUTTI_CLAUDE",
    ]) {
      expect([name, machineVariable(name)]).toEqual([name, true])
    }
  })

  test("is not the user's, the login's, or the test gates and fixtures' variables", () => {
    for (const name of [
      "HOME",
      "USER",
      "LANG",
      "SHELL",
      "TMPDIR",
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "TUTTI_SLOW",
      "TUTTI_LIVE",
      "TUTTI_TEST_TMPDIR",
      "TUTTI_FIXTURE_COUNTER",
    ]) {
      expect([name, machineVariable(name)]).toEqual([name, false])
    }
  })
})

describe("airtightPath", () => {
  test("finds none of the hidden tools, and all else in the PATH's order", () => {
    const first = fakeTools(["claude", "git", "bd"])
    const second = fakeTools(["git", "jq", "tmux"])
    const plain = fakeTools(["rg"])
    const path = [first, "", join(first, "missing"), second, plain].join(delimiter)
    const airtight = airtightPath(path, join(folder("shadows"), "path"))
    for (const tool of hiddenTools) expect(which(tool, airtight)).toBeNull()
    expect(which("git", airtight)).toStartWith(airtight.split(delimiter)[0] ?? "")
    expect(readFileSync(which("jq", airtight) ?? "", "utf8")).toContain("fake")
    // A folder with none of them is kept as it is; empty and missing entries are left out.
    const folders = airtight.split(delimiter)
    expect(folders).toHaveLength(3)
    expect(folders[2]).toBe(plain)
    expect(folders).not.toContain(first)
    expect(folders).not.toContain(second)
  })

  test("hides a tool whatever the case of its name", () => {
    const bin = fakeTools(["Claude", "git"])
    const airtight = airtightPath(bin, join(folder("shadows"), "path"))
    expect(which("claude", airtight)).toBeNull()
    expect(which("Claude", airtight)).toBeNull()
    expect(lstatSync(join(airtight, "git")).isSymbolicLink()).toBe(true)
  })
})

describe("testEnvironment", () => {
  test("leaves out the machine's variables, and keeps its PATH as TUTTI_TEST_MACHINE_PATH", () => {
    const bin = fakeTools(["claude", "git"])
    const env = testEnvironment(
      { PATH: bin, HOME: "/home/x", HERDR_PANE_ID: "p1", TUTTI_SLOW: "1", UNSET: undefined },
      join(folder("shadows"), "path"),
    )
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "PATH",
      "TUTTI_SLOW",
      "TUTTI_TEST_MACHINE_PATH",
    ])
    expect(env.TUTTI_TEST_MACHINE_PATH).toBe(bin)
    expect(which("claude", env.PATH ?? "")).toBeNull()
    expect(which("git", env.PATH ?? "")).not.toBeNull()
  })
})

describe("scripts/test.sh", () => {
  test("runs the suites without the machine's tools or variables, on a machine with them", () => {
    const bin = fakeTools(hiddenTools)
    const seen = join(folder("seen"), "seen.json")
    const machinePath = `${bin}${delimiter}${testEnv.PATH}`
    const proc = Bun.spawnSync(
      [join(root, "scripts/test.sh"), "./test/fixtures/airtight/airtight.fixture.ts"],
      {
        cwd: root,
        env: {
          ...testEnv,
          PATH: machinePath,
          HERDR_PANE_ID: "p1",
          TMUX: "/tmp/tmux-501/default,1,0",
          TERM_PROGRAM: "ghostty",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "s1",
          BD_JSON_ENVELOPE: "1",
          TUTTI_CONCURRENT: "9",
          TUTTI_FIXTURE_AIRTIGHT: seen,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    const saw = JSON.parse(readFileSync(seen, "utf8")) as {
      which: Record<string, string | null>
      machineWhich: Record<string, string | null>
      variables: ReadonlyArray<string>
      machinePath: string | null
    }
    for (const tool of hiddenTools) {
      expect([tool, saw.which[tool]]).toEqual([tool, null])
      expect([tool, saw.machineWhich[tool]]).toEqual([tool, join(bin, tool)])
    }
    for (const tool of ["git", "sh", "bun"])
      expect([tool, saw.which[tool]]).not.toEqual([tool, null])
    for (const name of [
      "HERDR_PANE_ID",
      "TMUX",
      "TERM_PROGRAM",
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "BD_JSON_ENVELOPE",
      "TUTTI_CONCURRENT",
    ]) {
      expect(saw.variables).not.toContain(name)
    }
    expect(saw.variables).toContain("TUTTI_FIXTURE_AIRTIGHT")
    expect(saw.machinePath).toBe(machinePath)
  }, 30_000)
})

describe("the lint on the tests' environment", () => {
  // Biome on a copy of its configuration, with a probe that reads process.env and Bun.which in the
  // places the rules cover and the ones they leave alone.
  const lint = (): string => {
    const dir = folder("lint")
    cpSync(join(root, "biome.json"), join(dir, "biome.json"))
    cpSync(join(root, "test/lint"), join(dir, "test/lint"), { recursive: true })
    const probe = 'export const a = process.env.X\nexport const b = Bun.which("x")\n'
    for (const file of [
      "test/probe.test.ts",
      "test/gates.ts",
      "test/env.ts",
      "test/contract/probe.test.ts",
      "test/fixtures/probe/probe.ts",
      "src/probe.ts",
      "scripts/probe.ts",
    ]) {
      mkdirSync(join(dir, file, ".."), { recursive: true })
      writeFileSync(join(dir, file), probe)
    }
    const proc = Bun.spawnSync(
      [join(root, "node_modules/.bin/biome"), "lint", "--vcs-enabled=false", "--reporter=github"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    )
    return proc.stdout.toString().replaceAll(`${realpathSync(dir)}/`, "")
  }

  test("finds process.env and Bun.which in the tests, outside test/env.ts and the live tests", () => {
    const found = lint()
      .split("\n")
      .flatMap((line) => {
        const match = /^::error title=([^,]+),file=([^,]+),line=(\d+)/.exec(line)
        return match === null ? [] : [`${match[2]}:${match[3]} ${match[1]}`]
      })
      .sort()
    expect(found).toEqual([
      "test/gates.ts:1 lint/style/noProcessEnv",
      "test/gates.ts:2 plugin",
      "test/probe.test.ts:1 lint/style/noProcessEnv",
      "test/probe.test.ts:2 plugin",
    ])
  }, 30_000)
})
