// tutti plan --apply warns when a run holds the repository's lock (§ 8.1, § 9.2): RunLock's probe,
// a shared flock for a moment that a run's retries get past, and the warning plan prints from it.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Exit, Fiber, Layer } from "effect"
import { Command } from "effect/cli"
import { tuttiWith } from "../src/cli/commands.ts"
import {
  close,
  flockExclusiveNonBlocking,
  flockSharedNonBlocking,
  O,
  openCloexec,
  unlock,
} from "../src/native/libc.ts"
import type { Beads } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import {
  AlreadyRunning,
  type Holder,
  LockFailed,
  lockFiles,
  orchestraLockText,
  RunLock,
} from "../src/services/RunLock.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { type Held, layer as memoryLayer } from "../src/testing/RunLock.ts"

/** A repository's top and its git folder, where the lock files go. */
const newRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-plan-lock-")))
  const commonDir = join(repo, ".git")
  mkdirSync(commonDir)
  return { repo, commonDir }
}

const holder: Holder = {
  pid: 44497,
  started: new Date(2026, 9, 17, 8, 31, 5).toISOString(),
  version: "0.1.0",
  branch: "main",
}

const probe = (where: { repo: string; commonDir: string }) =>
  Effect.runPromise(
    Effect.flatMap(RunLock, (lock) => lock.probe(where)).pipe(Effect.provide(RunLock.layer)),
  )

/** Holds an exclusive flock on `path` through an open file of this process, as orchestra would. */
const holdExclusive = (path: string, text: string) => {
  const fd = Effect.runSync(openCloexec(path, O.RDWR | O.CREAT))
  expect(Effect.runSync(flockExclusiveNonBlocking(fd))).toBe(true)
  writeFileSync(path, text)
  return () => Effect.runSync(close(fd))
}

describe("RunLock.probe", () => {
  test("sees no run where no lock file is, and creates none", async () => {
    const where = newRepo()
    expect(await probe(where)).toBeUndefined()
    expect(existsSync(join(where.commonDir, lockFiles.tutti))).toBe(false)
    expect(existsSync(join(where.commonDir, lockFiles.orchestra))).toBe(false)
  })

  test("sees no run in lock files nobody holds, and leaves them free", async () => {
    const where = newRepo()
    writeFileSync(join(where.commonDir, lockFiles.tutti), "")
    writeFileSync(join(where.commonDir, lockFiles.orchestra), "")
    expect(await probe(where)).toBeUndefined()
    const fd = Effect.runSync(openCloexec(join(where.commonDir, lockFiles.tutti), O.RDWR))
    try {
      expect(Effect.runSync(flockExclusiveNonBlocking(fd))).toBe(true)
    } finally {
      Effect.runSync(close(fd))
    }
  })

  test("sees a tutti run holding the lock, named as acquire would refuse it", async () => {
    const where = newRepo()
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RunLock
          yield* lock.acquire({ ...where, holder })
          return yield* lock.probe(where)
        }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    expect(seen).toBeInstanceOf(AlreadyRunning)
    expect(seen?.program).toBe("tutti")
    expect(seen?.holder).toEqual(holder)
    // Released with the run's scope: nobody holds it now.
    expect(await probe(where)).toBeUndefined()
  })

  test("sees orchestra holding its own lock", async () => {
    const where = newRepo()
    const release = holdExclusive(
      join(where.commonDir, lockFiles.orchestra),
      orchestraLockText(holder),
    )
    try {
      const seen = await probe(where)
      expect(seen?.program).toBe("orchestra")
      expect(seen?.holder.pid).toBe(holder.pid)
      expect(seen?.message).toStartWith(`orchestra is running in ${where.repo} (pid 44497`)
    } finally {
      release()
    }
  })

  test("a run starting while a probe holds its shared lock gets past it", async () => {
    const where = newRepo()
    const path = join(where.commonDir, lockFiles.tutti)
    const fd = Effect.runSync(openCloexec(path, O.RDONLY | O.CREAT))
    expect(Effect.runSync(flockSharedNonBlocking(fd))).toBe(true)
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          // The probe's moment ends while the run retries.
          const release = yield* Effect.forkChild(
            Effect.sleep("40 millis").pipe(
              Effect.andThen(Effect.ignore(unlock(fd))),
              Effect.andThen(Effect.ignore(close(fd))),
            ),
          )
          yield* (yield* RunLock).acquire({ ...where, holder })
          yield* Fiber.join(release)
        }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("the test layer sees the locks held in it", async () => {
    const where = newRepo()
    const held: ReadonlyArray<Held> = [
      { commonDir: where.commonDir, program: "orchestra", holder: { pid: 7 } },
    ]
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const lock = yield* RunLock
        return [yield* lock.probe(where), yield* lock.probe(newRepo())] as const
      }).pipe(Effect.provide(memoryLayer(held))),
    )
    expect(seen[0]?.program).toBe("orchestra")
    expect(seen[0]?.holder).toEqual({ pid: 7 })
    expect(seen[1]).toBeUndefined()
  })
})

