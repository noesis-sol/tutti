// tutti init --update interrupted (Ctrl+C) while it puts its files in (src/init/staged.ts): the
// commit runs to its end, so the project is left as an update leaves it, with none of the temporary
// files or the old files' copies beside its own and no half-renamed set. Interrupted at each of the
// writes the commit makes on disk in turn.
import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { skillPath, verifierPath } from "../src/init/checks.ts"
import { updateTemplates } from "../src/init/update.ts"

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", "templates", name), "utf8")

const write = (repo: string, path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

/** A project set up before tutti recorded template versions, with every template out of date. */
const oldProject = () => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-update-interrupt-"))), "repo")
  mkdirSync(join(repo, ".git"), { recursive: true })
  write(
    repo,
    ".tutti/worker-prompt.md",
    `${fixture("worker-prompt-2026-10-17.md")}\n## Project notes\n- Use pnpm.\n${fixture("verify-section-2026-10-19.md")}`,
  )
  write(repo, verifierPath, fixture("verifier-2026-10-19.md"))
  write(repo, skillPath, fixture("create-check-suite-2026-10-22.md"))
  write(repo, ".tutti/settings.json", `${JSON.stringify({ concurrent: 2 }, null, 2)}\n`)
  return repo
}

/** Every file under `repo` but the git folder: its path, mode and text. */
const tree = (repo: string): Record<string, string> => {
  const files: Record<string, string> = {}
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      const at = relative(repo, path)
      if (at === ".git") continue
      const info = statSync(path)
      if (info.isDirectory()) {
        files[`${at}/`] = ""
        walk(path)
      } else {
        files[at] = `${(info.mode & 0o777).toString(8)} ${readFileSync(path, "utf8")}`
      }
    }
  }
  walk(repo)
  return files
}

/** Whether `path` is one of the staged writes' temporary files. */
const temporary = (path: string) => /\.tutti-\d+-[0-9a-f-]+\.(new|old)$/.test(path)

/**
 * `real`, counting the writes made in `repo` (the temporary files, their renames and the old files'
 * copies), in `seen`; the one at `at` tells `reached` and waits for `go` before it is made.
 */
const pausing = (
  real: FileSystem.FileSystem,
  repo: string,
  seen: { count: number },
  at: number,
  reached: Deferred.Deferred<void>,
  go: Deferred.Deferred<void>,
): FileSystem.FileSystem => {
  const check = <A, R>(
    path: string,
    effect: Effect.Effect<A, PlatformError, R>,
    op?: string,
  ): Effect.Effect<A, PlatformError, R> =>
    Effect.suspend(() => {
      if (!path.startsWith(`${repo}/`) || path.startsWith(join(repo, ".git"))) return effect
      if (op === "open" && !temporary(path)) return effect
      seen.count += 1
      if (seen.count - 1 !== at) return effect
      return Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(go)),
        Effect.andThen(effect),
      )
    })
  return FileSystem.FileSystem.of({
    ...real,
    makeDirectory: (path, options) => check(path, real.makeDirectory(path, options)),
    open: (path, options) => check(path, real.open(path, options), "open"),
    chmod: (path, mode) => check(path, real.chmod(path, mode)),
    rename: (from, to) => check(from, real.rename(from, to)),
    link: (from, to) => check(to, real.link(from, to)),
    copyFile: (from, to) => check(to, real.copyFile(from, to)),
  })
}

/**
 * Runs --update in `repo`, interrupted as it is about to make its write at `at` (none where it
 * makes fewer): how it ended, and how many writes it made.
 */
const runInterrupted = async (repo: string, at: number) => {
  const seen = { count: 0 }
  const reached = Deferred.makeUnsafe<void>()
  const go = Deferred.makeUnsafe<void>()
  const files = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) => pausing(real, repo, seen, at, reached, go)),
  ).pipe(Layer.provide(BunServices.layer))
  const fiber = Effect.runFork(
    updateTemplates(repo).pipe(Effect.provide(files), Effect.provide(BunServices.layer)),
  )
  const paused = await Effect.runPromise(
    Effect.raceFirst(
      Effect.as(Deferred.await(reached), true),
      Effect.as(Fiber.await(fiber), false),
    ),
  )
  if (!paused) return { exit: await Effect.runPromise(Fiber.await(fiber)), count: seen.count }
  // Ctrl+C while the write waits; the write then goes on.
  const interrupting = Effect.runPromise(Fiber.interrupt(fiber))
  await Effect.runPromise(Deferred.succeed(go, undefined))
  await interrupting
  return { exit: await Effect.runPromise(Fiber.await(fiber)), count: seen.count }
}

describe("tutti init --update interrupted while it writes", () => {
  test("an interrupt at each write leaves the project updated, with nothing beside its files", async () => {
    const done = oldProject()
    const whole = await runInterrupted(done, -1)
    expect(Exit.isSuccess(whole.exit)).toBe(true)
    expect(whole.count).toBeGreaterThanOrEqual(12)
    const updated = Object.entries(tree(done))

    for (let at = 0; at < whole.count; at++) {
      const repo = oldProject()
      const ran = await runInterrupted(repo, at)
      // Every write was made, however far the interrupt came.
      expect([at, ran.count]).toEqual([at, whole.count])
      const files = tree(repo)
      expect([at, Object.keys(files).filter(temporary)]).toEqual([at, []])
      expect([at, Object.entries(files)]).toEqual([at, updated])
    }
  })
})
