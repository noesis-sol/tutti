import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Result } from "effect"
import fc from "fast-check"
import {
  cacheName,
  latestRelease,
  newerRelease,
  type Releases,
  startCheck,
  updateExit,
} from "../src/update/update.ts"
import { api, build, fakeTutti, fixture, installed, leftovers, run } from "./update-releases.ts"

const latestUrl = `${api}/releases/latest`

/** A body of `chunks` chunks of a MiB each, the same bytes each time; `cancelled` once it is. */
const endless = (chunks: number) => {
  const chunk = new Uint8Array(1024 * 1024)
  let sent = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (sent === chunks) {
        controller.close()
        return
      }
      sent++
      controller.enqueue(chunk)
    },
    cancel: () => {
      cancelled = true
    },
  })
  return { body, sent: () => sent, cancelled: () => cancelled }
}

describe("tutti update refuses a download over its size limit", () => {
  test("the latest release's details over 4 MB", async () => {
    const { exe } = installed()
    const { releases, asked } = await fixture({
      tag: "v0.9.1",
      latest: " ".repeat(4 * 1024 * 1024 + 1),
    })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error).toEqual([`tutti update: GET ${latestUrl}: over 4 MB`])
    expect(asked).toEqual([latestUrl])
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
  })

  test("an archive over 1024 MB, stopped at the limit, leaving the binary and nothing beside it", async () => {
    const { dir, exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1" })
    const archive = endless(2048)
    const huge: Releases = {
      ...releases,
      fetch: (url, init) =>
        url.endsWith(".tar.gz")
          ? Promise.resolve(new Response(archive.body))
          : releases.fetch(url, init),
    }
    const ran = await run({}, build(exe), huge)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error[0]).toMatch(
      /^tutti update: GET \S+tutti_0\.9\.1_darwin_arm64\.tar\.gz: over 1024 MB$/,
    )
    expect(ran.error[1]).toBe(`${exe} is unchanged.`)
    // Read no further than the limit, and the rest of the body cancelled.
    expect(archive.sent()).toBeGreaterThanOrEqual(1025)
    expect(archive.sent()).toBeLessThanOrEqual(1026)
    expect(archive.cancelled()).toBe(true)
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    expect(leftovers(dir)).toEqual([])
  })
})

describe("tutti update can't read the latest release", () => {
  const latest = async (body: string) => {
    const { exe } = installed()
    const { releases, asked } = await fixture({ tag: "v0.9.1", latest: body })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.out).toEqual([])
    // Nothing downloaded past the release's details, and the binary as it was.
    expect(asked).toEqual([latestUrl])
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    return ran.error
  }

  const release = (tag: unknown) =>
    JSON.stringify({ tag_name: tag, html_url: "https://github.com/x", assets: [] })

  test("JSON that doesn't parse", async () => {
    const error = await latest("{not json")
    expect(error).toHaveLength(1)
    expect(error[0]).toStartWith("tutti update: cannot read the latest release: ")
  })

  test("JSON without the release's fields", async () => {
    for (const body of [JSON.stringify({ message: "hi" }), release(9), "[]", "null"]) {
      const error = await latest(body)
      expect(error).toHaveLength(1)
      expect(error[0]).toStartWith("tutti update: cannot read the latest release: ")
    }
  })

  test("a tag that isn't a version, shown without its control characters", async () => {
    expect(await latest(release("nightly"))).toEqual([
      "tutti update: cannot read the latest release: its tag 'nightly' is not a version",
    ])
    const [line] = await latest(release("v1\x1b[31m.0"))
    expect(line).toStartWith("tutti update: cannot read the latest release: its tag '")
    expect(line).not.toContain("\x1b")
  })

  test("--check says so too, and exits 4", async () => {
    const { exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", latest: release("latest") })
    const ran = await run({ check: true }, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error).toEqual([
      "tutti update: cannot read the latest release: its tag 'latest' is not a version",
    ])
  })

  test("any body is a release with a version for a tag, or a failure that says why", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.json(), fc.string().map(release)), async (body) => {
        const releases: Releases = {
          api,
          fetch: () => Promise.resolve(new Response(body)),
        }
        const read = await Effect.runPromise(Effect.result(latestRelease(releases)))
        if (Result.isSuccess(read)) {
          expect(read.success.tag).toMatch(/^v?\d+\.\d+\.\d+/)
        } else {
          expect(read.failure.message).toStartWith("cannot read the latest release: ")
        }
      }),
      { numRuns: 200 },
    )
  })
})

