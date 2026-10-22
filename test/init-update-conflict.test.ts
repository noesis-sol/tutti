// tutti init --update beside another flag (§ 8.3): readInitFlags says the conflict whether the
// other flag's value read or not, so every problem is said at once.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { type InitFlagTexts, readInitFlags } from "../src/cli/commands.ts"

const none = Option.none<string>()
const texts: InitFlagTexts = {
  checkFast: none,
  checkFull: none,
  checkFastTimeout: none,
  checkFullTimeout: none,
  setup: none,
  concurrent: none,
  mcp: none,
  changelogUnion: none,
  installBeads: none,
  verifier: none,
  prefix: none,
  noMouse: none,
  force: false,
}
const conflict = "--update takes no other flag: run tutti init without it to change the rest"

describe("--update beside a flag whose value fails to read", () => {
  test("says the flag's problem and the conflict together", () => {
    const read = readInitFlags({ ...texts, update: true, concurrent: Option.some("0") })
    expect(read._tag).toBe("Failure")
    const problems = read._tag === "Failure" ? read.failure : []
    expect(problems).toHaveLength(2)
    expect(problems[0]).toStartWith("--concurrent ")
    expect(problems[1]).toBe(conflict)
  })

  test("each failing flag alone with --update brings the conflict", () => {
    for (const bad of [
      { concurrent: Option.some("x") },
      { verifier: Option.some("maybe") },
      { checkFastTimeout: Option.some("soon") },
      { noMouse: Option.some("perhaps") },
    ]) {
      const read = readInitFlags({ ...texts, ...bad, update: true })
      expect(read._tag === "Failure" && read.failure.at(-1)).toBe(conflict)
    }
  })

  test("without --update, a failing flag says only its own problem", () => {
    const read = readInitFlags({ ...texts, concurrent: Option.some("0") })
    expect(read._tag === "Failure" && read.failure.includes(conflict)).toBe(false)
  })
})
