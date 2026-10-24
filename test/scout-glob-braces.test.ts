import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk"
import fc from "fast-check"
import { braceAlternatives, confinement, globBase, inside, realPath } from "../src/organs/scout.ts"

/** A repository holding `src`, and a folder beside it, both real paths. */
const fixture = () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "tutti-scout-braces-")))
  const root = join(top, "repo")
  const beside = join(top, "beside")
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(beside)
  return { root, beside }
}

const pre = (tool_input: unknown): HookInput =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: "Glob",
    tool_input,
    tool_use_id: "toolu_1",
    session_id: "s",
    transcript_path: "",
    cwd: "",
  }) as HookInput

const denied = (output: HookJSONOutput): boolean =>
  "hookSpecificOutput" in output &&
  output.hookSpecificOutput?.hookEventName === "PreToolUse" &&
  output.hookSpecificOutput.permissionDecision === "deny"

describe("a Glob pattern's brace alternatives", () => {
  test("each alternative is spelled out, nested braces too", () => {
    expect(braceAlternatives("src/**/*.ts")).toEqual(["src/**/*.ts"])
    expect(braceAlternatives("**/*.{ts,js}")).toEqual(["**/*.ts", "**/*.js"])
    expect(braceAlternatives("{..,src}/*")).toEqual(["../*", "src/*"])
    expect(braceAlternatives("{a,{b,c}}/{x,y}")).toEqual(["a/x", "a/y", "b/x", "b/y", "c/x", "c/y"])
    expect(braceAlternatives("{..}/*")).toEqual(["../*"])
    expect(braceAlternatives("{,src}/x")).toEqual(["/x", "src/x"])
    expect(braceAlternatives("a}b")).toEqual(["a}b"])
  })

  test("an unclosed brace, or too many alternatives, has none", () => {
    expect(braceAlternatives("{..,src/*")).toBeUndefined()
    expect(braceAlternatives("src/{a,{b}")).toBeUndefined()
    expect(braceAlternatives("{a,b}".repeat(9))).toBeUndefined()
    expect(braceAlternatives("{a,b}".repeat(8))).toHaveLength(256)
  })
})

describe("the scout's confinement of a Glob pattern with braces", () => {
  const { root, beside } = fixture()
  const decide = (input: unknown) => confinement(root, beside, pre(input))

  test("braces that stay in the repository are allowed, with no decision", () => {
    expect(decide({ pattern: "**/*.{ts,tsx}" })).toEqual({})
    expect(decide({ pattern: "{src,test}/**/*.ts" })).toEqual({})
    expect(decide({ pattern: `{${root}/src,src}/*` })).toEqual({})
  })

  test("an alternative that goes up, is absolute outside or starts at home is denied", () => {
    const outside = [
      decide({ pattern: "{..,src}/*" }),
      decide({ pattern: "{src,..}/*" }),
      decide({ pattern: "src/{../..,x}/*" }),
      decide({ pattern: "{/etc,src}/*" }),
      decide({ pattern: "{,src}/etc/*" }),
      decide({ pattern: "{~,src}/*" }),
      decide({ pattern: `{${beside},src}/*` }),
      decide({ pattern: "{a,{b,..}}/*" }),
      decide({ pattern: "{..,src/*" }),
      decide({ pattern: "{a,b}".repeat(9) }),
    ]
    for (const output of outside) expect(denied(output)).toBe(true)
    expect(JSON.stringify(decide({ pattern: "{/etc,src}/*" }))).toContain('\\"/etc\\" lies outside')
  })

  test("whatever braces a model writes, every allowed alternative's base lies in the repository", () => {
    const piece = fc.constantFrom("..", ".", "src", "~", "", "*", "**", "/", ",", "{", "}", "/etc")
    const pattern = fc.array(piece, { maxLength: 10 }).map((pieces) => pieces.join(""))
    fc.assert(
      fc.property(pattern, (b) => {
        if (denied(decide({ pattern: b }))) return
        for (const alternative of braceAlternatives(b) ?? []) {
          expect(alternative.split("/")).not.toContain("..")
          expect(inside(root, realPath(globBase(alternative), root, beside))).toBe(true)
        }
      }),
    )
  })
})
