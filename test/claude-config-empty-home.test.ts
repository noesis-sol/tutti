import { describe, expect, test } from "bun:test"
import { userInfo } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { claudeConfigFile } from "../src/agent/mcp.ts"

// Claude Code, a Bun binary, takes an empty HOME as unset and keeps its user config in the
// account's home folder then: the user's .claude.json is read there, never under the current folder.
const account = userInfo().homedir

const file = (env: Record<string, string>) =>
  Effect.runSync(
    Effect.provide(claudeConfigFile, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  )

describe("the user's .claude.json under an empty HOME", () => {
  test("is in the account's home folder for HOME empty or unset", () => {
    const expected = join(account, ".claude.json")
    expect(file({ HOME: "" })).toBe(expected)
    expect(file({})).toBe(expected)
    expect(file({ HOME: "", CLAUDE_CONFIG_DIR: "" })).toBe(expected)
  })

  test("is in CLAUDE_CONFIG_DIR when that is set, whatever HOME is", () => {
    expect(file({ HOME: "", CLAUDE_CONFIG_DIR: "/etc/claude" })).toBe("/etc/claude/.claude.json")
  })

  test("keeps a relative HOME, as Claude Code does", () => {
    expect(file({ HOME: "relative" })).toBe(join("relative", ".claude.json"))
  })
})
