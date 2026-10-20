// scripts/build.sh (§ 12 Builds, Cross-compiling). The fast tests run a copy of the script in a temp
// folder with a fake bun first on PATH, which logs each call, installs empty platform packages as
// `bun install --os --cpu` would, and writes a file for each `bun build`. The slow ones use real git,
// and one compiles this machine's binary for real and runs it.
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { slow } from "./gates.ts"

const checkout = resolve(import.meta.dir, "..")
const script = join(checkout, "scripts/build.sh")
const host = `${process.platform}-${process.arch}`

// The fake bun. `install` without --os installs the host's packages (FAKE_HOST); with --os and
// --cpu it adds that platform's, and for Linux the musl ones too, beside those there. `build` logs
// its working folder and the OpenTUI packages installed, the ones a real compile would embed, and
// leaves a .bun-build file there, as a real compile does (tutti-nrg.21, oven-sh/bun#14020).
const bin = mkdtempSync(join(tmpdir(), "tutti-build-script-bin-"))
writeFileSync(
  join(bin, "bun"),
  `#!/bin/sh
case $1 in
--print) echo 0.9.0; exit 0 ;;
install)
  echo "install $*" >>"$FAKE_LOG"
  os= cpu=
  for arg; do
    case $arg in --os=*) os=\${arg#--os=} ;; --cpu=*) cpu=\${arg#--cpu=} ;; esac
  done
  platforms=$FAKE_HOST
  if [ -n "$os" ]; then
    platforms=$os-$cpu
    [ "$os" = linux ] && platforms="$platforms $os-$cpu-musl"
  fi
  for p in $platforms; do
    mkdir -p "node_modules/@opentui/core-$p" "node_modules/@anthropic-ai/claude-agent-sdk-$p"
  done ;;
build)
  echo "build in=$PWD embeds=$(ls "$FAKE_ROOT/node_modules/@opentui" | tr '\\n' ' ')$*" >>"$FAKE_LOG"
  echo bun >.1fc64566d4203500-00000000.bun-build
  while [ "$1" != --outfile ]; do shift; done
  echo binary >"$2"
  exit "\${FAKE_BUILD_EXIT:-0}" ;;
esac
`,
)
chmodSync(join(bin, "bun"), 0o755)

/** A checkout holding the script, the entries' names, the notices and, already installed, the host's packages. */
const setup = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-build-script-")))
  mkdirSync(join(root, "scripts"))
  copyFileSync(script, join(root, "scripts/build.sh"))
  mkdirSync(join(root, "src/entries"), { recursive: true })
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n")
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "notices\n")
  for (const p of [host, "core"]) {
    mkdirSync(join(root, "node_modules/@opentui", p === "core" ? p : `core-${p}`), {
      recursive: true,
    })
  }
  mkdirSync(join(root, `node_modules/@anthropic-ai/claude-agent-sdk-${host}`), { recursive: true })
  mkdirSync(join(root, "node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true })
  return root
}

const run = (root: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const log = join(root, "bun.log")
  writeFileSync(log, "")
  const proc = Bun.spawnSync(["sh", join(root, "scripts/build.sh"), ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_ROOT: root,
      FAKE_HOST: host,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
  }
}

/** The folders the builds ran in, and the .bun-build files under the checkout. */
const leftovers = (root: string, calls: ReadonlyArray<string>) => ({
  folders: calls.flatMap((c) => /^build in=(\S+) /.exec(c)?.[1] ?? []).filter(existsSync),
  copies: readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".bun-build"),
  ),
})

const installed = (root: string, scope: string) => readdirSync(join(root, "node_modules", scope))

