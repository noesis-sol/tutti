// scripts/test.sh gives each run a temp folder of its own, as TMPDIR, and removes it at the end, so
// the folders the suites leave in os.tmpdir() don't pile up in the system's temp folder.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const script = resolve(import.meta.dir, "../scripts/test.sh")

// Runs scripts/test.sh on the fixture and returns its exit code and the os.tmpdir() the fixture saw.
const runScript = (fail: boolean) => {
  const folder = mkdtempSync(join(tmpdir(), "tutti-test-tmpdir-"))
  const seen = join(folder, "tmpdir")
  const env: Record<string, string | undefined> = { ...process.env, TUTTI_FIXTURE_TMPDIR: seen }
  if (fail) env.TUTTI_FIXTURE_FAIL = "1"
  const proc = Bun.spawnSync([script, "./test/fixtures/tmpdir/tmpdir.fixture.ts"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const temp = readFileSync(seen, "utf8")
  rmSync(folder, { recursive: true, force: true })
  return { code: proc.exitCode, temp }
}

describe("scripts/test.sh's temp folder", () => {
  test("is a folder of the run's own in the system's temp folder, removed when it passes", () => {
    const { code, temp } = runScript(false)
    expect(code).toBe(0)
    expect(resolve(dirname(temp))).toBe(resolve(tmpdir()))
    expect(temp).toContain("tutti-test-")
    expect(existsSync(temp)).toBe(false)
  }, 30_000)

  test("is removed when the run fails too", () => {
    const { code, temp } = runScript(true)
    expect(code).toBe(1)
    expect(existsSync(temp)).toBe(false)
  }, 30_000)
})
