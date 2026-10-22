// The npm package's bundle and tutti update (§ 12 npm): its runs don't check for a newer release,
// and tutti update --check and tutti update name the package manager's upgrade, not tutti update's
// nor scripts/install.sh.
import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { buildKind, markNpmBundle } from "../src/cli/version.ts"
import {
  type Build,
  checksForUpdates,
  npmPackage,
  type Releases,
  update,
  updateExit,
} from "../src/update/update.ts"

const api = "https://api.test/repos/noesis-sol/tutti"

/** Releases whose latest is `tag`, recording what was asked of them. */
const releasesOf = (tag: string) => {
  const asked: Array<string> = []
  const releases: Releases = {
    api,
    fetch: async (url) => {
      asked.push(url)
      return url === `${api}/releases/latest`
        ? Response.json({
            tag_name: tag,
            html_url: `https://github.com/noesis-sol/tutti/releases/tag/${tag}`,
            assets: [],
          })
        : Response.json({ message: "Not Found" }, { status: 404 })
    },
  }
  return { releases, asked }
}

/** The npm package's bundle at 0.9.0, a release build unless `shown` says otherwise. */
const npmBuild = (shown = "0.9.0"): Build => ({
  version: "0.9.0",
  shown,
  kind: "npm",
  target: null,
  exe: "/usr/local/bin/bun",
})

const run = async (
  flags: { readonly check?: boolean; readonly force?: boolean },
  build: Build,
  tag: string,
) => {
  const { releases, asked } = releasesOf(tag)
  const out: Array<string> = []
  const error: Array<string> = []
  const code = await Effect.runPromise(
    update({ check: flags.check ?? false, force: flags.force ?? false }, build, {
      releases,
      keys: [],
      say: { out: (line) => out.push(line), error: (line) => error.push(line) },
    }).pipe(Effect.provide(BunServices.layer)),
  )
  return { code, out, error, asked }
}

const upgrade = `bunx ${npmPackage}@latest runs it, and bun add ${npmPackage}@latest (with -g where it is installed globally) installs it`

describe("the npm package's bundle", () => {
  test("is its own kind of build, release or not, once its entry marks it", () => {
    expect(buildKind(null)).toBe("source")
    expect(buildKind("darwin-arm64")).toBe("clone")
    markNpmBundle()
    expect(buildKind(null)).toBe("npm")
    expect(buildKind("darwin-arm64")).toBe("npm")
  })

  test("doesn't check for a newer release as it runs", () => {
    expect(checksForUpdates({ kind: "npm" }, () => undefined)).toBe(false)
    expect(checksForUpdates({ kind: "npm" }, () => "0")).toBe(false)
  })

  test("--check names the package manager's upgrade, exiting 1 behind the latest release", async () => {
    const ran = await run({ check: true }, npmBuild(), "v0.9.1")
    expect(ran.code).toBe(updateExit.available)
    expect(ran.out).toEqual([
      `tutti v0.9.0 is the npm package ${npmPackage}; the latest release is v0.9.1 (https://github.com/noesis-sol/tutti/releases/tag/v0.9.1): ${upgrade}.`,
    ])
    expect(ran.out[0]).not.toContain("tutti update")
    expect(ran.out[0]).not.toContain("install.sh")
  })

  test("--check says a release build level with the latest release is the latest", async () => {
    const ran = await run({ check: true }, npmBuild(), "v0.9.0")
    expect(ran.code).toBe(updateExit.ok)
    expect(ran.out).toEqual(["tutti v0.9.0 is the latest release."])
  })

  test("tutti update refuses, even with --force, naming the package manager's upgrade", async () => {
    for (const force of [false, true]) {
      const ran = await run({ force }, npmBuild("0.9.0 0123456789ab"), "v0.9.1")
      expect(ran.code).toBe(updateExit.refused)
      expect(ran.out).toEqual([])
      expect(ran.error).toEqual([
        `tutti update: tutti v0.9.0 0123456789ab is the npm package ${npmPackage}, which tutti update doesn't replace: ${upgrade}.`,
      ])
      expect(ran.error[0]).not.toContain("from source")
      expect(ran.error[0]).not.toContain("install.sh")
      // Nothing is downloaded.
      expect(ran.asked).toEqual([`${api}/releases/latest`])
    }
  })
})
