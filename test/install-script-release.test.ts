// scripts/install.sh goes with each release (§ 12 Install): the release workflow attaches the tag's
// script, and the install instructions run the latest release's, not main's, so the script matches
// the archives it downloads.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const checkout = resolve(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(checkout, path), "utf8")

const latestScript = "https://github.com/noesis-sol/tutti/releases/latest/download/install.sh"

interface Workflow {
  readonly jobs: Record<
    string,
    { readonly steps: ReadonlyArray<{ readonly name?: string; readonly run?: string }> }
  >
}

describe("scripts/install.sh in each release", () => {
  test("the release workflow's publish job attaches it with the archives", () => {
    const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as Workflow
    const publish = release.jobs.publish?.steps.find((step) => step.name === "Publish")?.run ?? ""
    const assets = /^\s*set -- (.*)$/m.exec(publish)?.[1]?.split(/\s+/)
    expect(assets).toContain("scripts/install.sh")
    expect(assets).toContain("dist/checksums.txt.sig")
    // Uploaded under its own name, install.sh, by both gh release create and upload.
    expect(publish).toContain('gh release upload "$TAG" --clobber "$@"')
    expect(publish).toMatch(/gh release create "\$TAG"[^\n]*\\\n[^\n]*"\$@"/)
  })

  for (const path of [
    "README.md",
    "docs/setup.md",
    "skills/tutti/SKILL.md",
    "scripts/install.sh",
  ]) {
    test(`${path} pipes the latest release's script, not main's`, () => {
      const text = read(path)
      expect(text).toContain(`curl -fsSL ${latestScript} | sh`)
      expect(text).not.toContain(
        "raw.githubusercontent.com/noesis-sol/tutti/main/scripts/install.sh",
      )
    })
  }
})
