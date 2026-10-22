// writeFileAtomic (src/services/atomicFile.ts), the one way tutti writes a file whole: through a
// link to the file it points at, keeping the file's mode, by a temporary file of its own beside it,
// synced and renamed over it, and removed where it fails. Then the writers built on it: the
// user's ~/.claude.json staying a link as markTrusted marks a checkout trusted, .gitattributes left
// as it is where it can't be read, and the writes init stages.
import { describe, expect, test } from "bun:test"
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, FileSystem } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"
import fc from "fast-check"
import { staging } from "../src/init/staged.ts"
import type { Machine } from "../src/init/steps.ts"
import { applyUnion, markTrusted } from "../src/init/workers.ts"
import { writeReadmeRequires } from "../src/project/requires.ts"
import { AtomicWriter, writeFileAtomic } from "../src/services/atomicFile.ts"

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-atomic-")))

const modeOf = (path: string) => statSync(path).mode & 0o7777

/** `effect` on Bun's file system, with what `override` changes in it. */
const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
  override: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem> = () => ({}),
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* Effect.provideService(effect, FileSystem.FileSystem, { ...fs, ...override(fs) })
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

const ok = async <A, E>(exit: Promise<Exit.Exit<A, E>>): Promise<A> => {
  const done = await exit
  if (Exit.isFailure(done)) throw new Error(`expected a success, got ${done.cause}`)
  return done.value
}

const refused = (method: string, path: string): PlatformError =>
  systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    description: "refused on purpose",
    pathOrDescriptor: path,
  })

describe("writeFileAtomic", () => {
  test("writes a new file, and replaces one, leaving nothing beside it", async () => {
    const dir = tempDir()
    const file = join(dir, "notes.txt")
    await ok(run(writeFileAtomic(file, "first\n")))
    expect(readFileSync(file, "utf8")).toBe("first\n")
    await ok(run(writeFileAtomic(file, new TextEncoder().encode("second\n"))))
    expect(readFileSync(file, "utf8")).toBe("second\n")
    expect(readdirSync(dir)).toEqual(["notes.txt"])
  })

  test("any text reads back as written", async () => {
    const dir = tempDir()
    const file = join(dir, "any")
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "binary" }), async (text) => {
        await ok(run(writeFileAtomic(file, text)))
        expect(readFileSync(file, "utf8")).toBe(text)
      }),
      { numRuns: 30 },
    )
    expect(readdirSync(dir)).toEqual(["any"])
  })

  test("keeps the mode a file had; mode sets it, newMode only for a new file", async () => {
    const dir = tempDir()
    const script = join(dir, "run.sh")
    writeFileSync(script, "old", { mode: 0o750 })
    await ok(run(writeFileAtomic(script, "new")))
    expect(modeOf(script)).toBe(0o750)
    await ok(run(writeFileAtomic(script, "newer", { newMode: 0o600 })))
    expect(modeOf(script)).toBe(0o750)
    await ok(run(writeFileAtomic(script, "newest", { mode: 0o755 })))
    expect(modeOf(script)).toBe(0o755)

    const secret = join(dir, "secret.json")
    await ok(run(writeFileAtomic(secret, "{}", { newMode: 0o600 })))
    expect(modeOf(secret)).toBe(0o600)
  })

  test("writes through a link, and a link to a link, to the file at their end", async () => {
    const dir = tempDir()
    const kept = join(tempDir(), "real.json")
    writeFileSync(kept, "old", { mode: 0o640 })
    const middle = join(dir, "middle.json")
    const link = join(dir, "config.json")
    symlinkSync(kept, middle)
    symlinkSync(middle, link)
    await ok(run(writeFileAtomic(link, "new")))
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(middle)
    expect(lstatSync(middle).isSymbolicLink()).toBe(true)
    expect(readFileSync(kept, "utf8")).toBe("new")
    expect(modeOf(kept)).toBe(0o640)
    expect(readdirSync(dir).sort()).toEqual(["config.json", "middle.json"])
  })

  test("a link to nothing yet makes the file it points at", async () => {
    const dir = tempDir()
    const target = join(dir, "made.txt")
    const link = join(dir, "link.txt")
    symlinkSync("made.txt", link)
    await ok(run(writeFileAtomic(link, "made")))
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, "utf8")).toBe("made")
  })

  test("a temporary file of a name of its own: one left by a crash is never in the way", async () => {
    const dir = tempDir()
    const file = join(dir, "state.json")
    const names: Array<string> = []
    const seeing = (fs: FileSystem.FileSystem): Partial<FileSystem.FileSystem> => ({
      open: (path, options) => {
        if (path.endsWith(".tmp")) names.push(path)
        return fs.open(path, options)
      },
    })
    await ok(run(writeFileAtomic(file, "1"), seeing))
    await ok(run(writeFileAtomic(file, "2"), seeing))
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name).toMatch(/\/\.state\.json\.tutti-\d+-[0-9a-f-]+\.tmp$/)
  })

  test("a failed write or rename leaves the old file, and removes its temporary file", async () => {
    const dir = tempDir()
    const file = join(dir, "kept.txt")
    writeFileSync(file, "old")
    for (const fails of ["rename", "chmod"] as const) {
      const exit = await run(writeFileAtomic(file, "new", { mode: 0o600 }), () => ({
        [fails]: (path: string) => Effect.fail(refused(fails, path)),
      }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(readFileSync(file, "utf8")).toBe("old")
      expect(readdirSync(dir)).toEqual(["kept.txt"])
    }
  })

  test("is synced: the file before its rename, its folder after", async () => {
    const dir = tempDir()
    const file = join(dir, "synced.txt")
    const steps: Array<string> = []
    await ok(
      run(writeFileAtomic(file, "data"), (fs) => ({
        open: (path, options) =>
          Effect.map(
            fs.open(path, options),
            (handle) =>
              new Proxy(handle, {
                get: (target, key) => {
                  if (key === "sync") {
                    return Effect.andThen(
                      Effect.sync(() => steps.push(`sync ${path === dir ? "folder" : "file"}`)),
                      target.sync,
                    )
                  }
                  const value: unknown = Reflect.get(target, key, target)
                  return typeof value === "function" ? value.bind(target) : value
                },
              }),
          ),
        rename: (from, to) =>
          Effect.andThen(
            Effect.sync(() => steps.push("rename")),
            fs.rename(from, to),
          ),
      })),
    )
    expect(steps).toEqual(["sync file", "rename", "sync folder"])
  })

  test("under init's staging, is staged and written nowhere until it is put in", async () => {
    const dir = tempDir()
    const file = join(dir, "run.sh")
    const writes = await ok(
      run(
        Effect.gen(function* () {
          const staged = staging(yield* FileSystem.FileSystem)
          yield* writeFileAtomic(file, "echo hi\n", { mode: 0o755 }).pipe(
            Effect.provideService(FileSystem.FileSystem, staged.fs),
            Effect.provideService(AtomicWriter, staged.write),
          )
          return staged.writes()
        }),
      ),
    )
    expect(readdirSync(dir)).toEqual([])
    expect(writes).toEqual([
      { path: file, data: new TextEncoder().encode("echo hi\n"), mode: 0o755 },
    ])
  })
})