describe("tutti update finds no tutti in the archive", () => {
  const extract = async (holds: Record<string, string>) => {
    const { dir, exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", holds })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error[1]).toBe(`${exe} is unchanged.`)
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    expect(leftovers(dir)).toEqual([])
    return ran.error[0]
  }

  test("an archive without it: cannot extract tutti", async () => {
    expect(await extract({ "README.md": "tutti 0.9.1\n" })).toBe(
      "tutti update: cannot extract tutti from tutti_0.9.1_darwin_arm64.tar.gz: no tutti in it",
    )
  })

  test("one with tutti only in a folder", async () => {
    expect(await extract({ "bin/tutti": fakeTutti("tutti v0.9.1") })).toBe(
      "tutti update: cannot extract tutti from tutti_0.9.1_darwin_arm64.tar.gz: no tutti in it",
    )
  })
})

describe("the daily check, with a cache it can't write", () => {
  const start = Date.UTC(2026, 9, 20, 9)

  const unwritable = async (cache: string) => {
    const { releases, asked } = await fixture({ tag: "v0.9.1" })
    const at = (now: number) =>
      Effect.runPromise(newerRelease({ releases, current: "0.9.0", cache, now: () => now }))
    // It still answers, and, having recorded nothing, asks again next time.
    expect(await at(start)).toEqual(Option.some("v0.9.1"))
    expect(await at(start + 1000)).toEqual(Option.some("v0.9.1"))
    expect(asked).toEqual([latestUrl, latestUrl])
  }

  test("a folder it may not write in", async () => {
    const cache = mkdtempSync(join(tmpdir(), "tutti-update-cache-"))
    chmodSync(cache, 0o555)
    try {
      await unwritable(cache)
    } finally {
      chmodSync(cache, 0o755)
    }
    expect(existsSync(join(cache, cacheName))).toBe(false)
  })

  test("a file where its folder would be", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "tutti-update-cache-")), "tutti")
    writeFileSync(cache, "not a folder")
    await unwritable(cache)
    expect(readFileSync(cache, "utf8")).toBe("not a folder")
  })
})

describe("startCheck", () => {
  const start = Date.UTC(2026, 9, 20, 9)

  /** Releases whose latest-release request waits for `answer`, or fails once aborted. */
  const held = (releases: Releases) => {
    let answer: () => void = () => {}
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    let asking: () => void = () => {}
    const asked = new Promise<void>((resolve) => {
      asking = resolve
    })
    let signal: AbortSignal | undefined
    const waiting: Releases = {
      ...releases,
      fetch: async (url, init) => {
        signal = init.signal
        asking()
        await Promise.race([
          answered,
          new Promise((_, reject) =>
            init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
        ])
        return releases.fetch(url, init)
      },
    }
    return { releases: waiting, answer, asked, aborted: () => signal?.aborted === true }
  }

  test("gives none while the check runs, and the newer tag once it has found one", async () => {
    const cache = mkdtempSync(join(tmpdir(), "tutti-update-cache-"))
    const check = held((await fixture({ tag: "v0.9.1" })).releases)
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const newer = yield* startCheck({
            releases: check.releases,
            current: "0.9.0",
            cache,
            now: () => start,
          })
          yield* Effect.promise(() => check.asked)
          const during = yield* newer
          check.answer()
          let after = yield* newer
          for (let i = 0; i < 500 && Option.isNone(after); i++) {
            yield* Effect.sleep("10 millis")
            after = yield* newer
          }
          return { during, after }
        }),
      ),
    )
    expect(seen.during).toEqual(Option.none())
    expect(seen.after).toEqual(Option.some("v0.9.1"))
    expect(JSON.parse(readFileSync(join(cache, cacheName), "utf8")).latest).toBe("v0.9.1")
  })

  test("leaves nothing running once its scope closes, and records nothing", async () => {
    const cache = mkdtempSync(join(tmpdir(), "tutti-update-cache-"))
    const check = held((await fixture({ tag: "v0.9.1" })).releases)
    const newer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const newer = yield* startCheck({
            releases: check.releases,
            current: "0.9.0",
            cache,
            now: () => start,
          })
          yield* Effect.promise(() => check.asked)
          return newer
        }),
      ),
    )
    // The request was stopped as the scope closed, and an interrupted check isn't recorded, so
    // the next run asks again.
    expect(check.aborted()).toBe(true)
    expect(await Effect.runPromise(newer)).toEqual(Option.none())
    expect(existsSync(join(cache, cacheName))).toBe(false)
    // An answer coming after it changes nothing.
    check.answer()
    await Bun.sleep(20)
    expect(await Effect.runPromise(newer)).toEqual(Option.none())
    expect(existsSync(join(cache, cacheName))).toBe(false)
  })
})
