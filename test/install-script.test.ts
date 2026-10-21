// scripts/install.sh (§ 12 Install) end to end, piped into sh as `curl … | sh` does, against a folder
// of fixture releases served from file:// paths through TUTTI_DOWNLOAD_URL: each release has the six
// archives, each holding a tutti that prints its version and names its archive, and checksums.txt
// signed with a key made here, which TUTTI_TEST_RELEASE_KEY makes the script trust. A fake uname and
// ldd, first on PATH, make the machine a Linux one where a test needs it.
import { describe, expect, test } from "bun:test"
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
import { parsePublicKey, releaseKeys } from "../src/update/keys.ts"
import { testEnv, which } from "./env.ts"

const script = readFileSync(resolve(import.meta.dir, "../scripts/install.sh"))

const archives = (tag: string) =>
  [
    "darwin_arm64",
    "darwin_x64",
    "linux_arm64",
    "linux_x64",
    "linux_arm64_musl",
    "linux_x64_musl",
  ].map((target) => `tutti_${tag.slice(1)}_${target}.tar.gz`)

/** The PEM public keys in `text`, trimmed, in order. */
const pemKeys = (text: string): ReadonlyArray<string> =>
  text.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? []

/** The keys in install.sh's `release_keys='…'`. */
const scriptKeys = () => {
  const value = /^release_keys='([^']*)'$/m.exec(script.toString())
  expect(value, "install.sh sets release_keys='…'").not.toBeNull()
  return pemKeys(value?.[1] ?? "")
}

const sha256 = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex")

const newKey = () => generateKeyPairSync("ed25519")

const publicPem = (key: { publicKey: KeyObject }) =>
  key.publicKey.export({ type: "spki", format: "pem" }).toString()

// One fake for uname, ldd and a LibreSSL openssl, linked under each name and steered by FAKE_*
// variables. ldd prints FAKE_LDD and exits 1, as musl's does.
const bin = mkdtempSync(join(tmpdir(), "tutti-install-script-bin-"))
writeFileSync(
  join(bin, "fake"),
  `#!/bin/sh
case "$(basename "$0")" in
uname) case "$1" in -s) echo "$FAKE_KERNEL" ;; -m) echo "$FAKE_MACHINE" ;; esac ;;
ldd) [ -z "\${FAKE_LDD:-}" ] || echo "$FAKE_LDD"; exit 1 ;;
libressl) echo 'LibreSSL 3.3.6' ;;
esac
`,
)
chmodSync(join(bin, "fake"), 0o755)
for (const tool of ["uname", "ldd", "libressl"]) symlinkSync("fake", join(bin, tool))

/** Whether an OpenSSL 3, which can verify ed25519, is where the script looks for one. */
const hasOpenssl3 = ["openssl", "/opt/homebrew/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"]
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
const releasesFolder = (key: KeyObject, releases: ReadonlyArray<Release>): string => {
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

type Install = {
  readonly releases: string
  /** The PEM public key the script trusts; "" for the script's own keys. */
  readonly key: string
  readonly shell?: string
  /** The machine uname tells, such as ["Linux", "x86_64"]; this one's when unset. */
  readonly uname?: readonly [string, string]
  readonly ldd?: string
  /** The musl loaders in the folder that replaces /lib. */
  readonly loaders?: ReadonlyArray<string>
  readonly env?: Record<string, string>
}

type Ran = {
  readonly code: number | null
  readonly out: string
  /** The folder in place of /usr/local/bin, and the HOME. */
  readonly system: string
  readonly home: string
}

const temp = (name: string) => mkdtempSync(join(tmpdir(), `tutti-install-script-${name}-`))

/** Runs the script piped into the shell, `curl … | sh`, and what it printed, stdout and stderr. */
const install = (options: Install): Ran => {
  const system = temp("system")
  const home = temp("home")
  const lib = temp("lib")
  for (const loader of options.loaders ?? []) writeFileSync(join(lib, loader), "")
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
    TUTTI_DOWNLOAD_URL: options.releases,
    TUTTI_TEST_RELEASE_KEY: options.key,
    TUTTI_TEST_SYSTEM_DIR: system,
    TUTTI_TEST_LIB_DIR: lib,
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
    system,
    home,
  }
}

