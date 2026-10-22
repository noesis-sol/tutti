// scripts/build.sh host on a machine it has no target for (tutti-mc7): install.sh sends a user on
// riscv64, armv7l or FreeBSD to it, and it stops there with its message, once, rather than loop. A
// fake uname first on PATH makes the machine; nothing is installed or built, so no bun is needed.
import { describe, expect, test } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { testEnv, which } from "./env.ts"

const script = resolve(import.meta.dir, "../scripts/build.sh")

/** Runs a copy of the script with `args` under `shell`, on a machine whose uname says `os` and `cpu`. */
const run = (shell: string, os: string, cpu: string, args: ReadonlyArray<string>) => {
  const root = mkdtempSync(join(tmpdir(), "tutti-build-script-host-"))
  mkdirSync(join(root, "scripts"))
  copyFileSync(script, join(root, "scripts/build.sh"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(
    join(bin, "uname"),
    `#!/bin/sh\ncase $1 in -s) echo ${os} ;; -m) echo ${cpu} ;; esac\n`,
  )
  chmodSync(join(bin, "uname"), 0o755)
  const proc = Bun.spawnSync([shell, join(root, "scripts/build.sh"), ...args], {
    cwd: root,
    env: { ...testEnv, PATH: `${bin}:${testEnv.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
    // The loop this guards against never ends: stop it rather than the test's time limit.
    timeout: 5_000,
  })
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() }
}

const count = (text: string, line: string) => text.split("\n").filter((l) => l === line).length

describe("scripts/build.sh host on an unsupported platform", () => {
  for (const shell of ["sh", "dash", "bash"]) {
    test.skipIf(which(shell) === null)(`stops on the OS, once, under ${shell}`, () => {
      const result = run(shell, "FreeBSD", "amd64", ["host"])
      expect(result.exitCode).toBe(1)
      expect(count(result.stderr, "scripts/build.sh: no target for FreeBSD")).toBe(1)
      expect(result.stderr).not.toContain("usage:")
    })

    test.skipIf(which(shell) === null)(`stops on the CPU, once, under ${shell}`, () => {
      const result = run(shell, "Linux", "riscv64", ["--out", "out", "host", "linux-x64"])
      expect(result.exitCode).toBe(1)
      expect(count(result.stderr, "scripts/build.sh: no target for riscv64")).toBe(1)
      expect(result.stderr).not.toContain("usage:")
    })
  }
})
