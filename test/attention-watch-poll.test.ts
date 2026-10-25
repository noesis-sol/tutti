// What wakes the attention folder's scan (src/agent/attentionFiles.ts's serve), under TestClock: the
// folder's events, and the poll, which goes on where the watch fails or its folder goes.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { TestClock } from "effect/testing"
import { Attention, type AttentionRequest } from "../src/agent/Attention.ts"
import {
  answerFile,
  attentionFolder,
  encodeFile,
  serve,
  writeExclusive,
} from "../src/agent/attentionFiles.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { openFibers } from "./fibers.ts"

const tempRepo = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-attention-watch-")))

/** The poll the tests serve with: TestClock moves it, or nothing does. */
const poll = "2 seconds"

/** BunFileSystem with a watch that fails as it starts. */
const noWatch = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) =>
    FileSystem.FileSystem.of({
      ...fs,
      watch: (path) =>
        Stream.fail(
          new PlatformError(
            new SystemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "watch",
              pathOrDescriptor: path,
            }),
          ),
        ),
    }),
  ),
).pipe(Layer.provide(BunFileSystem.layer))

/** Runs `effect` with the attention files of `repo` served under TestClock, over `files`. */
const run = <A, E>(
  repo: string,
  effect: Effect.Effect<A, E, Attention | Log | FileSystem.FileSystem | TestClock.TestClock>,
  files: Layer.Layer<FileSystem.FileSystem> = BunFileSystem.layer,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.andThen(serve({ repo, poll }), effect)).pipe(
      Effect.provide(
        attentionLayer().pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer(), files)),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

const sdkOptions = (): Parameters<CanUseTool>[2] => ({
  signal: new AbortController().signal,
  toolUseID: "toolu_1",
  requestId: "req",
})

/** Past the scan the poll makes as it starts, in real time: the answer written after it. */
const pastFirstScan = Effect.promise(() => Bun.sleep(200))

/** Opens a permission request of `t-1`'s, and gives it with its call's result. */
const ask = Effect.gen(function* () {
  const attention = yield* Attention
  const canUseTool = yield* attention.request("t-1" as TicketId, openFibers())
  const result = canUseTool("Bash", { command: "rm -rf build" }, sdkOptions())
  const open = yield* attention.open.pipe(
    Stream.filter((all) => all.length > 0),
    Stream.runHead,
  )
  const request = (open._tag === "Some" ? open.value[0] : undefined) as AttentionRequest
  return { request, result }
})

/** Waits, in real time, up to 5 s, for `check` to hold; whether it did. */
const realUntil = (check: () => boolean) =>
  Effect.promise(async () => {
    for (let i = 0; i < 500; i++) {
      if (check()) return true
      await Bun.sleep(10)
    }
    return check()
  })

/** Whether `result` has settled within `ms` of real time. */
const settledWithin = (result: Promise<PermissionResult | null>, ms: number) =>
  Effect.promise(() => Promise.race([result.then(() => true), Bun.sleep(ms).then(() => false)]))

const allow = (repo: string, id: string) =>
  Effect.orDie(
    writeExclusive(repo, answerFile(id), encodeFile({ v: 1, request: id, answer: "allow" })),
  )

describe("the attention folder's scan", () => {
  test("an answer file is taken on the folder's event, with no poll", async () => {
    const repo = tempRepo()
    const taken = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask
        yield* pastFirstScan
        yield* allow(repo, request.id)
        // TestClock never moves: only the folder's event can wake the scan.
        return yield* settledWithin(result, 5_000)
      }),
    )
    expect(taken).toBe(true)
  })

  test("with a watch that fails, the poll takes the answer, and only once it is due", async () => {
    const repo = tempRepo()
    const { before, after } = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask
        yield* pastFirstScan
        yield* allow(repo, request.id)
        const before = yield* settledWithin(result, 300)
        yield* TestClock.adjust(poll)
        const after = yield* settledWithin(result, 5_000)
        return { before, after }
      }),
      noWatch,
    )
    expect(before).toBe(false)
    expect(after).toBe(true)
  })

  test("its folder removed, the poll goes on, saying once that it can't read it", async () => {
    const repo = tempRepo()
    const lines = await run(
      repo,
      Effect.gen(function* () {
        rmSync(join(repo, attentionFolder), { recursive: true })
        yield* TestClock.adjust(poll)
        yield* TestClock.adjust(poll)
        yield* Effect.promise(() => Bun.sleep(50))
        return yield* texts
      }),
    )
    expect(existsSync(join(repo, attentionFolder))).toBe(false)
    expect(lines.filter((line) => line.includes(`reading ${attentionFolder}`))).toHaveLength(1)
  })

  test("its folder removed and made again, an answer in it is taken on the poll", async () => {
    const repo = tempRepo()
    const taken = await run(
      repo,
      Effect.gen(function* () {
        const { request, result } = yield* ask
        yield* pastFirstScan
        const folder = join(repo, attentionFolder)
        yield* realUntil(() => existsSync(folder))
        rmSync(folder, { recursive: true })
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.makeDirectory(folder, { mode: 0o700 }),
        )
        yield* allow(repo, request.id)
        yield* TestClock.adjust(poll)
        return yield* settledWithin(result, 5_000)
      }),
    )
    expect(taken).toBe(true)
  })
})
