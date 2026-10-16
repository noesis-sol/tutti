// scripts/test.sh end to end (§ 13 Flaky tests), on the fixtures in test/fixtures/flaky/: each
// counts its runs in a counter file in a temp folder.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const script = resolve(import.meta.dir, "../scripts/test.sh")

// Runs scripts/test.sh on one fixture, and returns its exit code, its output and how many times
// the fixture's counted test ran.
const runScript = (fixture: string) => {
  const counter = join(mkdtempSync(join(tmpdir(), "tutti-test-script-")), "runs")
  const proc = Bun.spawnSync([script, `./test/fixtures/flaky/${fixture}`], {
    env: { ...process.env, TUTTI_FIXTURE_COUNTER: counter },
    stdout: "pipe",
    stderr: "pipe",
  })
  const runs = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0
  return { code: proc.exitCode, out: proc.stdout.toString(), runs }
}

describe("scripts/test.sh", () => {
  test("prints FLAKY for a test that passes only on its retry, and exits 0", () => {
    const { code, out, runs } = runScript("flaky.fixture.ts")
    expect(out).toContain(
      "FLAKY: test/fixtures/flaky/flaky.fixture.ts fixture (flaky) passes on its second run",
    )
    expect(out.match(/^FLAKY:/gm)).toHaveLength(1)
    expect(runs).toBe(2)
    expect(code).toBe(0)
  })

  test("fails for a test that fails twice, without a FLAKY line", () => {
    const { code, out, runs } = runScript("broken.fixture.ts")
    expect(out).not.toContain("FLAKY:")
    expect(runs).toBe(2)
    expect(code).toBe(1)
  })
})
