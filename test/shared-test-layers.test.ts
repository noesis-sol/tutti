// The small test layers that go through the live code: AppConfig through resolve, Log through
// Log.layerOn, RunLock through the lock files' texts, Transcripts' ID check in makeTranscripts,
// Tty through fromEnvironment, and Worktrees through found.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { makeTranscripts, type Storage, Transcripts } from "../src/agent/Transcripts.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { Log, line } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import type { Sha } from "../src/services/Git.ts"
import {
  AlreadyRunning,
  type Holder,
  type LockFailed,
  orchestraLockText,
  parseHolder,
  RunLock,
  tuttiLockText,
} from "../src/services/RunLock.ts"
import { colourDepthOf, fromEnvironment, outputMode } from "../src/services/Tty.ts"
import { found, nothingEarlier, Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as testLog } from "../src/testing/Log.ts"
import { layer as testRunLock } from "../src/testing/RunLock.ts"
import { Files, layer as testTranscripts } from "../src/testing/Transcripts.ts"
import { tty } from "../src/testing/Tty.ts"
import { layer as testWorktrees } from "../src/testing/Worktrees.ts"

describe("the AppConfig test layer", () => {
  test("derives the paths from the repository it is given in overrides", () => {
    const config = appConfig({ repo: "/work/other" })
    expect(config).toEqual(appConfig({}, "/work/other"))
    expect(config.prompt).toBe("/work/other/.tutti/worker-prompt.md")
    expect(config.worktrees).toBe("/work/other-tutti")
  })

  test("resolves the settings it is given, as a run's are", () => {
    const settings = { ...defaultSettings, ui: { colour_scheme: "project" } }
    const config = appConfig({ settings })
    expect(config.settings).toEqual(settings)
    expect(config.colourScheme).toBe("project")
  })

  test("lays the other overrides over what it resolved", () => {
    expect(appConfig({ prompt: "/elsewhere/prompt.md" }).prompt).toBe("/elsewhere/prompt.md")
  })
})

describe("the Log test layer", () => {
  test("keeps what the live log over a file keeps", async () => {
    const program = Effect.gen(function* () {
      const log = yield* Log
      yield* log.write(line`one`, line`two`)
      let recorded = false
      yield* log.writeWith(
        [line`three`],
        Effect.sync(() => (recorded = true)),
      )
      return { lines: yield* log.lines, startBlockEnd: yield* log.startBlockEnd, recorded }
    })
    const written: Array<string> = []
    const file = {
      writeAll: (bytes: Uint8Array) =>
        Effect.sync(() => written.push(new TextDecoder().decode(bytes))),
    }
    const run = (layer: Layer.Layer<Log>) =>
      Effect.runPromise(program.pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))))
    const live = await run(Log.layerOn({ file }))
    const test = await run(testLog())
    expect(test).toEqual(live)
    expect(test.recorded).toBe(true)
    expect(test.lines.map((each) => String(each.text))).toEqual(["one", "two", "three"])
    expect(written.join("")).toBe(test.lines.map((each) => `${each.stamp} ${each.text}\n`).join(""))
  })
})

describe("the RunLock test layer", () => {
  const holderOf = (error: AlreadyRunning | LockFailed) =>
    error instanceof AlreadyRunning ? error.holder : error
  const holder: Holder = {
    pid: 4242,
    started: "2026-10-24T08:31:05.000Z",
    version: "0.1.0",
    branch: "main",
    scope: "demo-1",
    init: true,
  }
  const request = { repo: "/work/project", commonDir: "/work/project/.git", holder }

  test("refuses a second run with the holder as tutti.lock's text reads back", async () => {
    const refused = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RunLock
          const held = yield* lock.acquire(request)
          const first = yield* Effect.flip(Effect.scoped(lock.acquire(request)))
          yield* held.rewrite({ ...holder, feature: "dark mode" })
          const rewritten = yield* lock.probe(request)
          return { first, rewritten }
        }),
      ).pipe(Effect.provide(testRunLock())),
    )
    expect(holderOf(refused.first)).toEqual(parseHolder(tuttiLockText(holder)))
    expect(refused.rewritten?.holder).toEqual(
      parseHolder(tuttiLockText({ ...holder, feature: "dark mode" })),
    )
  })

  test("a held holder is read back as its file would be, keeping only what parseHolder keeps", async () => {
    const said = { pid: -1, version: "orchestra 2", branch: "main" }
    const refused = await Effect.runPromise(
      Effect.flip(Effect.scoped(Effect.flatMap(RunLock, (lock) => lock.acquire(request)))).pipe(
        Effect.provide(
          testRunLock([{ commonDir: request.commonDir, program: "orchestra", holder: said }]),
        ),
      ),
    )
    expect(holderOf(refused)).toEqual({ version: "orchestra 2", branch: "main" })
  })

  test("orchestra.lock's text names tutti's run in orchestra's shape", () => {
    expect(parseHolder(orchestraLockText(holder))).toEqual({
      pid: 4242,
      started: holder.started,
      version: "tutti 0.1.0",
      branch: "main",
    })
  })
})

