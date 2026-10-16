import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Schema } from "effect"
import fc from "fast-check"
import { close, flockExclusiveNonBlocking, O, openCloexec } from "../src/native/libc.ts"
import {
  AlreadyRunning,
  type Holder,
  type LockRequest,
  parseHolder,
  RunLock,
  SeenHolder,
  tuttiLockText,
} from "../src/services/RunLock.ts"
import { layer as memoryLayer } from "../src/testing/RunLock.ts"

/** A repository's top and its git folder, where the lock files go. */
const newRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-run-lock-")))
  const commonDir = join(repo, ".git")
  mkdirSync(commonDir)
  return { repo, commonDir }
}

const holder: Holder = {
  pid: process.pid,
  started: new Date(2026, 9, 17, 8, 31, 5).toISOString(),
  version: "0.1.0",
  branch: "main",
  scope: "demo-1",
}

const request = (repo: { repo: string; commonDir: string }, over: Partial<Holder> = {}) =>
  ({ ...repo, holder: { ...holder, ...over } }) satisfies LockRequest

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

const acquire = (lock: LockRequest) =>
  Effect.gen(function* () {
    yield* (yield* RunLock).acquire(lock)
  })

/** Takes the lock of `request` with the live layer, in a scope of its own, and runs `then`. */
const withLock = <A = void, E = never>(
  lock: LockRequest,
  then: Effect.Effect<A, E> = Effect.void as unknown as Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquire(lock)
        return yield* then
      }),
    ).pipe(Effect.provide(RunLock.layer)),
  )

/** Whether this process can take the lock on `path` now, through an open file of its own. */
const lockable = (path: string): boolean => {
  const fd = Effect.runSync(openCloexec(path, O.RDWR | O.CREAT))
  try {
    return Effect.runSync(flockExclusiveNonBlocking(fd))
  } finally {
    Effect.runSync(close(fd))
  }
}

