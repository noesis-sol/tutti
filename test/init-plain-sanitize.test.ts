// init's plain output sanitised (§ 7.10): a step's plain line (stepLine), which may carry bd's
// stderr, and init's lines on stderr, which may name an unknown key from a committed settings file,
// keep no escape sequence or control character a terminal would act on; a refusal keeps its lines.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { failedEnding, stderrText } from "../src/cli/commands.ts"
import { InitFailed, step, stepLine } from "../src/init/steps.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// The slow test starts tutti as a bun process, which bun's 5 s default fails beside other checks.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")

/** A title-setting OSC, a colour, a bell, a bidi override and a carriage return. */
const hostile = "\u001b]0;pwned\u0007\u001b[31mred\u001b[0m\u0007 ‮evil\r over"

/** Whether `text` has a character a terminal acts on, newline aside. */
const controls = (text: string): boolean =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what it looks for
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(text)

describe("a step's plain line", () => {
  test("its label and detail sanitised, on one line", () => {
    const line = stepLine(step("caution", `test work${hostile}`, `bd create failed: ${hostile}`))
    expect(controls(line)).toBe(false)
    expect(line).not.toContain("\n")
    expect(line).toStartWith("! test workred evil")
    expect(line).toContain("  bd create failed: red evil")
  })

  test("a step with plain text as it was", () => {
    expect(stepLine(step("done", "Beads", "ran bd init"))).toBe("✓ Beads  ran bd init")
    expect(stepLine(step("kept", "settings", ""))).toBe("• settings")
  })
})

describe("init's lines on stderr", () => {
  test("sanitised, each line kept", () => {
    const text = stderrText(`settings.json has problems:\n  unknown key "${hostile}"`)
    expect(controls(text)).toBe(false)
    expect(text.split("\n")).toEqual([
      "settings.json has problems:",
      '  unknown key "red evil',
      ' over"',
    ])
  })

  test("a failed step's reason sanitised", () => {
    const failed = new InitFailed({ steps: [], step: "the setup", reason: `bd: ${hostile}` })
    const { stderr } = failedEnding(failed, null, 80)
    expect(controls(stderr)).toBe(false)
    expect(stderr).toStartWith("tutti init: ")
    expect(stderr).toContain("bd: red evil")
  })
})

describe("tutti init refusing a settings file", () => {
  slow.test("an unknown key naming escapes: stderr sanitised, its lines kept, exit 2", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-sanitize-")))
    const home = join(root, "home")
    mkdirSync(home)
    const repo = makeRepo()
    mkdirSync(join(repo.dir, ".tutti"))
    writeFileSync(join(repo.dir, ".tutti", "settings.json"), JSON.stringify({ [hostile]: 1 }))
    const env: Record<string, string | undefined> = { ...testEnv, HOME: home }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    const proc = Bun.spawn(["bun", main, "init"], {
      cwd: repo.dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).toBe(2)
    expect(controls(stderr)).toBe(false)
    const lines = stderr.trimEnd().split("\n")
    expect(lines[0]).toStartWith("tutti init: .tutti/settings.json has problems")
    expect(lines.some((line) => line.includes("red evil"))).toBe(true)
  })
})
