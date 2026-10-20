// scripts/test.sh gives each run a temp folder of its own, as TMPDIR, and removes it at the end, so
// the folders the suites leave in os.tmpdir() don't pile up in the system's temp folder. On macOS it
// is made in /tmp, out of the crowded per-user $TMPDIR, and a run removes the folders of runs killed
// before they could remove their own.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { removeStaleRuns, runTempBase, runTempPid } from "../scripts/test.ts"

const script = resolve(import.meta.dir, "../scripts/test.sh")

// The ID of a process that has ended.
const endedPid = (): number => {
  const proc = Bun.spawnSync(["true"])
  return proc.pid
}

// Runs scripts/test.sh on the fixture, its temp folder made in base, and returns its exit code and
// the os.tmpdir() the fixture saw.
const runScript = (fail: boolean, base: string) => {
  const folder = mkdtempSync(join(tmpdir(), "tutti-test-tmpdir-"))
  const seen = join(folder, "tmpdir")
  const env: Record<string, string | undefined> = {
    ...process.env,
    TUTTI_FIXTURE_TMPDIR: seen,
    TUTTI_TEST_TMPDIR: base,
  }
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
  test("is a folder of the run's own, named with its process ID, removed when it passes", () => {
    const base = mkdtempSync(join(tmpdir(), "tutti-test-base-"))
    const { code, temp } = runScript(false, base)
    expect(code).toBe(0)
    expect(resolve(dirname(temp))).toBe(resolve(base))
    expect(runTempPid(basename(temp))).toBeNumber()
    expect(existsSync(temp)).toBe(false)
  }, 30_000)

  test("is removed when the run fails too", () => {
    const base = mkdtempSync(join(tmpdir(), "tutti-test-base-"))
    const { code, temp } = runScript(true, base)
    expect(code).toBe(1)
    expect(existsSync(temp)).toBe(false)
  }, 30_000)

  test("removes the folder a killed run left before it starts", () => {
    const base = mkdtempSync(join(tmpdir(), "tutti-test-base-"))
    const stale = join(base, `tutti-test-${endedPid()}-Ab12Cd`)
    mkdirSync(join(stale, "repo"), { recursive: true })
    const { code } = runScript(false, base)
    expect(code).toBe(0)
    expect(existsSync(stale)).toBe(false)
  }, 30_000)
})

describe("runTempBase", () => {
  test("is /tmp on macOS, out of the per-user $TMPDIR", () => {
    expect(runTempBase({ TMPDIR: "/var/folders/xy/T/" }, "darwin")).toBe("/tmp")
  })

  test("is os.tmpdir() elsewhere", () => {
    expect(runTempBase({}, "linux")).toBe(tmpdir())
  })

  test("is TUTTI_TEST_TMPDIR when it is set", () => {
    expect(runTempBase({ TUTTI_TEST_TMPDIR: "/scratch" }, "darwin")).toBe("/scratch")
    expect(runTempBase({ TUTTI_TEST_TMPDIR: "/scratch" }, "linux")).toBe("/scratch")
    expect(runTempBase({ TUTTI_TEST_TMPDIR: "" }, "darwin")).toBe("/tmp")
  })
})

describe("runTempPid", () => {
  test("reads the process ID from a run's folder name", () => {
    expect(runTempPid("tutti-test-4242-XAEd4D")).toBe(4242)
  })

  test("is undefined for other names, older runs' included", () => {
    for (const name of [
      "tutti-test-XAEd4D",
      "tutti-test-tmpdir-XAEd4D",
      "tutti-test-reports-XAEd4D",
      "tutti-test-42-",
      "tutti-test-42-a/b",
      "tutti-worktrees-123-abc",
    ]) {
      expect(runTempPid(name)).toBeUndefined()
    }
  })
})

describe("removeStaleRuns", () => {
  test("removes the folders of ended runs and keeps the rest", () => {
    const base = mkdtempSync(join(tmpdir(), "tutti-test-base-"))
    const ended = join(base, "tutti-test-111-aaaaaa")
    const running = join(base, "tutti-test-222-bbbbbb")
    const own = join(base, `tutti-test-${process.pid}-cccccc`)
    const other = join(base, "tutti-test-dddddd")
    const file = join(base, "tutti-test-333-eeeeee")
    for (const folder of [ended, running, own, other])
      mkdirSync(join(folder, "inner"), { recursive: true })
    writeFileSync(file, "")
    const removed = removeStaleRuns(base, (pid) => pid === 222)
    expect(removed).toEqual([ended])
    expect(existsSync(ended)).toBe(false)
    for (const kept of [running, own, other, file]) expect(existsSync(kept)).toBe(true)
  })

  test("leaves a link alone, and the folder it points to", () => {
    const base = mkdtempSync(join(tmpdir(), "tutti-test-base-"))
    const target = mkdtempSync(join(tmpdir(), "tutti-test-target-"))
    writeFileSync(join(target, "keep"), "")
    const link = join(base, "tutti-test-111-aaaaaa")
    symlinkSync(target, link)
    expect(removeStaleRuns(base, () => false)).toEqual([])
    expect(existsSync(link)).toBe(true)
    expect(existsSync(join(target, "keep"))).toBe(true)
  })

  test("tells an ended process from a running one by default", () => {
    const base = mkdtempSync(join(tmpdir(), "tutti-test-base-"))
    const ended = join(base, `tutti-test-${endedPid()}-aaaaaa`)
    const running = join(base, `tutti-test-${process.ppid}-bbbbbb`)
    mkdirSync(ended)
    mkdirSync(running)
    expect(removeStaleRuns(base)).toEqual([ended])
    expect(existsSync(running)).toBe(true)
  })

  test("removes nothing from a folder that isn't there", () => {
    expect(removeStaleRuns(join(tmpdir(), "tutti-test-missing", "nowhere"))).toEqual([])
  })
})