/** Whether node_modules holds the host platform's packages and no other platform's. */
const hostsOnly = (root: string) => {
  const platform = host.replace(/-musl$/, "")
  const ours = (name: string, prefix: string) =>
    name === prefix || name === `${prefix}-${platform}` || name === `${prefix}-${platform}-musl`
  expect(installed(root, "@opentui")).toContain(`core-${platform}`)
  expect(installed(root, "@opentui").filter((name) => !ours(name, "core"))).toEqual([])
  expect(
    installed(root, "@anthropic-ai").filter((name) => !ours(name, "claude-agent-sdk")),
  ).toEqual([])
}

describe("scripts/build.sh", () => {
  test.each([[[]], [["freebsd-x64"]], [["--sign", "host"]], [["--out"]]])(
    "%j is a usage error, which builds nothing",
    (args) => {
      const root = setup()
      const result = run(root, args)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("usage: scripts/build.sh")
      expect(result.stderr).toContain("linux-x64-musl")
      expect(result.calls).toEqual([])
    },
  )

  test("installs each platform's packages once, only them, and builds each target from its entry", () => {
    const root = setup()
    const out = join(root, "out")
    const result = run(root, ["--out", out, "linux-x64", "linux-x64-musl", "darwin-arm64"])
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    const flags = [
      "--define",
      'process.env.NODE_ENV:"production"',
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
    ]
    const build = (target: string, embeds: string) => {
      const call = result.calls.find((c) => c.includes(`--target=bun-${target} `)) ?? ""
      expect(call).toContain(`embeds=core ${embeds} build --compile`)
      for (const flag of flags) expect(call).toContain(flag)
      expect(call).toContain(`${root}/src/entries/${target}.ts --outfile ${out}/${target}/tutti`)
      // Not in the checkout, where the compile would leave its copy of Bun.
      expect(call).not.toContain(`in=${root} `)
      expect(readFileSync(join(out, target, "tutti"), "utf8")).toBe("binary\n")
    }
    build("linux-x64", "core-linux-x64 core-linux-x64-musl")
    build("linux-x64-musl", "core-linux-x64 core-linux-x64-musl")
    build("darwin-arm64", "core-darwin-arm64")
    expect(result.calls.filter((c) => c.startsWith("install"))).toEqual([
      "install install --frozen-lockfile --os=linux --cpu=x64",
      "install install --frozen-lockfile --os=darwin --cpu=arm64",
      "install install --frozen-lockfile",
    ])
    // The host's packages again, and no other's, for the checkout's own runs.
    hostsOnly(root)
    // The compiles' copies of Bun went with their temp folder.
    expect(leftovers(root, result.calls)).toEqual({ folders: [], copies: [] })
  })

  test("host is this machine's target", () => {
    const root = setup()
    const result = run(root, ["--out", join(root, "out"), "host"])
    expect(result.exitCode).toBe(0)
    expect(result.calls.some((c) => c.includes(`--target=bun-${host} `))).toBe(true)
  })

  test("--archive packs each binary with the notices, named for the target", () => {
    const root = setup()
    const out = join(root, "out")
    const result = run(root, ["--out", out, "--archive", "linux-arm64", "linux-arm64-musl"])
    expect(result.exitCode).toBe(0)
    expect(readdirSync(out).sort()).toEqual([
      "linux-arm64",
      "linux-arm64-musl",
      "tutti_0.9.0_linux_arm64.tar.gz",
      "tutti_0.9.0_linux_arm64_musl.tar.gz",
    ])
    for (const archive of [
      "tutti_0.9.0_linux_arm64.tar.gz",
      "tutti_0.9.0_linux_arm64_musl.tar.gz",
    ]) {
      const list = Bun.spawnSync(["tar", "-tzf", join(out, archive)]).stdout.toString()
      expect(list.split("\n").filter(Boolean).sort()).toEqual([
        "CHANGELOG.md",
        "THIRD_PARTY_NOTICES.md",
        "tutti",
      ])
    }
  })

  test("outside a git checkout a build defines no commit, so it shows the bare version", () => {
    const root = setup()
    const result = run(root, ["--out", join(root, "out"), "linux-x64"])
    expect(result.exitCode).toBe(0)
    expect(result.calls.find((c) => c.startsWith("build"))).not.toContain("TUTTI_BUILD_COMMIT")
  })

  test("a failed compile fails the script and still puts the host's packages back", () => {
    const root = setup()
    const result = run(root, ["--out", join(root, "out"), "linux-x64", "darwin-x64"], {
      FAKE_BUILD_EXIT: "1",
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.calls.filter((c) => c.startsWith("build"))).toHaveLength(1)
    expect(result.calls.at(-1)).toBe("install install --frozen-lockfile")
    hostsOnly(root)
    expect(leftovers(root, result.calls)).toEqual({ folders: [], copies: [] })
  })

  describe("in a git checkout", () => {
    const repo = (): { root: string; git: (...args: string[]) => string } => {
      const root = setup()
      const git = (...args: string[]) => {
        const proc = Bun.spawnSync(
          [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: root, stdout: "pipe", stderr: "pipe" },
        )
        if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
        return proc.stdout.toString().trim()
      }
      writeFileSync(join(root, ".gitignore"), "node_modules/\nout/\nbun.log\n")
      git("init", "-q")
      git("add", ".")
      git("commit", "-q", "-m", "one")
      return { root, git }
    }
    const commitDefine = (calls: ReadonlyArray<string>) =>
      /--define TUTTI_BUILD_COMMIT:"([^"]*)"/.exec(
        calls.find((c) => c.startsWith("build")) ?? "",
      )?.[1]

    slow.test("a build defines the commit's 12-character hash, +dirty with changes", () => {
      const { root, git } = repo()
      const hash = git("rev-parse", "HEAD").slice(0, 12)
      expect(commitDefine(run(root, ["--out", join(root, "out"), "linux-x64"]).calls)).toBe(hash)
      writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n- more\n")
      expect(commitDefine(run(root, ["--out", join(root, "out"), "linux-x64"]).calls)).toBe(
        `${hash}+dirty`,
      )
    })

    slow.test("--release defines no commit, and refuses a tree with changes", () => {
      const { root } = repo()
      const clean = run(root, ["--out", join(root, "out"), "--release", "linux-x64"])
      expect(clean.exitCode).toBe(0)
      expect(commitDefine(clean.calls)).toBe("")
      writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n- more\n")
      const dirty = run(root, ["--out", join(root, "out"), "--release", "linux-x64"])
      expect(dirty.exitCode).toBe(1)
      expect(dirty.stderr).toContain("--release needs a clean tree")
      expect(dirty.stderr).toContain("CHANGELOG.md")
      expect(dirty.calls).toEqual([])
    })
  })

  // The real thing: this machine's binary, compiled with its Claude Code embedded, runs.
  slow.test(
    "builds this machine's binary, which runs tutti --version",
    () => {
      const out = realpathSync(mkdtempSync(join(tmpdir(), "tutti-build-host-")))
      const copies = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".bun-build"))
      const before = copies(checkout)
      const build = Bun.spawnSync(["sh", script, "--out", out, "host"], {
        cwd: checkout,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(build.stderr.toString()).not.toContain("error:")
      expect(build.exitCode).toBe(0)
      // The compile's copy of Bun (oven-sh/bun#14020) is neither in the checkout nor beside the binary.
      expect(copies(checkout)).toEqual(before)
      const [target] = readdirSync(out)
      expect(copies(join(out, target ?? ""))).toEqual([])
      const binary = join(out, target ?? "", "tutti")
      expect(existsSync(binary)).toBe(true)
      const version = Bun.spawnSync([binary, "--version"], { cwd: out, stdout: "pipe" })
      expect(version.exitCode).toBe(0)
      expect(version.stdout.toString()).toMatch(
        new RegExp(`^tutti v${pkg.version.replaceAll(".", "\\.")} [0-9a-f]{12}(\\+dirty)?\\n$`),
      )
    },
    300_000,
  )
})
