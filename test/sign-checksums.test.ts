// scripts/sign-checksums.ts (§ 12 Releases): checksums.txt.sig is checksums.txt's raw ed25519
// signature with the release key from $TUTTI_RELEASE_KEY, and without a usable key, or with one
// whose public half tutti doesn't build in (src/update/keys.ts), nothing is signed.
import { describe, expect, test } from "bun:test"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { releaseKey, signChecksums, signFile, signRelease } from "../scripts/sign-checksums.ts"
import type { ReleaseKey } from "../src/update/keys.ts"

const script = resolve(import.meta.dir, "../scripts/sign-checksums.ts")
const sums = "0123  tutti_0.9.0_darwin_arm64.tar.gz\n4567  tutti_0.9.0_linux_x64_musl.tar.gz\n"

const ed25519 = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  }
}

/** A new folder holding checksums.txt. */
const sumsFolder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-sign-checksums-"))
  writeFileSync(join(dir, "checksums.txt"), sums)
  return dir
}

/** The signature written beside checksums.txt in `dir`, if any. */
const signatureIn = (dir: string) => {
  const sig = join(dir, "checksums.txt.sig")
  return existsSync(sig) ? readFileSync(sig) : undefined
}

/**
 * A folder holding checksums.txt, and the script run on it with `key` as $TUTTI_RELEASE_KEY. The
 * script trusts only the keys tutti builds in, so a key made here is never one of them.
 */
const sign = (key: string | undefined, args: ReadonlyArray<string> = ["checksums.txt"]) => {
  const dir = sumsFolder()
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.TUTTI_RELEASE_KEY
  if (key !== undefined) env.TUTTI_RELEASE_KEY = key
  const proc = Bun.spawnSync(["bun", script, ...args], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    dir,
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
    sig: signatureIn(dir),
  }
}

/** A folder holding checksums.txt, signed in it by signFile with `key`, trusting `keys`. */
const signWith = (key: string | undefined, keys: ReadonlyArray<ReleaseKey>) => {
  const dir = sumsFolder()
  const why = signFile(join(dir, "checksums.txt"), key, keys)
  return { dir, why, sig: signatureIn(dir) }
}

const asReleaseKey = (pem: string, name = "2026-10"): ReleaseKey => ({ name, pem })

// OpenSSL 3, which scripts/install.sh verifies with where it is installed; LibreSSL can't.
const openssl3 = (() => {
  const proc = Bun.spawnSync(["openssl", "version"], { stdout: "pipe", stderr: "pipe" })
  return proc.exitCode === 0 && proc.stdout.toString().startsWith("OpenSSL 3")
})()

describe("scripts/sign-checksums.ts", () => {
  test("writes checksums.txt's raw 64-byte signature, which the public key verifies", () => {
    const { privatePem, publicPem } = ed25519()
    const other = ed25519()
    const result = signWith(privatePem, [
      asReleaseKey(other.publicPem, "2025-01"),
      asReleaseKey(publicPem),
    ])
    expect(result.why).toBeUndefined()
    expect(result.sig?.length).toBe(64)
    expect(
      verify(null, Buffer.from(sums), createPublicKey(publicPem), result.sig ?? Buffer.alloc(0)),
    ).toBe(true)
    expect(
      verify(
        null,
        Buffer.from(sums),
        createPublicKey(other.publicPem),
        result.sig ?? Buffer.alloc(0),
      ),
    ).toBe(false)
  })

  test.skipIf(!openssl3)(
    "its signature verifies with openssl pkeyutl, as install.sh checks it",
    () => {
      const { privatePem, publicPem } = ed25519()
      const result = signWith(privatePem, [asReleaseKey(publicPem)])
      expect(result.why).toBeUndefined()
      writeFileSync(join(result.dir, "public.pem"), publicPem)
      const check = Bun.spawnSync(
        [
          "openssl",
          "pkeyutl",
          "-verify",
          "-pubin",
          "-inkey",
          "public.pem",
          "-rawin",
          "-in",
          "checksums.txt",
          "-sigfile",
          "checksums.txt.sig",
        ],
        { cwd: result.dir, stdout: "pipe", stderr: "pipe" },
      )
      expect(check.stdout.toString()).toContain("Signature Verified Successfully")
      expect(check.exitCode).toBe(0)
    },
  )

  test.each([
    ["unset", undefined, "$TUTTI_RELEASE_KEY is empty"],
    ["empty", "", "$TUTTI_RELEASE_KEY is empty"],
    ["not PEM", "hunter2", "not a PKCS#8 PEM private key"],
    [
      "a broken PEM",
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      "doesn't parse",
    ],
  ])("a key %s signs nothing and says why", (_, key, why) => {
    const result = sign(key)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(why)
    expect(result.sig).toBeUndefined()
  })

  test("a key that isn't ed25519 signs nothing", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const result = sign(privateKey.export({ type: "pkcs8", format: "pem" }).toString())
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("is a ec key, not an ed25519 key")
    expect(result.sig).toBeUndefined()
  })

  test("a key tutti doesn't build in signs nothing: tutti update would refuse the release", () => {
    const result = sign(ed25519().privatePem)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      "$TUTTI_RELEASE_KEY's public key is not in src/update/keys.ts, so tutti update would refuse the release",
    )
    expect(result.sig).toBeUndefined()
  })

  test("signFile refuses a key whose public half isn't among the keys it trusts", () => {
    const { privatePem } = ed25519()
    const others = [asReleaseKey(ed25519().publicPem, "2025-01"), asReleaseKey(ed25519().publicPem)]
    for (const keys of [[], others]) {
      const result = signWith(privatePem, keys)
      expect(result.why).toContain("is not in src/update/keys.ts")
      expect(result.sig).toBeUndefined()
    }
  })

  test("signFile passes on releaseKey's refusal, signing nothing", () => {
    const { publicPem } = ed25519()
    const result = signWith("hunter2", [asReleaseKey(publicPem)])
    expect(result.why).toContain("not a PKCS#8 PEM private key")
    expect(result.sig).toBeUndefined()
  })

  test("signRelease skips a trusted key that isn't an ed25519 public key", () => {
    const { privatePem, publicPem } = ed25519()
    const key = releaseKey(privatePem)
    if (typeof key === "string") throw new Error(key)
    const data = new TextEncoder().encode(sums)
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString()
    expect(signRelease(data, key, [asReleaseKey(ec), asReleaseKey("hunter2")])).toContain(
      "is not in src/update/keys.ts",
    )
    const signature = signRelease(data, key, [asReleaseKey(ec), asReleaseKey(publicPem)])
    if (typeof signature === "string") throw new Error(signature)
    expect(verify(null, data, createPublicKey(publicPem), signature)).toBe(true)
  })

  test.each([[[]], [["checksums.txt", "more.txt"]]])("arguments %j are a usage error", (args) => {
    const result = sign(ed25519().privatePem, args)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("usage:")
  })

  test("signChecksums signs with the key releaseKey accepts", () => {
    const { privatePem, publicPem } = ed25519()
    const key = releaseKey(privatePem)
    if (typeof key === "string") throw new Error(key)
    const data = new TextEncoder().encode(sums)
    expect(verify(null, data, createPublicKey(publicPem), signChecksums(data, key))).toBe(true)
  })
})
