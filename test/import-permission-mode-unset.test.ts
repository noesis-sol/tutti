// tutti init's import from orchestra (§ 8.3): settings without a worker_permission_mode tutti takes
// leave workers.permission_mode at auto, while orchestra's workers ran in the mode the user's Claude
// Code settings choose, so the import's summary cautions that workers will run in auto.
import { describe, expect, test } from "bun:test"
import { importSettings, importSteps, type SettingsImport } from "../src/init/import.ts"
import { stepLine } from "../src/init/steps.ts"

const caution =
  "! import  worker_permission_mode isn't imported: orchestra's workers ran in your Claude Code settings' mode (defaultMode, else default), tutti's run in auto; choose another with workers.permission_mode (auto, default, acceptEdits) in .tutti/settings.json"

const lines = (settings: SettingsImport) =>
  importSteps({ settings, prompt: null }, true).map(stepLine)

describe("orchestra's settings without worker_permission_mode", () => {
  test("absent or unset, the import cautions that workers run in auto", () => {
    for (const orchestra of [
      { concurrent: 2 },
      { worker_permission_mode: "" },
      { worker_permission_mode: null },
    ]) {
      const imported = importSettings(orchestra)
      expect(imported.permissionModeUnset).toBe(true)
      expect(lines(imported)).toContain(caution)
    }
  })

  test("a mode tutti can't take is left out, and workers run in auto all the same", () => {
    const imported = importSettings({ worker_permission_mode: "bypassPermissions" })
    expect(imported.permissionModeUnset).toBe(true)
    expect(lines(imported)).toContain(caution)
  })

  test("a mode tutti takes is imported, with no caution", () => {
    for (const mode of ["auto", "default", "manual", "acceptEdits"]) {
      const imported = importSettings({ worker_permission_mode: mode })
      expect(imported.permissionModeUnset).toBe(false)
      expect(lines(imported)).not.toContain(caution)
    }
  })

  test("settings that can't be read, a declined import and none asked don't say it", () => {
    expect(importSettings([1]).permissionModeUnset).toBe(false)
    const imported = importSettings({ concurrent: 2 })
    for (const consent of [false, "unasked"] as const) {
      expect(
        importSteps({ settings: imported, prompt: null }, consent).map(stepLine),
      ).not.toContain(caution)
    }
  })
})
