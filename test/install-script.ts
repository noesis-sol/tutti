// The fixtures of scripts/install.sh's tests (§ 12 Install): the script run end to end, piped into sh
// as `curl … | sh` does, against a folder of fixture releases served from file:// paths through
// TUTTI_DOWNLOAD_URL: each release has the six archives, each holding a tutti that prints its version
// and names its archive, and checksums.txt signed with a key made here, which TUTTI_TEST_RELEASE_KEY
// makes the script trust. A fake uname, ldd and sysctl, first on PATH, and a file in place of
// /proc/cpuinfo make the machine another one where a test needs it.
import { expect } from "bun:test"
import { generateKeyPairSync, type KeyObject } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { signChecksums } from "../scripts/sign-checksums.ts"
import { testEnv, which } from "./env.ts"

export const script = readFileSync(resolve(import.meta.dir, "../scripts/install.sh"))

export const archives = (tag: string) =>
  [
    "darwin_arm64",
    "darwin_x64",
    "linux_arm64",
    "linux_x64",
    "linux_arm64_musl",
    "linux_x64_musl",
  ].map((target) => `tutti_${tag.slice(1)}_${target}.tar.gz`)

/** The PEM public keys in `text`, trimmed, in order. */
export const pemKeys = (text: string): ReadonlyArray<string> =>
  text.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? []

/** The keys in install.sh's `release_keys='…'`. */
export const scriptKeys = () => {
  const value = /^release_keys='([^']*)'$/m.exec(script.toString())
  expect(value, "install.sh sets release_keys='…'").not.toBeNull()
  return pemKeys(value?.[1] ?? "")
}

const sha256 = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex")

export const newKey = () => generateKeyPairSync("ed25519")

export const publicPem = (key: { publicKey: KeyObject }) =>
  key.publicKey.export({ type: "spki", format: "pem" }).toString()

// One fake for uname, ldd, sysctl and a LibreSSL openssl, linked under each name and steered by
// FAKE_* variables. ldd prints FAKE_LDD and exits 1, as musl's does. sysctl -n prints FAKE_AVX2 for
// hw.optional.avx2_0 and FAKE_TRANSLATED for sysctl.proc_translated, and fails as for a name the
// machine hasn't (an Intel Mac has no sysctl.proc_translated) where that is empty.
export const bin = mkdtempSync(join(tmpdir(), "tutti-install-script-bin-"))
writeFileSync(
  join(bin, "fake"),
  `#!/bin/sh
case "$(basename "$0")" in
uname) case "$1" in -s) echo "$FAKE_KERNEL" ;; -m) echo "$FAKE_MACHINE" ;; esac ;;
ldd) [ -z "\${FAKE_LDD:-}" ] || echo "$FAKE_LDD"; exit 1 ;;
sysctl)
  case "$2" in hw.optional.avx2_0) value="\${FAKE_AVX2:-}" ;; sysctl.proc_translated) value="\${FAKE_TRANSLATED:-}" ;; *) value= ;; esac
  if [ -z "$value" ]; then echo "sysctl: unknown oid '$2'" >&2; exit 1; fi
  echo "$value" ;;
libressl) echo 'LibreSSL 3.3.6' ;;
esac
`,
)
chmodSync(join(bin, "fake"), 0o755)
for (const tool of ["uname", "ldd", "sysctl", "libressl"]) symlinkSync("fake", join(bin, tool))

/** Whether an OpenSSL 3, which can verify ed25519, is where the script looks for one. */
export const hasOpenssl3 = [
  "openssl",
  "/opt/homebrew/bin/openssl",
  "/usr/local/opt/openssl@3/bin/openssl",
]
  .map((candidate) => which(candidate))
  .some((path) => {
    if (path === null) return false
    const out = Bun.spawnSync([path, "version"], { stdout: "pipe", stderr: "ignore" })
    return /^OpenSSL ([3-9]\.|[1-9][0-9])/.test(out.stdout.toString())
  })

/** A tar.gz holding `files`, made with tar. */
const tarGz = (files: Record<string, string>): Uint8Array => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-install-script-archive-"))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body)
    chmodSync(join(dir, name), 0o755)
  }
  const proc = Bun.spawnSync(["tar", "-czf", "archive.tar.gz", ...Object.keys(files)], {
    cwd: dir,
    env: { ...testEnv, COPYFILE_DISABLE: "1" },
  })
  if (proc.exitCode !== 0) throw new Error(`tar failed: ${proc.stderr.toString()}`)
  return readFileSync(join(dir, "archive.tar.gz"))
}

type Release = {
  readonly tag: string
  readonly signedWith?: KeyObject
  /** checksums.txt's sum for each archive, in place of its own. */
  readonly sum?: string
}

/**
 * A folder of releases as GitHub serves them, download/<tag>/<name>, with `latest` holding the last
 * one's tag, and its file:// URL. Each archive's tutti prints `tutti <tag>` and names its archive.
 */
