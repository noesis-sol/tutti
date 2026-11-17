// The gate of the contract tests against a real Linear team (test/gates.ts' linearLive,
// test/contract/linear.test.ts): they run only with TUTTI_LIVE_LINEAR=1 and LINEAR_API_KEY in the
// environment, and scripts/test.ts keeps the variable, and the team's, in the suites' environment.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { machineVariable } from "../scripts/test.ts"
import { testEnv } from "./env.ts"

// Runs a test file using test/gates.ts in a fresh folder, with the given environment, and returns
// the names of the tests that ran.
const ranWith = (env: Record<string, string>): ReadonlyArray<string> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-linear-gate-"))
  const gates = resolve(import.meta.dir, "gates.ts")
  writeFileSync(
    join(dir, "g.test.ts"),
    `import { appendFileSync } from "node:fs"
import { test } from "bun:test"
import { linearLive } from ${JSON.stringify(gates)}
const ran = (name: string) => appendFileSync("ran", name + "\\n")
test("plain", () => ran("plain"))
linearLive.test("linear test", () => ran("linear test"))
linearLive.describe("linear group", () => { test("inside", () => ran("linear group")) })
`,
  )
  const { TUTTI_LIVE: _live, TUTTI_LIVE_LINEAR: _linear, LINEAR_API_KEY: _key, ...rest } = testEnv
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

describe("the Linear contract tests' gate", () => {
  test("skips them by default, and with TUTTI_LIVE=1 alone", () => {
    expect(ranWith({})).toEqual(["plain"])
    expect(ranWith({ TUTTI_LIVE: "1" })).toEqual(["plain"])
  })

  test("skips them with the variable and no key, or the key and no variable", () => {
    expect(ranWith({ TUTTI_LIVE_LINEAR: "1" })).toEqual(["plain"])
    expect(ranWith({ TUTTI_LIVE_LINEAR: "1", LINEAR_API_KEY: "" })).toEqual(["plain"])
    expect(ranWith({ LINEAR_API_KEY: "lin_api_test" })).toEqual(["plain"])
  })

  test("runs them with TUTTI_LIVE_LINEAR=1 and LINEAR_API_KEY", () => {
    expect(ranWith({ TUTTI_LIVE_LINEAR: "1", LINEAR_API_KEY: "lin_api_test" })).toEqual([
      "linear group",
      "linear test",
      "plain",
    ])
  })

  test("its variable and the team's reach the suites", () => {
    for (const name of ["TUTTI_LIVE_LINEAR", "TUTTI_TEST_LINEAR_TEAM"]) {
      expect([name, machineVariable(name)]).toEqual([name, false])
    }
  })
})
