// tutti init's import from orchestra (§ 8.3), key by key: worker_permission_mode goes to
// workers.permission_mode, orchestra's manual as default, and each setting orchestra has that tutti
// has no place for is left out with why, named without its value, not as one tutti doesn't know.
import { describe, expect, test } from "bun:test"
import { Exit } from "effect"
import { importSettings } from "../src/init/import.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import { Settings } from "../src/project/settings.ts"

const unknown = "not an orchestra setting tutti knows"

describe("orchestra's worker_permission_mode, imported", () => {
  for (const [orchestra, tutti] of [
    ["manual", "default"],
    ["default", "default"],
    ["acceptEdits", "acceptEdits"],
    ["auto", "auto"],
  ] as const) {
    test(`${orchestra} is workers.permission_mode ${tutti}`, () => {
      const imported = importSettings({ worker_permission_mode: orchestra })
      expect(imported.json).toEqual({ workers: { permission_mode: tutti } })
      expect(imported.imported).toEqual([
        { key: "worker_permission_mode", to: "workers.permission_mode" },
      ])
      expect(imported.leftOut).toEqual([])
      const decoded = decodeConfig(Settings, "settings.json", imported.json)
      expect(Exit.isSuccess(decoded) && decoded.value.workers.permission_mode).toBe(tutti)
    })
  }

  test("unset, it is skipped, as orchestra reads it unset", () => {
    const imported = importSettings({ worker_permission_mode: "" })
    expect(imported.json).toEqual({})
    expect(imported.leftOut).toEqual([])
  })

  test("a mode that doesn't suit a worker is left out with why", () => {
    for (const mode of ["bypassPermissions", "plan", "yolo"]) {
      const imported = importSettings({ worker_permission_mode: mode })
      expect(imported.json).toEqual({})
      expect(imported.leftOut).toHaveLength(1)
      expect(imported.leftOut[0]?.key).toBe(`worker_permission_mode ("${mode}")`)
      expect(imported.leftOut[0]?.why).toStartWith("tutti can't take it: ")
      expect(imported.leftOut[0]?.why).toContain("permission_mode")
    }
  })
})

describe("orchestra's settings tutti has no place for", () => {
  for (const [key, value, why] of [
    [
      "usage_limit_wait",
      "4h",
      "tutti takes it for each run, as --usage-limit-wait (6h by default), not from its settings",
    ],
    [
      "overnight_free_disk_gb",
      30,
      "tutti takes it for each run, as --overnight-free-disk (20 GB by default), not from its settings",
    ],
    ["questions", "key", "tutti has no answer talk yet for it to say how to open"],
  ] as const) {
    test(`${key} is left out with why`, () => {
      const imported = importSettings({ [key]: value })
      expect(imported.json).toEqual({})
      expect(imported.imported).toEqual([])
      expect(imported.leftOut).toEqual([{ key, why }])
      expect(imported.leftOut[0]?.why).not.toBe(unknown)
    })
  }

  test("a key orchestra doesn't have is still one tutti doesn't know", () => {
    expect(importSettings({ worker_colour: "blue" }).leftOut).toEqual([
      { key: 'worker_colour ("blue")', why: unknown },
    ])
  })
})
