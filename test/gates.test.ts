import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Runs a test file using test/gates.ts in a fresh folder, with the given environment, and returns
// the names of the tests that ran.
const ranWith = (env: Record<string, string>): ReadonlyArray<string> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-gates-"))
  const gates = resolve(import.meta.dir, "gates.ts")
  writeFileSync(
    join(dir, "g.test.ts"),
    `import { appendFileSync } from "node:fs"
import { test } from "bun:test"
import { live, slow } from ${JSON.stringify(gates)}
const ran = (name: string) => appendFileSync("ran", name + "\\n")
test("plain", () => ran("plain"))
slow.test("slow test", () => ran("slow test"))
slow.describe("slow group", () => { test("inside", () => ran("slow group")) })
live.test("live test", () => ran("live test"))
`,
  )
  const { TUTTI_SLOW: _slow, TUTTI_LIVE: _live, ...rest } = process.env
  const proc = Bun.spawnSync(["bun", "test", "./g.test.ts"], {
    cwd: dir,
    env: { ...rest, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(proc.exitCode).toBe(0)
  return readFileSync(join(dir, "ran"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .sort()
}

describe("gates", () => {
  test("slow and live tests are skipped by default", () => {
    expect(ranWith({})).toEqual(["plain"])
  })

  test("TUTTI_SLOW=1 runs the slow tests", () => {
    expect(ranWith({ TUTTI_SLOW: "1" })).toEqual(["plain", "slow group", "slow test"])
  })

  test("TUTTI_LIVE=1 runs the live tests", () => {
    expect(ranWith({ TUTTI_LIVE: "1" })).toEqual(["live test", "plain"])
  })
})
