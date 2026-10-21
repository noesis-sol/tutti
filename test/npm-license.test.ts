// The npm package's licence (§ 12 npm): MIT, in package.json's license and the LICENSE file at the
// repository's root, which bun pm pack and npm put in the package whatever package.json's files say.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { testEnv } from "./env.ts"

const checkout = resolve(import.meta.dir, "..")

describe("the npm package's licence", () => {
  test("is MIT in package.json", () => {
    expect(pkg.license).toBe("MIT")
  })

  test("is the MIT License in LICENSE, Michael Michailidis's copyright", () => {
    const text = readFileSync(join(checkout, "LICENSE"), "utf8")
    expect(text.startsWith("MIT License\n\nCopyright (c) 2026 Michael Michailidis\n")).toBe(true)
    expect(text).toContain(
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
    )
    expect(text.trimEnd().endsWith("SOFTWARE.")).toBe(true)
  })

  test("goes in the package bun pm pack makes", () => {
    const proc = Bun.spawnSync(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"], {
      cwd: checkout,
      env: testEnv,
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = proc.stdout.toString()
    expect(proc.exitCode).toBe(0)
    expect(out.split("\n").some((line) => /^packed \S+ LICENSE$/.test(line))).toBe(true)
  })
})
