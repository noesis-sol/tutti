// skills/tutti/SKILL.md, the skill for running tutti through an agent (§ 14 M8), checked against the
// code: every flag it gives a tutti command is one that command's --help lists, its table of stop
// lines gives each the exit code tutti ends with, its PERMISSION and QUESTION lines are the ones the
// log writes, and it names every field `tutti answer --json` prints.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RequestFile } from "../src/agent/attentionFiles.ts"
import { stopCodes } from "../src/run/holds.ts"
import * as log from "../src/run/log.ts"

// Each --help starts tutti as a bun process, which bun's 5 s default fails when other checks run
// beside this one.
setDefaultTimeout(30_000)

const root = join(import.meta.dir, "..")
const skill = readFileSync(join(root, "skills", "tutti", "SKILL.md"), "utf8")

const subcommands = ["init", "answer", "plan", "login", "colours", "update"] as const
type Command = "run" | (typeof subcommands)[number]

/** The flags a command's --help lists, its global flags included: `--json`, `-c`, … */
const helpFlags = async (command: Command): Promise<ReadonlySet<string>> => {
  const args = command === "run" ? ["--help"] : [command, "--help"]
  const proc = Bun.spawn(["bun", join(root, "src", "main.ts"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  expect(code).toBe(0)
  const flags = new Set<string>()
  for (const [, first, second] of out.matchAll(
    /^\s+(-{1,2}[a-z][a-z-]*)(?:,\s+(-{1,2}[a-z][a-z-]*))?/gm,
  )) {
    if (first !== undefined) flags.add(first)
    if (second !== undefined) flags.add(second)
  }
  return flags
}

/** The skill's code: each inline code span and each line of its fenced blocks. */
const codeOf = (text: string): ReadonlyArray<string> => {
  const fenced = [...text.matchAll(/^ *```[^\n]*\n([\s\S]*?)^ *```/gm)].flatMap(([, body]) =>
    (body ?? "").split("\n"),
  )
  const prose = text.replace(/^ *```[^\n]*\n[\s\S]*?^ *```/gm, "")
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span ?? "")
  return [...fenced, ...spans]
}

/** The tutti commands in a piece of code, each as its command and the flags given to it. */
const tuttiCommands = (code: string): ReadonlyArray<{ command: Command; flags: string[] }> =>
  code
    .split(/;|&&|\|\||\||\$\(|'|"|:\s|#/)
    .map((part) => part.trim().replace(/^!\s*/, ""))
    .filter((part) => /^tutti(\s|$)/.test(part))
    .map((part) => {
      const words = part.split(/\s+/).slice(1)
      const sub = subcommands.find((each) => each === words[0])
      const flags = words
        .filter((word) => /^-{1,2}[a-z]/.test(word))
        .map((word) => word.replace(/=.*$/, ""))
      return { command: sub ?? "run", flags }
    })

describe("the tutti skill", () => {
  test("gives each tutti command only flags its --help lists", async () => {
    const commands: ReadonlyArray<Command> = ["run", ...subcommands]
    const known = new Map(
      await Promise.all(commands.map(async (c) => [c, await helpFlags(c)] as const)),
    )
    const code = codeOf(skill)
    const used = code.flatMap(tuttiCommands)
    // The commands it must show: running plain, and answering.
    expect(used.some((u) => u.command === "run" && u.flags.includes("--plain"))).toBe(true)
    expect(used.some((u) => u.command === "answer" && u.flags.includes("--json"))).toBe(true)
    expect(used.some((u) => u.command === "answer" && u.flags.includes("--confirm"))).toBe(true)
    const unknown = used.flatMap(({ command, flags }) =>
      flags
        .filter((flag) => !known.get(command)?.has(flag))
        .map((flag) => `tutti ${command} ${flag}`),
    )
    // A bare flag in the prose (`--triage=false`, `-c N`) is one of some tutti command's.
    const every = new Set([...known.values()].flatMap((flags) => [...flags]))
    const bare = code
      .filter((span) => /^-{1,2}[a-z]/.test(span))
      .map((span) => (span.split(/[\s=]/)[0] ?? "").replace(/=.*$/, ""))
      .filter((flag) => !every.has(flag))
    expect([...unknown, ...bare]).toEqual([])
  })

  test("gives each stop line the exit code tutti ends with, and names them all", () => {
    const rows = skill
      .split("\n")
      .filter((row) => row.startsWith("| `"))
      .map((row) => row.split(" | "))
      .filter((cells) => /^\d+$/.test(cells[1]?.trim() ?? ""))
    const named = new Map<string, number>()
    for (const [words, code] of rows) {
      for (const [, word] of (words ?? "").matchAll(/`([A-Z_]+)/g)) {
        if (word !== undefined && word in stopCodes) named.set(word, Number(code))
      }
    }
    for (const [word, code] of Object.entries(stopCodes)) {
      expect({ word, code: named.get(word) }).toEqual({ word, code })
    }
  })

  test("shows the PERMISSION and QUESTION lines the log writes", () => {
    const permission = log.permission({
      id: "tut-9a1",
      requestId: "a3f9c2d1",
      what: "Bash(rm -rf build)",
      why: "held by the safety check",
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    })
    const question = log.question({
      id: "tut-7k2",
      requestId: "5be01c7a",
      questions: [{ question: "Which store?", options: ["SQLite", "Postgres"] }],
    })
    expect(skill).toContain(`\n  ${permission}\n`)
    expect(skill).toContain(`\n  ${question}\n`)
  })

  test("names every field of tutti answer --json's requests", () => {
    for (const field of Object.keys(RequestFile.fields).filter((f) => f !== "v")) {
      expect({ field, named: skill.includes(`\`${field}\``) }).toEqual({ field, named: true })
    }
  })
})