describe("the writers on it", () => {
  test("markTrusted keeps a linked .claude.json a link, and its mode", async () => {
    const home = tempDir()
    const dotfiles = tempDir()
    const kept = join(dotfiles, "claude.json")
    writeFileSync(kept, `${JSON.stringify({ theme: "dark" })}\n`, { mode: 0o644 })
    const file = join(home, ".claude.json")
    symlinkSync(kept, file)
    await ok(run(markTrusted(file, "/work/repo")))
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(kept, "utf8"))).toEqual({
      theme: "dark",
      projects: { "/work/repo": { hasTrustDialogAccepted: true } },
    })
    expect(modeOf(kept)).toBe(0o644)
    expect(readdirSync(home)).toEqual([".claude.json"])
    expect(readdirSync(dotfiles)).toEqual(["claude.json"])
  })

  test("markTrusted makes a missing .claude.json readable by its user only", async () => {
    const home = tempDir()
    const file = join(home, ".claude.json")
    await ok(run(markTrusted(file, "/work/repo")))
    expect(modeOf(file)).toBe(0o600)
  })

  test("applyUnion fails on a .gitattributes it can't read, leaving it as it is", async () => {
    const repo = tempDir()
    writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n")
    const attributes = join(repo, ".gitattributes")
    writeFileSync(attributes, "*.png binary\n")
    const machine: Machine = {
      run: () => Effect.succeed("CHANGELOG.md: merge: unspecified\n"),
      which: () => null,
      env: () => undefined,
      platform: "darwin",
      executable: () => false,
    }
    const exit = await run(applyUnion(machine, repo, true), (fs) => ({
      readFileString: (path, encoding) =>
        path === attributes
          ? Effect.fail(refused("readFileString", path))
          : fs.readFileString(path, encoding),
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(readFileSync(attributes, "utf8")).toBe("*.png binary\n")

    // Missing, it is made with the one line.
    const fresh = tempDir()
    writeFileSync(join(fresh, "CHANGELOG.md"), "# Changelog\n")
    await ok(run(applyUnion(machine, fresh, true)))
    expect(readFileSync(join(fresh, ".gitattributes"), "utf8")).toBe("CHANGELOG.md merge=union\n")
  })

  test("the README's section is written through a link to the README", async () => {
    const repo = tempDir()
    const kept = join(tempDir(), "README.md")
    writeFileSync(kept, "# Project\n")
    symlinkSync(kept, join(repo, "README.md"))
    const changed = await ok(
      run(writeReadmeRequires(repo, [{ name: "tool", check: "true", install: "true" }])),
    )
    expect(changed).toBe(true)
    expect(lstatSync(join(repo, "README.md")).isSymbolicLink()).toBe(true)
    expect(readFileSync(kept, "utf8")).toContain("tool")
    expect(readdirSync(repo)).toEqual(["README.md"])
  })
})
