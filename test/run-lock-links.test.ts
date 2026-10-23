// The run lock never writes through a link (§ 9.2): the git folder is writable from every worktree,
// so a worker can put a symbolic link, or a hard link to a file of its user's, at a lock file's
// name. The run is refused with LockFailed and the other file is left as it was; the probe too.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { close, flockExclusiveNonBlocking, O, openCloexec } from "../src/native/libc.ts"
import { type Holder, type LockRequest, lockFiles, RunLock } from "../src/services/RunLock.ts"

/** A repository's top, its git folder where the lock files go, and a precious file beside them. */
const newRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-run-lock-links-")))
  const commonDir = join(repo, ".git")
  mkdirSync(commonDir)
  const precious = join(repo, "precious.txt")
  writeFileSync(precious, "keep me\n")
  return { repo, commonDir, precious }
}

const holder: Holder = {
  pid: process.pid,
  started: new Date(2026, 9, 23, 8, 31, 5).toISOString(),
  version: "0.1.0",
  branch: "main",
}

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

/** Takes the lock with the live layer, in a scope of its own, and releases it. */
const withLock = (lock: LockRequest) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* RunLock).acquire(lock)
      }),
    ).pipe(Effect.provide(RunLock.layer)),
  )

const probe = (repo: { repo: string; commonDir: string }) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* RunLock).probe(repo)
    }).pipe(Effect.provide(RunLock.layer)),
  )

/** Whether this process can take the lock on `path` now, through an open file of its own. */
const lockable = (path: string): boolean => {
  const fd = Effect.runSync(openCloexec(path, O.RDWR | O.CREAT | O.NOFOLLOW))
  try {
    return Effect.runSync(flockExclusiveNonBlocking(fd))
  } finally {
    Effect.runSync(close(fd))
  }
}

const mkfifo = (path: string) => {
  const made = Bun.spawnSync(["mkfifo", path])
  if (made.exitCode !== 0) throw new Error(`mkfifo ${path}: ${made.stderr.toString()}`)
}

describe("a link at the lock's name", () => {
  for (const program of ["tutti", "orchestra"] as const) {
    test(`a symbolic link at ${lockFiles[program]} refuses the run and leaves its target as it was`, async () => {
      const repo = newRepo()
      symlinkSync(repo.precious, join(repo.commonDir, lockFiles[program]))
      const error = failure(await withLock({ ...repo, holder }))
      expect(error).toMatchObject({
        _tag: "LockFailed",
        file: join(repo.commonDir, lockFiles[program]),
      })
      expect(error.message).toContain("symbolic link")
      expect(readFileSync(repo.precious, "utf8")).toBe("keep me\n")
      // A refusal of the second file frees the first at once.
      if (program === "orchestra") expect(lockable(join(repo.commonDir, "tutti.lock"))).toBe(true)
    })

    test(`a hard link at ${lockFiles[program]} refuses the run and leaves the other name's file as it was`, async () => {
      const repo = newRepo()
      linkSync(repo.precious, join(repo.commonDir, lockFiles[program]))
      const error = failure(await withLock({ ...repo, holder }))
      expect(error).toMatchObject({
        _tag: "LockFailed",
        file: join(repo.commonDir, lockFiles[program]),
      })
      expect(error.message).toContain("2 links")
      expect(readFileSync(repo.precious, "utf8")).toBe("keep me\n")
    })
  }

  test("a dangling symbolic link refuses the run and creates nothing where it points", async () => {
    const repo = newRepo()
    const target = join(repo.repo, "made-through-the-link")
    symlinkSync(target, join(repo.commonDir, "tutti.lock"))
    expect(failure(await withLock({ ...repo, holder }))).toMatchObject({ _tag: "LockFailed" })
    expect(existsSync(target)).toBe(false)
  })

  test("a named pipe at the lock's name refuses the run without waiting on it", async () => {
    const repo = newRepo()
    mkfifo(join(repo.commonDir, "tutti.lock"))
    const error = failure(await withLock({ ...repo, holder }))
    expect(error).toMatchObject({ _tag: "LockFailed" })
    expect(error.message).toContain("named pipe")
  })

  test("a lock file of its own still takes the lock, and is emptied on release", async () => {
    const repo = newRepo()
    expect(Exit.isSuccess(await withLock({ ...repo, holder }))).toBe(true)
    expect(readFileSync(join(repo.commonDir, "tutti.lock"), "utf8")).toBe("")
    expect(readFileSync(join(repo.commonDir, "orchestra.lock"), "utf8")).toBe("")
  })
})

describe("the probe", () => {
  test("refuses a symbolic link at the lock's name, leaving its target as it was", async () => {
    const repo = newRepo()
    symlinkSync(repo.precious, join(repo.commonDir, "tutti.lock"))
    expect(failure(await probe(repo))).toMatchObject({
      _tag: "LockFailed",
      file: join(repo.commonDir, "tutti.lock"),
    })
    expect(readFileSync(repo.precious, "utf8")).toBe("keep me\n")
  })

  test("still finds nobody holding missing files", async () => {
    const repo = newRepo()
    const exit = await probe(repo)
    expect(Exit.isSuccess(exit) && exit.value).toBeUndefined()
  })
})