/** What dir/tutti is: the archive it came from and what --version prints; undefined when none. */
const installed = (dir: string) => {
  const names = readdirSync(dir)
  if (names.length === 0) return undefined
  // Nothing else is left behind, such as a temporary copy.
  expect(names).toEqual(["tutti"])
  const binary = join(dir, "tutti")
  const version = Bun.spawnSync([binary, "--version"], { stdout: "pipe" }).stdout.toString().trim()
  const archive = /^# (\S+)$/m.exec(readFileSync(binary, "utf8"))?.[1]
  return { archive, version }
}

const hostArchive = (tag: string) =>
  `tutti_${tag.slice(1)}_${process.platform}_${process.arch}.tar.gz`

const signatureChecked = (out: string) => {
  if (out.includes("Verified the signature of checksums.txt")) return true
  expect(out).toContain("The signature of checksums.txt wasn't checked")
  return false
}

const timeout = 30_000

describe("scripts/install.sh", () => {
  const key = newKey()
  const releases = releasesFolder(key.privateKey, [{ tag: "v0.1.0" }, { tag: "v0.2.0" }])

  for (const shell of ["sh", "dash", "bash"]) {
    test.skipIf(which(shell) === null)(
      `piped into ${shell}, installs the latest release, verified, and says how to put it on the PATH`,
      () => {
        const ran = install({ releases, key: publicPem(key), shell })
        expect(ran.code, ran.out).toBe(0)
        // On Linux the host's archive may be the musl one; this suite runs on macOS and glibc Linux.
        expect(installed(ran.system)).toEqual({
          archive: hostArchive("v0.2.0"),
          version: "tutti v0.2.0",
        })
        expect(signatureChecked(ran.out)).toBe(hasOpenssl3)
        expect(ran.out).toContain("Installing tutti v0.2.0 for")
        expect(ran.out).toContain(`Installed tutti v0.2.0 in ${join(ran.system, "tutti")}.`)
        expect(ran.out).toContain(`${ran.system} isn't on your PATH`)
        expect(ran.out).toContain(`echo 'export PATH="${ran.system}:$PATH"' >> ~/.zshrc`)
        expect(ran.out).toContain("'tutti init'")
      },
      timeout,
    )
  }

  test(
    "installs the release TUTTI_VERSION names, with or without its v",
    () => {
      for (const version of ["v0.1.0", "0.1.0"]) {
        const ran = install({ releases, key: publicPem(key), env: { TUTTI_VERSION: version } })
        expect(ran.code, ran.out).toBe(0)
        expect(installed(ran.system)?.version).toBe("tutti v0.1.0")
      }
    },
    timeout,
  )

  test(
    "refuses an archive whose SHA-256 isn't checksums.txt's, and installs nothing",
    () => {
      // Signed, so that the sum is what fails.
      const bad = releasesFolder(key.privateKey, [{ tag: "v0.2.0", sum: "0".repeat(64) }])
      const ran = install({ releases: bad, key: publicPem(key) })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain(`${hostArchive("v0.2.0")}'s SHA-256 is`)
      expect(ran.out).toContain(`not checksums.txt's ${"0".repeat(64)}. Nothing was installed.`)
      expect(installed(ran.system)).toBeUndefined()
      expect(readdirSync(ran.home)).toEqual([])
    },
    timeout,
  )

  test.skipIf(!hasOpenssl3)(
    "refuses a checksums.txt signed with another key, and installs nothing",
    () => {
      const other = newKey().privateKey
      const bad = releasesFolder(key.privateKey, [{ tag: "v0.2.0", signedWith: other }])
      const ran = install({ releases: bad, key: publicPem(key) })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain("checksums.txt.sig doesn't verify checksums.txt with a release key")
      expect(ran.out).toContain("Nothing was installed.")
      expect(ran.out).not.toContain("SHA-256 is")
      expect(installed(ran.system)).toBeUndefined()
    },
    timeout,
  )

  test.skipIf(!hasOpenssl3)(
    "verifies with any of several release keys",
    () => {
      const old = newKey()
      const ran = install({ releases, key: `${publicPem(old)}${publicPem(key)}` })
      expect(ran.code, ran.out).toBe(0)
      expect(ran.out).toContain("Verified the signature of checksums.txt with the release key.")
    },
    timeout,
  )

  test(
    "without OpenSSL 3, says the signature wasn't checked and installs on the SHA-256",
    () => {
      const other = newKey().privateKey
      const unchecked = releasesFolder(key.privateKey, [{ tag: "v0.2.0", signedWith: other }])
      const ran = install({
        releases: unchecked,
        key: publicPem(key),
        env: { TUTTI_TEST_OPENSSL: join(bin, "libressl") },
      })
      expect(ran.code, ran.out).toBe(0)
      expect(signatureChecked(ran.out)).toBe(false)
      expect(ran.out).toContain("The archive's SHA-256 is still checked against checksums.txt.")
      expect(installed(ran.system)?.version).toBe("tutti v0.2.0")
    },
    timeout,
  )

  test("holds exactly the release keys src/update/keys.ts does, each an ed25519 key", () => {
    const keys = scriptKeys()
    expect(keys).toEqual(releaseKeys.flatMap((key) => pemKeys(key.pem)))
    for (const pem of keys) expect(typeof parsePublicKey(pem)).not.toBe("string")
  })

  test.skipIf(releaseKeys.length > 0)(
    "with no release key, installs nothing",
    () => {
      const ran = install({ releases, key: "" })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain("this install script holds no release key yet")
      expect(installed(ran.system)).toBeUndefined()
    },
    timeout,
  )

  test.skipIf(releaseKeys.length === 0 || !hasOpenssl3)(
    "with its own release keys, refuses a release signed with another, and installs nothing",
    () => {
      const ran = install({ releases, key: "" })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain("checksums.txt.sig doesn't verify checksums.txt with a release key")
      expect(installed(ran.system)).toBeUndefined()
    },
    timeout,
  )

  describe("on Linux, picks the glibc or the musl archive", () => {
    const cases: ReadonlyArray<{
      readonly name: string
      readonly machine?: string
      readonly libc?: string
      readonly ldd?: string
      readonly loaders?: ReadonlyArray<string>
      readonly want: "glibc" | "musl"
    }> = [
      { name: "TUTTI_LIBC=musl", libc: "musl", ldd: "ldd (GNU libc) 2.39", want: "musl" },
      { name: "TUTTI_LIBC=glibc", libc: "glibc", ldd: "musl libc (x86_64)", want: "glibc" },
      {
        name: "ldd naming musl",
        ldd: "musl libc (x86_64)\nVersion 1.2.5\nDynamic Program Loader",
        want: "musl",
      },
      {
        name: "ldd naming GNU libc, beside a musl loader",
        ldd: "ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39\nCopyright (C) 2024 Free Software Foundation",
        loaders: ["ld-musl-x86_64.so.1"],
        want: "glibc",
      },
      { name: "ldd naming GNU libc", ldd: "ldd (GNU libc) 2.39", want: "glibc" },
      {
        name: "the musl loader, ldd naming neither",
        loaders: ["ld-musl-x86_64.so.1"],
        want: "musl",
      },
      {
        name: "the arm64 musl loader",
        machine: "aarch64",
        loaders: ["ld-musl-aarch64.so.1"],
        want: "musl",
      },
      {
        name: "another machine's musl loader",
        loaders: ["ld-musl-aarch64.so.1"],
        want: "glibc",
      },
      { name: "neither ldd nor a musl loader", want: "glibc" },
    ]
    for (const c of cases) {
      test(
        c.name,
        () => {
          const machine = c.machine ?? "x86_64"
          const arch = machine === "aarch64" ? "arm64" : "x64"
          const ran = install({
            releases,
            key: publicPem(key),
            uname: ["Linux", machine],
            ...(c.ldd === undefined ? {} : { ldd: c.ldd }),
            ...(c.loaders === undefined ? {} : { loaders: c.loaders }),
            ...(c.libc === undefined ? {} : { env: { TUTTI_LIBC: c.libc } }),
          })
          expect(ran.code, ran.out).toBe(0)
          const suffix = c.want === "musl" ? "_musl" : ""
          expect(installed(ran.system)?.archive).toBe(`tutti_0.2.0_linux_${arch}${suffix}.tar.gz`)
          expect(ran.out).toContain(`Installing tutti v0.2.0 for linux ${arch} ${c.want}.`)
          const note =
            "A musl build needs libstdc++ and libgcc (on Alpine: apk add libstdc++ libgcc)."
          if (c.want === "musl") expect(ran.out).toContain(note)
          else expect(ran.out).not.toContain(note)
        },
        timeout,
      )
    }

    test(
      "TUTTI_LIBC set to anything else is an error naming the two",
      () => {
        const ran = install({
          releases,
          key: publicPem(key),
          uname: ["Linux", "x86_64"],
          env: { TUTTI_LIBC: "uclibc" },
        })
        expect(ran.code).toBe(1)
        expect(ran.out).toContain("TUTTI_LIBC is 'uclibc', not musl or glibc")
        expect(installed(ran.system)).toBeUndefined()
      },
      timeout,
    )
  })

  test(
    "macOS gets the darwin archive, whatever TUTTI_LIBC says",
    () => {
      const ran = install({
        releases,
        key: publicPem(key),
        uname: ["Darwin", "x86_64"],
        env: { TUTTI_LIBC: "musl" },
      })
      expect(ran.code, ran.out).toBe(0)
      expect(installed(ran.system)?.archive).toBe("tutti_0.2.0_darwin_x64.tar.gz")
      expect(ran.out).toContain("Installing tutti v0.2.0 for darwin x64.")
    },
    timeout,
  )

  for (const [kernel, machine] of [
    ["FreeBSD", "amd64"],
    ["Linux", "i686"],
  ] as const) {
    test(
      `refuses ${kernel} ${machine}, which has no release binary`,
      () => {
        const ran = install({ releases, key: publicPem(key), uname: [kernel, machine] })
        expect(ran.code).toBe(1)
        expect(ran.out).toContain(`there is no release binary for ${kernel} ${machine}`)
        expect(ran.out).toContain("darwin and linux, arm64 and x64")
        expect(installed(ran.system)).toBeUndefined()
      },
      timeout,
    )
  }

  test(
    "installs in ~/.local/bin where /usr/local/bin isn't writable, and says how to install there",
    () => {
      const ran = install({
        releases,
        key: publicPem(key),
        env: { TUTTI_TEST_SYSTEM_DIR: join(temp("absent"), "bin") },
      })
      expect(ran.code, ran.out).toBe(0)
      const local = join(ran.home, ".local/bin")
      expect(installed(local)?.version).toBe("tutti v0.2.0")
      expect(ran.out).toContain(`Installing in ${local}, as`)
      expect(ran.out).toContain("sudo TUTTI_INSTALL_DIR=")
    },
    timeout,
  )

  test(
    "replaces the tutti in TUTTI_INSTALL_DIR, and says when another tutti comes first on the PATH",
    () => {
      const dir = temp("install-dir")
      writeFileSync(join(dir, "tutti"), "#!/bin/sh\necho 'tutti v0.0.1'\n")
      chmodSync(join(dir, "tutti"), 0o755)
      const earlier = temp("earlier")
      writeFileSync(join(earlier, "tutti"), "#!/bin/sh\necho 'tutti v0.0.0'\n")
      chmodSync(join(earlier, "tutti"), 0o755)
      const ran = install({
        releases,
        key: publicPem(key),
        env: { TUTTI_INSTALL_DIR: dir, PATH: `${earlier}:${dir}:${testEnv.PATH}` },
      })
      expect(ran.code, ran.out).toBe(0)
      expect(installed(dir)?.version).toBe("tutti v0.2.0")
      expect(installed(ran.system)).toBeUndefined()
      expect(ran.out).toContain(`${join(earlier, "tutti")} comes before ${dir} on your PATH`)
    },
    timeout,
  )

  test(
    "says so when the release named isn't there",
    () => {
      const ran = install({ releases, key: publicPem(key), env: { TUTTI_VERSION: "v9.9.9" } })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain("cannot download")
      expect(existsSync(join(ran.system, "tutti"))).toBe(false)
    },
    timeout,
  )
})