describe("Transcripts' ID check", () => {
  test("makeTranscripts asks the storage nothing of a worker whose ID can't name a folder", async () => {
    const asked: Array<string> = []
    const refused: Array<[string, string, string]> = []
    const storage: Storage = {
      append: (worker) => asked.push(`append ${worker}`),
      stderr: (worker) => asked.push(`stderr ${worker}`),
      linesBackward: (worker) => {
        asked.push(`read ${worker}`)
        return []
      },
      release: () => {},
      refused: (worker, file, problem) => refused.push([worker, file, problem]),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const transcripts = yield* makeTranscripts(storage)
        yield* transcripts.record("../escape", { session: "s", message: { type: "user" } as never })
        transcripts.stderr("../escape")("oops")
        yield* transcripts.page("../escape")
      }),
    )
    expect(asked).toEqual([])
    const problem = "IDs with path characters can't be run"
    expect(refused).toEqual([
      ["../escape", ".tutti/run/workers/../escape/messages.jsonl", problem],
      ["../escape", ".tutti/run/workers/../escape/stderr.log", problem],
    ])
  })

  test("the test layer writes nothing for such a worker, as live", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const transcripts = yield* Transcripts
        yield* transcripts.record("../escape", { session: "s", message: { type: "user" } as never })
        transcripts.stderr("../escape")("oops")
        const files = yield* Files
        return {
          messages: yield* files.messages("../escape"),
          stderr: yield* files.stderr("../escape"),
        }
      }).pipe(Effect.provide(testTranscripts())),
    )
    expect(kept).toEqual({ messages: [], stderr: "" })
  })
})

describe("the Tty test layer", () => {
  test("reads its value from the environment as live does", () => {
    for (const env of [{}, { TERM: "dumb" }, { TERM: "xterm" }, { COLORTERM: "truecolor" }]) {
      const value = tty({ env })
      const variables = { TERM: "xterm-256color", ...env }
      expect({ ...value, size: undefined }).toEqual({
        ...fromEnvironment({
          stdinIsTty: true,
          stdoutIsTty: true,
          env: (name) => (variables as Record<string, string>)[name],
          size: value.size,
        }),
        size: undefined,
      })
      expect(value.colourDepth).toBe(colourDepthOf(variables))
    }
  })

  test("TERM=dumb is dumb with fewer colours, and plain", () => {
    const value = tty({ env: { TERM: "dumb" } })
    expect(value).toMatchObject({ dumb: true, term: "dumb", colourDepth: "fewer" })
    expect(outputMode(value, false)).toEqual({ _tag: "Plain", reason: "dumb" })
  })

  test("NO_COLOR and an unset TERM come through", () => {
    expect(tty({ env: { NO_COLOR: "1" } }).noColor).toBe(true)
    expect(tty({ env: { TERM: undefined } })).toMatchObject({
      term: undefined,
      colourDepth: "fewer",
    })
  })
})

describe("the Worktrees test layer", () => {
  test("found counts reuse and what was left as live does", () => {
    const earlier = {
      commits: [{ hash: "abc" as Sha, subject: "Start", message: "Start\n" }],
      status: [],
    }
    const at = (existing: boolean, branchLeft: boolean) =>
      found("t-1" as TicketId, "/w/t-1", { existing, branchLeft, earlier })
    expect(at(true, true)).toMatchObject({ reused: true, fresh: false, earlier })
    expect(at(false, true)).toMatchObject({ reused: true, fresh: true, earlier })
    expect(at(false, false)).toEqual({
      id: "t-1" as TicketId,
      branch: "tutti/t-1",
      path: "/w/t-1",
      reused: false,
      fresh: true,
      earlier: nothingEarlier,
    })
  })

  test("a branch left without its worktree is reused in a fresh folder, until removed", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-shared-layers-")))
    const earlier = {
      commits: [{ hash: "abc" as Sha, subject: "Start", message: "Start\n" }],
      status: [],
    }
    const [first, again] = await Effect.runPromise(
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const first = yield* worktrees.prepare("t-1" as TicketId)
        yield* worktrees.remove("t-1" as TicketId)
        const again = yield* worktrees.prepare("t-1" as TicketId)
        return [first, again]
      }).pipe(
        Effect.provide(testWorktrees({ root, earlier: { "t-1": earlier }, branchesLeft: ["t-1"] })),
      ),
    )
    expect(first).toMatchObject({ reused: true, fresh: true, earlier })
    expect(again).toMatchObject({ reused: false, fresh: true, earlier: nothingEarlier })
    expect(existsSync(join(root, "t-1"))).toBe(true)
  })

  test("a folder there already is reused, not fresh", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-shared-layers-")))
    mkdirSync(join(root, "t-2"))
    const worktree = await Effect.runPromise(
      Effect.flatMap(Worktrees, (worktrees) => worktrees.prepare("t-2" as TicketId)).pipe(
        Effect.provide(testWorktrees({ root })),
      ),
    )
    expect(worktree).toMatchObject({ reused: true, fresh: false, earlier: nothingEarlier })
    expect(readdirSync(root)).toEqual(["t-2"])
  })
})
