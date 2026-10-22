// scripts/install.sh (§ 12 Install) end to end: the fixtures and how they run it are in
// test/install-script.ts.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parsePublicKey, releaseKeys } from "../src/update/keys.ts"
import { testEnv, which } from "./env.ts"
import {
  bin,
  hasOpenssl3,
  hostArchive,
  install,
  installed,
  newKey,
  pemKeys,
  publicPem,
  releasesFolder,
  scriptKeys,
  signatureChecked,
  temp,
  timeout,
} from "./install-script.ts"

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
        expect(installed(ran.dir)).toEqual({
          archive: hostArchive("v0.2.0"),
          version: "tutti v0.2.0",
        })
        expect(signatureChecked(ran.out)).toBe(hasOpenssl3)
        expect(ran.out).toContain("Installing tutti v0.2.0 for")
        expect(ran.out).toContain(`Installed tutti v0.2.0 in ${join(ran.dir, "tutti")}.`)
        expect(ran.out).toContain(`${ran.dir} isn't on your PATH`)
        expect(ran.out).toContain(`echo 'export PATH="${ran.dir}:$PATH"' >> ~/.zshrc`)
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
        expect(installed(ran.dir)?.version).toBe("tutti v0.1.0")
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
      expect(installed(ran.dir)).toBeUndefined()
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
      expect(installed(ran.dir)).toBeUndefined()
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
      expect(installed(ran.dir)?.version).toBe("tutti v0.2.0")
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
      expect(installed(ran.dir)).toBeUndefined()
    },
    timeout,
  )

  test.skipIf(releaseKeys.length === 0 || !hasOpenssl3)(
    "with its own release keys, refuses a release signed with another, and installs nothing",
    () => {
      const ran = install({ releases, key: "" })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain("checksums.txt.sig doesn't verify checksums.txt with a release key")
      expect(installed(ran.dir)).toBeUndefined()
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
          expect(installed(ran.dir)?.archive).toBe(`tutti_0.2.0_linux_${arch}${suffix}.tar.gz`)
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
        expect(installed(ran.dir)).toBeUndefined()
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
      expect(installed(ran.dir)?.archive).toBe("tutti_0.2.0_darwin_x64.tar.gz")
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
        expect(installed(ran.dir)).toBeUndefined()
      },
      timeout,
    )
  }

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
      expect(installed(ran.dir)).toBeUndefined()
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
      expect(existsSync(join(ran.dir, "tutti"))).toBe(false)
    },
    timeout,
  )
})