export const releasesFolder = (key: KeyObject, releases: ReadonlyArray<Release>): string => {
  const root = mkdtempSync(join(tmpdir(), "tutti-install-script-releases-"))
  for (const release of releases) {
    const dir = join(root, "download", release.tag)
    mkdirSync(dir, { recursive: true })
    let sums = ""
    for (const name of archives(release.tag)) {
      const archive = tarGz({
        tutti: `#!/bin/sh\n# ${name}\necho 'tutti ${release.tag}'\n`,
        "README.md": "# tutti\n",
      })
      writeFileSync(join(dir, name), archive)
      sums += `${release.sum ?? sha256(archive)}  ${name}\n`
    }
    writeFileSync(join(dir, "checksums.txt"), sums)
    writeFileSync(
      join(dir, "checksums.txt.sig"),
      signChecksums(Buffer.from(sums), release.signedWith ?? key),
    )
  }
  writeFileSync(join(root, "latest"), `${releases.at(-1)?.tag}\n`)
  return `file://${root}`
}

export type Install = {
  readonly releases: string
  /** The PEM public key the script trusts; "" for the script's own keys. */
  readonly key: string
  readonly shell?: string
  /** The machine uname tells, such as ["Linux", "x86_64"]; this one's when unset. */
  readonly uname?: readonly [string, string]
  readonly ldd?: string
  /**
   * The text of the file that replaces /proc/cpuinfo, null for none; where uname is faked, a CPU
   * with AVX2 when unset.
   */
  readonly cpuinfo?: string | null
  /** What the fake sysctl says, where uname is faked: by default, an Intel Mac with AVX2. */
  readonly sysctl?: { readonly avx2?: string; readonly translated?: string }
  /** The musl loaders in the folder that replaces /lib. */
  readonly loaders?: ReadonlyArray<string>
  readonly env?: Record<string, string>
}

export type Ran = {
  readonly code: number | null
  readonly out: string
  /** The folder it installs in by default, ~/.local/bin, and the HOME. */
  readonly dir: string
  readonly home: string
}

/** A /proc/cpuinfo of two x64 CPUs whose flags are `flags`, after some every x64 CPU has. */
export const cpuWith = (flags: ReadonlyArray<string>) =>
  [0, 1]
    .map(
      (n) =>
        `processor\t: ${n}\nvendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Xeon(R) CPU\n` +
        `flags\t\t: ${["fpu", "vme", "sse", "sse2", ...flags].join(" ")}\n`,
    )
    .join("\n")

export const temp = (name: string) => mkdtempSync(join(tmpdir(), `tutti-install-script-${name}-`))

/** Runs the script piped into the shell, `curl … | sh`, and what it printed, stdout and stderr. */
export const install = (options: Install): Ran => {
  const home = temp("home")
  const lib = temp("lib")
  for (const loader of options.loaders ?? []) writeFileSync(join(lib, loader), "")
  const cpuinfo = join(temp("cpuinfo"), "cpuinfo")
  const cpu = options.cpuinfo === undefined ? cpuWith(["avx", "avx2"]) : options.cpuinfo
  if (cpu !== null) writeFileSync(cpuinfo, cpu)
  // The machine's own TUTTI_* settings stay out of it.
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(testEnv)) {
    if (!name.startsWith("TUTTI_") && value !== undefined) env[name] = value
  }
  Object.assign(env, {
    PATH: options.uname === undefined ? env.PATH : `${bin}:${env.PATH}`,
    HOME: home,
    TMPDIR: temp("tmp"),
    SHELL: "/bin/zsh",
    FAKE_KERNEL: options.uname?.[0] ?? "",
    FAKE_MACHINE: options.uname?.[1] ?? "",
    FAKE_LDD: options.ldd ?? "",
    FAKE_AVX2: options.sysctl?.avx2 ?? "1",
    FAKE_TRANSLATED: options.sysctl?.translated ?? "",
    TUTTI_DOWNLOAD_URL: options.releases,
    TUTTI_TEST_RELEASE_KEY: options.key,
    TUTTI_TEST_LIB_DIR: lib,
    // The host's own /proc/cpuinfo where uname isn't faked.
    ...(options.uname === undefined ? {} : { TUTTI_TEST_CPUINFO: cpuinfo }),
    ...options.env,
  })
  const proc = Bun.spawnSync([options.shell ?? "sh"], {
    stdin: script,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
    dir: join(home, ".local/bin"),
    home,
  }
}

/**
 * What dir/tutti is: the archive it came from and what --version prints; undefined when none, or no
 * such folder.
 */
export const installed = (dir: string) => {
  if (!existsSync(dir)) return undefined
  const names = readdirSync(dir)
  if (names.length === 0) return undefined
  // Nothing else is left behind, such as a temporary copy.
  expect(names).toEqual(["tutti"])
  const binary = join(dir, "tutti")
  const version = Bun.spawnSync([binary, "--version"], { stdout: "pipe" }).stdout.toString().trim()
  const archive = /^# (\S+)$/m.exec(readFileSync(binary, "utf8"))?.[1]
  return { archive, version }
}

export const hostArchive = (tag: string) =>
  `tutti_${tag.slice(1)}_${process.platform}_${process.arch}.tar.gz`

export const signatureChecked = (out: string) => {
  if (out.includes("Verified the signature of checksums.txt")) return true
  expect(out).toContain("The signature of checksums.txt wasn't checked")
  return false
}

export const timeout = 30_000
