import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, Result } from "effect"
import fc from "fast-check"
import { mainCheckout } from "../src/cli/commands.ts"
import { check, findRepository, type StartupFailed } from "../src/run/startup.ts"
import { Git, GitWriter, gitTooOld, parseGitVersion } from "../src/services/Git.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import { withVariable } from "./env.ts"

const tooOld =
  "git 2.34.1 is too old: tutti needs git 2.38 or later. Update git, then run tutti again."

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-git-version-")))

/**
 * A git as Ubuntu 22.04 ships it, 2.34.1, in a folder of its own: it prints its version, refuses
 * `worktree list -z` as 2.34.1 does, and lists a worktree in `listed` otherwise.
 */
const oldGit = (listed: string): string => {
  const dir = join(tempDir(), "bin")
  mkdirSync(dir)
  const path = join(dir, "git")
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = --version ]; then echo "git version 2.34.1"; exit 0; fi',
      'for arg in "$@"; do',
      '  if [ "$arg" = -z ]; then echo "error: unknown switch \\`z\'" >&2; exit 129; fi',
      "done",
      `printf 'worktree ${listed}\\nHEAD 0000000000000000000000000000000000000000\\nbranch refs/heads/main\\n\\n'`,
      "",
    ].join("\n"),
  )
  chmodSync(path, 0o755)
  return path
}

/** findRepository in `cwd`, over `git`. */
const find = (cwd: string, git: Layer.Layer<Git, never, never>) =>
  Effect.runPromise(
    findRepository(cwd).pipe(Effect.provide(git), Effect.provide(BunServices.layer)),
  )

const liveGit = (command: string) =>
  Git.layer({ command }).pipe(Layer.provide(GitWriter.layer), Layer.provide(BunServices.layer))

describe("git --version", () => {
  test("reads the versions git prints, on each platform", () => {
    expect(parseGitVersion("git version 2.34.1\n")).toEqual([2, 34, 1])
    expect(parseGitVersion("git version 2.39.3 (Apple Git-146)")).toEqual([2, 39, 3])
    expect(parseGitVersion("git version 2.45.1.windows.1")).toEqual([2, 45, 1])
    expect(parseGitVersion("git version 2.38.0.rc1")).toEqual([2, 38, 0])
    expect(parseGitVersion("git version 3.0")).toEqual([3, 0, 0])
    expect(parseGitVersion("hub version 2.14.2")).toBeNull()
    expect(parseGitVersion("")).toBeNull()
  })

  test("reads back any version it is given, and never throws on other text", () => {
    const part = fc.integer({ min: 0, max: 999 })
    fc.assert(
      fc.property(part, part, part, fc.string(), (major, minor, patch, rest) => {
        const tail = /^[\d.]/.test(rest) ? "" : rest
        expect(parseGitVersion(`git version ${major}.${minor}.${patch}${tail}`)).toEqual([
          major,
          minor,
          patch,
        ])
      }),
    )
    fc.assert(
      fc.property(fc.string(), (text) => {
        const read = parseGitVersion(text)
        expect(read === null || read.every(Number.isInteger)).toBe(true)
      }),
    )
  })

  test("is too old below 2.38, and says which version tutti needs", () => {
    expect(gitTooOld("git version 2.34.1")).toBe(tooOld)
    expect(gitTooOld("git version 2.37.9")).toContain("git 2.37.9 is too old")
    expect(gitTooOld("git version 1.99.0")).toContain("git 1.99.0 is too old")
    expect(gitTooOld("git version 2.38.0")).toBeNull()
    expect(gitTooOld("git version 2.54.0 (Apple Git-157)")).toBeNull()
    expect(gitTooOld("git version 3.0.0")).toBeNull()
    expect(gitTooOld("not git")).toBeNull()
  })

  test("the live service runs git --version", async () => {
    const version = await Effect.runPromise(
      Effect.flatMap(Git, (git) => git.version(tempDir())).pipe(
        Effect.provide(liveGit(oldGit("/repo"))),
      ),
    )
    expect(version).toBe("git version 2.34.1")
  })
})

describe("the startup checks with git 2.34.1", () => {
  test("say git is too old, not that there is no repository", async () => {
    const repo = tempDir()
    const exit = await Effect.runPromise(
      Effect.exit(
        check({
          cwd: repo,
          env: {},
          config: (top) => Effect.succeed(TestAppConfig.appConfig({}, top)),
          beads: () => TestBeads.layer(),
          claude: (given) => Effect.succeed({ path: given, warnings: [], problems: [] }),
          account: TestAccount.layer(),
        }),
      ).pipe(
        Effect.scoped,
        Effect.provide(liveGit(oldGit(repo))),
        Effect.provide(BunServices.layer),
      ),
    )
    if (Exit.isSuccess(exit)) throw new Error("the checks passed")
    const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
    const failure = reason?.error as StartupFailed
    expect(failure.problems).toEqual([tooOld])
    expect(failure.notSetUp).toBe(false)
  })

  test("tutti init and the run find no repository past it", async () => {
    const repo = tempDir()
    const found = await find(repo, liveGit(oldGit(repo)))
    expect(found).toEqual(Result.fail(tooOld))
  })

  test("the commands that find the main checkout say so too", async () => {
    const repo = tempDir()
    const git = oldGit(repo)
    const exit = await withVariable("PATH", join(git, ".."), () =>
      Effect.runPromise(Effect.exit(mainCheckout(repo).pipe(Effect.provide(BunServices.layer)))),
    )
    expect(exit).toEqual(Exit.fail(tooOld))
  })
})

describe("a git that passes the version check", () => {
  test("2.38 lists the worktrees", async () => {
    const found = await find(
      "/repo",
      TestGit.layer({ dir: "/repo", version: "git version 2.38.0" }),
    )
    expect(found).toEqual(Result.succeed({ repo: "/repo", linked: null }))
  })

  test("a version tutti can't read is left to the commands after it", async () => {
    const found = await find(
      "/repo",
      TestGit.layer({ dir: "/repo", version: "git version unknown" }),
    )
    expect(found).toEqual(Result.succeed({ repo: "/repo", linked: null }))
  })

  test("git not installed is a command not found", async () => {
    const found = await find(tempDir(), liveGit(join(tempDir(), "no-git")))
    expect(found).toEqual(Result.fail("Required command not found: git"))
  })
})
