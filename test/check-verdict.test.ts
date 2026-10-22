// scripts/check.sh's verdict line (§ 13): its last line says PASS, or FAIL and the step it failed
// in, with its exit status unchanged. The script runs in a copy of its own in a temp folder, its
// steps stubbed: bunx on PATH (tsc, biome), scripts/test.sh and scripts/fetch-shellcheck.sh, each
// failing with exit 3 when TUTTI_FAKE_FAIL names its step.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { testEnv } from "./env.ts"

// Each test starts scripts/check.sh and its stubs as processes: well under a second alone, but over
// bun's 5 s on a loaded machine with the suites running side by side (2026-10-22).
setDefaultTimeout(30_000)

const script = resolve(import.meta.dir, "../scripts/check.sh")

const stub = (file: string, body: string) => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

/** A temp project with scripts/check.sh and its steps stubbed, and a folder of stubs for PATH. */
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "tutti-check-verdict-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  mkdirSync(join(root, "scripts"))
  copyFileSync(script, join(root, "scripts", "check.sh"))
  chmodSync(join(root, "scripts", "check.sh"), 0o755)
  stub(join(bin, "bunx"), `[ "$TUTTI_FAKE_FAIL" = "$1" ] && exit 3\necho "$1 ok"`)
  stub(join(root, "scripts", "test.sh"), `[ "$TUTTI_FAKE_FAIL" = test ] && exit 3\necho "tests ok"`)
  // Exit 2 is fetch-shellcheck.sh's "couldn't download it", which the check skips.
  stub(
    join(root, "scripts", "fetch-shellcheck.sh"),
    `[ "$TUTTI_FAKE_FAIL" = shellcheck ] && exit 3\nexit 2`,
  )
  return { root, bin }
}

const runCheck = (env: Record<string, string>) => {
  const { root, bin } = project()
  const proc = Bun.spawnSync([join(root, "scripts", "check.sh")], {
    env: {
      ...testEnv,
      TUTTI_SLOW: "",
      TUTTI_FAKE_FAIL: "",
      ...env,
      PATH: `${bin}:/usr/bin:/bin`,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const lines = proc.stdout.toString().trimEnd().split("\n")
  return { code: proc.exitCode, last: lines[lines.length - 1], out: proc.stdout.toString() }
}

describe("scripts/check.sh's verdict line", () => {
  test("ends with PASS when every step passes, and exits 0", () => {
    const { code, last, out } = runCheck({})
    expect(out).toContain("SUITE: shellcheck")
    expect(last).toBe("scripts/check.sh: PASS")
    expect(code).toBe(0)
  })

  for (const step of ["tsc", "biome", "test", "shellcheck"]) {
    test(`ends with FAIL in ${step} when ${step} fails, keeping its exit status`, () => {
      const { code, last } = runCheck({ TUTTI_FAKE_FAIL: step })
      expect(last).toBe(`scripts/check.sh: FAIL in ${step} (exit 3)`)
      expect(code).toBe(3)
    })
  }

  test("names TUTTI_SLOW=1 when the slow suites run too", () => {
    expect(runCheck({ TUTTI_SLOW: "1" }).last).toBe("TUTTI_SLOW=1 scripts/check.sh: PASS")
    const failed = runCheck({ TUTTI_SLOW: "1", TUTTI_FAKE_FAIL: "test" })
    expect(failed.last).toBe("TUTTI_SLOW=1 scripts/check.sh: FAIL in test (exit 3)")
    expect(failed.code).toBe(3)
  })

  test("stops at the step that failed, running none after it", () => {
    const { out } = runCheck({ TUTTI_FAKE_FAIL: "biome" })
    expect(out).toContain("SUITE: biome")
    expect(out).not.toContain("SUITE: test")
  })
})
