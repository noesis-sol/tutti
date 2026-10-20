// scripts/release-notes.sh: a version's section of the changelog, which becomes its Release's notes.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const script = resolve(import.meta.dir, "../scripts/release-notes.sh")

const changelog = `# Changelog

## Unreleased

- Next.

## [0.9.0] - 2026-10-20


- One.

  More of one.

- Two.

## [0.8.0-rc.1] - 2026-10-01

- Early.

## [0.7.0] - 2026-09-01

## [0.6.0] - 2026-08-01

- Last.

[0.9.0]: https://github.com/noesis-sol/tutti/compare/v0.8.0-rc.1...v0.9.0
`

const notes = (version: string) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-release-notes-"))
  writeFileSync(join(dir, "CHANGELOG.md"), changelog)
  const proc = Bun.spawnSync(["sh", script, version], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

describe("scripts/release-notes.sh", () => {
  test("prints the version's section, without its heading or the blank lines around it", () => {
    expect(notes("v0.9.0")).toEqual({
      exitCode: 0,
      stdout: "- One.\n\n  More of one.\n\n- Two.\n",
      stderr: "",
    })
  })

  test("takes a pre-release's version, with or without the v", () => {
    expect(notes("v0.8.0-rc.1").stdout).toBe("- Early.\n")
    expect(notes("0.8.0-rc.1").stdout).toBe("- Early.\n")
  })

  test("the last section ends at the links", () => {
    expect(notes("v0.6.0").stdout).toBe("- Last.\n")
  })

  test.each(["v0.7.0", "v1.0.0", "v0.9"])("%s, with no notes, fails", (version) => {
    const result = notes(version)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`has no notes for ${version.replace(/^v/, "")}`)
  })
})
