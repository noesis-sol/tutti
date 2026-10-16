import { describe, expect, test } from "bun:test"
import pkg from "../package.json" with { type: "json" }
import { version } from "../src/main.ts"

describe("smoke", () => {
  test("main exports the version from package.json", () => {
    expect(version).toBe(pkg.version)
  })

  test("bun src/main.ts prints the version and exits 0", async () => {
    const proc = Bun.spawn(["bun", "src/main.ts"], { stdout: "pipe", stderr: "pipe" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(out.trim()).toBe(pkg.version)
    expect(code).toBe(0)
  })
})
