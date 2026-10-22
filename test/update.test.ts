import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Fiber, Option } from "effect"
import fc from "fast-check"
import { parsePublicKey, releaseKeys } from "../src/update/keys.ts"
import {
  archiveName,
  type Build,
  cacheDir,
  cacheName,
  checkEvery,
  checksForUpdates,
  checksumOf,
  compareVersions,
  newerNotice,
  newerRelease,
  type Releases,
  update,
  updateExit,
} from "../src/update/update.ts"
import {
  api,
  build,
  downloads,
  fakeTutti,
  fixture,
  installed,
  leftovers,
  run,
  signer,
  stranger,
} from "./update-releases.ts"

describe("tutti update", () => {
  test("installs the latest release over the binary, once its signature and sum verify", async () => {
    const { dir, exe } = installed()
    const { releases, asked } = await fixture({ tag: "v0.9.1" })
    const ran = await run({}, build(exe), releases)
    expect(ran.error).toEqual([])
    expect(ran.code).toBe(updateExit.ok)
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.1"))
    expect(statSync(exe).mode & 0o777).toBe(0o755)
    expect(leftovers(dir)).toEqual([])
    expect(ran.out.at(-2)).toBe(`Updated tutti v0.9.0 -> v0.9.1 (${realpathSync(exe)})`)
    // checksums.txt and its signature before the archive.
    expect(asked.map((url) => url.split("/").at(-1))).toEqual([
      "latest",
      "checksums.txt",
      "checksums.txt.sig",
      "tutti_0.9.1_darwin_arm64.tar.gz",
    ])
  })

  test("takes its own build's archive: a musl build the musl one", async () => {
    const { exe } = installed()
    const { releases, asked } = await fixture({ tag: "v0.9.1" })
    const ran = await run({}, build(exe, { target: "linux-x64-musl" }), releases)
    expect(ran.code).toBe(updateExit.ok)
    expect(asked.at(-1)).toBe(`${downloads}/v0.9.1/tutti_0.9.1_linux_x64_musl.tar.gz`)
  })

  test("replaces the file a symbolic link leads to, and leaves the link", async () => {
    const { dir, exe } = installed()
    const link = join(dir, "link")
    symlinkSync(exe, link)
    const { releases } = await fixture({ tag: "v0.9.1" })
    const ran = await run({}, build(link), releases)
    expect(ran.code).toBe(updateExit.ok)
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.1"))
    expect(readdirSync(dir).sort()).toEqual(["link", "tutti"])
  })

  test("refuses a release signed by another key, before downloading the archive", async () => {
    const { dir, exe } = installed()
    const { releases, asked } = await fixture({ tag: "v0.9.1", signWith: stranger.privateKey })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error).toEqual([
      "tutti update: checksums.txt.sig doesn't verify checksums.txt: it isn't signed by a release key",
      `${exe} is unchanged.`,
    ])
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    expect(leftovers(dir)).toEqual([])
    expect(asked.some((url) => url.endsWith(".tar.gz"))).toBe(false)
  })

  test("refuses a signature that isn't 64 bytes", async () => {
    const { exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", signature: new Uint8Array(10) })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error[0]).toContain("it has 10 bytes, not an ed25519 signature's 64")
  })

  test("takes a signature by any of the release keys, as a key rotation needs", async () => {
    const { exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", signWith: stranger.privateKey })
    const ran = await run({}, build(exe), releases, [signer.key, stranger.key])
    expect(ran.code).toBe(updateExit.ok)
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.1"))
  })

  test("refuses an archive whose SHA-256 isn't checksums.txt's", async () => {
    const { dir, exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", tampered: true })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error[0]).toMatch(
      /^tutti update: tutti_0\.9\.1_darwin_arm64\.tar\.gz has SHA-256 [0-9a-f]{64}, but checksums\.txt says [0-9a-f]{64}$/,
    )
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    expect(leftovers(dir)).toEqual([])
  })

  test("installs nothing without a release key", async () => {
    const { exe } = installed()
    const { releases, asked } = await fixture({ tag: "v0.9.1" })
    const ran = await run({}, build(exe), releases, [])
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error[0]).toContain("this tutti holds no release key yet")
    expect(asked).toEqual([`${api}/releases/latest`])
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
  })

  test("refuses a new binary whose --version isn't the release's", async () => {
    const { dir, exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", says: "tutti v0.8.0" })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error[0]).toBe(
      "tutti update: the new binary's --version says 'tutti v0.8.0', not tutti v0.9.1",
    )
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    expect(leftovers(dir)).toEqual([])
  })

  test("refuses a folder it can't write in, before downloading", async () => {
    const { dir, exe } = installed()
    const { releases, asked } = await fixture({ tag: "v0.9.1" })
    chmodSync(dir, 0o555)
    try {
      const ran = await run({}, build(exe), releases)
      expect(ran.code).toBe(updateExit.refused)
      expect(ran.error[1]).toBe("Run it as the folder's owner instead: sudo tutti update")
      expect(asked).toEqual([`${api}/releases/latest`])
    } finally {
      chmodSync(dir, 0o755)
    }
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
  })

  test("leaves the latest release as it is", async () => {
    const { exe } = installed()
    const { releases, asked } = await fixture({ tag: "v0.9.0" })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.ok)
    expect(ran.out).toEqual(["tutti v0.9.0 is the latest release already."])
    expect(asked).toHaveLength(1)
  })

  test("replaces a build from a clone only with --force", async () => {
    const { exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1" })
    const clone = build(exe, { kind: "clone", shown: "0.9.0 0123456789ab" })
    const refused = await run({}, clone, releases)
    expect(refused.code).toBe(updateExit.refused)
    expect(refused.error[0]).toContain("is a build from a clone, not a release")
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    const forced = await run({ force: true }, clone, releases)
    expect(forced.code).toBe(updateExit.ok)
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.1"))
  })

  test("never replaces tutti run from source, whose binary is Bun", async () => {
    const { exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1" })
    const ran = await run({ force: true }, build(exe, { kind: "source", target: null }), releases)
    expect(ran.code).toBe(updateExit.refused)
    expect(ran.error[0]).toContain("runs from source")
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
  })

  test("interrupted during the download (Ctrl+C), leaves the binary and nothing beside it", async () => {
    const { dir, exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1" })
    let downloading: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      downloading = resolve
    })
    // The archive never comes: its request waits until it is aborted.
    const stalled: Releases = {
      ...releases,
      fetch: (url, init) => {
        if (!url.endsWith(".tar.gz")) return releases.fetch(url, init)
        downloading()
        return new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        )
      },
    }
    const fiber = Effect.runFork(
      update({ check: false, force: false }, build(exe), {
        releases: stalled,
        keys: [signer.key],
        say: { out: () => {}, error: () => {} },
      }).pipe(Effect.provide(BunServices.layer)),
    )
    await started
    expect(leftovers(dir)).toHaveLength(1)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(leftovers(dir)).toEqual([])
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
  })

  test("says why when the latest release can't be read", async () => {
    const { exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", status: 403 })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error[0]).toContain("403")
    expect(ran.error[0]).toContain("API rate limit exceeded")
  })
})

