#!/usr/bin/env bun
// M0 spike (tutti-nrg.1.7): compiles program.tsx with one platform's Claude Code embedded.
//
//   bun spikes/compile/build.ts [--out <dir>] <target>...
//
// Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64, linux-arm64-musl, linux-x64-musl,
// or host. Each builds entries/<target>.ts into <out>/tutti-spike-<target> (out defaults to a new
// temp folder) and prints `RESULT build {...}`: the size, the build time, the native packages that
// were installed (and so embedded), and any file the compile left in its working folder.
//
// A target other than the host needs its packages installed first: for a missing one, the RESULT
// line names the commands that install them. The compile runs in a temp folder of its own: `bun build --compile` leaves a copy
// of the Bun executable named `.<hash>-00000000.bun-build` in its working folder (tutti-nrg.21),
// which the script reports and then removes with the folder.
// Throwaway code: not part of tutti, not type-checked or linted by scripts/check.sh.

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

const TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
] as const

const here = import.meta.dir
const modules = join(here, "..", "..", "node_modules")

const { values, positionals } = parseArgs({
  options: { out: { type: "string" } },
  allowPositionals: true,
})
const out = values.out ?? realpathSync(mkdtempSync(join(tmpdir(), "tutti-compile-out-")))
const host = `${process.platform}-${process.arch}`
const targets = positionals.map((t) => (t === "host" ? host : t))
if (targets.length === 0 || targets.some((t) => !(TARGETS as readonly string[]).includes(t))) {
  process.stderr.write(`usage: build.ts [--out <dir>] <${[...TARGETS, "host"].join("|")}>...\n`)
  process.exit(2)
}

const installed = (scope: string, prefix: string) =>
  existsSync(join(modules, scope))
    ? readdirSync(join(modules, scope))
        .filter((name) => name.startsWith(prefix))
        .map((name) => `${scope}/${name}`)
    : []

let failed = false
for (const target of targets) {
  const claude = join(modules, "@anthropic-ai", `claude-agent-sdk-${target}`, "claude")
  const opentui = join(modules, "@opentui", `core-${target}`)
  if (!existsSync(claude) || !existsSync(opentui)) {
    const [os, cpu] = target.split("-")
    process.stdout.write(
      `RESULT build ${JSON.stringify({
        target,
        error: "the target's packages aren't installed",
        missing: [claude, opentui].filter((p) => !existsSync(p)),
        install: [
          `bun install --os=${os} --cpu=${cpu}`,
          `npm install @anthropic-ai/claude-agent-sdk-${target}@<sdk version> @opentui/core-${target}@<opentui version> --force --no-save`,
        ],
      })}\n`,
    )
    failed = true
    continue
  }
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tutti-compile-cwd-")))
  const outfile = join(out, `tutti-spike-${target}`)
  const argv = [
    process.execPath,
    "build",
    "--compile",
    `--target=bun-${target}`,
    "--define",
    'process.env.NODE_ENV:"production"',
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    join(here, "entries", `${target}.ts`),
    "--outfile",
    outfile,
  ]
  const t0 = performance.now()
  const build = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  const ms = Math.round(performance.now() - t0)
  const bytes = existsSync(outfile) ? statSync(outfile).size : null
  process.stdout.write(
    `RESULT build ${JSON.stringify({
      target,
      outfile,
      exitCode: build.exitCode,
      ms,
      bytes,
      mb: bytes === null ? null : Math.round(bytes / 1e5) / 10,
      claudeBytes: statSync(claude).size,
      nativePackages: [
        ...installed("@anthropic-ai", "claude-agent-sdk-"),
        ...installed("@opentui", "core-"),
      ],
      leftInCwd: readdirSync(cwd).map((name) => ({ name, bytes: statSync(join(cwd, name)).size })),
      ...(build.exitCode === 0 ? {} : { stderr: build.stderr.toString().slice(-2000) }),
    })}\n`,
  )
  rmSync(cwd, { recursive: true, force: true })
  if (build.exitCode !== 0) failed = true
}
process.exit(failed ? 1 : 0)
