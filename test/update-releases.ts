// Fake releases and keys for tutti update's tests (update.test.ts, update-failures.test.ts): a
// fixture release served by a fetch that records what it was asked for, an old tutti in a folder of
// its own, and tutti update run on it.
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import type { ReleaseKey } from "../src/update/keys.ts"
import { archiveName, type Build, type Releases, update } from "../src/update/update.ts"

export const api = "https://api.test/repos/noesis-sol/tutti"
export const downloads = "https://downloads.test"

/** A release key made for the tests: its private half signs, its public half is the built-in's stand-in. */
export const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const key: ReleaseKey = {
    name: "test",
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  }
  return { privateKey, key }
}

export const signer = keyPair()
export const stranger = keyPair()

/** The tutti a fixture release's archive holds: a script printing the version it names. */
export const fakeTutti = (says: string) => `#!/bin/sh\necho "${says}"\n`

export interface Fixture {
  readonly tag: string
  /** What the archive's tutti prints for --version; `tutti <tag>` by default. */
  readonly says?: string
  /** The files each archive holds instead of tutti and a README. */
  readonly holds?: Record<string, string>
  /** Signs checksums.txt with this key instead of the test release key. */
  readonly signWith?: ReturnType<typeof keyPair>["privateKey"]
  /** Replaces the signature. */
  readonly signature?: Uint8Array
  /** Replaces the archive after its sum was taken. */
  readonly tampered?: boolean
  /** The latest release request fails with this status. */
  readonly status?: number
  /** The latest release request's body instead of the release's JSON. */
  readonly latest?: string
}

/**
 * A fixture release, served by a fetch that records what it was asked for: the latest release's
 * JSON, and its six archives, checksums.txt and checksums.txt.sig.
 */
export const fixture = async (release: Fixture) => {
  const version = release.tag.replace(/^v/, "")
  const targets = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "linux-arm64-musl",
    "linux-x64-musl",
  ]
  const files = new Map<string, Uint8Array>()
  for (const target of targets) {
    const says = release.says ?? `tutti ${release.tag}`
    const archive = new Bun.Archive(
      release.holds ?? {
        tutti: fakeTutti(`${says}`),
        "README.md": `tutti ${version} for ${target}\n`,
      },
      { compress: "gzip" },
    )
    files.set(archiveName(release.tag, target), await archive.bytes())
  }
  const sums = [...files]
    .map(([name, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${name}`)
    .join("\n")
  const sumsBytes = new TextEncoder().encode(`${sums}\n`)
  if (release.tampered === true) {
    for (const name of files.keys()) files.set(name, new TextEncoder().encode("not the archive"))
  }
  files.set("checksums.txt", sumsBytes)
  files.set(
    "checksums.txt.sig",
    release.signature ?? sign(null, sumsBytes, release.signWith ?? signer.privateKey),
  )
  const latest = {
    tag_name: release.tag,
    html_url: `https://github.com/noesis-sol/tutti/releases/tag/${release.tag}`,
    assets: [...files.keys()].map((name) => ({
      name,
      browser_download_url: `${downloads}/${release.tag}/${name}`,
    })),
  }
  const asked: Array<string> = []
  const releases: Releases = {
    api,
    fetch: async (url) => {
      asked.push(url)
      if (url === `${api}/releases/latest`) {
        return release.status !== undefined
          ? Response.json({ message: "API rate limit exceeded" }, { status: release.status })
          : release.latest !== undefined
            ? new Response(release.latest)
            : Response.json(latest)
      }
      const name = url.startsWith(`${downloads}/${release.tag}/`)
        ? url.slice(`${downloads}/${release.tag}/`.length)
        : ""
      const body = files.get(name)
      return body === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : new Response(body)
    },
  }
  return { releases, asked }
}

/** A folder for a test, with an old tutti in it. */
export const installed = () => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-update-"))
  const exe = join(dir, "tutti")
  writeFileSync(exe, fakeTutti("tutti v0.9.0"), { mode: 0o755 })
  return { dir, exe }
}

export const build = (exe: string, overrides: Partial<Build> = {}): Build => ({
  version: "0.9.0",
  shown: "0.9.0",
  kind: "release",
  target: "darwin-arm64",
  exe,
  ...overrides,
})

/** tutti update with `flags` on `of`, from `releases`, verified with `keys`: its code and lines. */
export const run = async (
  flags: { readonly check?: boolean; readonly force?: boolean },
  of: Build,
  releases: Releases,
  keys: ReadonlyArray<ReleaseKey> = [signer.key],
) => {
  const out: Array<string> = []
  const error: Array<string> = []
  const code = await Effect.runPromise(
    update({ check: flags.check ?? false, force: flags.force ?? false }, of, {
      releases,
      keys,
      say: { out: (line) => out.push(line), error: (line) => error.push(line) },
    }).pipe(Effect.provide(BunServices.layer)),
  )
  return { code, out, error }
}

/** The files in `dir` other than tutti: a leftover from the update would be one. */
export const leftovers = (dir: string) => readdirSync(dir).filter((name) => name !== "tutti")
