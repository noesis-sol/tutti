import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { AlreadyRunning, type Holder, RunLock } from "../src/services/RunLock.ts"

// A run refused while init holds the lock says so, as orchestra says `(orchestra init, pid N)`.

const newRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-run-lock-init-")))
  const commonDir = join(repo, ".git")
  mkdirSync(commonDir)
  return { repo, commonDir }
}

const started = new Date(2026, 9, 17, 8, 31, 5).toISOString()

const initHolder: Holder = {
  pid: 44497,
  started,
  version: "0.1.0",
  branch: "main",
  init: true,
}

describe("the refusal while init holds the lock", () => {
  test("names init before the pid, the start time and the branch", () => {
    const refusal = new AlreadyRunning({
      program: "tutti",
      repo: "/work/project",
      holder: initHolder,
    })
    expect(refusal.message).toBe(
      "tutti is already running in /work/project (tutti init, pid 44497, since 08:31, main)",
    )
  })

  test("names orchestra init when orchestra's init holds its lock", () => {
    const refusal = new AlreadyRunning({
      program: "orchestra",
      repo: "/work/project",
      holder: { init: true, pid: 7 },
    })
    expect(refusal.message).toBe("orchestra is running in /work/project (orchestra init, pid 7)")
  })

  test("a run doesn't say init", () => {
    const { init: _, ...run } = initHolder
    const refusal = new AlreadyRunning({ program: "tutti", repo: "/work/project", holder: run })
    expect(refusal.message).not.toContain("init")
  })

  test("a run refused by init's held lock says init holds it", async () => {
    const repo = newRepo()
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RunLock
          yield* lock.acquire({ ...repo, holder: initHolder })
          const { init: _, ...run } = initHolder
          return yield* Effect.flip(
            Effect.scoped(lock.acquire({ ...repo, holder: { ...run, pid: 1 } })),
          )
        }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    expect(exit.value).toBeInstanceOf(AlreadyRunning)
    expect(exit.value.message).toMatch(
      new RegExp(
        `^tutti is already running in ${repo.repo} \\(tutti init, pid 44497, since \\d\\d:\\d\\d, main\\)$`,
      ),
    )
  })
})
