// scripts/build-npm.sh's TUTTI_BUILD_COMMIT define (§ 8.1, § 12 npm). A copy of the script runs in a
// temp folder with a fake bun first on PATH, which logs its arguments; the slow test makes the
// folder a git checkout with real git.
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"

const script = join(resolve(import.meta.dir, ".."), "scripts/build-npm.sh")

const bin = mkdtempSync(join(tmpdir(), "tutti-build-npm-bin-"))
writeFileSync(join(bin, "bun"), '#!/bin/sh\necho "$*" >>"$FAKE_LOG"\n')
chmodSync(join(bin, "bun"), 0o755)

/** A folder holding only the script, outside any git checkout. */
const setup = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-build-npm-")))
  mkdirSync(join(root, "scripts"))
  copyFileSync(script, join(root, "scripts/build-npm.sh"))
  return root
}

/** The bun build call the script made. */
const build = (root: string): string => {
  const log = join(root, "bun.log")
  writeFileSync(log, "")
  const proc = Bun.spawnSync(["sh", join(root, "scripts/build-npm.sh"), "--out", "out"], {
    cwd: root,
    env: { ...testEnv, PATH: `${bin}:${testEnv.PATH}`, FAKE_LOG: log },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(proc.exitCode).toBe(0)
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean)
  expect(calls).toHaveLength(1)
  return calls[0] ?? ""
}

describe("scripts/build-npm.sh", () => {
  test("outside a git checkout defines no commit, so the bundle shows the bare version", () => {
    const call = build(setup())
    expect(call).toContain('--define process.env.NODE_ENV:"production"')
    expect(call).not.toContain("TUTTI_BUILD_COMMIT")
  })

  slow.test("in a git checkout defines the commit's 12-character hash", () => {
    const root = setup()
    const git = (...args: string[]) => {
      const proc = Bun.spawnSync(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      )
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
      return proc.stdout.toString().trim()
    }
    writeFileSync(join(root, ".gitignore"), "out/\nbun.log\n")
    git("init", "-q")
    git("add", ".")
    git("commit", "-q", "-m", "one")
    const hash = git("rev-parse", "HEAD").slice(0, 12)
    expect(build(root)).toContain(`--define TUTTI_BUILD_COMMIT:"${hash}"`)
  })
})