describe("tutti plan --apply", () => {
  const backlog: ReadonlyArray<Seed> = [
    { id: "t-1", priority: 2, description: "Retry in `Loop.merge`." },
    { id: "t-2", priority: 1, description: "Log each rebase in Loop.merge()." },
  ]
  // The source declaring Loop.merge, so that the tickets naming it are linked.
  const files = { "src/run/loop.ts": "export class Loop {\n  merge() {\n  }\n}\n" }

  const warning = (message: string) =>
    `tutti plan: warning: ${message}. A ticket it has started keeps going and may merge before a ticket it now waits for.`

  /** Runs `tutti plan` with args in a new checkout, the lock `lock` given; what it printed. */
  const plan = (
    where: { repo: string },
    args: ReadonlyArray<string>,
    lock: Layer.Layer<RunLock>,
    seeds: ReadonlyArray<Seed> = backlog,
  ) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(where.repo, file)), { recursive: true })
      writeFileSync(join(where.repo, file), content)
    }
    const printed: Array<string> = []
    const errors: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
      error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
    })
    return Effect.runPromise(
      Effect.gen(function* () {
        const services = yield* Effect.context<Beads | Git | RunLock>()
        const exit = yield* Command.runWith(
          tuttiWith(Effect.succeed(where.repo), () => Layer.succeedContext(services)),
          { version: "test", renderErrors: false },
        )(["plan", ...args]).pipe(Effect.provideService(Console.Console, console), Effect.exit)
        return { printed, errors, failed: Exit.isFailure(exit) }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(beadsLayer(seeds), gitLayer({ dir: where.repo, files }), lock),
        ),
        Effect.provide(BunServices.layer),
      ),
    )
  }

  test("warns on stderr when a run holds the lock, and adds the links", async () => {
    const where = newRepo()
    const release = holdExclusive(
      join(where.commonDir, lockFiles.tutti),
      JSON.stringify({ ...holder, branch: "" }),
    )
    try {
      const result = await plan(where, ["--apply"], RunLock.layer)
      expect(result.errors).toEqual([
        warning(`tutti is already running in ${where.repo} (pid 44497, since 08:31)`),
      ])
      expect(result.printed).toEqual([
        "Adding 1 blocks link between the 2 open tickets:",
        "  t-1 (P2) waits for t-2 (P1): both touch Loop.merge",
        "Added 1 link.",
      ])
      expect(result.failed).toBe(false)
    } finally {
      release()
    }
  })

  test("warns of an orchestra run too", async () => {
    const where = newRepo()
    const held: ReadonlyArray<Held> = [
      {
        commonDir: where.commonDir,
        program: "orchestra",
        holder: { pid: 12, branch: "main" },
      },
    ]
    const result = await plan(where, ["--apply"], memoryLayer(held))
    expect(result.errors).toEqual([warning(`orchestra is running in ${where.repo} (pid 12, main)`)])
    expect(result.failed).toBe(false)
  })

  test("says nothing of the lock when no run holds it", async () => {
    const where = newRepo()
    const result = await plan(where, ["--apply"], RunLock.layer)
    expect(result.errors).toEqual([])
    expect(result.printed.at(-1)).toBe("Added 1 link.")
  })

  test("without --apply, or with no link to add, it doesn't warn", async () => {
    const where = newRepo()
    const held: ReadonlyArray<Held> = [
      { commonDir: where.commonDir, program: "tutti", holder: { pid: 12 } },
    ]
    const proposed = await plan(where, [], memoryLayer(held))
    expect(proposed.errors).toEqual([])
    const none = await plan(where, ["--apply"], memoryLayer(held), [backlog[0] as Seed])
    expect(none.errors).toEqual([])
    expect(none.printed[0]).toStartWith("No links to add")
  })

  test("a lock it can't probe warns of nothing", async () => {
    const where = newRepo()
    const failing = Layer.succeed(
      RunLock,
      RunLock.of({
        acquire: () => Effect.die("not used"),
        probe: () => Effect.fail(new LockFailed({ file: "tutti.lock", reason: "EACCES" })),
      }),
    )
    const result = await plan(where, ["--apply"], failing)
    expect(result.errors).toEqual([])
    expect(result.printed.at(-1)).toBe("Added 1 link.")
  })
})