const bothLockable = (commonDir: string) => ({
  tutti: lockable(join(commonDir, "tutti.lock")),
  orchestra: lockable(join(commonDir, "orchestra.lock")),
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const gone = async (pid: number) => {
  const deadline = Date.now() + 5000
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20)
}

const toKill: Array<number> = []

afterEach(() => {
  for (const pid of toKill.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL")
})

const holderScript = join(import.meta.dir, "fixtures/run-lock/holder.ts")

/** Starts the holder and waits for its `held` line; returns its PID and its sleep's, if any. */
const startHolder = async (commonDir: string, who: "tutti" | "orchestra", spawn?: "system") => {
  const args = spawn === undefined ? [] : [spawn]
  const process_ = Bun.spawn(["bun", holderScript, commonDir, who, ...args], {
    stdout: "pipe",
    stderr: "inherit",
  })
  toKill.push(process_.pid)
  let out = ""
  const decoder = new TextDecoder()
  for await (const chunk of process_.stdout) {
    out += decoder.decode(chunk)
    if (/^(held|refused|.* running in .*)$/m.test(out)) break
  }
  expect(out).toMatch(/^held$/m)
  const child = /^child (\d+)$/m.exec(out)?.[1]
  if (child !== undefined) toKill.push(Number(child))
  return { pid: process_.pid, child: child === undefined ? undefined : Number(child) }
}

describe("the live lock", () => {
  test("takes both files for the scope, naming the run, and releases them when it closes", async () => {
    const repo = newRepo()
    const exit = await withLock(
      request(repo),
      Effect.sync(() => ({
        lockable: bothLockable(repo.commonDir),
        tutti: JSON.parse(readFileSync(join(repo.commonDir, "tutti.lock"), "utf8")),
        orchestra: JSON.parse(readFileSync(join(repo.commonDir, "orchestra.lock"), "utf8")),
      })),
    )
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    expect(exit.value.lockable).toEqual({ tutti: false, orchestra: false })
    expect(exit.value.tutti).toEqual(holder)
    expect(exit.value.orchestra).toEqual({
      pid: process.pid,
      started: holder.started,
      version: "tutti 0.1.0",
      branch: "main",
    })
    expect(bothLockable(repo.commonDir)).toEqual({ tutti: true, orchestra: true })
    // Emptied on release, so neither file names a run that has ended.
    expect(readFileSync(join(repo.commonDir, "tutti.lock"), "utf8")).toBe("")
    expect(readFileSync(join(repo.commonDir, "orchestra.lock"), "utf8")).toBe("")
  })

  test("writes init and feature runs as they are", async () => {
    const repo = newRepo()
    const { scope: _, ...run } = holder
    for (const each of [
      { ...run, init: true as const },
      { ...run, feature: "dark mode" },
    ]) {
      const exit = await withLock(
        { ...repo, holder: each },
        Effect.sync(() => JSON.parse(readFileSync(join(repo.commonDir, "tutti.lock"), "utf8"))),
      )
      if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
      expect(exit.value).toEqual(each)
    }
  })

  test("a second run in the same process is refused with the holder's details", async () => {
    const repo = newRepo()
    const exit = await withLock(
      request(repo),
      Effect.flip(Effect.scoped(acquire(request(repo, { pid: 1 })))).pipe(
        Effect.provide(RunLock.layer),
      ),
    )
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    const error = exit.value
    expect(error).toBeInstanceOf(AlreadyRunning)
    expect(error).toMatchObject({ program: "tutti", repo: repo.repo })
    expect((error as AlreadyRunning).holder).toEqual(holder)
  })

  test("a second process is refused with the holder's pid, start time and branch", async () => {
    const repo = newRepo()
    const other = await startHolder(repo.commonDir, "tutti")
    const error = failure(await withLock(request(repo)))
    expect(error).toBeInstanceOf(AlreadyRunning)
    const refused = error as AlreadyRunning
    expect(refused.program).toBe("tutti")
    expect(refused.holder).toMatchObject({ pid: other.pid, branch: "main", scope: "demo-1" })
    expect(Number.isNaN(Date.parse(refused.holder.started ?? ""))).toBe(false)
    expect(refused.message).toMatch(
      new RegExp(
        `^tutti is already running in ${repo.repo} \\(pid ${other.pid}, since \\d\\d:\\d\\d, main\\)$`,
      ),
    )
    // orchestra.lock is left to the holder too.
    expect(bothLockable(repo.commonDir)).toEqual({ tutti: false, orchestra: false })
  })

  test("orchestra holding its lock refuses the run, which then holds neither lock", async () => {
    const repo = newRepo()
    const orchestra = await startHolder(repo.commonDir, "orchestra")
    const error = failure(await withLock(request(repo)))
    expect(error).toBeInstanceOf(AlreadyRunning)
    const refused = error as AlreadyRunning
    expect(refused.program).toBe("orchestra")
    expect(refused.holder).toEqual({
      pid: orchestra.pid,
      started: "2026-10-17T08:31:00.123456+03:00",
      version: "v0.8.0",
      branch: "main",
    })
    expect(refused.message).toMatch(
      new RegExp(
        `^orchestra is running in ${repo.repo} \\(pid ${orchestra.pid}, since \\d\\d:\\d\\d, main\\)$`,
      ),
    )
    expect(lockable(join(repo.commonDir, "tutti.lock"))).toBe(true)
  })

  test("both locks are released when the holder is killed with kill -9", async () => {
    const repo = newRepo()
    const other = await startHolder(repo.commonDir, "tutti")
    expect(bothLockable(repo.commonDir)).toEqual({ tutti: false, orchestra: false })
    process.kill(other.pid, "SIGKILL")
    await gone(other.pid)
    expect(bothLockable(repo.commonDir)).toEqual({ tutti: true, orchestra: true })
    expect(Exit.isSuccess(await withLock(request(repo)))).toBe(true)
  })

  test("the files are close-on-exec: a child the holder started keeps neither lock", async () => {
    const repo = newRepo()
    const other = await startHolder(repo.commonDir, "tutti", "system")
    expect(other.child).toBeDefined()
    process.kill(other.pid, "SIGKILL")
    await gone(other.pid)
    expect(alive(other.child as number)).toBe(true)
    expect(bothLockable(repo.commonDir)).toEqual({ tutti: true, orchestra: true })
  })

  test("a git folder that can't hold the files fails with LockFailed", async () => {
    const repo = newRepo()
    const error = failure(
      await withLock({ ...repo, commonDir: join(repo.commonDir, "missing"), holder }),
    )
    expect(error).toMatchObject({
      _tag: "LockFailed",
      file: join(repo.commonDir, "missing", "tutti.lock"),
    })
  })
})

describe("the refusal's message", () => {
  const refusal = (program: "tutti" | "orchestra", seen: SeenHolder) =>
    new AlreadyRunning({ program, repo: "/work/project", holder: seen }).message

  test("names the pid, the local start time and the branch", () => {
    expect(refusal("tutti", { pid: 44497, started: holder.started, branch: "main" })).toBe(
      "tutti is already running in /work/project (pid 44497, since 08:31, main)",
    )
    expect(refusal("orchestra", { pid: 44497, started: holder.started, branch: "main" })).toBe(
      "orchestra is running in /work/project (pid 44497, since 08:31, main)",
    )
  })

  test("leaves out what the file doesn't say, and says so when it says nothing", () => {
    expect(refusal("orchestra", { pid: 7 })).toBe("orchestra is running in /work/project (pid 7)")
    expect(refusal("tutti", { started: "yesterday", branch: "" })).toBe(
      "tutti is already running in /work/project (tutti.lock doesn't say which)",
    )
  })

  test("can't be given an escape sequence or a line break by the file", () => {
    const message = refusal("tutti", { pid: 1, branch: "main\u001b[2J\nrm -rf" })
    expect(message).not.toMatch(/\p{Cc}/u)
  })
})

describe("parseHolder", () => {
  test("reads back what tutti writes", () => {
    const decode = Schema.decodeUnknownSync(SeenHolder)
    fc.assert(
      fc.property(
        fc.record(
          {
            pid: fc.integer({ min: 1, max: 4_194_304 }),
            started: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
            version: fc.string(),
            branch: fc.string(),
            scope: fc.string(),
            feature: fc.string(),
            init: fc.constant(true as const),
          },
          { requiredKeys: ["pid", "started", "version", "branch"] },
        ),
        (run) => {
          expect(parseHolder(tuttiLockText(run))).toEqual(decode(run))
        },
      ),
    )
  })

  test("never throws, and keeps only the fields with the right type", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.jsonValue().map((v) => JSON.stringify(v)),
        ),
        (text) => {
          const seen = parseHolder(text)
          expect(() => Schema.decodeUnknownSync(SeenHolder)(seen)).not.toThrow()
          if (seen.pid !== undefined)
            expect(Number.isSafeInteger(seen.pid) && seen.pid > 0).toBe(true)
        },
      ),
    )
    expect(parseHolder("")).toEqual({})
    expect(parseHolder("[1]")).toEqual({})
    expect(parseHolder('{"pid": "12", "branch": 3, "init": "yes", "version": "v0.8.0"}')).toEqual({
      version: "v0.8.0",
    })
  })
})

describe("the test layer", () => {
  test("refuses a second run until the first one's scope closes", async () => {
    const repo = newRepo()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* acquire(request(repo))
            return yield* Effect.flip(Effect.scoped(acquire(request(repo, { pid: 2 }))))
          }),
        )
        const after = yield* Effect.exit(Effect.scoped(acquire(request(repo, { pid: 3 }))))
        return { first, after }
      }).pipe(Effect.provide(memoryLayer())),
    )
    expect(result.first).toMatchObject({ program: "tutti", holder: holder })
    expect(Exit.isSuccess(result.after)).toBe(true)
  })

  test("refuses while orchestra holds its lock", async () => {
    const repo = newRepo()
    const error = await Effect.runPromise(
      Effect.flip(Effect.scoped(acquire(request(repo)))).pipe(
        Effect.provide(
          memoryLayer([
            { commonDir: repo.commonDir, program: "orchestra", holder: { pid: 9, branch: "main" } },
          ]),
        ),
      ),
    )
    expect(error.message).toBe(`orchestra is running in ${repo.repo} (pid 9, main)`)
  })
})