describe("tutti update --check", () => {
  const check = async (tag: string, overrides: Partial<Build> = {}) => {
    const { exe } = installed()
    const { releases, asked } = await fixture({ tag })
    const ran = await run({ check: true }, build(exe, overrides), releases)
    // --check changes nothing, and downloads nothing but the release's details.
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    expect(asked).toEqual([`${api}/releases/latest`])
    return ran
  }

  test("exits 1 when a newer release is out", async () => {
    const ran = await check("v0.9.1")
    expect(ran.code).toBe(1)
    expect(ran.out).toEqual([
      "tutti v0.9.0; the latest release is v0.9.1 (https://github.com/noesis-sol/tutti/releases/tag/v0.9.1): tutti update installs it.",
    ])
  })

  test("exits 0 on the latest release", async () => {
    const ran = await check("v0.9.0")
    expect(ran.code).toBe(0)
    expect(ran.out).toEqual(["tutti v0.9.0 is the latest release."])
  })

  test("exits 0 on a build newer than the latest release", async () => {
    const ran = await check("v0.8.2")
    expect(ran.code).toBe(0)
    expect(ran.out).toEqual(["tutti v0.9.0 is newer than the latest release, v0.8.2."])
  })

  test("exits 1 for a build from a clone behind the latest release, 0 for one level with it", async () => {
    const clone = { kind: "clone", shown: "0.9.0 0123456789ab" } as const
    const behind = await check("v0.9.1", clone)
    expect(behind.code).toBe(1)
    expect(behind.out[0]).toContain("tutti update --force installs it")
    expect((await check("v0.9.0", clone)).code).toBe(0)
  })

  test("exits 4 when the latest release can't be read", async () => {
    const { exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", status: 500 })
    expect((await run({ check: true }, build(exe), releases)).code).toBe(updateExit.failed)
  })
})

describe("the daily check", () => {
  const day = Duration.toMillis(checkEvery)

  test("asks GitHub at most once a day, and keeps its answer between runs", async () => {
    const cache = mkdtempSync(join(tmpdir(), "tutti-update-cache-"))
    const { releases, asked } = await fixture({ tag: "v0.9.1" })
    const at = (now: number) =>
      Effect.runPromise(newerRelease({ releases, current: "0.9.0", cache, now: () => now }))
    const start = Date.UTC(2026, 9, 20, 9)
    expect(await at(start)).toEqual(Option.some("v0.9.1"))
    expect(asked).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(cache, cacheName), "utf8"))).toEqual({
      latest: "v0.9.1",
      checked: start,
    })
    // Within the day: the cache's answer, without asking.
    expect(await at(start + day - 1)).toEqual(Option.some("v0.9.1"))
    expect(asked).toHaveLength(1)
    // A day on: asked again.
    expect(await at(start + day)).toEqual(Option.some("v0.9.1"))
    expect(asked).toHaveLength(2)
    // A clock set back is asked again too.
    expect(await at(start - 1)).toEqual(Option.some("v0.9.1"))
    expect(asked).toHaveLength(3)
  })

  test("records a failed request, so that GitHub isn't asked again within the day", async () => {
    const cache = mkdtempSync(join(tmpdir(), "tutti-update-cache-"))
    const failing = await fixture({ tag: "v0.9.1", status: 403 })
    const start = Date.UTC(2026, 9, 20, 9)
    const at = (releases: Releases, now: number) =>
      Effect.runPromise(newerRelease({ releases, current: "0.9.0", cache, now: () => now }))
    expect(await at(failing.releases, start)).toEqual(Option.none())
    expect(await at(failing.releases, start + 1000)).toEqual(Option.none())
    expect(failing.asked).toHaveLength(1)
  })

  test("says nothing on the latest release, or with a cache it can't read", async () => {
    const cache = mkdtempSync(join(tmpdir(), "tutti-update-cache-"))
    writeFileSync(join(cache, cacheName), "{not json")
    const { releases, asked } = await fixture({ tag: "v0.9.0" })
    const found = await Effect.runPromise(
      newerRelease({ releases, current: "0.9.0", cache, now: () => Date.UTC(2026, 9, 20) }),
    )
    expect(found).toEqual(Option.none())
    expect(asked).toHaveLength(1)
  })

  test("writes its cache where the folder is missing", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "tutti-update-cache-")), "a", "tutti")
    const { releases } = await fixture({ tag: "v0.9.1" })
    await Effect.runPromise(
      newerRelease({ releases, current: "0.9.0", cache, now: () => Date.UTC(2026, 9, 20) }),
    )
    expect(JSON.parse(readFileSync(join(cache, cacheName), "utf8")).latest).toBe("v0.9.1")
  })

  test("runs for a release build unless TUTTI_NO_UPDATE_CHECK turns it off", () => {
    const env = (value?: string) => (name: string) =>
      name === "TUTTI_NO_UPDATE_CHECK" ? value : undefined
    const release = { kind: "release" } as const
    expect(checksForUpdates(release, env())).toBe(true)
    expect(checksForUpdates(release, env(""))).toBe(true)
    for (const on of ["1", "true", "yes", "on", "TRUE"]) {
      expect(checksForUpdates(release, env(on))).toBe(false)
    }
    for (const off of ["0", "false", "no", "off"]) {
      expect(checksForUpdates(release, env(off))).toBe(true)
    }
    // A value that is neither turns it off too.
    expect(checksForUpdates(release, env("maybe"))).toBe(false)
    expect(checksForUpdates({ kind: "clone" }, env())).toBe(false)
    expect(checksForUpdates({ kind: "source" }, env())).toBe(false)
  })

  test("keeps its cache in $XDG_CACHE_HOME/tutti, else ~/.cache/tutti", () => {
    const env =
      (vars: Record<string, string>) =>
      (name: string): string | undefined =>
        vars[name]
    expect(cacheDir(env({ XDG_CACHE_HOME: "/x/cache", HOME: "/home/a" }))).toBe("/x/cache/tutti")
    expect(cacheDir(env({ XDG_CACHE_HOME: "relative", HOME: "/home/a" }))).toBe(
      "/home/a/.cache/tutti",
    )
    expect(cacheDir(env({ HOME: "/home/a" }))).toBe("/home/a/.cache/tutti")
  })

  test("the newer-release line names both versions and the command", () => {
    expect(newerNotice("v0.9.1", "0.9.0")).toEqual({
      text: "tutti v0.9.1 is available (you have v0.9.0): ",
      command: "tutti update",
    })
  })
})

