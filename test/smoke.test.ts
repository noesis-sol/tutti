import { describe, expect, test } from "bun:test"
import pkg from "../package.json" with { type: "json" }

describe("smoke", () => {
  test("bun src/main.ts --version prints package.json's version and the checkout's commit", async () => {
    const proc = Bun.spawn(["bun", "src/main.ts", "--version"], { stdout: "pipe", stderr: "pipe" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(out.trim()).toMatch(new RegExp(`^tutti v${pkg.version} [0-9a-f]{12}(\\+dirty)?$`))
    expect(code).toBe(0)
  })

  test("bun src/main.ts prints the version and exits 0", async () => {
    const proc = Bun.spawn(["bun", "src/main.ts"], { stdout: "pipe", stderr: "pipe" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(out.trim()).toBe(pkg.version)
    expect(code).toBe(0)
  })
})
