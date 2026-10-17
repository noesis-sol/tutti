import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import fc from "fast-check"
import { formatVersion, parseBuildCommit, sourceCommit } from "../src/cli/version.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const read = (root: string) =>
  Effect.runPromise(Effect.provide(sourceCommit(root), BunServices.layer))

describe("formatVersion", () => {
  test("a release has the bare version", () => {
    expect(formatVersion("0.1.0", Option.none())).toBe("0.1.0")
  })

  test("a clone build ends with its commit's hash", () => {
    expect(formatVersion("0.1.0", Option.some({ hash: "0123456789ab", dirty: false }))).toBe(
      "0.1.0 0123456789ab",
    )
  })

  test("a build from a tree with changes ends with +dirty", () => {
    expect(formatVersion("0.1.0", Option.some({ hash: "0123456789ab", dirty: true }))).toBe(
      "0.1.0 0123456789ab+dirty",
    )
  })
})

describe("parseBuildCommit", () => {
  test("a release's empty define is no commit", () => {
    expect(parseBuildCommit("")).toEqual(Option.none())
  })

  test("a hash is cut to 12 characters, and +dirty read", () => {
    expect(parseBuildCommit("0123456789abcdef")).toEqual(
      Option.some({ hash: "0123456789ab", dirty: false }),
    )
    expect(parseBuildCommit("0123456789abcdef+dirty")).toEqual(
      Option.some({ hash: "0123456789ab", dirty: true }),
    )
  })

  test("a define formats back to the version it describes", () => {
    const hex = fc.stringMatching(/^[0-9a-f]{12,40}$/)
    fc.assert(
      fc.property(hex, fc.boolean(), (hash, dirty) => {
        const define = `${hash}${dirty ? "+dirty" : ""}`
        expect(formatVersion("1.2.3", parseBuildCommit(define))).toBe(
          `1.2.3 ${hash.slice(0, 12)}${dirty ? "+dirty" : ""}`,
        )
      }),
    )
  })
})

slow.describe("sourceCommit", () => {
  test("a clean checkout has its HEAD's hash", async () => {
    const repo = makeRepo()
    expect(await read(repo.dir)).toEqual(
      Option.some({ hash: repo.head().slice(0, 12), dirty: false }),
    )
  })

  test("a checkout with changes is dirty, an untracked file included", async () => {
    const repo = makeRepo()
    repo.write({ "new.txt": "new" })
    expect(await read(repo.dir)).toEqual(
      Option.some({ hash: repo.head().slice(0, 12), dirty: true }),
    )
  })

  test("a folder inside another checkout has no commit of its own", async () => {
    const repo = makeRepo()
    const inner = join(repo.dir, "node_modules", "tutti")
    mkdirSync(inner, { recursive: true })
    expect(await read(inner)).toEqual(Option.none())
  })

  test("a folder outside any checkout has no commit", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-version-")))
    expect(await read(dir)).toEqual(Option.none())
  })
})
