// scripts/install.sh's CPU checks (§ 12 Install): it stops on an x64 CPU without AVX2, which tutti
// and the Claude Code it embeds need, before downloading anything, and installs the darwin arm64
// build in a shell under Rosetta. A fake uname and sysctl, and a file in place of /proc/cpuinfo, make
// the machine (test/install-script.ts).
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { which } from "./env.ts"
import {
  cpuWith,
  type Install,
  install,
  installed,
  newKey,
  publicPem,
  releasesFolder,
  temp,
  timeout,
} from "./install-script.ts"

const noAvx2 =
  "tutti and Claude Code need a CPU with AVX2 (Intel Haswell, 2013, or AMD Excavator, 2015, or\nlater), and this one has none. Nothing was installed."

const rosetta =
  "This shell runs under Rosetta on Apple Silicon: installing the darwin arm64 build, which runs natively."

const cantTell = (from: string) =>
  `Couldn't tell from ${from} whether this CPU has AVX2, which tutti and Claude Code need on x64; installing all the same.`

describe("scripts/install.sh's CPU checks", () => {
  const key = newKey()
  const releases = releasesFolder(key.privateKey, [{ tag: "v0.2.0" }])
  // No release is here: a script that stops before downloading never finds that out.
  const nowhere = `file://${join(temp("nowhere"), "releases")}`

  /** Installs on the machine `options` makes, and checks it installed `archive`'s tutti. */
  const installs = (options: Omit<Install, "releases" | "key">, archive: string) => {
    const ran = install({ releases, key: publicPem(key), ...options })
    expect(ran.code, ran.out).toBe(0)
    expect(installed(ran.dir)?.archive).toBe(archive)
    return ran.out
  }

  /** Runs the script on the machine `options` makes, and checks it stopped on the missing AVX2. */
  const refuses = (options: Omit<Install, "releases" | "key">) => {
    const ran = install({ releases: nowhere, key: publicPem(key), ...options })
    expect(ran.code).toBe(1)
    expect(ran.out).toContain(noAvx2)
    expect(ran.out).not.toContain("cannot download")
    expect(ran.out).not.toContain("Installing tutti")
    expect(installed(ran.dir)).toBeUndefined()
  }

  describe("on x64 Linux, reads /proc/cpuinfo's flags", () => {
    test(
      "installs where they name avx2",
      () => {
        const out = installs(
          { uname: ["Linux", "x86_64"], ldd: "ldd (GNU libc) 2.39", cpuinfo: cpuWith(["avx2"]) },
          "tutti_0.2.0_linux_x64.tar.gz",
        )
        expect(out).toContain("Installing tutti v0.2.0 for linux x64 glibc.")
        expect(out).not.toContain("AVX2")
      },
      timeout,
    )

    for (const shell of ["sh", "dash", "bash"]) {
      test.skipIf(which(shell) === null)(
        `stops before downloading where they don't, piped into ${shell}`,
        () => {
          // AVX but not AVX2, as a Sandy Bridge's: avx2 is a word of its own, not a prefix.
          refuses({ shell, uname: ["Linux", "x86_64"], cpuinfo: cpuWith(["avx", "avx512_vnni"]) })
        },
        timeout,
      )
    }

    test(
      "stops on musl too, whatever TUTTI_LIBC says",
      () => {
        refuses({
          uname: ["Linux", "x86_64"],
          cpuinfo: cpuWith([]),
          env: { TUTTI_LIBC: "musl" },
        })
      },
      timeout,
    )

    for (const [name, cpuinfo] of [
      ["without /proc/cpuinfo", null],
      ["with no line of flags in it", "processor\t: 0\nvendor_id\t: GenuineIntel\n"],
    ] as const) {
      test(
        `says it couldn't tell, and installs, ${name}`,
        () => {
          const ran = install({
            releases,
            key: publicPem(key),
            uname: ["Linux", "x86_64"],
            ldd: "ldd (GNU libc) 2.39",
            cpuinfo,
          })
          expect(ran.code, ran.out).toBe(0)
          expect(ran.out).toMatch(
            /Couldn't tell from \S+cpuinfo whether this CPU has AVX2, which tutti and Claude Code need on x64; installing all the same\./,
          )
          expect(installed(ran.dir)?.archive).toBe("tutti_0.2.0_linux_x64.tar.gz")
        },
        timeout,
      )
    }

    test(
      "doesn't check on arm64",
      () => {
        const out = installs(
          { uname: ["Linux", "aarch64"], ldd: "ldd (GNU libc) 2.39", cpuinfo: cpuWith([]) },
          "tutti_0.2.0_linux_arm64.tar.gz",
        )
        expect(out).not.toContain("AVX2")
      },
      timeout,
    )
  })

  describe("on macOS, asks sysctl", () => {
    test(
      "installs the x64 build on an Intel Mac whose hw.optional.avx2_0 is 1",
      () => {
        const out = installs(
          { uname: ["Darwin", "x86_64"], sysctl: { avx2: "1" } },
          "tutti_0.2.0_darwin_x64.tar.gz",
        )
        expect(out).toContain("Installing tutti v0.2.0 for darwin x64.")
        expect(out).not.toContain("AVX2")
        expect(out).not.toContain("Rosetta")
      },
      timeout,
    )

    test(
      "installs the x64 build where sysctl.proc_translated is 0",
      () => {
        installs(
          { uname: ["Darwin", "x86_64"], sysctl: { avx2: "1", translated: "0" } },
          "tutti_0.2.0_darwin_x64.tar.gz",
        )
      },
      timeout,
    )

    test(
      "stops before downloading on an Intel Mac whose hw.optional.avx2_0 is 0",
      () => {
        refuses({ uname: ["Darwin", "x86_64"], sysctl: { avx2: "0" } })
      },
      timeout,
    )

    test(
      "says it couldn't tell, and installs, where sysctl has no hw.optional.avx2_0",
      () => {
        const out = installs(
          { uname: ["Darwin", "x86_64"], sysctl: { avx2: "" } },
          "tutti_0.2.0_darwin_x64.tar.gz",
        )
        expect(out).toContain(cantTell("sysctl hw.optional.avx2_0"))
      },
      timeout,
    )

    for (const avx2 of ["0", "1", ""]) {
      test(
        `under Rosetta, installs the arm64 build and says so (hw.optional.avx2_0 ${avx2 || "absent"})`,
        () => {
          const out = installs(
            { uname: ["Darwin", "x86_64"], sysctl: { avx2, translated: "1" } },
            "tutti_0.2.0_darwin_arm64.tar.gz",
          )
          expect(out).toContain(rosetta)
          expect(out).toContain("Installing tutti v0.2.0 for darwin arm64.")
          expect(out).not.toContain("AVX2")
        },
        timeout,
      )
    }

    test(
      "on Apple Silicon, installs the arm64 build without a word of AVX2 or Rosetta",
      () => {
        const out = installs(
          { uname: ["Darwin", "arm64"], sysctl: { avx2: "" } },
          "tutti_0.2.0_darwin_arm64.tar.gz",
        )
        expect(out).not.toContain("AVX2")
        expect(out).not.toContain("Rosetta")
      },
      timeout,
    )
  })
})