describe("versions", () => {
  test("rank by semantic-version precedence", () => {
    const ordered = [
      "v0.1.0",
      "v0.9.0-alpha",
      "v0.9.0-alpha.1",
      "v0.9.0-alpha.beta",
      "v0.9.0-beta.2",
      "v0.9.0-beta.11",
      "v0.9.0-rc.1",
      "v0.9.0",
      "v0.9.1",
      "v0.10.0",
      "v1.0.0",
    ]
    for (const [i, a] of ordered.entries()) {
      for (const [j, b] of ordered.entries()) {
        expect(compareVersions(a, b)).toEqual(Option.some(Math.sign(i - j) as -1 | 0 | 1))
      }
    }
    expect(compareVersions("0.9.0", "v0.9.0")).toEqual(Option.some(0))
    expect(compareVersions("0.9.0+dirty", "v0.9.0")).toEqual(Option.some(0))
  })

  test("text that isn't a version ranks nowhere", () => {
    for (const text of [
      "dev",
      "v1.2",
      "v1.2.3.4",
      "v01.2.3",
      "v1.2.3-",
      "v1.2.3-a..b",
      "v1.2.3-01",
    ]) {
      expect(compareVersions(text, "v1.0.0")).toEqual(Option.none())
    }
    // A tag with a control character is no version, so it is never shown.
    expect(compareVersions("v1.2.3-\x1b[31m", "v1.0.0")).toEqual(Option.none())
  })

  test("comparing is antisymmetric, for any text", () => {
    const version = fc.oneof(
      fc
        .tuple(fc.nat(20), fc.nat(20), fc.nat(20), fc.option(fc.stringMatching(/^[0-9a-z]{1,4}$/)))
        .map(([a, b, c, pre]) => `v${a}.${b}.${c}${pre === null ? "" : `-${pre}`}`),
      fc.string(),
    )
    fc.assert(
      fc.property(version, version, (a, b) => {
        const ab = compareVersions(a, b)
        const ba = compareVersions(b, a)
        expect(Option.map(ab, (order) => -order || 0)).toEqual(
          Option.map(ba, (order) => order || 0),
        )
      }),
    )
  })
})

