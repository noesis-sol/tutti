// The symlink guard's opens refuse what isn't a regular file, a named pipe above all, without
// waiting on it: open(2) on a named pipe waits for its other end, and through bun:ffi it would wait
// on the JavaScript thread, holding the whole of tutti.

import { dlopen, FFIType } from "bun:ffi"
import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer } from "effect"
import { answerFile, attentionFolder, refusedFile, serve } from "../src/agent/attentionFiles.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { close, libcPath, NotAFileRefused, O, openUnder } from "../src/native/libc.ts"
import { outputTo } from "../src/run/check.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Checks, checkLogName } from "../src/services/Checks.ts"
import { readRunFile, runFolder, writeRunFile } from "../src/services/Worktrees.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import * as TestLog from "../src/testing/Log.ts"
import * as TestWorktrees from "../src/testing/Worktrees.ts"

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-guarded-")))

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

const mkfifo = (path: string) => {
  const made = Bun.spawnSync(["mkfifo", path])
  if (made.exitCode !== 0) throw new Error(`mkfifo ${path}: ${made.stderr.toString()}`)
}

const rescuers: Array<number> = []

afterEach(() => {
  for (const pid of rescuers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
})

/**
 * Opens the named pipe at `path` for reading and writing after two seconds, which ends an open of
 * it that waits for its other end: an open that waits fails its test on the time it took, rather
 * than holding the test run for good.
 */
const rescue = (path: string) => {
  const rescuer = Bun.spawn(["sh", "-c", 'sleep 2; exec 3<>"$1"; sleep 5', "rescuer", path], {
    stdout: "ignore",
    stderr: "ignore",
  })
  rescuers.push(rescuer.pid)
}

/** Runs `f`, failing when it took a second or more. */
const atOnce = <A>(f: () => A): A => {
  const started = performance.now()
  const result = f()
  expect(performance.now() - started).toBeLessThan(1000)
  return result
}

// fcntl(F_GETFL) through a binding of the test's own, as libc.ts keeps it to itself.
const F_GETFL = 3
const own = dlopen(libcPath, { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
const statusFlags = (fd: number) => own.symbols.fcntl(fd, F_GETFL)

describe("openUnder and what isn't a regular file", () => {
  /** A worktree with .tutti/run/, a named pipe in it at `name`, and its rescuer started. */
  const withPipe = (name: string) => {
    const tree = tempDir()
    mkdirSync(join(tree, runFolder), { recursive: true })
    mkfifo(join(tree, runFolder, name))
    rescue(join(tree, runFolder, name))
    return tree
  }

  for (const [how, flags] of [
    ["reading", O.RDONLY],
    ["writing", O.WRONLY | O.CREAT | O.TRUNC],
    ["appending", O.RDWR | O.APPEND | O.CREAT],
  ] as const) {
    test(`refuses a named pipe for ${how} at once, naming it`, () => {
      const tree = withPipe("check.log")
      const exit = atOnce(() =>
        Effect.runSyncExit(openUnder(tree, `${runFolder}/check.log`, flags)),
      )
      const error = failure(exit)
      expect(error).toBeInstanceOf(NotAFileRefused)
      expect(error).toMatchObject({ path: `${runFolder}/check.log`, kind: "a named pipe" })
      expect(error.message).toBe(
        `${runFolder}/check.log under ${tree} is a named pipe, not a regular file`,
      )
    })
  }

  test("refuses a socket", async () => {
    const tree = tempDir()
    mkdirSync(join(tree, "r"))
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(join(tree, "r/s"), resolve))
    try {
      for (const flags of [O.RDONLY, O.WRONLY | O.CREAT | O.TRUNC]) {
        const error = failure(atOnce(() => Effect.runSyncExit(openUnder(tree, "r/s", flags))))
        expect(error).toMatchObject({ _tag: "NotAFileRefused", kind: "a socket" })
      }
    } finally {
      server.close()
    }
  })

  test("refuses a folder unless O_DIRECTORY asks for one", () => {
    const tree = tempDir()
    mkdirSync(join(tree, runFolder), { recursive: true })
    expect(failure(Effect.runSyncExit(openUnder(tree, runFolder, O.RDONLY)))).toMatchObject({
      _tag: "NotAFileRefused",
      kind: "a folder",
    })
    Effect.runSync(close(Effect.runSync(openUnder(tree, runFolder, O.RDONLY | O.DIRECTORY))))
  })

  test("refuses a regular file where O_DIRECTORY asks for a folder", () => {
    const tree = tempDir()
    writeFileSync(join(tree, "file"), "")
    expect(
      failure(Effect.runSyncExit(openUnder(tree, "file", O.RDONLY | O.DIRECTORY))),
    ).toMatchObject({ _tag: "LibcError", code: "ENOTDIR" })
  })

  test("leaves a regular file blocking, as asked, or non-blocking where asked", () => {
    const tree = tempDir()
    writeFileSync(join(tree, "file"), "text")
    const blocking = Effect.runSync(openUnder(tree, "file", O.WRONLY | O.APPEND))
    expect(statusFlags(blocking) & O.NONBLOCK).toBe(0)
    writeSync(blocking, " more")
    Effect.runSync(close(blocking))
    expect(readFileSync(join(tree, "file"), "utf8")).toBe("text more")
    const nonBlocking = Effect.runSync(openUnder(tree, "file", O.RDONLY | O.NONBLOCK))
    expect(statusFlags(nonBlocking) & O.NONBLOCK).toBe(O.NONBLOCK)
    Effect.runSync(close(nonBlocking))
  })

  test("a run file read or written through the guard is refused at a named pipe", () => {
    const tree = withPipe("state")
    for (const effect of [writeRunFile(tree, "state", "x"), readRunFile(tree, "state")]) {
      const exit = atOnce(() => Effect.runSyncExit(effect as Effect.Effect<unknown, unknown>))
      expect(failure(exit)).toMatchObject({ _tag: "NotAFileRefused", kind: "a named pipe" })
    }
  })
})

describe("a named pipe at the merge check's check.log", () => {
  test("is refused, and the check runs with its output dropped, saying why", async () => {
    const worktree = tempDir()
    mkdirSync(join(worktree, runFolder), { recursive: true })
    const log = join(worktree, runFolder, checkLogName)
    mkfifo(log)
    rescue(log)
    const settings = {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        fast: { command: "echo checked", timeout: Duration.seconds(10) },
      },
    }
    const layer = Layer.mergeAll(
      Checks.layer.pipe(
        Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
        Layer.provide(BunServices.layer),
      ),
      TestWorktrees.layer(),
      TestLog.layer(),
    )
    const started = performance.now()
    const { ran, lines } = await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Effect.scoped(
          Effect.gen(function* () {
            const to = yield* outputTo(
              { id: "a" as TicketId, worktree },
              checkLogName,
              "the check's",
            )
            expect(to).toEqual({ outputFile: "/dev/null" })
            return yield* Effect.exit((yield* Checks).fast({ cwd: worktree, ...to }))
          }),
        )
        return { ran, lines: yield* TestLog.texts }
      }).pipe(Effect.provide(layer)),
    )
    expect(performance.now() - started).toBeLessThan(2000)
    expect(Exit.isSuccess(ran)).toBe(true)
    expect(lines).toEqual([
      `  a: the check's whole output can't be kept in ${log}: ${runFolder}/${checkLogName} under ${worktree} is a named pipe, not a regular file`,
    ])
  })
})

