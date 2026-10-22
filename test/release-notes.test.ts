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

const notes = (version: string, text = changelog, env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-release-notes-"))
  writeFileSync(join(dir, "CHANGELOG.md"), text)
  const proc = Bun.spawnSync(["sh", script, version], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", ...env },
  })
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

// A section of five entries, the second of two lines: the first three take 36 characters with
// their newlines (9, 17 and 10).
const long = `## [1.0.0] - 2026-10-22

- First.
- Second
  more.
- Third..
- Fourth.
- Fifth...
`

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

  test("a section over the limit keeps the whole entries that fit, then links to the changelog", () => {
    const result = notes("v1.0.0", long, {
      RELEASE_NOTES_LIMIT: "36",
      GITHUB_REPOSITORY: "someone/tutti",
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(
      "- First.\n- Second\n  more.\n- Third..\n\n" +
        "…and 2 more, too many for a Release: every change is in " +
        "https://github.com/someone/tutti/blob/v1.0.0/CHANGELOG.md\n",
    )
  })

  test("a section within the limit is printed whole, with no link", () => {
    expect(notes("v1.0.0", long, { RELEASE_NOTES_LIMIT: "1000" }).stdout).toBe(
      "- First.\n- Second\n  more.\n- Third..\n- Fourth.\n- Fifth...\n",
    )
  })

  test("is cut within GitHub's 125,000 characters by default", () => {
    const entries = Array.from({ length: 400 }, (_, i) => `- Entry ${i} ${"x".repeat(990)}`)
    const result = notes("v1.0.0", `## [1.0.0] - 2026-10-22\n\n${entries.join("\n")}\n`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBeLessThan(125_000)
    expect(result.stdout).toContain("- Entry 0 ")
    expect(result.stdout).toMatch(/…and \d+ more, too many for a Release/)
  })

  test.each(["v0.7.0", "v1.0.0", "v0.9"])("%s, with no notes, fails", (version) => {
    const result = notes(version)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`has no notes for ${version.replace(/^v/, "")}`)
  })
})
