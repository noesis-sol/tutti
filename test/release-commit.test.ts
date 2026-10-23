// scripts/release-commit.sh: whether HEAD is a release commit pushed alone, which CI leaves to the
// Release workflow's check at its tag (tutti-ac2x).
import { expect } from "bun:test"
import { resolve } from "node:path"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

const script = resolve(import.meta.dir, "../scripts/release-commit.sh")

const packageJson = (version: string, more = "") =>
  `{\n  "name": "@noesis-sol/tutti",\n  "version": "${version}",${more}\n  "license": "MIT"\n}\n`

const changelog = (heading: string) => `# Changelog\n\n${heading}\n\n- One.\n`

/** The script's answer in `repo` for a push that went on `before`. */
const releaseCommit = (repo: Repo, ...args: ReadonlyArray<string>) => {
  const proc = Bun.spawnSync(["sh", script, ...args], {
    cwd: repo.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: testEnv.PATH ?? "/usr/bin:/bin" },
  })
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() }
}

/** A repository whose 0.1.0 has work since, and that work's commit, the release's parent. */
const unreleased = () => {
  const repo = makeRepo()
  repo.commit("Add the package", {
    "package.json": packageJson("0.1.0"),
    "CHANGELOG.md": changelog("## Unreleased"),
  })
  return { repo, parent: repo.head() }
}

/** The release commit as release.yml's Releasing makes it, with `files` over its own. */
const release = (
  repo: Repo,
  version: string,
  subject = `Release ${version}`,
  files: Readonly<Record<string, string>> = {},
) =>
  repo.commit(`${subject}\n\nCo-Authored-By: Someone <someone@example.com>`, {
    "package.json": packageJson(version),
    "CHANGELOG.md": changelog(`## [${version}] - 2026-10-23`),
    ...files,
  })

slow.describe("scripts/release-commit.sh", () => {
  slow.test("a release commit pushed alone on its parent is one", () => {
    const { repo, parent } = unreleased()
    release(repo, "0.2.0")
    expect(releaseCommit(repo, parent)).toEqual({
      exitCode: 0,
      stdout: "a release commit pushed alone: 0.2.0\n",
    })
  })

  slow.test("so is a pre-release's", () => {
    const { repo, parent } = unreleased()
    release(repo, "1.0.0-rc.1")
    expect(releaseCommit(repo, parent).exitCode).toBe(0)
  })

  slow.test("not pushed with the commits under it, or as a new branch's first push", () => {
    const { repo } = unreleased()
    const start = repo.head("HEAD^")
    release(repo, "0.2.0")
    const withMore = releaseCommit(repo, start)
    expect(withMore.exitCode).toBe(1)
    expect(withMore.stdout).toContain("holds more than this commit")
    expect(releaseCommit(repo, "0".repeat(40)).exitCode).toBe(1)
  })

  slow.test("not with another subject", () => {
    for (const subject of [
      "Release notes for 0.2.0",
      "Release 0.2",
      "Release 0.2.0 and a fix",
      "release 0.2.0",
      "Release v0.2.0",
    ]) {
      const { repo, parent } = unreleased()
      release(repo, "0.2.0", subject)
      const answer = releaseCommit(repo, parent)
      expect({ subject, ...answer }).toEqual({
        subject,
        exitCode: 1,
        stdout: `not a release commit pushed alone: its subject is '${subject}', not 'Release X.Y.Z'\n`,
      })
    }
  })

  slow.test("not when it changes a file besides CHANGELOG.md and package.json", () => {
    const { repo, parent } = unreleased()
    release(repo, "0.2.0", undefined, { "src/main.ts": "export {}\n" })
    expect(releaseCommit(repo, parent)).toEqual({
      exitCode: 1,
      stdout: "not a release commit pushed alone: it changes src/main.ts\n",
    })
  })

  slow.test("not when it changes package.json besides its version, or to another", () => {
    const more = '\n  "dependencies": { "effect": "4.0.6" },'
    const cases = [
      { version: "0.2.0", json: packageJson("0.2.0", more) },
      { version: "0.2.0", json: packageJson("0.2.1") },
      { version: "0.2.0", json: packageJson("0.1.0") },
    ]
    for (const { version, json } of cases) {
      const { repo, parent } = unreleased()
      release(repo, version, undefined, { "package.json": json })
      expect(releaseCommit(repo, parent)).toEqual({
        exitCode: 1,
        stdout: `not a release commit pushed alone: it changes package.json other than setting its version to ${version}\n`,
      })
    }
  })

  slow.test("without its one argument it can't tell", () => {
    const { repo } = unreleased()
    expect(releaseCommit(repo).exitCode).toBe(2)
  })
})