describe("a named pipe at an answer file's path", () => {
  /** Serves the attention files in `repo` while `effect` runs. */
  const serving = <A, E>(repo: string, effect: Effect.Effect<A, E, Log>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* serve({ repo, poll: "50 millis" })
          return yield* effect
        }),
      ).pipe(
        Effect.provide(
          attentionLayer().pipe(
            Layer.provideMerge(Layer.mergeAll(TestLog.layer(), eventsLayer(), BunFileSystem.layer)),
          ),
        ),
      ),
    )

  /** Waits up to 5 seconds for `check` to hold, looking every 10 ms. */
  const until = (what: string, check: () => boolean) =>
    Effect.gen(function* () {
      for (let i = 0; i < 500; i++) {
        if (check()) return
        yield* Effect.sleep("10 millis")
      }
      return yield* Effect.die(new Error(`timed out waiting for ${what}`))
    })

  /** The reason the run gave for refusing `id`'s answer, once it has, and the answer is gone. */
  const refusal = (repo: string, id: string) =>
    Effect.gen(function* () {
      yield* until(`${id}'s refusal`, () => existsSync(join(repo, refusedFile(id))))
      yield* until(`${id}'s answer to go`, () => !existsSync(join(repo, answerFile(id))))
      return JSON.parse(readFileSync(join(repo, refusedFile(id)), "utf8")).reason as string
    })

  test("is refused and removed, and the run goes on taking answers", async () => {
    const repo = tempDir()
    const started = performance.now()
    const { first, next, lines } = await serving(
      repo,
      Effect.gen(function* () {
        yield* until("the folder", () => existsSync(join(repo, attentionFolder)))
        mkfifo(join(repo, answerFile("r1")))
        rescue(join(repo, answerFile("r1")))
        const first = yield* refusal(repo, "r1")
        writeFileSync(join(repo, answerFile("r2")), '{"v":1,"request":"r2","answer":"allow"}')
        const next = yield* refusal(repo, "r2")
        return { first, next, lines: yield* TestLog.texts }
      }),
    )
    expect(performance.now() - started).toBeLessThan(2000)
    expect(first).toBe("it is a named pipe, not a regular file")
    expect(next).toBe("request r2 is no longer open")
    expect(lines).toContain(
      "ANSWER_REFUSED: tutti answer for request r1: it is a named pipe, not a regular file",
    )
  })
})
