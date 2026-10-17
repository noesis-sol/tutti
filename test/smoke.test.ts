import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }

describe("smoke", () => {
  test("bun src/main.ts --version prints package.json's version and the checkout's commit", async () => {
    const proc = Bun.spawn(["bun", "src/main.ts", "--version"], { stdout: "pipe", stderr: "pipe" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(out.trim()).toMatch(new RegExp(`^tutti v${pkg.version} [0-9a-f]{12}(\\+dirty)?$`))
    expect(code).toBe(0)
  })

  test("bun src/main.ts --version prints the version and exits 0", async () => {
    const proc = Bun.spawn(["bun", "src/main.ts", "--version"], { stdout: "pipe", stderr: "pipe" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(out.trim()).toBe(`tutti v${pkg.version}`)
    expect(code).toBe(0)
  })

  test("a bare tutti outside a git repository fails its startup checks with exit 2", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "tutti-smoke-")))
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts")], {
      cwd: outside,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(err).toContain("Not inside a git repository")
    expect(code).toBe(2)
  })
})