describe("the release's files", () => {
  test("an archive is named after its tag and its build's target", () => {
    expect(archiveName("v0.9.0", "darwin-arm64")).toBe("tutti_0.9.0_darwin_arm64.tar.gz")
    expect(archiveName("v0.9.0", "linux-x64")).toBe("tutti_0.9.0_linux_x64.tar.gz")
    expect(archiveName("v0.9.0", "linux-arm64-musl")).toBe("tutti_0.9.0_linux_arm64_musl.tar.gz")
  })

  test("checksums.txt gives each archive's sum, in sha256sum's text or binary mode", () => {
    const sums = `${"a".repeat(64)}  tutti_0.9.0_linux_x64.tar.gz\n${"B".repeat(64)} *tutti_0.9.0_linux_x64_musl.tar.gz\n`
    expect(checksumOf(sums, "tutti_0.9.0_linux_x64.tar.gz")).toEqual(Option.some("a".repeat(64)))
    expect(checksumOf(sums, "tutti_0.9.0_linux_x64_musl.tar.gz")).toEqual(
      Option.some("b".repeat(64)),
    )
    expect(checksumOf(sums, "tutti_0.9.0_darwin_x64.tar.gz")).toEqual(Option.none())
  })

  test("checksumOf finds no sum in text that doesn't name the archive", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(checksumOf(text.replaceAll("tutti_", ""), "tutti_0.9.0_linux_x64.tar.gz")).toEqual(
          Option.none(),
        )
      }),
    )
  })
})

describe("the release keys", () => {
  test("each built-in key is an ed25519 public key", () => {
    for (const key of releaseKeys) {
      expect(key.name).toMatch(/^\d{4}-\d{2}$/)
      expect(typeof parsePublicKey(key.pem)).not.toBe("string")
    }
  })

  test("a key that isn't an ed25519 public key is refused, saying why", () => {
    expect(typeof parsePublicKey(signer.key.pem)).not.toBe("string")
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString()
    expect(parsePublicKey(rsa)).toBe("a rsa key, not an ed25519 key")
    expect(parsePublicKey("ssh-ed25519 AAAA")).toBe(
      "not a PKIX PEM public key (-----BEGIN PUBLIC KEY-----)",
    )
  })
})
