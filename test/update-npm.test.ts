// The npm package's bundle and tutti update (§ 12 npm): its runs don't check for a newer release,
// and tutti update --check and tutti update name the package manager's upgrade, not tutti update's
// nor scripts/install.sh.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import pkg from "../package.json" with { type: "json" }
import { buildKind, markNpmBundle } from "../src/cli/version.ts"
import {
  type Build,
  checksForUpdates,
  npmPackage,
  type Releases,
  update,
  updateExit,
} from "../src/update/update.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"

const checkout = resolve(import.meta.dir, "..")

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

  test("is marked by its entry before main, and a run's daily check goes by the mark", () => {
    const entry = readFileSync(join(checkout, "src/npm.ts"), "utf8")
    const marked = entry.indexOf("\nmarkNpmBundle()\n")
    expect(marked).toBeGreaterThan(-1)
    expect(entry.indexOf("\nmain()")).toBeGreaterThan(marked)
    const main = readFileSync(join(checkout, "src/main.ts"), "utf8")
    expect(main).toContain("checksForUpdates({ kind: thisBuildKind() }, env)")
  })

  // The real bundle, built as the package's prepack builds it, run by Bun with a fetch that answers
  // GitHub's latest release with v99.0.0 and nothing else.
  slow.test(
    "built, tutti update --check and tutti update name the package manager's upgrade",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "tutti-update-npm-"))
      symlinkSync(join(checkout, "node_modules"), join(dir, "node_modules"))
      const env = { ...testEnv }
      delete env.NODE_ENV
      const build = Bun.spawnSync(["scripts/build-npm.sh", "--out", join(dir, "bundle")], {
        cwd: checkout,
        env,
        stderr: "pipe",
      })
      expect(build.stderr.toString()).toBe("")
      expect(build.exitCode).toBe(0)
      const stub = join(dir, "stub.ts")
      writeFileSync(
        stub,
        `globalThis.fetch = (async (url: string | URL | Request) =>
  String(url).endsWith("/releases/latest")
    ? Response.json({ tag_name: "v99.0.0", html_url: "https://releases.test/v99.0.0", assets: [] })
    : Response.json({ message: "Not Found" }, { status: 404 })) as typeof fetch
`,
      )
      const tutti = (...args: ReadonlyArray<string>) => {
        const ran = Bun.spawnSync(
          ["bun", "--config=/dev/null", "--preload", stub, join(dir, "bundle/tutti.js"), ...args],
          { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
        )
        return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
      }
      const checked = tutti("update", "--check")
      expect(checked.out).toContain(
        `is the npm package ${npmPackage}; the latest release is v99.0.0 (https://releases.test/v99.0.0): ${upgrade}.`,
      )
      expect(checked.out).toStartWith(`tutti v${pkg.version} `)
      expect(checked.code).toBe(updateExit.available)
      const refused = tutti("update", "--force")
      expect(refused.err).toContain(
        `is the npm package ${npmPackage}, which tutti update doesn't replace: ${upgrade}.`,
      )
      expect(refused.code).toBe(updateExit.refused)
    },
    120_000,
  )
})
