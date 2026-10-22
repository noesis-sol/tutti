// tutti init's import from orchestra (§ 8.3): settings without a worker_permission_mode tutti takes
// leave workers.permission_mode at auto, so the import's summary cautions that workers will run in
// auto. Where orchestra's is unset, its workers ran in the mode the user's Claude Code settings
// choose, which it says; a mode orchestra refuses too is only said to leave workers in auto.
import { describe, expect, test } from "bun:test"
import { importSettings, importSteps, type SettingsImport } from "../src/init/import.ts"
import { stepLine } from "../src/init/steps.ts"

const choose =
  "choose another with workers.permission_mode (auto, default, acceptEdits) in .tutti/settings.json"
const unsetCaution = `! import  worker_permission_mode isn't set: orchestra's workers ran in your Claude Code settings' mode (defaultMode, else default), tutti's run in auto; ${choose}`
const leftOutCaution = `! import  worker_permission_mode isn't imported: tutti's workers run in auto; ${choose}`

const lines = (settings: SettingsImport, consent: boolean | "unasked" = true) =>
  importSteps({ settings, prompt: null }, consent).map(stepLine)

describe("orchestra's settings without worker_permission_mode", () => {
  test("absent or unset, the import cautions that workers run in auto, not in Claude Code's mode", () => {
    for (const orchestra of [
      { concurrent: 2 },
      { worker_permission_mode: "" },
      { worker_permission_mode: null },
    ]) {
      const imported = importSettings(orchestra)
      expect(imported.permissionMode).toBe("unset")
      expect(lines(imported)).toContain(unsetCaution)
      expect(lines(imported)).not.toContain(leftOutCaution)
    }
  })

  test("a mode tutti can't take is left out, and workers run in auto, saying nothing of orchestra", () => {
    for (const mode of ["bypassPermissions", "plan", "auot", 3]) {
      const imported = importSettings({ worker_permission_mode: mode })
      expect(imported.permissionMode).toBe("leftOut")
      expect(lines(imported)).toContain(leftOutCaution)
      expect(lines(imported)).not.toContain(unsetCaution)
    }
  })

  test("settings that can't be read leave workers in auto too", () => {
    const imported = importSettings([1])
    expect(imported.permissionMode).toBe("leftOut")
    expect(lines(imported)).toContain(leftOutCaution)
  })

  test("a mode tutti takes is imported, with no caution", () => {
    for (const mode of ["auto", "default", "manual", "acceptEdits"]) {
      const imported = importSettings({ worker_permission_mode: mode })
      expect(imported.permissionMode).toBe("imported")
      const shown = lines(imported)
      expect(shown.some((line) => line.includes("worker_permission_mode isn't"))).toBe(false)
    }
  })

  test("a declined import and one not asked don't say it", () => {
    const imported = importSettings({ concurrent: 2 })
    for (const consent of [false, "unasked"] as const) {
      const shown = lines(imported, consent)
      expect(shown.some((line) => line.includes("worker_permission_mode isn't"))).toBe(false)
    }
  })
})
