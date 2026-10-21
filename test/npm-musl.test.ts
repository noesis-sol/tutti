// The npm bundle on musl (§ 12 npm): the bundle is one for every platform, so its entry,
// src/npm.ts, first imports src/native/detectMusl.ts, which sets OPENTUI_LIBC=musl on a
// musl Linux before anything loads OpenTUI. The detection is checked in a bun process told it is
// Linux, with a process report as glibc's or musl's; the slow test builds the bundle and checks the
// detection comes before OpenTUI resolves its native library. scripts/check-npm.sh opens the
// library on Alpine, in the npm workflow.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { muslReport } from "../src/native/musl.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"

const checkout = resolve(import.meta.dir, "..")

describe("muslReport", () => {
  test("is musl on Linux when the report has no glibc version", () => {
    expect(muslReport("linux", { header: {} })).toBe(true)
    expect(muslReport("linux", { header: { glibcVersionRuntime: undefined } })).toBe(true)
    expect(muslReport("linux", undefined)).toBe(true)
  })

  test("is glibc on Linux when the report has a glibc version", () => {
    expect(muslReport("linux", { header: { glibcVersionRuntime: "2.39" } })).toBe(false)
  })

  test("is never musl off Linux", () => {
    expect(muslReport("darwin", { header: {} })).toBe(false)
    expect(muslReport("win32", undefined)).toBe(false)
  })
})

/**
 * OPENTUI_LIBC after src/native/detectMusl.ts runs in a bun process told it is Linux, with a
 * process report whose header has `glibc`'s version (none for musl), and `env` set.
 */
const detected = (glibc: string | undefined, env: Record<string, string> = {}): string => {
  const script = `
Object.defineProperty(process, "platform", { value: "linux" })
process.report.getReport = () => ({ header: ${JSON.stringify(glibc === undefined ? {} : { glibcVersionRuntime: glibc })} })
await import(${JSON.stringify(join(checkout, "src/native/detectMusl.ts"))})
console.log(JSON.stringify(process.env.OPENTUI_LIBC ?? null))
`
  const base: Record<string, string | undefined> = { ...testEnv }
  delete base.OPENTUI_LIBC
  const proc = Bun.spawnSync(["bun", "-e", script], {
    cwd: checkout,
    env: { ...base, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(proc.stderr.toString()).toBe("")
  expect(proc.exitCode).toBe(0)
  return JSON.parse(proc.stdout.toString())
}

describe("the npm bundle's musl detection", () => {
  test("sets OPENTUI_LIBC=musl on a musl Linux", () => {
    expect(detected(undefined)).toBe("musl")
  })

  test("leaves OPENTUI_LIBC unset on a glibc Linux", () => {
    expect(detected("2.39")).toBeNull()
  })

  test("leaves an OPENTUI_LIBC already set as it is", () => {
    expect(detected(undefined, { OPENTUI_LIBC: "glibc" })).toBe("glibc")
  })

  test("is the npm entry's first import, and the entry the bundle's", () => {
    const entry = readFileSync(join(checkout, "src/npm.ts"), "utf8")
    const imports = entry.split("\n").filter((line) => line.startsWith("import "))
    expect(imports[0]).toBe('import "./native/detectMusl.ts"')
    const build = readFileSync(join(checkout, "scripts/build-npm.sh"), "utf8")
    expect(build).toContain("bun build --target=bun src/npm.ts ")
  })

  // The bundle is evaluated top to bottom, OpenTUI's native library resolved as its module is.
  slow.test(
    "comes before OpenTUI resolves its native library in the built bundle",
    () => {
      const out = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-npm-musl-"))), "bundle")
      const build = Bun.spawnSync(["scripts/build-npm.sh", "--out", out], {
        cwd: checkout,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(build.stderr.toString()).toBe("")
      expect(build.exitCode).toBe(0)
      const bundle = readFileSync(join(out, "tutti.js"), "utf8")
      const detection = bundle.indexOf('process.env.OPENTUI_LIBC ??= "musl"')
      const resolution = bundle.indexOf("await resolveNativeLibraryPath()")
      expect(detection).toBeGreaterThan(-1)
      expect(resolution).toBeGreaterThan(detection)
      expect(bundle.trimEnd().endsWith("main();")).toBe(true)
    },
    60_000,
  )
})
